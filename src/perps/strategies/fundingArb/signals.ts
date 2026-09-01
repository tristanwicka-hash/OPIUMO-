import { FundingArbConfig } from "../../../config";
import { FundingSample, PositionLegs } from "./types";

export interface SignalResult {
  decision: boolean;
  reasons: string[];
}

/**
 * Pure decision functions for the funding-arb strategy - same PASS/SKIP-
 * with-reasons philosophy as src/filters/engine.ts and src/perps/risk.ts.
 * Every function here takes plain data (no DriftClient, no network) so the
 * actual decision logic is fully offline-testable; src/perps/strategies/
 * fundingArb/engine.ts is the only place that talks to Drift and it just
 * feeds these functions live numbers.
 */

/** "N consecutive settlements above threshold, not a single spike." */
export function shouldEnter(samples: FundingSample[], config: FundingArbConfig): SignalResult {
  const reasons: string[] = [];
  const n = config.minConsecutiveSettlementsToEnter;

  if (samples.length < n) {
    reasons.push(`only ${samples.length} settlement(s) recorded, need ${n} before entry is even considered`);
    return { decision: false, reasons };
  }

  const lastN = samples.slice(-n);
  const belowThreshold = lastN.filter((s) => s.shortRateHourlyPercent < config.minFundingRateHourlyPercent);
  if (belowThreshold.length > 0) {
    reasons.push(
      `${belowThreshold.length}/${n} of the last ${n} settlements were below minFundingRateHourlyPercent ` +
        `(${config.minFundingRateHourlyPercent}%/hr) - funding hasn't been consistently attractive, could be a spike`
    );
    return { decision: false, reasons };
  }

  return { decision: true, reasons: [] };
}

/** Funding flipped (or dropped) for N consecutive settlements - time to give up the trade. */
export function shouldExitOnFundingFlip(samples: FundingSample[], config: FundingArbConfig): SignalResult {
  const n = config.minConsecutiveSettlementsToExit;
  if (samples.length < n) return { decision: false, reasons: [] };

  const lastN = samples.slice(-n);
  const stillGood = lastN.filter((s) => s.shortRateHourlyPercent >= config.minFundingRateHourlyPercent);
  if (stillGood.length === 0) {
    return {
      decision: true,
      reasons: [`funding rate has been below minFundingRateHourlyPercent for ${n} consecutive settlements - no longer worth holding`],
    };
  }
  return { decision: false, reasons: [] };
}

/** The perp trading at too big a premium/discount to spot means the "market-neutral" position isn't, really. */
export function shouldExitOnBasis(basisPercent: number, config: FundingArbConfig): SignalResult {
  if (Math.abs(basisPercent) > config.maxBasisPercent) {
    return {
      decision: true,
      reasons: [
        `basis (perp vs spot price gap) is ${basisPercent.toFixed(3)}%, exceeds maxBasisPercent ` +
          `(${config.maxBasisPercent}%) - the hedge has drifted away from market-neutral`,
      ],
    };
  }
  return { decision: false, reasons: [] };
}

/** Computes how far the two legs have drifted apart, in $ and %, and whether that crosses the rebalance threshold. */
export function computePositionLegs(spotNotionalUsd: number, perpNotionalUsd: number): PositionLegs {
  const driftUsd = perpNotionalUsd - spotNotionalUsd;
  const base = Math.max(spotNotionalUsd, 1e-9); // avoid divide-by-zero if the spot leg is ~empty
  return {
    spotNotionalUsd,
    perpNotionalUsd,
    driftUsd,
    driftPercentOfSpot: (driftUsd / base) * 100,
  };
}

export function shouldRebalance(legs: PositionLegs, config: FundingArbConfig): SignalResult {
  if (Math.abs(legs.driftPercentOfSpot) > config.rebalanceDriftPercent) {
    return {
      decision: true,
      reasons: [
        `legs have drifted ${legs.driftPercentOfSpot.toFixed(2)}% apart (spot $${legs.spotNotionalUsd.toFixed(2)} vs ` +
          `perp $${legs.perpNotionalUsd.toFixed(2)}), exceeds rebalanceDriftPercent (${config.rebalanceDriftPercent}%)`,
      ],
    };
  }
  return { decision: false, reasons: [] };
}

/**
 * "Reject if funding spread doesn't clear round-trip costs." Ties directly to the entry
 * confirmation window: if the income earned over minConsecutiveSettlementsToEnter settlements
 * (the minimum holding period this strategy already requires before it will even enter)
 * doesn't cover the estimated entry+exit trading costs, the trade isn't worth putting on -
 * you'd be paying fees to collect funding that the fees themselves eat.
 */
export function passesCostGate(fundingRateHourlyPercent: number, config: FundingArbConfig): SignalResult {
  const reasons: string[] = [];

  if (fundingRateHourlyPercent <= 0) {
    reasons.push("funding rate is not positive - a short would be paying, not earning, funding");
    return { decision: false, reasons };
  }

  const roundTripCostUsd = (config.notionalUsd * config.estimatedRoundTripCostBps) / 10_000;
  const incomePerSettlementUsd = config.notionalUsd * (fundingRateHourlyPercent / 100);
  const incomeOverEntryWindowUsd = incomePerSettlementUsd * config.minConsecutiveSettlementsToEnter;

  if (incomeOverEntryWindowUsd <= roundTripCostUsd) {
    reasons.push(
      `estimated round-trip cost ($${roundTripCostUsd.toFixed(2)}, from estimatedRoundTripCostBps=` +
        `${config.estimatedRoundTripCostBps}) is not cleared by projected funding income over the ` +
        `${config.minConsecutiveSettlementsToEnter}-settlement confirmation window ` +
        `($${incomeOverEntryWindowUsd.toFixed(2)}) - not worth the fees yet`
    );
    return { decision: false, reasons };
  }

  return { decision: true, reasons: [] };
}

/** Margin buffer check - "never let the short leg approach liquidation even while hedged." */
export function hasSufficientMarginBuffer(healthPercent: number, config: FundingArbConfig): SignalResult {
  if (healthPercent < config.minMarginBufferPercent) {
    return {
      decision: false,
      reasons: [
        `account health (${healthPercent.toFixed(1)}%) is below minMarginBufferPercent ` +
          `(${config.minMarginBufferPercent}%) - too close to liquidation to open or hold this position`,
      ],
    };
  }
  return { decision: true, reasons: [] };
}
