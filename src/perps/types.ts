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
}
