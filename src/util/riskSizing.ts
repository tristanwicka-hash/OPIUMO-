/**
 * Fixed-fractional position sizing, shared by both trading tracks (perps
 * funding-arb and the spot sniper): size a position so that if the stop is
 * hit, the loss equals exactly `riskPercentOfAccount` of `accountValue`.
 * Currency-agnostic - pass SOL for the spot bot, USD for perps.
 */
export function computePositionSizeForRisk(
  accountValue: number,
  riskPercentOfAccount: number,
  entryPrice: number,
  stopPrice: number
): number {
  if (accountValue <= 0) throw new Error("accountValue must be > 0");
  if (riskPercentOfAccount <= 0) throw new Error("riskPercentOfAccount must be > 0");
  if (entryPrice <= 0) throw new Error("entryPrice must be > 0");

  const priceMoveFraction = Math.abs(entryPrice - stopPrice) / entryPrice;
  if (priceMoveFraction === 0) throw new Error("stopPrice cannot equal entryPrice");

  const maxLoss = accountValue * (riskPercentOfAccount / 100);
  return maxLoss / priceMoveFraction;
}
