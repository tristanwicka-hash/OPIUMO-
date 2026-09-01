import { Connection, Keypair } from "@solana/web3.js";
import { loadConfig, TakeProfitStep } from "../config";
import { Logger } from "../util/logger";
import { NewPoolEvent } from "../watcher/types";
import { FilterResult } from "../filters/engine";
import { executeSwap, getQuote, SOL_MINT } from "./jupiter";
import { computeSpotPositionSizeSol } from "./sizing";
import { computeATR, candlesFromPrices } from "./atr";
import { checkAtrStopLoss, checkTimeStop, checkTrailingStop, checkLadderTier, computeAtrStopPrice } from "./exitLogic";
import { PriceHistoryStore } from "./priceHistory";
import { PositionStore, SpotPosition } from "./positionStore";
import { SpotTradeLog } from "./tradeLog";

const logger = new Logger("trading", loadConfig().logging.level);
const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Orchestrates the spot sniper's buy/sell execution - the thing that ties
 * Part 4's filter PASS decisions to an actual Jupiter swap, and manages
 * open positions through the exit ladder/trailing-stop/time-stop logic
 * (src/trading/exitLogic.ts) on a timer. Nothing here runs unless
 * trading.enabled is true; every buy also passes back through the same
 * filter result it was already given (belt-and-suspenders - this should
 * never be called with a SKIP, but it checks anyway).
 *
 * UNIT CONVENTION: every "priceSol" value in this file (entryPriceSol,
 * currentPriceSol, highestPriceSol, stopLossPriceSol, ...) means SOL per
 * RAW token unit (i.e. per the smallest on-chain unit), not per whole/
 * human-readable token - consistent throughout, so ratios and differences
 * between them are correct, but a printed price will look like a much
 * smaller number than what you'd see on a token explorer for anything
 * with more than a couple of decimals. Cosmetic only, never mixed with a
 * human-unit price anywhere in this file.
 */
export class SpotTradingEngine {
  private connection: Connection;
  private wallet: Keypair;
  private priceHistory: PriceHistoryStore;
  private positions: PositionStore;
  private tradeLog: SpotTradeLog;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(connection: Connection, wallet: Keypair, priceHistory?: PriceHistoryStore, positions?: PositionStore, tradeLog?: SpotTradeLog) {
    this.connection = connection;
    this.wallet = wallet;
    this.priceHistory = priceHistory ?? new PriceHistoryStore("logs/price-history.json");
    this.positions = positions ?? new PositionStore("logs/spot-positions.json");
    this.tradeLog = tradeLog ?? new SpotTradeLog();
  }

  start(): void {
    const config = loadConfig();
    if (this.timer) {
      logger.warn("start() called but the monitoring loop is already running");
      return;
    }
    logger.info(`Starting spot position monitor: every ${config.trading.priceCheckIntervalMs}ms`);
    this.timer = setInterval(() => {
      this.checkAllPositions().catch((err) => logger.error(`checkAllPositions() failed: ${err?.message || err}`));
    }, config.trading.priceCheckIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("Spot position monitor stopped");
  }

  /**
   * Call this when Part 4's filter engine returns PASS for a token. Sizes
   * the position from a fallback stop (no ATR exists yet for a brand-new
   * token - see TradingConfig.fallbackStopLossPercent), executes the buy,
   * and starts tracking it.
   */
  async onFilterPass(event: NewPoolEvent, filterResult: FilterResult): Promise<void> {
    const config = loadConfig();

    if (filterResult.decision !== "PASS") {
      logger.warn(`onFilterPass() called with a non-PASS result for ${event.mint} - refusing to buy`);
      return;
    }
    if (!config.trading.enabled) {
      this.tradeLog.recordRejectedBuy({ mint: event.mint, reasons: ["trading.enabled is false - no order was placed"] });
      return;
    }
    if (this.positions.get(event.mint)) {
      logger.debug(`Already holding a position in ${event.mint} - skipping duplicate buy`);
      return;
    }
    const openCount = this.positions.getAllOpen().length;
    if (openCount >= config.trading.maxOpenPositions) {
      const reasons = [`already at trading.maxOpenPositions (${config.trading.maxOpenPositions}) open position(s)`];
      this.tradeLog.recordRejectedBuy({ mint: event.mint, reasons });
      logger.warn(`Buy for ${event.mint} rejected: ${reasons[0]}`);
      return;
    }

    try {
      // Probe quote at a small fixed size to get an indicative price for sizing math, BEFORE
      // committing to the real (larger) swap - the real fill price from the actual buy below is
      // what actually gets recorded, this is only used to compute how big that buy should be.
      const probeSol = Math.min(0.01, config.trading.totalCapitalSol * 0.001);
      const probeLamports = Math.round(probeSol * LAMPORTS_PER_SOL);
      const probeQuote = await executeSwapQuoteOnly(event.mint, probeLamports);
      const indicativePriceSol = probeSol / (Number(probeQuote.outAmount) || 1);

      const fallbackStopPriceSol = indicativePriceSol * (1 + config.trading.fallbackStopLossPercent / 100);
      const sizing = computeSpotPositionSizeSol(config.trading.totalCapitalSol, indicativePriceSol, fallbackStopPriceSol, config.trading);

      if (sizing.positionSizeSol <= 0) {
        this.tradeLog.recordRejectedBuy({ mint: event.mint, reasons: ["computed position size was <= 0"] });
        return;
      }

      const buyLamports = Math.round(sizing.positionSizeSol * LAMPORTS_PER_SOL);
      const swap = await executeSwap(this.connection, this.wallet, SOL_MINT, event.mint, String(buyLamports), config.trading.maxSlippageBps);

      const entryPriceSol = Number(swap.inAmountRaw) / LAMPORTS_PER_SOL / Number(swap.outAmountRaw);
      const stopLossPriceSol = entryPriceSol * (1 + config.trading.fallbackStopLossPercent / 100);

      const position: SpotPosition = {
        mint: event.mint,
        entryPriceSol,
        entrySizeTokens: Number(swap.outAmountRaw),
        remainingSizeTokens: Number(swap.outAmountRaw),
        entryAt: Date.now(),
        highestPriceSol: entryPriceSol,
        executedLadderTiers: [],
        stopLossPriceSol,
      };
      this.positions.save(position);
      this.priceHistory.append(event.mint, { observedAt: Date.now(), priceSol: entryPriceSol });

      this.tradeLog.recordBuy({
        mint: event.mint,
        entryPriceSol,
        sizeSol: sizing.positionSizeSol,
        sizeTokens: position.entrySizeTokens,
        stopLossPriceSol,
        txSignature: swap.signature,
      });
      logger.info(`BOUGHT ${event.mint}: ${sizing.positionSizeSol.toFixed(4)} SOL @ ${entryPriceSol.toExponential(4)} SOL/token (tx ${swap.signature})`);
    } catch (err: any) {
      logger.error(`Buy failed for ${event.mint}: ${err?.message || err}`);
      this.tradeLog.recordFailedExecution({ mint: event.mint, action: "buy", error: err?.message || String(err) });
    }
  }

  private async checkAllPositions(): Promise<void> {
    for (const position of this.positions.getAllOpen()) {
      await this.checkPosition(position).catch((err) =>
        logger.error(`checkPosition(${position.mint}) failed: ${err?.message || err}`)
      );
    }
  }

  /** One monitoring cycle for a single open position - exposed for tests/manual triggers. */
  async checkPosition(position: SpotPosition): Promise<void> {
    const config = loadConfig();

    const quote = await executeSwapQuoteOnly(position.mint, position.remainingSizeTokens, true);
    const currentPriceSol = Number(quote.outAmount) / LAMPORTS_PER_SOL / position.remainingSizeTokens;

    this.priceHistory.append(position.mint, { observedAt: Date.now(), priceSol: currentPriceSol });
    position.highestPriceSol = Math.max(position.highestPriceSol, currentPriceSol);

    // Once real ATR data exists, only ever TIGHTEN the stop toward it (closer to entry), never
    // loosen it back out to the fallback - see TradingConfig.fallbackStopLossPercent.
    const samples = this.priceHistory.getSamples(position.mint).map((s) => s.priceSol);
    const atr = computeATR(candlesFromPrices(samples), config.trading.atrPeriod);
    if (atr !== null) {
      const atrStopPriceSol = computeAtrStopPrice(position.entryPriceSol, atr, config.trading.atrStopMultiplier);
      position.stopLossPriceSol = Math.max(position.stopLossPriceSol, atrStopPriceSol);
    }

    // Priority order: protect capital first, then let winners run, then clean up stagnation,
    // then take profit. Only one action per cycle.
    const stopLoss = checkAtrStopLoss(currentPriceSol, position);
    if (stopLoss.triggered) return this.executeExit(position, currentPriceSol, 100, stopLoss.reason);

    const trailing = checkTrailingStop(currentPriceSol, position, config.trading);
    if (trailing.triggered) return this.executeExit(position, currentPriceSol, 100, trailing.reason);

    const timeStop = checkTimeStop(Date.now(), position, config.trading.takeProfitLadder, config.trading.timeStopHours);
    if (timeStop.triggered) return this.executeExit(position, currentPriceSol, 100, timeStop.reason);

    const ladder = checkLadderTier(currentPriceSol, position, config.trading.takeProfitLadder);
    if (ladder.triggered) {
      // Re-derive which tier fired using the EXACT same sort-ascending-then-first-unexecuted-
      // match logic checkLadderTier uses internally, so this can't disagree with it even if
      // config.trading.takeProfitLadder isn't itself listed in ascending order.
      const sortedLadder: TakeProfitStep[] = [...config.trading.takeProfitLadder].sort((a, b) => a.atMultipleOfEntry - b.atMultipleOfEntry);
      const tier = sortedLadder.find((t) => currentPriceSol / position.entryPriceSol >= t.atMultipleOfEntry && !position.executedLadderTiers.includes(t.atMultipleOfEntry));
      await this.executeExit(position, currentPriceSol, ladder.sellPercentOfRemaining, ladder.reason);
      if (tier) {
        const fresh = this.positions.get(position.mint);
        if (fresh) {
          fresh.executedLadderTiers.push(tier.atMultipleOfEntry);
          this.positions.save(fresh);
        }
      }
      return;
    }

    this.positions.save(position); // persist highestPriceSol/stopLossPriceSol updates even when nothing triggers
  }

  private async executeExit(position: SpotPosition, currentPriceSol: number, sellPercentOfRemaining: number, reason: string): Promise<void> {
    const config = loadConfig();
    const sellAmountRaw = Math.floor(position.remainingSizeTokens * (sellPercentOfRemaining / 100));
    if (sellAmountRaw <= 0) return;

    try {
      const swap = await executeSwap(this.connection, this.wallet, position.mint, SOL_MINT, String(sellAmountRaw), config.trading.maxSlippageBps);
      const solReceived = Number(swap.outAmountRaw) / LAMPORTS_PER_SOL;
      const costBasisSol = (sellAmountRaw / position.entrySizeTokens) * (position.entrySizeTokens * position.entryPriceSol);
      const pnlSol = solReceived - costBasisSol;
      const pnlPercent = (pnlSol / costBasisSol) * 100;

      this.tradeLog.recordSell({
        mint: position.mint,
        entryPriceSol: position.entryPriceSol,
        exitPriceSol: currentPriceSol,
        sizeSolReceived: solReceived,
        sizeTokensSold: sellAmountRaw,
        pnlSol,
        pnlPercent,
        reason,
        txSignature: swap.signature,
      });
      logger.info(`SOLD ${sellPercentOfRemaining}% of ${position.mint}: ${solReceived.toFixed(4)} SOL, P&L ${pnlSol.toFixed(4)} SOL (${pnlPercent.toFixed(1)}%) - ${reason}`);

      const remaining = position.remainingSizeTokens - sellAmountRaw;
      if (remaining <= 0) {
        this.positions.remove(position.mint);
        this.priceHistory.clear(position.mint);
      } else {
        position.remainingSizeTokens = remaining;
        this.positions.save(position);
      }
    } catch (err: any) {
      logger.error(`Sell failed for ${position.mint}: ${err?.message || err}`);
      this.tradeLog.recordFailedExecution({ mint: position.mint, action: "sell", error: err?.message || String(err) });
    }
  }
}

/** Gets a Jupiter quote without executing a swap - used for price discovery (sizing, monitoring). */
async function executeSwapQuoteOnly(mint: string, amountRaw: number, sellDirection = false) {
  return sellDirection ? getQuote(mint, SOL_MINT, String(amountRaw), 50) : getQuote(SOL_MINT, mint, String(amountRaw), 50);
}
