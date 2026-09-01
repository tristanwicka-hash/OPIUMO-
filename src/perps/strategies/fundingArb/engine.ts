import { DriftClient } from "@drift-labs/sdk";
import { loadConfig, FundingArbConfig } from "../../../config";
import { Logger } from "../../../util/logger";
import { resolveMarketIndex, resolveSpotMarketIndex } from "../../marketRegistry";
import { getAccountSnapshot } from "../../positions";
import { openPerpPosition, closePerpPosition } from "../../orders";
import { PerpsTradeLog } from "../../tradeLog";
import { FundingHistoryStore } from "./history";
import { getFundingSnapshot, getSpotNotionalUsd } from "./marketData";
import {
  shouldEnter,
  shouldExitOnFundingFlip,
  shouldExitOnBasis,
  shouldRebalance,
  passesCostGate,
  hasSufficientMarginBuffer,
  computePositionLegs,
} from "./signals";
import { FundingSample } from "./types";

const logger = new Logger("funding-arb", loadConfig().logging.level);

export interface CycleResult {
  action: "none" | "entered" | "exited" | "rebalanced" | "emergency-unwind" | "blocked";
  reasons: string[];
}

/**
 * Orchestrates the funding-rate-arb strategy: reads live data, runs it
 * through the pure signal functions (signals.ts), and - only if
 * fundingArb.enabled AND perps.enabled are both true - calls into the same
 * risk-gated openPerpPosition()/closePerpPosition() used everywhere else in
 * the perps plumbing. This class makes zero trading decisions of its own;
 * every decision traces back to a signals.ts function you can read and test
 * in isolation.
 */
export class FundingArbStrategy {
  private driftClient: DriftClient;
  private history: FundingHistoryStore;
  private tradeLog: PerpsTradeLog;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(driftClient: DriftClient, history?: FundingHistoryStore, tradeLog?: PerpsTradeLog) {
    this.driftClient = driftClient;
    const config = loadConfig();
    this.history = history ?? new FundingHistoryStore(config.fundingArb.historyFile);
    this.tradeLog = tradeLog ?? new PerpsTradeLog();
  }

  start(): void {
    const config = loadConfig();
    if (this.timer) {
      logger.warn("start() called but the strategy loop is already running");
      return;
    }
    if (!config.fundingArb.enabled) {
      logger.warn("fundingArb.enabled is false - start() will run checkOnce() on schedule but every action is blocked at the order gate");
    }
    logger.info(
      `Starting funding-arb loop: market=${config.fundingArb.market} every ${config.fundingArb.checkIntervalMinutes}min ` +
        `(env=${config.perps.env})`
    );
    this.timer = setInterval(() => {
      this.checkOnce().catch((err) => logger.error(`checkOnce() failed: ${err?.message || err}`));
    }, config.fundingArb.checkIntervalMinutes * 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("Funding-arb loop stopped");
  }

  /** One full evaluation cycle. Safe to call directly (e.g. from a test or a manual trigger) without start(). */
  async checkOnce(): Promise<CycleResult> {
    const config = loadConfig();
    const fa = config.fundingArb;

    const marketIndex = resolveMarketIndex(config.perps.env, fa.market);
    const spotMarketIndex = resolveSpotMarketIndex(config.perps.env, fa.spotMarket);
    if (marketIndex === null || spotMarketIndex === null) {
      const reasons = [`could not resolve market="${fa.market}" (${marketIndex}) or spotMarket="${fa.spotMarket}" (${spotMarketIndex}) on env=${config.perps.env}`];
      logger.error(reasons[0]);
      return { action: "blocked", reasons };
    }

    // -- live reads --
    const funding = getFundingSnapshot(this.driftClient, marketIndex);
    const account = getAccountSnapshot(this.driftClient, config.perps.subAccountId);
    const spotNotionalUsd = getSpotNotionalUsd(this.driftClient, spotMarketIndex, config.perps.subAccountId);

    const isNewSettlement = this.history.appendIfNewSettlement(marketIndex, {
      observedAt: Date.now(),
      settlementTs: funding.lastFundingRateTs,
      shortRateHourlyPercent: funding.shortRateHourlyPercent,
    } satisfies FundingSample);
    logger.info(
      `${fa.market}: shortRate=${funding.shortRateHourlyPercent.toFixed(4)}%/hr basis=${funding.basisPercent.toFixed(3)}% ` +
        `spot=$${spotNotionalUsd.toFixed(2)} health=${account.healthPercent.toFixed(1)}% ` +
        `${isNewSettlement ? "(new settlement recorded)" : "(no new settlement since last poll)"}`
    );

    const samples = this.history.getSamples(marketIndex);
    const openShort = account.openPositions.find((p) => p.marketIndex === marketIndex && p.direction === "short");

    // -- margin buffer is checked every cycle regardless of phase; a breach with an open position is an emergency --
    const marginCheck = hasSufficientMarginBuffer(account.healthPercent, fa);
    if (!marginCheck.decision && openShort) {
      logger.error(`EMERGENCY UNWIND: ${marginCheck.reasons.join("; ")}`);
      const result = await closePerpPosition(this.driftClient, fa.market, `margin buffer breach: ${marginCheck.reasons.join("; ")}`, this.tradeLog);
      return { action: result.success ? "emergency-unwind" : "blocked", reasons: result.success ? marginCheck.reasons : result.reasons };
    }

    if (openShort) {
      return this.manageOpenPosition(fa, funding, samples, spotNotionalUsd, openShort);
    }
    return this.considerEntry(fa, funding, samples, spotNotionalUsd, marginCheck);
  }

  private async manageOpenPosition(
    fa: FundingArbConfig,
    funding: ReturnType<typeof getFundingSnapshot>,
    samples: FundingSample[],
    spotNotionalUsd: number,
    openShort: ReturnType<typeof getAccountSnapshot>["openPositions"][number]
  ): Promise<CycleResult> {
    const basisExit = shouldExitOnBasis(funding.basisPercent, fa);
    if (basisExit.decision) {
      const result = await closePerpPosition(this.driftClient, fa.market, `basis exit: ${basisExit.reasons.join("; ")}`, this.tradeLog);
      return { action: result.success ? "exited" : "blocked", reasons: basisExit.reasons };
    }

    const fundingExit = shouldExitOnFundingFlip(samples, fa);
    if (fundingExit.decision) {
      const result = await closePerpPosition(this.driftClient, fa.market, `funding flip exit: ${fundingExit.reasons.join("; ")}`, this.tradeLog);
      return { action: result.success ? "exited" : "blocked", reasons: fundingExit.reasons };
    }

    const legs = computePositionLegs(spotNotionalUsd, openShort.notionalUsd);
    const rebalance = shouldRebalance(legs, fa);
    if (rebalance.decision) {
      // No partial-resize order exists yet - rebalance by closing and reopening at the corrected
      // size. Slightly less capital-efficient (pays entry+exit fees again) than a true resize
      // would be, but correct, and simple enough to trust. A real resize order is a reasonable
      // future improvement, not built now.
      logger.info(`Rebalancing: ${rebalance.reasons.join("; ")}`);
      const closeResult = await closePerpPosition(this.driftClient, fa.market, `rebalance: ${rebalance.reasons.join("; ")}`, this.tradeLog);
      if (!closeResult.success) return { action: "blocked", reasons: closeResult.reasons };

      const openResult = await openPerpPosition(
        this.driftClient,
        {
          market: fa.market,
          direction: "short",
          notionalUsd: Math.min(fa.notionalUsd, spotNotionalUsd),
          leverage: fa.maxLeverage,
          stopLossPercent: this.disasterStopPercent(),
        },
        this.tradeLog
      );
      return { action: openResult.success ? "rebalanced" : "blocked", reasons: rebalance.reasons.concat(openResult.reasons) };
    }

    return { action: "none", reasons: [] };
  }

  private async considerEntry(
    fa: FundingArbConfig,
    funding: ReturnType<typeof getFundingSnapshot>,
    samples: FundingSample[],
    spotNotionalUsd: number,
    marginCheck: ReturnType<typeof hasSufficientMarginBuffer>
  ): Promise<CycleResult> {
    if (spotNotionalUsd <= 0) {
      const reasons = ["no spot leg detected (spotNotionalUsd <= 0) - this strategy hedges an EXISTING spot position, it does not buy one for you. Deposit/hold the spot asset first."];
      return { action: "blocked", reasons };
    }

    const entrySignal = shouldEnter(samples, fa);
    const costGate = passesCostGate(funding.shortRateHourlyPercent, fa);
    const reasons = [...entrySignal.reasons, ...costGate.reasons, ...marginCheck.reasons];

    if (!entrySignal.decision || !costGate.decision || !marginCheck.decision) {
      return { action: "blocked", reasons };
    }

    const notionalUsd = Math.min(fa.notionalUsd, spotNotionalUsd);
    const result = await openPerpPosition(
      this.driftClient,
      {
        market: fa.market,
        direction: "short",
        notionalUsd,
        leverage: fa.maxLeverage,
        stopLossPercent: this.disasterStopPercent(),
      },
      this.tradeLog
    );

    return { action: result.success ? "entered" : "blocked", reasons: result.success ? [] : result.reasons };
  }

  /**
   * A wide, last-resort stop attached to every order this strategy places - NOT the strategy's
   * primary exit mechanism (that's the basis/funding/margin monitoring above). This exists purely
   * so that if this bot process dies while a position is open, there's still an on-chain order
   * that fires if something goes badly wrong instead of an unmonitored naked short forever.
   * No takeProfitPercent is set on these orders on purpose - a delta-neutral position's profit
   * comes from funding accrual over time, not price movement, so a price-based take-profit would
   * work against the hedge.
   */
  private disasterStopPercent(): number {
    return loadConfig().perps.defaultStopLossPercent;
  }
}
