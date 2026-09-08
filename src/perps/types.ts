export type PerpDirection = "long" | "short";

/**
 * A requested perp trade, before any risk checks or execution. This is the
 * shape any future strategy (manual trigger, indicator-based, copy-trading -
 * none of which exist yet, see README) would build and hand to openPerpPosition().
 */
export interface PerpOrderRequest {
  /** Market symbol, e.g. "SOL-PERP". Must be in config.perps.allowedMarkets. */
  market: string;
  direction: PerpDirection;
  /** Position notional size in USD (before leverage - this is the exposure size, not your margin). */
  notionalUsd: number;
  leverage: number;
  /** % below (long) or above (short) entry to stop out at. Negative number, e.g. -10 for -10%. */
  stopLossPercent?: number;
  /** % above (long) or below (short) entry to take profit at. Positive number, e.g. 20 for +20%. */
  takeProfitPercent?: number;
  reduceOnly?: boolean;
}

export interface RiskCheckResult {
  allowed: boolean;
  /** Every failed check, same PASS/SKIP-with-reasons philosophy as the spot filter engine (src/filters/engine.ts). */
  reasons: string[];
}

export interface AccountSnapshot {
  subAccountId: number;
  totalCollateralUsd: number;
  freeCollateralUsd: number;
  /** Account-wide leverage as reported by Drift's own health calculation (not an estimate). */
  leverage: number;
  /** 0-100, Drift's own margin health score. 0 = about to be liquidated. */
  healthPercent: number;
  unrealizedPnlUsd: number;
  openPositions: OpenPerpPosition[];
}

export interface OpenPerpPosition {
  market: string;
  marketIndex: number;
  direction: PerpDirection;
  baseSize: number;
  notionalUsd: number;
  entryPrice: number;
  unrealizedPnlUsd: number;
  /**
   * Lifetime fees AND funding for this position, in USD, from Drift's own
   * calculateFeesAndFundingPnl() (settled + unsettled). This is what lets a
   * funding-arb result be judged: unrealizedPnlUsd blends price movement with
   * funding, whereas this isolates the carry side of the trade.
   *
   * It is fees AND funding combined, not funding alone - Drift derives it from
   * quoteBreakEvenAmount - quoteEntryAmount, which nets trading fees in. For a
   * funding-arb position that is the honest number to judge anyway, since the
   * cost gate exists precisely to check funding beats fees.
   *
   * null means "couldn't read it" (e.g. the market account was unavailable),
   * never "it was zero" - the same null-vs-false rule used everywhere else.
   */
  feesAndFundingUsd: number | null;
  /** The not-yet-settled slice of the above, so settled-only can be derived by subtraction. Null when unreadable. */
  unsettledFundingUsd: number | null;
}
