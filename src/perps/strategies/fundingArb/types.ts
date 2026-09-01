/** One observed funding settlement for a market - what the history store persists. */
export interface FundingSample {
  /** Unix ms when this sample was recorded. */
  observedAt: number;
  /** Unix seconds of the on-chain settlement this sample corresponds to (amm.lastFundingRateTs). */
  settlementTs: number;
  /** % per hour a SHORT position earns (positive) or pays (negative) at this settlement. */
  shortRateHourlyPercent: number;
}

export interface FundingSnapshot {
  marketIndex: number;
  /** % per hour a SHORT position earns (positive) or pays (negative) right now. */
  shortRateHourlyPercent: number;
  /** Unix seconds of the most recent on-chain settlement - compare across polls to detect a new one. */
  lastFundingRateTs: number;
  fundingPeriodSeconds: number;
  markPrice: number;
  oraclePrice: number;
  /** (markPrice - oraclePrice) / oraclePrice * 100. */
  basisPercent: number;
}

export interface PositionLegs {
  spotNotionalUsd: number;
  perpNotionalUsd: number;
  /** perpNotionalUsd - spotNotionalUsd. Positive = perp leg oversized relative to spot. */
  driftUsd: number;
  driftPercentOfSpot: number;
}

/**
 * No separate "am I flat or open" state is persisted - engine.ts derives it fresh from
 * Drift's own live position data every cycle (an open short in the target market = "open").
 * That's always ground-truth-correct after a restart, whereas a separately-tracked state
 * file could silently drift out of sync with what's actually on-chain.
 */
