import { DriftClient, User, BASE_PRECISION, QUOTE_PRECISION, MARGIN_PRECISION, convertToNumber } from "@drift-labs/sdk";
import { loadConfig } from "../config";
import { resolveMarketSymbol } from "./marketRegistry";
import { AccountSnapshot, OpenPerpPosition, PerpDirection } from "./types";

/**
 * Reads live account state straight from Drift's own SDK calculations
 * (User.getHealth/getLeverage/getUnrealizedPNL/getFreeCollateral) rather
 * than reimplementing that math ourselves - Drift's cross-margin health
 * depends on your whole account (all positions, all markets), which is not
 * something worth re-deriving by hand. This module is read-only; nothing
 * here places or modifies an order.
 */
export function getAccountSnapshot(driftClient: DriftClient, subAccountId: number): AccountSnapshot {
  const config = loadConfig();
  const user: User = driftClient.getUser(subAccountId);

  const totalCollateralUsd = convertToNumber(user.getTotalCollateral(), QUOTE_PRECISION);
  const freeCollateralUsd = convertToNumber(user.getFreeCollateral(), QUOTE_PRECISION);
  const healthPercent = user.getHealth();
  const unrealizedPnlUsd = convertToNumber(user.getUnrealizedPNL(true), QUOTE_PRECISION);

  const userAccount = user.getUserAccount();
  const openPositions: OpenPerpPosition[] = userAccount.perpPositions
    .filter((p) => !p.baseAssetAmount.isZero())
    .map((p) => {
      const direction: PerpDirection = p.baseAssetAmount.isNeg() ? "short" : "long";
      const baseSize = Math.abs(convertToNumber(p.baseAssetAmount, BASE_PRECISION));
      const oracleData = driftClient.getOracleDataForPerpMarket(p.marketIndex);
      const notionalUsd = Math.abs(convertToNumber(user.getPerpPositionValue(p.marketIndex, oracleData), QUOTE_PRECISION));
      const entryPrice = baseSize > 0 ? notionalUsd / baseSize : 0;
      const symbol = resolveMarketSymbol(config.perps.env, p.marketIndex) ?? `market-${p.marketIndex}`;
      const positionPnlUsd = convertToNumber(user.getUnrealizedPNL(true, p.marketIndex), QUOTE_PRECISION);

      return {
        market: symbol,
        marketIndex: p.marketIndex,
        direction,
        baseSize,
        notionalUsd,
        entryPrice,
        unrealizedPnlUsd: positionPnlUsd,
      };
    });

  return {
    subAccountId,
    totalCollateralUsd,
    freeCollateralUsd,
    leverage: leverageAsNumber(user),
    healthPercent,
    unrealizedPnlUsd,
    openPositions,
  };
}

/** Drift reports account leverage as a BN scaled by MARGIN_PRECISION (10_000 = 1.00x). */
function leverageAsNumber(user: User): number {
  return convertToNumber(user.getLeverage(), MARGIN_PRECISION);
}
