/**
 * The drawdown kill switch: a hard loss limit that halts a bot and says so.
 *
 * Same shape as the credit breaker (src/rpc/creditBudget.ts), deliberately, so
 * there is one pattern for "this bot must stop" rather than two:
 *
 *  - **State survives a restart.** The limit is measured against a persisted
 *    ledger, not an in-memory counter. A bot that restarts after blowing the
 *    limit comes back halted, not fresh. A kill switch you can clear by
 *    restarting is not a kill switch.
 *  - **A halt has its own reason string**, distinct from every other reason a
 *    bot might be quiet. `drawdown-halt` never reads like a slow night.
 *  - **A manual override is written down**, is granted for ONE named UTC day,
 *    and expires with that day. A forgotten override cannot silently disable
 *    the switch forever.
 *
 * PURE: no clock, no filesystem, no config. The caller supplies `now`, loads
 * and saves the state, and decides what "halted" means for its own loop.
 *
 * ## This must exist before real money moves
 *
 * Everything in this vault is paper today. The point of building it now is
 * that the day something goes live is the worst possible day to be writing a
 * loss limit for the first time.
 */

export type DrawdownReason =
  | "ok"
  | "daily-loss-limit"
  | "total-loss-limit"
  | "peak-drawdown-limit"
  | "manual-override"
  | "already-halted";

export interface DrawdownConfig {
  enabled: boolean;
  /** Halt once the day's realised loss reaches this many units (positive number, same unit as the P&L fed in). */
  maxDailyLoss: number;
  /** Halt once cumulative realised loss since the ledger began reaches this. */
  maxTotalLoss: number;
  /** Halt once equity falls this far below its own high-water mark. */
  maxPeakDrawdown: number;
  /** What the numbers are denominated in, printed in every message so a SOL limit is never read as dollars. */
  unit: string;
}

export function validateDrawdownConfig(c: DrawdownConfig): string[] {
  const e: string[] = [];
  for (const k of ["maxDailyLoss", "maxTotalLoss", "maxPeakDrawdown"] as const) {
    if (!(typeof c[k] === "number" && c[k] > 0)) e.push(`drawdown.${k} must be a positive number (it is a LOSS limit, so state it positive)`);
  }
  if (!c.unit) e.push("drawdown.unit must say what the limits are denominated in");
  return e;
}

export interface DrawdownState {
  version: 1;
  /** UTC "YYYY-MM-DD" the daily figure belongs to. */
  day: string;
  /** Realised P&L today. Negative is a loss. */
  dayPnl: number;
  /** Realised P&L since this ledger began. */
  totalPnl: number;
  /** Highest totalPnl ever seen - the high-water mark peak drawdown is measured from. */
  peakPnl: number;
  /** Set once halted, and it STAYS set across restarts until a human clears it. */
  halted: null | { at: string; reason: DrawdownReason; detail: string };
  /** One named UTC day only. */
  override: null | { day: string; by: string; note: string; at: string };
  trades: number;
}

export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

export function emptyState(at: Date): DrawdownState {
  return { version: 1, day: utcDay(at), dayPnl: 0, totalPnl: 0, peakPnl: 0, halted: null, override: null, trades: 0 };
}

/** Roll the day over, and expire an override that belonged to a day that has ended. A HALT does not expire. */
export function rollTo(state: DrawdownState, at: Date): DrawdownState {
  const day = utcDay(at);
  if (state.day === day) return state;
  return {
    ...state,
    day,
    dayPnl: 0,
    // The override is granted for one day and dies with it. The halt is not:
    // a limit breach outlives midnight, because the money did not come back.
    override: state.override && state.override.day === day ? state.override : null,
  };
}

/** Record one realised result. Positive is a gain. */
export function applyRealised(state: DrawdownState, pnl: number, at: Date): DrawdownState {
  const rolled = rollTo(state, at);
  const totalPnl = Number((rolled.totalPnl + pnl).toFixed(10));
  return {
    ...rolled,
    dayPnl: Number((rolled.dayPnl + pnl).toFixed(10)),
    totalPnl,
    peakPnl: Math.max(rolled.peakPnl, totalPnl),
    trades: rolled.trades + 1,
  };
}

export interface DrawdownDecision {
  halted: boolean;
  reason: DrawdownReason;
  /** Written verbatim into the log and into every halted record. Loud on purpose. */
  detail: string;
  dayPnl: number;
  totalPnl: number;
  drawdownFromPeak: number;
}

/**
 * Should this bot be trading right now?
 *
 * Checked in a fixed order so the reason is stable: an existing halt first (it
 * survives restarts), then an override, then each limit.
 */
export function evaluateDrawdown(state: DrawdownState, config: DrawdownConfig, at: Date): DrawdownDecision {
  const s = rollTo(state, at);
  const drawdownFromPeak = Number((s.peakPnl - s.totalPnl).toFixed(10));
  const base = { dayPnl: s.dayPnl, totalPnl: s.totalPnl, drawdownFromPeak };

  if (!config.enabled) return { ...base, halted: false, reason: "ok", detail: "drawdown guard is disabled in config" };

  if (s.halted) {
    // An override lifts an EXISTING halt for its one day - that is the whole point of it.
    if (s.override && s.override.day === utcDay(at)) {
      return { ...base, halted: false, reason: "manual-override", detail: `HALTED (${s.halted.reason}) but manually overridden for ${s.override.day} by ${s.override.by}: ${s.override.note}. The halt returns tomorrow unless it is cleared.` };
    }
    return { ...base, halted: true, reason: "already-halted", detail: `STILL HALTED from ${s.halted.at}: ${s.halted.detail} - this survived a restart and only a human clears it` };
  }

  if (s.override && s.override.day === utcDay(at)) {
    return { ...base, halted: false, reason: "manual-override", detail: `limits suspended for ${s.override.day} by ${s.override.by}: ${s.override.note}` };
  }

  const loss = -s.dayPnl;
  if (loss >= config.maxDailyLoss) {
    return { ...base, halted: true, reason: "daily-loss-limit", detail: `DRAWDOWN HALT: lost ${loss.toFixed(4)} ${config.unit} today, limit is ${config.maxDailyLoss} ${config.unit} (${s.trades} trade(s))` };
  }
  const total = -s.totalPnl;
  if (total >= config.maxTotalLoss) {
    return { ...base, halted: true, reason: "total-loss-limit", detail: `DRAWDOWN HALT: lost ${total.toFixed(4)} ${config.unit} in total, limit is ${config.maxTotalLoss} ${config.unit} (${s.trades} trade(s))` };
  }
  if (drawdownFromPeak >= config.maxPeakDrawdown) {
    return { ...base, halted: true, reason: "peak-drawdown-limit", detail: `DRAWDOWN HALT: down ${drawdownFromPeak.toFixed(4)} ${config.unit} from a peak of ${s.peakPnl.toFixed(4)}, limit is ${config.maxPeakDrawdown} ${config.unit}` };
  }
  return { ...base, halted: false, reason: "ok", detail: `within limits: today ${s.dayPnl.toFixed(4)}, total ${s.totalPnl.toFixed(4)}, ${drawdownFromPeak.toFixed(4)} off peak (${config.unit})` };
}

/** Persist the halt onto the state so it survives a restart. Idempotent: an existing halt is never overwritten. */
export function markHalted(state: DrawdownState, decision: DrawdownDecision, at: Date): DrawdownState {
  if (!decision.halted || state.halted) return state;
  return { ...state, halted: { at: at.toISOString(), reason: decision.reason, detail: decision.detail } };
}

/** A human clears a halt. Attributable, and it does not silently reset the P&L that caused it. */
export function clearHalt(state: DrawdownState, by: string, note: string): DrawdownState {
  if (!by || !note) throw new Error("clearing a drawdown halt requires who cleared it and why - an anonymous clear is not a decision");
  return { ...state, halted: null };
}

/** Grant an override for ONE named UTC day. */
export function grantOverride(state: DrawdownState, day: string, by: string, note: string, at: Date): DrawdownState {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`override day must be YYYY-MM-DD, got "${day}"`);
  if (!by || !note) throw new Error("an override requires who granted it and why");
  return { ...state, override: { day, by, note, at: at.toISOString() } };
}
