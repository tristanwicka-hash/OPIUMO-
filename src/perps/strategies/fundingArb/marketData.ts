import { DriftClient, PRICE_PRECISION, QUOTE_PRECISION, convertToNumber } from "@drift-labs/sdk";
import { calculateFormattedLiveFundingRate } from "@drift-labs/sdk";
import { calculateReservePrice } from "@drift-labs/sdk";
import { FundingSnapshot } from "./types";

/**
 * Live reads only - no decisions made here (see signals.ts for the pure
 * logic). Uses Drift's own SDK math for funding rate and mark price rather
 * than re-deriving the AMM formulas ourselves.
 */
export function getFundingSnapshot(driftClient: DriftClient, marketIndex: number): FundingSnapshot {
  const market = driftClient.getPerpMarketAccount(marketIndex);
  if (!market) throw new Error(`No perp market account loaded for marketIndex=${marketIndex}`);

  const mmOracleData = driftClient.getMMOracleDataForPerpMarket(marketIndex);
  const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);

  // shortRate is already sign-adjusted by the SDK: positive = a short position EARNS funding.
  const { shortRate } = calculateFormattedLiveFundingRate(market, mmOracleData, oracleData, "hour");

  const markPriceBN = calculateReservePrice(market, mmOracleData);
  const markPrice = convertToNumber(markPriceBN, PRICE_PRECISION);
  const oraclePrice = convertToNumber(oracleData.price, PRICE_PRECISION);
  const basisPercent = oraclePrice > 0 ? ((markPrice - oraclePrice) / oraclePrice) * 100 : 0;

  return {
    marketIndex,
    shortRateHourlyPercent: shortRate,
    lastFundingRateTs: market.amm.lastFundingRateTs.toNumber(),
    fundingPeriodSeconds: market.amm.fundingPeriod.toNumber(),
    markPrice,
    oraclePrice,
    basisPercent,
  };
}

/** Current USD value of the spot position Drift's account already holds for this market (your existing "long spot" leg). */
export function getSpotNotionalUsd(driftClient: DriftClient, spotMarketIndex: number, subAccountId: number): number {
  const user = driftClient.getUser(subAccountId);
  const value = user.getSpotMarketAssetValue(spotMarketIndex);
  return convertToNumber(value, QUOTE_PRECISION);
}
