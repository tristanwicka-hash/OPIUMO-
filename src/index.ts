import { loadConfig } from "./config";
import { Logger } from "./util/logger";
import { loadWalletFromBase58 } from "./util/wallet";
import { getConnection, confirmConnection } from "./rpc/connection";
import { PoolWatcher, NewPoolEvent } from "./watcher";
import { collectTokenMetrics } from "./data/tokenMetrics";
import { evaluateFilters } from "./filters/engine";
import { DecisionLog } from "./filters/decisionLog";
import { SpotTradingEngine } from "./trading/engine";
import { WorkQueue } from "./util/workQueue";
import { DelayProbe } from "./data/delayProbe";
import { OutcomeTracker } from "./data/outcomeTracker";
import { Watchlist } from "./watchlist/watchlist";

const logger = new Logger("main", loadConfig().logging.level);

async function main() {
  const config = loadConfig();

  logger.info("=== OPIUMO Sniper Bot starting ===");
  const tradingMode = !config.trading.enabled
    ? "no (detection/filtering only)"
    : config.trading.paperTrading
    ? "YES - PAPER (simulated fills, no real orders)"
    : "YES - LIVE TRADING (real SOL)";
  logger.info(`Trading enabled: ${tradingMode}`);
  logger.info(`Watching: pumpfun=${config.sources.watchPumpFun} raydium=${config.sources.watchRaydium}`);

  // Part 1: prove the RPC connection is alive before doing anything else.
  const status = await confirmConnection();
  if (!status.ok) {
    logger.error(`Cannot start - RPC connection failed: ${status.error}`);
    process.exit(1);
  }

  const connection = getConnection();
  const decisionLog = new DecisionLog();
  const watcher = new PoolWatcher(connection);

  // Parts 5-7: only built if trading.enabled=true. A real wallet is only required for LIVE
  // trading (paperTrading=false) - config validation already enforces that pairing, so this is
  // a belt-and-suspenders check, not the actual gate (every buy/sell inside SpotTradingEngine
  // re-checks trading.enabled/paperTrading itself).
  let tradingEngine: SpotTradingEngine | null = null;
  if (config.trading.enabled) {
    if (!config.trading.paperTrading && !config.walletPrivateKey) {
      logger.error(
        "trading.enabled is true and paperTrading is false (LIVE mode) but WALLET_PRIVATE_KEY is not set - " +
          "this should have failed config validation already."
      );
      process.exit(1);
    }
    // A wallet is optional in paper mode - only used (if present) so log lines show a real
    // address; SpotTradingEngine never signs or sends anything while paperTrading is true.
    const wallet = config.walletPrivateKey ? loadWalletFromBase58(config.walletPrivateKey) : null;
    tradingEngine = new SpotTradingEngine(connection, wallet);
    tradingEngine.start();
    const walletLabel = wallet ? wallet.publicKey.toBase58() : "(none configured - not needed in paper mode)";
    if (config.trading.paperTrading) {
      logger.warn(
        `*** PAPER TRADING IS ON *** simulated fills only, no real orders will be placed. wallet=${walletLabel} ` +
          `totalCapitalSol=${config.trading.totalCapitalSol} maxOpenPositions=${config.trading.maxOpenPositions}`
      );
    } else {
      logger.warn(
        `*** LIVE TRADING IS ON *** wallet=${walletLabel} totalCapitalSol=${config.trading.totalCapitalSol} ` +
          `maxOpenPositions=${config.trading.maxOpenPositions}`
      );
    }
  }

  // Part 2 -> Part 3 -> Part 4 -> (Part 5, if enabled): on every new pool, fetch metrics, filter, log, maybe buy.
  //
  // Routed through a bounded queue rather than run directly in the event
  // handler. EventEmitter does not await its listeners, so previously every
  // detected token started its full metrics pipeline the instant it arrived,
  // unbounded - the direct cause of the rate-limiting that made a whole 3-hour
  // run unusable. maxConcurrentTokens is now the ceiling.
  // Measurement only - never touches a PASS/SKIP or a trade. Runs on its own
  // bounded queue so a burst of observations cannot delay a live decision.
  const delayProbe = new DelayProbe(connection);
  if (config.delayProbe.enabled) {
    logger.info(
      `Delay probe ON (measurement only): re-checking each detected token at ` +
        `${config.delayProbe.delaysSeconds.join("s, ")}s on ${Math.round(config.delayProbe.sampleRate * 100)}% of ` +
        `detected tokens -> ${config.logging.delayProbeFile}. No effect on any buy/sell decision.`
    );
  }

  // Also measurement only. Records what each token BECAME, which is the only
  // thing that can say whether a SKIP was correct - a 0% pass rate is a good
  // filter if none of the rejects ran, and a broken one if some did.
  const outcomeTracker = new OutcomeTracker(connection);
  if (config.outcomeTracker.enabled) {
    outcomeTracker.restorePending();
    logger.info(
      `Outcome tracker ON (measurement only): re-reading liquidity at ` +
        `${config.outcomeTracker.checkpointsSeconds.map((s) => `${Math.round(s / 60)}min`).join(", ")} after detection ` +
        `-> ${config.logging.outcomeFile}. Pending checkpoints survive a restart. No effect on any buy/sell decision.`
    );
  }

  // Unlike the probe and the tracker, this one CAN reach the trading engine -
  // but only through the same onFilterPass the live path uses, which still
  // refuses everything while trading.enabled is false. It changes *when* a
  // token is offered for a decision, never who decides.
  const watchlist = new Watchlist(connection, {
    onPass: async (event, result) => {
      if (tradingEngine) await tradingEngine.onFilterPass(event, result);
    },
  });
  watchlist.start();

  // Reconciliation counters: detected === decided + dropped + still-queued.
  let detected = 0;
  let decided = 0;
  let dropped = 0;

  const queue = new WorkQueue<{ event: NewPoolEvent; queuedAt: number }>({
    maxConcurrent: config.polling.maxConcurrentTokens,
    maxQueued: config.polling.maxQueuedTokens,
    onDrop: ({ event, queuedAt }, queueLength) => {
      dropped++;
      // Recorded to the decision log, not just stdout: a dropped token that
      // leaves no trace would bias every later PASS/SKIP analysis toward the
      // tokens that happened to survive the queue.
      decisionLog.recordDropped({
        mint: event.mint,
        signature: event.signature,
        source: event.source,
        detectedAt: event.detectedAt,
        queueWaitMs: Date.now() - queuedAt,
      });
      logger.warn(
        `Queue full (${config.polling.maxQueuedTokens}) - dropped OLDEST pending token ${event.mint} ` +
          `(${event.source}). ${queueLength} still waiting. Detection is outpacing metrics collection; ` +
          `raise polling.maxConcurrentTokens only if your RPC provider has rate-limit headroom.`
      );
    },
    onError: ({ event }, err: any) => {
      logger.error(`Failed to process ${event.source} event ${event.signature}: ${err?.message || err}`);
    },
    worker: async ({ event, queuedAt }) => {
      const startedAt = Date.now();
      const queueWaitMs = startedAt - queuedAt;
      const detectedAtMs = Date.parse(event.detectedAt);

      const metrics = await collectTokenMetrics(connection, event);
      const result = evaluateFilters(event, metrics, config.filters);

      const decidedAt = Date.now();
      decisionLog.record(result, {
        detectionToDecisionMs: Number.isNaN(detectedAtMs) ? undefined : decidedAt - detectedAtMs,
        queueWaitMs,
      });
      decided++;

      // Baseline is the liquidity the DECISION was made on, so a later multiple
      // means "grew this much since we looked", not "since some other moment".
      // Scheduled after the decision is recorded so it can never sit in front
      // of the live path.
      outcomeTracker.schedule(event, metrics.liquiditySol ?? null);

      // A SKIP at t+0 is no longer final. Both known winners were rejected here
      // for being new and grew past the thresholds afterwards, so the token goes
      // under observation instead of being forgotten.
      if (result.decision !== "PASS") {
        watchlist.add(event, metrics.liquiditySol ?? null);
      }

      if (result.decision === "PASS" && tradingEngine) {
        await tradingEngine.onFilterPass(event, result);
      }
    },
  });

  watcher.on("newPool", (event: NewPoolEvent) => {
    detected++;
    queue.push({ event, queuedAt: Date.now() });
    // Scheduled alongside, not inside, the decision path - schedule() returns
    // immediately and a probe failure can never reach the live pipeline.
    delayProbe.schedule(event);
  });

  // Periodic visibility into whether the queue is keeping up. Silent when idle.
  const queueStatsTimer = setInterval(() => {
    const s = queue.stats();
    if (s.running > 0 || s.queued > 0) {
      logger.info(
        `queue: ${s.running} processing, ${s.queued} waiting, ${s.totalCompleted} done, ${s.totalDropped} dropped`
      );
      // Persisted too, so totals survive a crash rather than living only in stdout.
      decisionLog.recordQueueStats({ detected, decided, dropped, queued: s.queued, running: s.running });
    }
    if (config.delayProbe.enabled) {
      const p = delayProbe.stats();
      if (p.pendingTimers > 0 || p.running > 0) {
        logger.info(
          `delay-probe: ${p.completed}/${p.scheduled} observations done, ${p.pendingTimers} pending, ` +
            `${p.droppedObservations} dropped, ${p.skippedBySampling} tokens not sampled`
        );
        delayProbe.recordStats(detected);
      }
    }
    if (config.watchlist.enabled) {
      const w = watchlist.stats();
      if (w.watching > 0) {
        const stages = Object.entries(w.byStage).map(([k, v]) => `${k}=${v}`).join(" ");
        logger.info(
          `watchlist: ${w.watching} watched (${stages}), ${w.cheapChecks} liquidity reads, ` +
            `${w.fullChecks} full evaluations, ${w.passes} passes, ${w.evicted} evicted` +
            (w.skippedForBudget > 0 ? `, ${w.skippedForBudget} checks deferred for budget` : "")
        );
      }
    }
    if (config.outcomeTracker.enabled) {
      const o = outcomeTracker.stats();
      if (o.pendingCheckpoints > 0 || o.running > 0) {
        logger.info(
          `outcomes: ${o.completed}/${o.scheduled} readings done, ${o.pendingCheckpoints} pending, ` +
            `${o.missed} missed, ${o.replayedAfterRestart} replayed after restart`
        );
      }
    }
  }, 30_000);
  queueStatsTimer.unref?.();

  watcher.start();
  logger.info("Watcher running. Waiting for new pools... (Ctrl+C to stop)");

  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    clearInterval(queueStatsTimer);
    const s = queue.stats();
    decisionLog.recordQueueStats({ detected, decided, dropped, queued: s.queued, running: s.running });
    logger.info(
      `Final tally: detected=${detected} decided=${decided} dropped=${dropped} stillQueued=${s.queued}. ` +
        `These are also in the decision log (event="queue-stats") so the run can be reconciled later.`
    );
    delayProbe.recordStats(detected);
    delayProbe.stop();
    // Pending checkpoints stay on disk on purpose - the next run replays them.
    outcomeTracker.stop();
    watchlist.stop();
    tradingEngine?.stop();
    await watcher.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(`Fatal error: ${err?.message || err}`);
  process.exit(1);
});
