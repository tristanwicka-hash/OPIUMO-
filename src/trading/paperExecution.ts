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
  state: TrailState;
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

  constructor(
    private readonly config: PaperConfig,
    private readonly proceeds: ProceedsFn
  ) {}

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
  }): { opened: PaperPosition | null; refusal: OpenRefusal | null } {
    const refuse = (reason: string) => {
      const r = { mint: params.mint, reason };
      this.refusals.push(r);
      return { opened: null, refusal: r };
    };

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
    const entryProceeds = this.proceeds(params.liquiditySol, this.config.poolFraction);
    if (entryProceeds === null || !(entryProceeds > 0)) {
      return refuse(`position of ${this.config.poolFraction} of the pool realises nothing at entry - unsellable`);
    }

    const position: PaperPosition = {
      mint: params.mint,
      openedAt: params.at,
      liveVerdict: params.liveVerdict,
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
      state: initState({
        mint: params.mint,
        entryTs: params.at,
        poolFraction: this.config.poolFraction,
        entryProceedsSol: entryProceeds,
      } as Position),
    };
    this.positions.set(params.mint, position);
    return { opened: position, refusal: null };
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
    const realizable = this.proceeds(obs.liquiditySol, p.poolFraction);
    if (realizable !== null) {
      p.peakProceedsSol = Math.max(p.peakProceedsSol, realizable);
      p.lastProceedsSol = realizable;
    }

    const out = step(p.state, obs, this.config.trailing, this.proceeds, p.poolFraction);
    p.state = out.state;

    if (out.decision.action === "EXIT") {
      p.outcome = "closed";
      p.closedAt = obs.ts;
      p.exitProceedsSol = out.decision.proceedsSol;
      p.exitReason = out.decision.reason;
      this.positions.delete(mint);
      this.closed.push(p);
    } else if (out.decision.action === "EXIT_FAILED") {
      p.outcome = "exit-failed";
      p.closedAt = obs.ts;
      p.exitReason = out.decision.reason;
      this.positions.delete(mint);
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
