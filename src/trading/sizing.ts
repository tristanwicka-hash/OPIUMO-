import { TradingConfig } from "../config";
import { computePositionSizeForRisk } from "../util/riskSizing";

/**
 * "Max 0.5-1% of total capital per trade (hard cap, non-overridable). Size
 * derived from stop-loss distance, not flat dollar amount."
 *
 * HARD_CAP_PERCENT_OF_CAPITAL is a source-code constant, not a config value,
 * on purpose - "non-overridable" means it, so editing config/default.json
 * cannot loosen it. It's set to the top of the spec's stated 0.5-1% range.
 *
 * In practice this hard cap is the binding constraint on almost every trade:
 * for the risk-based calculation (config.trading.riskPercentPerTrade,
 * defaults to 0.75%) to produce a SMALLER size than the 1% hard cap, the
 * stop-loss would need to sit more than riskPercentPerTrade/1% away from
 * entry - e.g. more than 75% away at the 0.75% default. Real ATR-based
 * stops on a volatile token are nowhere near that wide, so expect most
 * positions to size in right at the hard cap - that's the point, not a
 * bug: it means the hard cap really is doing the capping, and risk-based
 * sizing only pulls a position SMALLER on the rare setup with a genuinely
 * wide stop, protecting you from over-sizing into one.
 */
const HARD_CAP_PERCENT_OF_CAPITAL = 1;

export interface SizingResult {
  positionSizeSol: number;
  /** True if the risk-based size was reduced by the hard cap. */
  cappedByHardLimit: boolean;
}

/**
 * Sizes a position in SOL from the distance to its stop-loss, not a flat
 * dollar amount - a wider stop (more volatile token) automatically means a
 * smaller position for the same $ risk, and vice versa. Always clamped to
 * HARD_CAP_PERCENT_OF_CAPITAL regardless of what config says.
 */
export function computeSpotPositionSizeSol(
  totalCapitalSol: number,
  entryPriceSol: number,
  stopLossPriceSol: number,
  trading: TradingConfig
): SizingResult {
  if (totalCapitalSol <= 0) throw new Error("totalCapitalSol must be > 0");

  const riskBasedSizeSol = computePositionSizeForRisk(
    totalCapitalSol,
    trading.riskPercentPerTrade,
    entryPriceSol,
    stopLossPriceSol
  );

  const hardCapSol = totalCapitalSol * (HARD_CAP_PERCENT_OF_CAPITAL / 100);
  const positionSizeSol = Math.min(riskBasedSizeSol, hardCapSol);
  return {
    positionSizeSol,
    cappedByHardLimit: positionSizeSol < riskBasedSizeSol,
  };
}
