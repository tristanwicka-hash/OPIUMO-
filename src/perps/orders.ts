import { DriftClient, OrderType, PositionDirection, OrderTriggerCondition } from "@drift-labs/sdk";
import { loadConfig } from "../config";
import { Logger } from "../util/logger";
import { resolveMarketIndex } from "./marketRegistry";
import { getAccountSnapshot } from "./positions";
import { validateOrderAgainstRiskLimits, computeStopLossPrice, computeTakeProfitPrice } from "./risk";
import { usdNotionalToBaseAssetAmount, priceToBN, bnPriceToNumber } from "./sizing";
import { PerpsTradeLog } from "./tradeLog";
import { PerpOrderRequest, PerpDirection } from "./types";

const logger = new Logger("perps", loadConfig().logging.level);

export interface OpenOrderResult {
  success: boolean;
  reasons: string[];
  txSignature?: string;
  entryPrice?: number;
  stopLossTxSignature?: string;
  takeProfitTxSignature?: string;
}

export interface CloseOrderResult {
  success: boolean;
  reasons: string[];
  txSignature?: string;
  exitPrice?: number;
}

/**
 * Opens a market-order perp position, then attaches a reduce-only stop-loss
 * trigger order (and take-profit, if set) so the position isn't left
 * unprotected. NOTHING here runs unless config.perps.enabled is true AND
 * the order clears every check in validateOrderAgainstRiskLimits() - this
 * is pure plumbing, there is no strategy deciding to call this yet (see
 * README). You (or whatever you build next) decide when to call it.
 */
export async function openPerpPosition(
  driftClient: DriftClient,
  order: PerpOrderRequest,
  tradeLog: PerpsTradeLog = new PerpsTradeLog()
): Promise<OpenOrderResult> {
  const config = loadConfig();

  if (!config.perps.enabled) {
    const reasons = ["perps.enabled is false in config/default.json - no order was placed"];
    tradeLog.recordRejected({ market: order.market, direction: order.direction, reasons });
    logger.warn(`Order for ${order.market} rejected: ${reasons[0]}`);
    return { success: false, reasons };
  }

  const marketIndex = resolveMarketIndex(config.perps.env, order.market);
  if (marketIndex === null) {
    const reasons = [`could not resolve market "${order.market}" on env=${config.perps.env}`];
    tradeLog.recordRejected({ market: order.market, direction: order.direction, reasons });
    return { success: false, reasons };
  }

  const snapshot = getAccountSnapshot(driftClient, config.perps.subAccountId);
  const riskCheck = validateOrderAgainstRiskLimits(order, config.perps, snapshot.openPositions.length);
  if (!riskCheck.allowed) {
    tradeLog.recordRejected({ market: order.market, direction: order.direction, reasons: riskCheck.reasons });
    logger.warn(`Order for ${order.market} rejected: ${riskCheck.reasons.join("; ")}`);
    return { success: false, reasons: riskCheck.reasons };
  }

  const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
  const entryPrice = bnPriceToNumber(oracleData.price);
  const baseAssetAmount = usdNotionalToBaseAssetAmount(order.notionalUsd, entryPrice);
  const direction = order.direction === "long" ? PositionDirection.LONG : PositionDirection.SHORT;

  logger.info(
    `Opening ${order.direction} ${order.market}: $${order.notionalUsd} notional @ ~$${entryPrice.toFixed(4)} ` +
      `(${config.perps.env})`
  );

  const txSignature = await driftClient.placeAndTakePerpOrder({
    orderType: OrderType.MARKET,
    marketIndex,
    baseAssetAmount,
    direction,
  });

  const result: OpenOrderResult = { success: true, reasons: [], txSignature, entryPrice };

  // Attach protective orders. A failure here does NOT roll back the position that's already
  // open - it's logged loudly instead, because "silently retry opening a leveraged position
  // you already have" is worse than "tell the human their stop-loss didn't attach."
  if (order.stopLossPercent !== undefined) {
    try {
      const stopPrice = computeStopLossPrice(entryPrice, order.stopLossPercent, order.direction);
      result.stopLossTxSignature = await placeReduceOnlyTrigger(
        driftClient,
        marketIndex,
        order.direction,
        stopPrice,
        entryPrice,
        baseAssetAmount
      );
    } catch (err: any) {
      logger.error(
        `Position opened (${txSignature}) but FAILED to attach stop-loss: ${err?.message || err} - ` +
          `this position is currently UNPROTECTED, check it manually.`
      );
    }
  }
  if (order.takeProfitPercent !== undefined) {
    try {
      const tpPrice = computeTakeProfitPrice(entryPrice, order.takeProfitPercent, order.direction);
      result.takeProfitTxSignature = await placeReduceOnlyTrigger(
        driftClient,
        marketIndex,
        order.direction,
        tpPrice,
        entryPrice,
        baseAssetAmount
      );
    } catch (err: any) {
      logger.error(`Position opened (${txSignature}) but failed to attach take-profit: ${err?.message || err}`);
    }
  }

  tradeLog.recordOpen({
    market: order.market,
    direction: order.direction,
    notionalUsd: order.notionalUsd,
    leverage: order.leverage,
    entryPrice,
    stopLossPercent: order.stopLossPercent,
    takeProfitPercent: order.takeProfitPercent,
    txSignature,
  });

  return result;
}

/**
 * Places a reduce-only trigger order that closes a position when `triggerPrice` is hit.
 * Used for both stop-loss and take-profit - which one it is depends only on which side of
 * entry the caller's triggerPrice sits on; the direction/condition math is identical either way:
 *   - a LONG closes by selling (SHORT order), and its trigger fires when price falls BELOW it
 *     (both its stop-loss, below entry, and... no: a long's take-profit is ABOVE entry, so a
 *     long needs BELOW for its stop and ABOVE for its take-profit - i.e. the condition depends
 *     on whether triggerPrice is below or above the position's own entry, not on direction alone.
 */
async function placeReduceOnlyTrigger(
  driftClient: DriftClient,
  marketIndex: number,
  positionDirection: PerpDirection,
  triggerPrice: number,
  entryPrice: number,
  baseAssetAmount: ReturnType<typeof usdNotionalToBaseAssetAmount>
): Promise<string> {
  // Closing a long = sell = SHORT order; closing a short = buy = LONG order.
  const closingDirection = positionDirection === "long" ? PositionDirection.SHORT : PositionDirection.LONG;
  // The trigger fires when price crosses INTO the closing side from the current side - i.e.
  // BELOW entry if triggerPrice is below entry, ABOVE entry if triggerPrice is above entry.
  // This is direction-agnostic: it's true for a long's stop (below), a long's take-profit
  // (above), a short's stop (above), and a short's take-profit (below) alike.
  const triggerCondition = triggerPrice < entryPrice ? OrderTriggerCondition.BELOW : OrderTriggerCondition.ABOVE;

  return driftClient.placePerpOrder({
    orderType: OrderType.TRIGGER_MARKET,
    marketIndex,
    baseAssetAmount,
    direction: closingDirection,
    triggerPrice: priceToBN(triggerPrice),
    triggerCondition,
    reduceOnly: true,
  });
}

/**
 * Flattens a position at market. Drift's own closePosition() handles sizing
 * (closes the full position) - this just wraps it with our logging/config gate.
 */
export async function closePerpPosition(
  driftClient: DriftClient,
  market: string,
  reason: string,
  tradeLog: PerpsTradeLog = new PerpsTradeLog()
): Promise<CloseOrderResult> {
  const config = loadConfig();
  if (!config.perps.enabled) {
    return { success: false, reasons: ["perps.enabled is false in config/default.json - no order was placed"] };
  }

  const marketIndex = resolveMarketIndex(config.perps.env, market);
  if (marketIndex === null) {
    return { success: false, reasons: [`could not resolve market "${market}" on env=${config.perps.env}`] };
  }

  const snapshot = getAccountSnapshot(driftClient, config.perps.subAccountId);
  const position = snapshot.openPositions.find((p) => p.marketIndex === marketIndex);
  if (!position) {
    return { success: false, reasons: [`no open position in ${market} on subAccountId=${config.perps.subAccountId}`] };
  }

  logger.info(`Closing ${position.direction} ${market} position (reason: ${reason})`);
  const txSignature = await driftClient.closePosition(marketIndex);

  const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
  const exitPrice = bnPriceToNumber(oracleData.price);

  tradeLog.recordClose({
    market,
    direction: position.direction,
    entryPrice: position.entryPrice,
    exitPrice,
    notionalUsd: position.notionalUsd,
    pnlUsd: position.unrealizedPnlUsd,
    reason,
    txSignature,
  });

  return { success: true, reasons: [], txSignature, exitPrice };
}
