import { PerpsConfig } from "../config";
import { computePositionSizeForRisk as computePositionSizeForRiskShared } from "../util/riskSizing";
import { PerpOrderRequest, RiskCheckResult } from "./types";

/**
 * Pure risk-limit gate for perp orders - same PASS/SKIP-with-reasons
 * philosophy as the spot filter engine (src/filters/engine.ts). This is
 * NOT a trading strategy (there isn't one yet, see README) - it's the last
 * line of defense that runs on every order regardless of what decided to
 * place it, checking it against your configured limits before anything
 * touches the chain.
 *
 * `currentOpenPositionCount` is passed in rather than fetched here so this
 * stays a pure, offline-testable function - the caller (orders.ts) is
 * responsible for getting that from a live AccountSnapshot.
 */
export function validateOrderAgainstRiskLimits(
  order: PerpOrderRequest,
  config: PerpsConfig,
  currentOpenPositionCount: number
): RiskCheckResult {
  const reasons: string[] = [];

  const allowed = config.allowedMarkets.some((m) => m.toUpperCase() === order.market.toUpperCase());
  if (!allowed) {
    reasons.push(`market ${order.market} is not in perps.allowedMarkets (${config.allowedMarkets.join(", ")})`);
  }

  if (order.direction !== "long" && order.direction !== "short") {
    reasons.push(`direction must be "long" or "short", got "${order.direction}"`);
  }

  if (!(order.notionalUsd > 0)) {
    reasons.push("notionalUsd must be > 0");
  } else if (order.notionalUsd > config.maxPositionSizeUsd) {
    reasons.push(`notional $${order.notionalUsd} exceeds perps.maxPositionSizeUsd ($${config.maxPositionSizeUsd})`);
  }

  if (!(order.leverage > 0)) {
    reasons.push("leverage must be > 0");
  } else if (order.leverage > config.maxLeverage) {
    reasons.push(`leverage ${order.leverage}x exceeds perps.maxLeverage (${config.maxLeverage}x)`);
  }

  if (config.requireStopLoss) {
    if (order.stopLossPercent === undefined) {
      reasons.push("no stopLossPercent set and perps.requireStopLoss is true");
    } else if (order.stopLossPercent >= 0) {
      reasons.push(`stopLossPercent must be negative (a distance below entry for a long / above entry for a short), got ${order.stopLossPercent}`);
    }
  }

  if (order.takeProfitPercent !== undefined && order.takeProfitPercent <= 0) {
    reasons.push(`takeProfitPercent must be positive when set, got ${order.takeProfitPercent}`);
  }

  if (currentOpenPositionCount >= config.maxOpenPositions) {
    reasons.push(
      `already at perps.maxOpenPositions (${config.maxOpenPositions}) open position(s) - close one before opening another`
    );
  }

  return { allowed: reasons.length === 0, reasons };
}

/**
 * Rough, ISOLATED-MARGIN estimate of liquidation price, for pre-trade "what would
 * this look like" display only. Ignores funding payments, fees, and (most importantly)
 * Drift's actual cross-margin account health across your OTHER positions - your real
 * liquidation price depends on your whole account, not just this one order. Ignores
 * variable per-market maintenance margin (defaults to a conservative 3%, Drift's actual
 * requirement varies by market and by your account's leverage tier).
 * ALWAYS cross-check the real number in Drift's own UI before trusting this for anything
 * that matters - this exists to catch "wait, 20x leverage liquidates almost immediately"
 * obviously-bad orders, not to be an authoritative risk figure.
 */
export function estimateLiquidationPrice(
  entryPrice: number,
  leverage: number,
  direction: "long" | "short",
  maintenanceMarginRatio = 0.03
): number {
  if (leverage <= 0) throw new Error("leverage must be > 0");
  const marginFraction = 1 / leverage;
  if (direction === "long") {
    return entryPrice * (1 - marginFraction + maintenanceMarginRatio);
  }
  return entryPrice * (1 + marginFraction - maintenanceMarginRatio);
}

/** Where a stop-loss trigger order should sit, given entry price and direction. stopLossPercent is negative. */
export function computeStopLossPrice(entryPrice: number, stopLossPercent: number, direction: "long" | "short"): number {
  if (stopLossPercent >= 0) throw new Error("stopLossPercent must be negative");
  const fraction = stopLossPercent / 100;
  return direction === "long" ? entryPrice * (1 + fraction) : entryPrice * (1 - fraction);
}

/** Where a take-profit trigger order should sit, given entry price and direction. takeProfitPercent is positive. */
export function computeTakeProfitPrice(entryPrice: number, takeProfitPercent: number, direction: "long" | "short"): number {
  if (takeProfitPercent <= 0) throw new Error("takeProfitPercent must be positive");
  const fraction = takeProfitPercent / 100;
  return direction === "long" ? entryPrice * (1 + fraction) : entryPrice * (1 - fraction);
}

/**
 * Position sizing so that if `stopLossPrice` is hit, the loss equals exactly
 * `riskPercentOfAccount` of `accountValueUsd`. Classic fixed-fractional risk
 * sizing - returns the notional (exposure) size in USD, independent of leverage
 * (leverage only changes how much margin that notional ties up, not the $ loss
 * at the stop). Shared with the spot sniper's position sizing (src/trading/sizing.ts) -
 * see src/util/riskSizing.ts for the actual (currency-agnostic) implementation.
 */
export function computePositionSizeForRisk(
  accountValueUsd: number,
  riskPercentOfAccount: number,
  entryPrice: number,
  stopLossPrice: number
): number {
  return computePositionSizeForRiskShared(accountValueUsd, riskPercentOfAccount, entryPrice, stopLossPrice);
}
