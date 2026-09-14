/**
 * Paper execution: record what a position WOULD have done, and track it to close.
 *
 * ## Why this exists
 *
 * OPIUMO has never bought anything, not even on paper. So position tracking,
 * the trailing stop, and every exit path have never run on a real token, and
 * the 0% filter pass rate is unreadable because nothing downstream of the
 * filters has ever executed. This runs all of it, on records.
 *
 * ## A paper position is a RECORD. There is no order path here.
 *
 * No wallet, no Keypair, no signing, no transaction building, no swap client,
 * no Jupiter, no connection. This module imports none of them and cannot reach
 * them. `tests/test-paper-execution.ts` greps the source and fails if any
 * appears, and that test is mutation-checked.
 *
 * `trading.enabled` is irrelevant here because there is nothing to enable -
 * which is a stronger guarantee than a flag.
 *
 * ## Entry uses REALIZABLE PROCEEDS, not the headline price
 *
 * A paper fill at the pool's headline value would manufacture profits that
 * could not exist: on a thin pool your own buy moves the price against you, and
 * your own sell moves it again on the way out. Entry and every subsequent
 * valuation go through the same `ProceedsFn` the trailing stop uses, so the
 * paper record and the backtest agree by construction.
 *
 * ## Zero added RPC calls
 *
 * Entry consumes `liquiditySol` the live metrics path already fetched. Tracking
 * consumes liquidity observations the watchlist already reads. This module
 * makes no calls of its own - it is fed.
 */
import {
  Position,
  PoolObservation,
  TrailingStopConfig,
  ProceedsFn,
  TrailState,
  initState,
  step,
} from "./trailingStop";
import { RaisedTakeProfitConfig, RaisedState, initRaisedState, stepRaised } from "./raisedExit";
import { DrawdownConfig, DrawdownState, DrawdownDecision, applyRealised, evaluateDrawdown, markHalted, emptyState } from "../risk/drawdownGuard";

/** What the LIVE filters decided. Recorded so paper results can be split by it. */
export type LiveVerdict = "PASS" | "REJECTED";

export interface PaperConfig {
  /** Fraction of the pool a paper position represents. Drives slippage. */
  poolFraction: number;
  /** Hard ceiling on simultaneously open paper positions. */
  maxOpenPositions: number;
  /** Open paper positions for tokens the live filters REJECTED, not just PASSes. */
  includeRejected: boolean;
  trailing: TrailingStopConfig;
  /**
   * APPROVALS 43 (decided (a), 2026-09-12): positions on the listed venues exit
   * on "raised-stop OR take-profit" instead of the trailing value stop. Omitted
   * or disabled = every position keeps the trailing stop, as before.
   */
  raisedTakeProfit?: (RaisedTakeProfitConfig & { enabled: boolean }) | null;
  /**
   * The drawdown kill switch. Omitted or `enabled: false` = no halt, which is
   * exactly how it behaved before this was wired.
   *
   * ## Why this appeared here on 2026-09-13
   *
   * An audit asked, of every component, "has this ever actually run?" and found
   * that `src/risk/drawdownGuard.ts` - 172 lines of loss-limit logic, copied
   * verbatim into three repos - was imported by NOTHING except its own test.
   * All three bots record positions; not one of them called the guard that is
   * meant to stop them. A kill switch nothing is wired to is not a safety net,
   * it is a document about one, and it passed every test in that state.
   *
   * It is wired here and defaulted OFF, so nothing about tonight's run changes.
   * Switching it on is a config change and Tristan's decision (APPROVALS).
   */
  drawdown?: (DrawdownConfig & { state?: DrawdownState }) | null;
}

export type ExitRuleName = "trailing" | "raised-stop-or-take-profit";

/**
 * Pricing per position (NIGHT-PROMPT-V5 Project 2, APPROVALS 37). The book
 * used to price every venue with constant product on the pool's REAL SOL;
 * Pump.fun is a bonding curve on VIRTUAL reserves (real + 30 SOL), which puts a
 * floor under every drain. The factory receives what the position knows at
 * entry and returns the ProceedsFn every later valuation uses. A plain
 * ProceedsFn is still accepted: one model for every venue, as before.
 */
export type PricingFactory = ((p: { venue: string | null; entryLiquiditySol: number; poolFraction: number }) => { fn: ProceedsFn; model: string }) & { readonly isPricingFactory: true };

/** Brand a per-position pricing function so the book can tell it from a plain ProceedsFn (arity is not reliable: `unsellable` takes no arguments). */
export function pricingFactory(f: (p: { venue: string | null; entryLiquiditySol: number; poolFraction: number }) => { fn: ProceedsFn; model: string }): PricingFactory {
  return Object.assign(f, { isPricingFactory: true as const });
}

export type PaperOutcome =
  | "open"
  | "closed"
  | "exit-failed"
  /** Observations stopped before any exit fired - the watchlist evicted the token. */
  | "abandoned";

export interface PaperPosition {
  mint: string;
  openedAt: string;
  liveVerdict: LiveVerdict;
  /** Where the token launched ("pumpfun" | "raydium"), or null when the caller did not say. */
  venue: string | null;
  /** Which pricing model values this position - recorded so a P&L figure can never be read without its model. */
  pricingModel: string;
  /** Which exit rule this position is under - recorded on every row so a close can never be read without knowing what closed it. */
  exitRule: ExitRuleName;
  entryLiquiditySol: number;
  /** Realizable proceeds at entry. Every percentage is measured against this. */
  entryProceedsSol: number;
  poolFraction: number;
  outcome: PaperOutcome;
  observations: number;
  /** Set once closed. */
  closedAt: string | null;
  exitProceedsSol: number | null;
  exitReason: string | null;
  peakProceedsSol: number;
  lastProceedsSol: number | null;
  /** Timestamp of the most recent observation, or null when none has arrived since entry (or restore). */
  lastObservedAt?: string | null;
  /** Set only when the position was closed by `expire`, not by its exit rule. */
  forcedExit?: ForcedExitRecord;
  state: TrailState;
  /** Present only under the raised-stop-or-take-profit rule. */
  raisedState?: RaisedState;
  /**
   * Set only on a position rebuilt from the log after a restart. Says what the
   * restore could NOT carry over, so a restored row is never mistaken for one
   * that was tracked continuously.
   */
  restored?: { at: string; note: string };
}

/**
 * The `paper-open` row as written to the log. Built here rather than inline in
 * the pipeline so the writer and `PaperBook.restore` share one shape.
 */
export interface PaperOpenRow {
  mint: string;
  openedAt: string;
  liveVerdict: LiveVerdict;
  /** Absent on rows written before APPROVALS 37. */
  venue?: string | null;
  pricingModel?: string | null;
  /** Absent on rows written before the restore existed. */
  exitRule?: ExitRuleName;
  entryLiquiditySol: number;
  entryProceedsSol: number;
  poolFraction: number;
}

export function paperOpenRow(p: PaperPosition, openNow: number): Record<string, unknown> {
  return {
    event: "paper-open", mint: p.mint, openedAt: p.openedAt, liveVerdict: p.liveVerdict, venue: p.venue ?? null,
    pricingModel: p.pricingModel ?? null, exitRule: p.exitRule, entryLiquiditySol: p.entryLiquiditySol,
    entryProceedsSol: p.entryProceedsSol, poolFraction: p.poolFraction, openNow,
  };
}

/**
 * Opens minus closes, in log order. Any `paper-close` row (closed, exit-failed
 * or abandoned) ends a position; the last `paper-open` for a mint wins.
 */
export function openRowsFromLog(rows: Record<string, unknown>[]): PaperOpenRow[] {
  const open = new Map<string, PaperOpenRow>();
  for (const r of rows) {
    if (typeof r.mint !== "string") continue;
    if (r.event === "paper-open") open.set(r.mint, r as unknown as PaperOpenRow);
    else if (r.event === "paper-close") open.delete(r.mint);
  }
  return [...open.values()];
}

/**
 * Closes positions the exit rule can no longer reach. Positions only ever close
 * from an observation, so a token the watchlist stops reading - evicted, aged
 * out, or simply not re-added after a restart - would otherwise stay open
 * forever. Both limits are in config (paperExecution.forcedExit).
 */
export interface ForcedExitConfig {
  enabled: boolean;
  /** Close any position held at least this long, however recently it was observed. */
  maxHoldMs: number;
  /** Close a position with no observation for this long (measured from entry when there has been none). */
  staleObservationMs: number;
}

export type ForcedExitRule = "stale-observation" | "max-hold";

export interface ForcedExitRecord {
  rule: ForcedExitRule;
  heldMs: number;
  /** Time since the last observation, or since entry when there was none. */
  silentMs: number;
  /** Where exitProceedsSol came from. Null exit = no reading ever, so there is no price to close at. */
  priceSource: string;
}

export interface RestoreResult {
  restored: number;
  skipped: { mint: string; reason: string }[];
  /** Rows without an exitRule, whose rule was re-derived from the CURRENT config. */
  exitRuleInferred: number;
  /** Restored positions given a last observation from the supplied readings. */
  lastObservationSeeded: number;
}

export interface OpenRefusal {
  mint: string;
  reason: string;
}

/**
 * Holds paper positions and feeds them observations.
 *
 * Deliberately not a singleton and not wired to a clock: the caller supplies
 * every timestamp, so a whole session can be replayed from logs deterministically.
 */
export class PaperBook {
  private readonly positions = new Map<string, PaperPosition>();
  private readonly closed: PaperPosition[] = [];
  private readonly refusals: OpenRefusal[] = [];
  /** The ProceedsFn each open position is valued with. Functions are not serialisable, so they live here, not on the position. */
  private readonly pricing = new Map<string, ProceedsFn>();
  private readonly factory: PricingFactory;
  /** Null when the guard is absent or disabled. */
  private drawdown: DrawdownState | null = null;
  private lastDrawdownDecision: DrawdownDecision | null = null;

  constructor(
    config: PaperConfig,
    proceeds: ProceedsFn | PricingFactory
  ) {
    this.config = config;
    this.factory = (proceeds as Partial<PricingFactory>).isPricingFactory === true
      ? (proceeds as PricingFactory)
      : pricingFactory(() => ({ fn: proceeds as ProceedsFn, model: "single model for every venue" }));
    if (config.drawdown?.enabled) {
      // The state is SUPPLIED by the caller, loaded from disk. A guard that
      // starts fresh on every construction is one a restart clears, which is
      // the failure the guard module's own header calls out.
      this.drawdown = config.drawdown.state ?? emptyState(new Date());
    }
  }

  /** The halt state, so the caller can persist it. Null when the guard is off. */
  get drawdownState(): DrawdownState | null { return this.drawdown; }
  /** The most recent verdict, for logging. Null until a close has been recorded. */
  get drawdownDecision(): DrawdownDecision | null { return this.lastDrawdownDecision; }
  private readonly config: PaperConfig;

  get openCount(): number {
    return this.positions.size;
  }

  /**
   * Opens a paper position, or refuses with a reason.
   *
   * Every refusal is RECORDED rather than applied silently - a cap that
   * quietly drops candidates would bias the sample toward whatever arrived
   * when the book happened to be empty, which is the same survivorship problem
   * the outcome tracker exists to avoid.
   */
  open(params: {
    mint: string;
    at: string;
    liquiditySol: number | null;
    liveVerdict: LiveVerdict;
    /** "pumpfun" | "raydium" from the detection event. Omitted = unknown venue, priced with the fallback model. */
    source?: string | null;
  }): { opened: PaperPosition | null; refusal: OpenRefusal | null } {
    const refuse = (reason: string) => {
      const r = { mint: params.mint, reason };
      this.refusals.push(r);
      return { opened: null, refusal: r };
    };

    // The halt is checked FIRST, before any other refusal reason. A halted book
    // must not open a position for any reason, and the reason string is
    // distinct so a halt never reads like a slow night.
    if (this.drawdown && this.config.drawdown?.enabled) {
      const d = evaluateDrawdown(this.drawdown, this.config.drawdown, new Date(params.at));
      if (d.halted) return refuse(`DRAWDOWN HALT - ${d.detail}`);
    }

    if (params.liveVerdict === "REJECTED" && !this.config.includeRejected) {
      return refuse("live filters rejected it and includeRejected is false");
    }
    if (this.positions.has(params.mint)) {
      return refuse("a paper position is already open for this mint");
    }
    if (this.positions.size >= this.config.maxOpenPositions) {
      return refuse(
        `paper position cap reached (${this.config.maxOpenPositions} open) - not opened, and this ` +
          `refusal is recorded so the cap is visible in the report rather than silently biasing it`
      );
    }
    if (params.liquiditySol === null) {
      // Unknown liquidity is not zero liquidity. Refuse rather than invent a fill.
      return refuse("liquiditySol is null - could not be read, so no entry price can be established");
    }
    const venue = params.source ?? null;
    const priced = this.factory({ venue, entryLiquiditySol: params.liquiditySol, poolFraction: this.config.poolFraction });
    const entryProceeds = priced.fn(params.liquiditySol, this.config.poolFraction);
    if (entryProceeds === null || !(entryProceeds > 0)) {
      return refuse(`position of ${this.config.poolFraction} of the pool realises nothing at entry - unsellable (${priced.model})`);
    }

    const exitRule = this.exitRuleFor(venue);
    const position: PaperPosition = {
      mint: params.mint,
      openedAt: params.at,
      liveVerdict: params.liveVerdict,
      venue,
      pricingModel: priced.model,
      exitRule,
      entryLiquiditySol: params.liquiditySol,
      entryProceedsSol: entryProceeds,
      poolFraction: this.config.poolFraction,
      outcome: "open",
      observations: 0,
      closedAt: null,
      exitProceedsSol: null,
      exitReason: null,
      peakProceedsSol: entryProceeds,
      lastProceedsSol: entryProceeds,
      lastObservedAt: null,
      state: initState({
        mint: params.mint,
        entryTs: params.at,
        poolFraction: this.config.poolFraction,
        entryProceedsSol: entryProceeds,
      } as Position),
    };
    if (exitRule === "raised-stop-or-take-profit") {
      position.raisedState = initRaisedState({ entryTs: params.at, entryLiquiditySol: params.liquiditySol, entryProceedsSol: entryProceeds });
    }
    this.positions.set(params.mint, position);
    this.pricing.set(params.mint, priced.fn);
    return { opened: position, refusal: null };
  }

  private exitRuleFor(venue: string | null): ExitRuleName {
    const rtp = this.config.raisedTakeProfit;
    return rtp && rtp.enabled && venue !== null && rtp.venues.includes(venue) ? "raised-stop-or-take-profit" : "trailing";
  }

  /**
   * Puts positions that were open when the process last stopped back into the
   * book. Without this every restart orphaned the whole open book: the rows
   * said "open" forever and nothing could ever close them.
   *
   * What comes back exactly: entry (the RECORDED entryProceedsSol, not a
   * re-price), venue, verdict, pool fraction, and the exit rule when the row
   * carries it. What does not: the peak, the last valuation and the
   * persistence counters, because observations are not logged - the stop
   * restarts from entry, and `restored.note` says so on the position.
   *
   * The open-position cap is NOT applied: these positions already exist, and
   * refusing one would orphan it again. The cap still refuses new opens.
   */
  restore(
    rows: PaperOpenRow[],
    at: string,
    /**
     * The last liquidity reading per mint from before the restart (the
     * watchlist logs them). Sets the last valuation so a later forced exit
     * closes at a real reading rather than at entry. The exit rule is NOT
     * stepped with it: one reading cannot satisfy a persistence count.
     */
    lastObservations?: Map<string, { ts: string; liquiditySol: number }>
  ): RestoreResult {
    const result: RestoreResult = { restored: 0, skipped: [], exitRuleInferred: 0, lastObservationSeeded: 0 };
    for (const r of rows) {
      const skip = (reason: string) => result.skipped.push({ mint: String(r.mint), reason });
      if (this.positions.has(r.mint)) { skip("already open in this book"); continue; }
      if (typeof r.openedAt !== "string" || Number.isNaN(Date.parse(r.openedAt))) { skip("openedAt missing or unparseable"); continue; }
      if (!(r.entryProceedsSol > 0) || !(r.entryLiquiditySol > 0) || !(r.poolFraction > 0)) {
        skip("entry values missing or not positive - no entry price to measure against");
        continue;
      }
      if (r.liveVerdict !== "PASS" && r.liveVerdict !== "REJECTED") { skip("liveVerdict missing"); continue; }
      const venue = r.venue ?? null;
      const priced = this.factory({ venue, entryLiquiditySol: r.entryLiquiditySol, poolFraction: r.poolFraction });
      const inferred = r.exitRule === undefined;
      const exitRule: ExitRuleName = r.exitRule ?? this.exitRuleFor(venue);
      if (inferred) result.exitRuleInferred++;
      const notes = ["restored from the log after a restart; peak, last valuation and stop counters restart from entry"];
      if (inferred) notes.push(`exit rule not on the row, re-derived from current config as ${exitRule}`);
      if (r.pricingModel && r.pricingModel !== priced.model) notes.push(`opened under "${r.pricingModel}", now valued with "${priced.model}"`);

      const position: PaperPosition = {
        mint: r.mint,
        openedAt: r.openedAt,
        liveVerdict: r.liveVerdict,
        venue,
        pricingModel: priced.model,
        exitRule,
        entryLiquiditySol: r.entryLiquiditySol,
        entryProceedsSol: r.entryProceedsSol,
        poolFraction: r.poolFraction,
        outcome: "open",
        observations: 0,
        closedAt: null,
        exitProceedsSol: null,
        exitReason: null,
        peakProceedsSol: r.entryProceedsSol,
        lastProceedsSol: r.entryProceedsSol,
        state: initState({ mint: r.mint, entryTs: r.openedAt, poolFraction: r.poolFraction, entryProceedsSol: r.entryProceedsSol } as Position),
        restored: { at, note: notes.join("; ") },
      };
      if (exitRule === "raised-stop-or-take-profit") {
        position.raisedState = initRaisedState({ entryTs: r.openedAt, entryLiquiditySol: r.entryLiquiditySol, entryProceedsSol: r.entryProceedsSol });
      }
      const seed = lastObservations?.get(r.mint);
      if (seed && Date.parse(seed.ts) >= Date.parse(r.openedAt)) {
        const v = priced.fn(seed.liquiditySol, r.poolFraction);
        position.lastObservedAt = seed.ts;
        position.lastProceedsSol = v;
        if (v !== null) position.peakProceedsSol = Math.max(position.peakProceedsSol, v);
        position.restored!.note += `; last valuation seeded from the reading at ${seed.ts} (${seed.liquiditySol} SOL in the pool)`;
        result.lastObservationSeeded++;
      } else {
        position.lastObservedAt = null;
      }
      this.positions.set(r.mint, position);
      this.pricing.set(r.mint, priced.fn);
      result.restored++;
    }
    return result;
  }

  /**
   * Closes every open position that has gone stale or reached the maximum hold,
   * at its last known proceeds. Stale is checked first: when both apply, the
   * position stopped being observed, which is the more useful thing to know.
   *
   * "Last known proceeds" means a REAL reading. A position that never received
   * one (only possible for a restored position with no logged reading, since an
   * opened one starts with its entry) closes with exitProceedsSol null: closing
   * it at entry would record a 0% trade that was never measured.
   */
  expire(now: string, cfg: ForcedExitConfig): PaperPosition[] {
    if (!cfg.enabled) return [];
    const nowMs = Date.parse(now);
    const out: PaperPosition[] = [];
    for (const p of [...this.positions.values()]) {
      const openedMs = Date.parse(p.openedAt);
      const heldMs = nowMs - openedMs;
      const lastMs = p.lastObservedAt ? Date.parse(p.lastObservedAt) : openedMs;
      const silentMs = nowMs - lastMs;
      let rule: ForcedExitRule;
      if (silentMs >= cfg.staleObservationMs) rule = "stale-observation";
      else if (heldMs >= cfg.maxHoldMs) rule = "max-hold";
      else continue;

      const neverRead = p.restored !== undefined && !p.lastObservedAt;
      const exit = neverRead ? null : p.lastProceedsSol;
      const priceSource = neverRead
        ? "none - restored with no logged reading, so there is no price to close at"
        : p.lastObservedAt
          ? `last observation at ${p.lastObservedAt}`
          : "entry valuation - no observation arrived after entry";
      const h = (ms: number) => `${(ms / 3_600_000).toFixed(1)}h`;
      const why = rule === "stale-observation"
        ? `stale-observation: no observation for ${h(silentMs)} (limit ${h(cfg.staleObservationMs)})`
        : `max-hold: held ${h(heldMs)} (limit ${h(cfg.maxHoldMs)})`;

      p.outcome = "closed";
      p.closedAt = now;
      p.exitProceedsSol = exit;
      p.exitReason = `${why} - the exit rule never fired; closed at ${priceSource}`;
      p.forcedExit = { rule, heldMs, silentMs, priceSource };
      this.positions.delete(p.mint);
      this.pricing.delete(p.mint);
      this.closed.push(p);
      if (exit !== null) this.applyToDrawdown(p, exit, now);
      out.push(p);
    }
    return out;
  }

  private applyToDrawdown(p: PaperPosition, exitProceedsSol: number, ts: string): void {
    if (!this.drawdown || !this.config.drawdown?.enabled) return;
    const at = new Date(ts);
    this.drawdown = applyRealised(this.drawdown, exitProceedsSol - p.entryProceedsSol, at);
    const d = evaluateDrawdown(this.drawdown, this.config.drawdown, at);
    this.lastDrawdownDecision = d;
    this.drawdown = markHalted(this.drawdown, d, at);
  }

  /**
   * Feeds one liquidity observation to an open position, if there is one.
   *
   * Called from the watchlist's observation hook, so it costs no RPC: the
   * reading has already been paid for.
   */
  observe(mint: string, obs: PoolObservation): PaperPosition | null {
    const p = this.positions.get(mint);
    if (!p) return null;

    p.observations++;
    p.lastObservedAt = obs.ts;
    const proceeds = this.pricing.get(mint)!;
    const realizable = proceeds(obs.liquiditySol, p.poolFraction);
    if (realizable !== null) {
      p.peakProceedsSol = Math.max(p.peakProceedsSol, realizable);
      p.lastProceedsSol = realizable;
    }

    let out: { decision: ReturnType<typeof step>["decision"] };
    if (p.exitRule === "raised-stop-or-take-profit" && p.raisedState && this.config.raisedTakeProfit) {
      const r = stepRaised(p.raisedState, obs, this.config.raisedTakeProfit, proceeds, p.poolFraction);
      p.raisedState = r.state;
      out = r;
    } else {
      const t = step(p.state, obs, this.config.trailing, proceeds, p.poolFraction);
      p.state = t.state;
      out = t;
    }

    if (out.decision.action === "EXIT") {
      p.outcome = "closed";
      p.closedAt = obs.ts;
      p.exitProceedsSol = out.decision.proceedsSol;
      p.exitReason = out.decision.reason;
      this.positions.delete(mint);
      this.pricing.delete(mint);
      this.closed.push(p);
      // Realised result feeds the guard. Only a close with a real exit price
      // counts - an exit-failed position has no realised number, and treating
      // its absence as a zero would make a broken exit look like a flat trade.
      if (p.exitProceedsSol !== null) this.applyToDrawdown(p, p.exitProceedsSol, obs.ts);
    } else if (out.decision.action === "EXIT_FAILED") {
      p.outcome = "exit-failed";
      p.closedAt = obs.ts;
      p.exitReason = out.decision.reason;
      this.positions.delete(mint);
      this.pricing.delete(mint);
      this.closed.push(p);
    }
    return p;
  }

  /**
   * Marks a position abandoned because observations stopped.
   *
   * Distinct from a close on purpose: the trailing stop never fired, so
   * counting it as an exit would put a made-up P&L in the record. The last
   * known valuation is kept, labelled as last-known.
   */
  abandon(mint: string, at: string, reason: string): PaperPosition | null {
    const p = this.positions.get(mint);
    if (!p) return null;
    p.outcome = "abandoned";
    p.closedAt = at;
    p.exitReason = `abandoned: ${reason} - the stop never fired, so this is NOT an exit and has no exit price`;
    this.positions.delete(mint);
    this.pricing.delete(mint);
    this.closed.push(p);
    return p;
  }

  openPositions(): PaperPosition[] {
    return [...this.positions.values()];
  }
  closedPositions(): PaperPosition[] {
    return [...this.closed];
  }
  refusalList(): OpenRefusal[] {
    return [...this.refusals];
  }
}

export interface PaperSummary {
  opened: number;
  open: number;
  closed: number;
  exitFailed: number;
  abandoned: number;
  refused: number;
  refusedByCap: number;
  /** Realised P&L in SOL, EXCLUDING exit-failed and abandoned - neither realised anything. */
  realisedPnlSol: number;
  byVerdict: Record<LiveVerdict, { closed: number; realisedPnlSol: number }>;
}

export function summarise(book: PaperBook): PaperSummary {
  const closed = book.closedPositions();
  const byVerdict: PaperSummary["byVerdict"] = {
    PASS: { closed: 0, realisedPnlSol: 0 },
    REJECTED: { closed: 0, realisedPnlSol: 0 },
  };
  let realised = 0;
  for (const p of closed) {
    if (p.outcome !== "closed" || p.exitProceedsSol === null) continue;
    const pnl = p.exitProceedsSol - p.entryProceedsSol;
    realised += pnl;
    byVerdict[p.liveVerdict].closed++;
    byVerdict[p.liveVerdict].realisedPnlSol += pnl;
  }
  const refusals = book.refusalList();
  return {
    opened: closed.length + book.openCount,
    open: book.openCount,
    closed: closed.filter((p) => p.outcome === "closed").length,
    exitFailed: closed.filter((p) => p.outcome === "exit-failed").length,
    abandoned: closed.filter((p) => p.outcome === "abandoned").length,
    refused: refusals.length,
    refusedByCap: refusals.filter((r) => r.reason.includes("cap reached")).length,
    realisedPnlSol: realised,
    byVerdict,
  };
}
