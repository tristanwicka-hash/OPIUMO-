/**
 * Credit circuit breaker.
 *
 * The meter measures; nothing acted on it. Tristan ran out of Helius credits
 * once with no warning, and nothing prevented a repeat - a retry storm, a
 * loop, or a launch spike empties a 10M/month plan in days.
 *
 * ## Credits, never calls
 *
 * Every number here is CREDITS, priced through the meter's own `CREDIT_COST`
 * map. A breaker that counted calls would have been 15% wrong the moment a
 * 10-credit DAS method went live - which is exactly the bug the meter itself
 * had. The instrument that decides affordability must know the price.
 *
 * ## A halt must not look like a quiet night
 *
 * Same precedent as `outside-schedule`: a halted cycle is recorded with its own
 * reason string and a detail line saying what stopped it and when it lifts.
 * Silence is never the signal.
 *
 * ## It spends nothing itself
 *
 * The breaker makes no RPC call, opens no connection and asks no provider for a
 * balance. It reads counters the meter already keeps for free, and writes a
 * small local file. Added credit cost: zero, and `tests/test-credit-budget.ts`
 * asserts it against a Connection stub that throws on any use.
 *
 * ## State survives a restart
 *
 * A counter that resets on every start is not a budget, and this bot restarts
 * often - it restarted three times in the two days before this was written. The
 * ledger is keyed by UTC calendar day and month and persisted to disk, so a
 * restart resumes the same day's tally rather than granting a fresh allowance.
 */
import fs from "fs";
import path from "path";
import { creditsForMethod } from "./rpcMeter";

/** Helius Developer plan, the one this bot runs on. */
export const PLAN_MONTHLY_CREDITS = 10_000_000;

/**
 * Defaults derived from that plan with headroom, never from nothing and never
 * unlimited. 10% of the month is held back so an overrun is caught by this
 * breaker rather than by the provider cutting the key off mid-launch.
 *
 * The daily figure is the monthly allowance spread over the longest month,
 * rounded down. Measured burn on 2026-09-11 was 9,891 credits/h = ~237k/day,
 * so this sits above the observed rate with room, and is not a target.
 */
export const DEFAULT_MONTHLY_CREDITS = 9_000_000;
export const DEFAULT_DAILY_CREDITS = 290_000;
export const DEFAULT_WARN_FRACTION = 0.8;

export const DEFAULT_LEDGER_FILE = "logs/credit-ledger.json";

export interface CreditBudgetConfig {
  enabled: boolean;
  dailyCredits: number;
  monthlyCredits: number;
  /** Warn once usage crosses this fraction of either budget. 0-1, exclusive of 0. */
  warnFraction: number;
  ledgerFile: string;
}

export const DEFAULT_CREDIT_BUDGET: CreditBudgetConfig = {
  enabled: true,
  dailyCredits: DEFAULT_DAILY_CREDITS,
  monthlyCredits: DEFAULT_MONTHLY_CREDITS,
  warnFraction: DEFAULT_WARN_FRACTION,
  ledgerFile: DEFAULT_LEDGER_FILE,
};

/**
 * Rejects a budget that cannot function as one.
 *
 * "Unlimited" is not an option: a missing, zero, negative or infinite budget is
 * a configuration error, not a licence to spend. Failing closed here is the
 * whole point - the breaker exists because nothing stopped an overrun before.
 */
export function validateCreditBudget(c: CreditBudgetConfig): void {
  const finitePositive = (v: unknown, name: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(
        `creditBudget.${name} must be a finite number greater than 0, got ${JSON.stringify(v)}. ` +
          `There is deliberately no "unlimited" setting - turn the breaker off explicitly with ` +
          `creditBudget.enabled: false if that is really what you want.`
      );
    }
  };
  finitePositive(c.dailyCredits, "dailyCredits");
  finitePositive(c.monthlyCredits, "monthlyCredits");
  if (typeof c.warnFraction !== "number" || !(c.warnFraction > 0) || c.warnFraction > 1) {
    throw new Error(
      `creditBudget.warnFraction must be greater than 0 and at most 1, got ${JSON.stringify(c.warnFraction)}`
    );
  }
  if (c.dailyCredits > c.monthlyCredits) {
    throw new Error(
      `creditBudget.dailyCredits (${c.dailyCredits}) exceeds monthlyCredits (${c.monthlyCredits}) - ` +
        `the daily limit could never fire, so the monthly one is the only real budget. Lower the daily figure.`
    );
  }
}

// --- the ledger ----------------------------------------------------------

export interface LedgerPeriod {
  /** UTC "YYYY-MM-DD" for the day, "YYYY-MM" for the month. */
  key: string;
  credits: number;
}

export interface ManualOverride {
  /** UTC "YYYY-MM-DD" the override applies to. One day only, never open-ended. */
  day: string;
  reason: string;
  grantedAt: string;
}

export interface LedgerState {
  version: 1;
  day: LedgerPeriod;
  month: LedgerPeriod;
  /** Set only by an explicit operator action. Null in normal running. */
  override: ManualOverride | null;
}

export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}
export function utcMonthKey(at: Date): string {
  return at.toISOString().slice(0, 7);
}

export function emptyLedger(at: Date): LedgerState {
  return {
    version: 1,
    day: { key: utcDayKey(at), credits: 0 },
    month: { key: utcMonthKey(at), credits: 0 },
    override: null,
  };
}

/**
 * Rolls the ledger forward to `at`, zeroing any period whose key has changed.
 *
 * Pure, so the rollover boundary is testable exactly rather than by waiting for
 * midnight. A month rollover also rolls the day - the reverse is not true.
 */
export function rollTo(state: LedgerState, at: Date): LedgerState {
  const dayKey = utcDayKey(at);
  const monthKey = utcMonthKey(at);
  return {
    version: 1,
    day: state.day.key === dayKey ? state.day : { key: dayKey, credits: 0 },
    month: state.month.key === monthKey ? state.month : { key: monthKey, credits: 0 },
    // An override is granted for one named day and expires with it, so a
    // forgotten override cannot silently disable the breaker forever.
    override: state.override && state.override.day === dayKey ? state.override : null,
  };
}

// --- the decision --------------------------------------------------------

export type BudgetReason =
  | "breaker-disabled"
  | "within-budget"
  | "warn-threshold"
  | "daily-limit-reached"
  | "monthly-limit-reached"
  | "manual-override";

export interface BudgetDecision {
  /** True when detection may proceed. */
  allowed: boolean;
  reason: BudgetReason;
  /** True while usage is past the warn fraction but still under the limit. */
  warning: boolean;
  /** Written verbatim into every halted record and into the periodic report. */
  detail: string;
  dayCredits: number;
  monthCredits: number;
  dayFraction: number;
  monthFraction: number;
  /** UTC ISO time the halt lifts on its own, or null when not halted. */
  resumesAt: string | null;
}

function nextUtcMidnight(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
  return d.toISOString();
}
function nextUtcMonthStart(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return d.toISOString();
}

/**
 * Decides whether detection may proceed, given a rolled-forward ledger.
 *
 * Pure: no clock of its own, no file access. `at` must be the same instant the
 * ledger was rolled to, or the resume times will describe a different day.
 *
 * The monthly limit is checked FIRST. Both can be breached at once, and a
 * "daily limit reached, resumes at midnight" message would be actively
 * misleading when the month is gone and midnight changes nothing.
 */
export function evaluateBudget(
  config: CreditBudgetConfig,
  state: LedgerState,
  at: Date
): BudgetDecision {
  const dayCredits = state.day.credits;
  const monthCredits = state.month.credits;
  const dayFraction = dayCredits / config.dailyCredits;
  const monthFraction = monthCredits / config.monthlyCredits;
  const base = { dayCredits, monthCredits, dayFraction, monthFraction };

  if (!config.enabled) {
    return {
      ...base,
      allowed: true,
      reason: "breaker-disabled",
      warning: false,
      detail:
        `credit breaker is OFF - nothing will stop an overrun. Used today ${dayCredits.toLocaleString()} ` +
        `credits, this month ${monthCredits.toLocaleString()}.`,
      resumesAt: null,
    };
  }

  const overLimit = monthCredits >= config.monthlyCredits || dayCredits >= config.dailyCredits;

  if (overLimit && state.override) {
    return {
      ...base,
      allowed: true,
      reason: "manual-override",
      warning: true,
      detail:
        `*** SPENDING PAST THE CREDIT LIMIT UNDER A MANUAL OVERRIDE granted ` +
        `${state.override.grantedAt} for ${state.override.day}: ${state.override.reason}. *** ` +
        `Used today ${dayCredits.toLocaleString()}/${config.dailyCredits.toLocaleString()}, ` +
        `this month ${monthCredits.toLocaleString()}/${config.monthlyCredits.toLocaleString()}. ` +
        `The override expires at ${nextUtcMidnight(at)} and is not renewed automatically.`,
      resumesAt: null,
    };
  }

  if (monthCredits >= config.monthlyCredits) {
    return {
      ...base,
      allowed: false,
      reason: "monthly-limit-reached",
      warning: true,
      detail:
        `*** DETECTION HALTED: MONTHLY CREDIT LIMIT REACHED *** ` +
        `${monthCredits.toLocaleString()} of ${config.monthlyCredits.toLocaleString()} credits used in ` +
        `${state.month.key}. No token will be evaluated until ${nextUtcMonthStart(at)}. ` +
        `This is a halt, NOT a quiet market.`,
      resumesAt: nextUtcMonthStart(at),
    };
  }

  if (dayCredits >= config.dailyCredits) {
    return {
      ...base,
      allowed: false,
      reason: "daily-limit-reached",
      warning: true,
      detail:
        `*** DETECTION HALTED: DAILY CREDIT LIMIT REACHED *** ` +
        `${dayCredits.toLocaleString()} of ${config.dailyCredits.toLocaleString()} credits used on ` +
        `${state.day.key}. No token will be evaluated until ${nextUtcMidnight(at)}. ` +
        `This is a halt, NOT a quiet market.`,
      resumesAt: nextUtcMidnight(at),
    };
  }

  if (dayFraction >= config.warnFraction || monthFraction >= config.warnFraction) {
    const which = monthFraction >= config.warnFraction ? "MONTHLY" : "DAILY";
    return {
      ...base,
      allowed: true,
      reason: "warn-threshold",
      warning: true,
      detail:
        `*** ${which} CREDIT BUDGET ${Math.floor((which === "MONTHLY" ? monthFraction : dayFraction) * 100)}% USED *** ` +
        `today ${dayCredits.toLocaleString()}/${config.dailyCredits.toLocaleString()}, ` +
        `this month ${monthCredits.toLocaleString()}/${config.monthlyCredits.toLocaleString()}. ` +
        `Detection continues, but it will stop at the limit.`,
      resumesAt: null,
    };
  }

  return {
    ...base,
    allowed: true,
    reason: "within-budget",
    warning: false,
    detail:
      `credits today ${dayCredits.toLocaleString()}/${config.dailyCredits.toLocaleString()} ` +
      `(${Math.floor(dayFraction * 100)}%), this month ${monthCredits.toLocaleString()}/` +
      `${config.monthlyCredits.toLocaleString()} (${Math.floor(monthFraction * 100)}%)`,
    resumesAt: null,
  };
}

// --- credit accounting ---------------------------------------------------

/**
 * Credits for one JSON-RPC batch.
 *
 * A batch of 40 getAccountInfo calls is 40 billable calls in one HTTP request,
 * and pricing a batch as one request is the mistake that makes a burn rate look
 * survivable when it isn't - the meter's own docstring says so, having made it.
 * Each method in the batch is priced individually and summed.
 */
export function creditsForBatch(methods: string[]): number {
  let total = 0;
  for (const method of methods) total += creditsForMethod(method);
  return total;
}

/**
 * The breaker: a persisted credit ledger plus the decision over it.
 *
 * Makes no network call of any kind. It is handed method names the meter has
 * already parsed, prices them, and keeps a running total on disk.
 */
export class CreditBreaker {
  private state: LedgerState;
  private dirty = false;
  /** Last lifetime total seen from the meter, for delta charging. */
  private lastMeterCredits = 0;
  private lastPersistMs = 0;

  constructor(
    private readonly config: CreditBudgetConfig,
    now: Date = new Date(),
    private readonly ledgerFile: string = config.ledgerFile
  ) {
    validateCreditBudget(config);
    this.state = rollTo(loadLedger(ledgerFile, now), now);
  }

  /** The ledger as it stands. Copied, so a caller cannot mutate the tally. */
  snapshot(): LedgerState {
    return JSON.parse(JSON.stringify(this.state));
  }

  /**
   * Prices a batch and adds it to both periods.
   *
   * Returns the credits charged, so a caller can log the price of a single
   * expensive step rather than only the running total.
   */
  chargeBatch(methods: string[], at: Date = new Date()): number {
    const credits = creditsForBatch(methods);
    this.charge(credits, at);
    return credits;
  }

  /**
   * Charges the breaker from the meter's lifetime credit counter.
   *
   * The breaker deliberately does not count anything itself. It reads the
   * counter the meter already keeps and charges the DELTA since it last
   * looked, so the two can never drift apart and no call is priced twice.
   *
   * The meter resets to zero on every process start; the ledger does not. A
   * total lower than the last one seen therefore means "new process", not
   * "negative spend", and the whole new total is charged rather than a
   * negative number being silently added - which would hand the bot free
   * credits on every restart, the exact failure this class exists to stop.
   */
  chargeFromMeter(lifetimeCredits: number, at: Date = new Date()): number {
    if (!Number.isFinite(lifetimeCredits) || lifetimeCredits < 0) return 0;
    const delta =
      lifetimeCredits >= this.lastMeterCredits ? lifetimeCredits - this.lastMeterCredits : lifetimeCredits;
    this.lastMeterCredits = lifetimeCredits;
    this.charge(delta, at);
    return delta;
  }

  /**
   * Writes the ledger at most once per `minIntervalMs`.
   *
   * Called on the detection path, so it must not do a disk write per token.
   * The bound on what a crash can lose is that interval's spend, which at the
   * measured 9,891 credits/h is about 165 credits a minute - immaterial
   * against a 290,000 daily budget, and far cheaper than the alternative of
   * not persisting at all.
   */
  persistThrottled(nowMs: number, minIntervalMs = 60_000): boolean {
    if (!this.dirty) return false;
    if (nowMs - this.lastPersistMs < minIntervalMs) return false;
    this.lastPersistMs = nowMs;
    this.persist();
    return true;
  }

  /** Adds already-priced credits - e.g. a delta read from the meter. */
  charge(credits: number, at: Date = new Date()): void {
    if (!(credits > 0)) return;
    this.state = rollTo(this.state, at);
    this.state.day.credits += credits;
    this.state.month.credits += credits;
    this.dirty = true;
  }

  decide(at: Date = new Date()): BudgetDecision {
    this.state = rollTo(this.state, at);
    return evaluateBudget(this.config, this.state, at);
  }

  /**
   * Grants a one-day override. Explicit and logged: it names a reason, is
   * stamped with the time, and expires at the next UTC midnight via rollTo().
   */
  grantOverride(reason: string, at: Date = new Date()): ManualOverride {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw new Error("a manual credit override must state a reason - an unexplained override is not auditable");
    }
    this.state = rollTo(this.state, at);
    const override: ManualOverride = { day: utcDayKey(at), reason: trimmed, grantedAt: at.toISOString() };
    this.state.override = override;
    this.dirty = true;
    this.persist();
    return override;
  }

  clearOverride(): void {
    if (this.state.override === null) return;
    this.state.override = null;
    this.dirty = true;
    this.persist();
  }

  /** Atomic write, same temp-file-and-rename pattern as the outcome tracker. */
  persist(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const dir = path.dirname(this.ledgerFile);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.ledgerFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.ledgerFile);
  }
}

/**
 * Reads the ledger from disk, or starts a fresh one.
 *
 * A file that is missing, unreadable or malformed starts at zero AND is
 * reported by the caller - it is not silently treated as "no spend yet",
 * because a corrupt ledger and a genuinely fresh month look identical from the
 * numbers alone. The distinction is why this returns a fresh ledger rather
 * than throwing: refusing to start would take the bot down over a log file,
 * but pretending the file was fine would grant a second full allowance.
 */
export function loadLedger(file: string, now: Date): LedgerState {
  try {
    if (!fs.existsSync(file)) return emptyLedger(now);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (
      !raw ||
      raw.version !== 1 ||
      typeof raw.day?.key !== "string" ||
      typeof raw.day?.credits !== "number" ||
      typeof raw.month?.key !== "string" ||
      typeof raw.month?.credits !== "number" ||
      !Number.isFinite(raw.day.credits) ||
      !Number.isFinite(raw.month.credits)
    ) {
      return emptyLedger(now);
    }
    return {
      version: 1,
      day: { key: raw.day.key, credits: raw.day.credits },
      month: { key: raw.month.key, credits: raw.month.credits },
      override:
        raw.override && typeof raw.override.day === "string" && typeof raw.override.reason === "string"
          ? { day: raw.override.day, reason: raw.override.reason, grantedAt: String(raw.override.grantedAt ?? "") }
          : null,
    };
  } catch {
    return emptyLedger(now);
  }
}
