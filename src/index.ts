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
import { evaluateSchedule, weeklyOpenHours } from "./schedule/scheduler";
import { CreditBreaker } from "./rpc/creditBudget";
import { getRpcMeter } from "./rpc/connection";
import { PaperBook, summarise } from "./trading/paperExecution";
import { constantProductProceeds } from "./trading/trailingStop";
import { evaluateShadows, ShadowSet } from "./filters/shadowFilters";
import { JsonlLog } from "./util/logger";

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
  /**
   * Paper execution. RECORDS ONLY - no wallet, no signing, no order path. It is
   * fed data the live path already fetched, so it costs zero additional RPC
   * calls. See config paperExecution._comment.
   */
  const paperCfg = config.paperExecution;
  const paperLog = new JsonlLog(paperCfg.logFile, config.logging.maxLogFileSizeMB);
  const paperBook = new PaperBook(
    {
      poolFraction: paperCfg.poolFraction,
      maxOpenPositions: paperCfg.maxOpenPositions,
      includeRejected: paperCfg.includeRejected,
      trailing: paperCfg.trailing,
    },
    constantProductProceeds
  );
  if (paperCfg.enabled) {
    logger.warn(
      `*** PAPER EXECUTION ON (records only) *** ${paperCfg.poolFraction * 100}% of pool per position, ` +
        `max ${paperCfg.maxOpenPositions} open, includeRejected=${paperCfg.includeRejected}, ` +
        `entry priced at REALIZABLE PROCEEDS -> ${paperCfg.logFile}. No wallet, no signing, no order path: ` +
        `trading.enabled is irrelevant because there is nothing to enable. Zero added RPC calls.`
    );
  }

  /**
   * Shadow filters. Evaluated synchronously on the SAME metrics object the live
   * filters just used, so they add no calls and cannot change any behaviour.
   */
  const shadowCfg = config.shadowFilters;
  const shadowLog = new JsonlLog(shadowCfg.logFile, config.logging.maxLogFileSizeMB);
  const shadowSets: ShadowSet[] = shadowCfg.sets.map((s) => ({
    id: s.id,
    rationale: s.rationale,
    // Only the named keys are overridden - the rest track the live thresholds.
    filters: { ...config.filters, ...s.overrides },
  }));
  if (shadowCfg.enabled) {
    logger.warn(
      `*** SHADOW FILTERS ON (measurement only) *** ${shadowSets.length} set(s): ` +
        `${shadowSets.map((s) => s.id).join(", ")} -> ${shadowCfg.logFile}. Evaluated on already-fetched ` +
        `metrics, zero added RPC calls, no effect on any live PASS/SKIP.`
    );
  }

  const watchlist = new Watchlist(connection, {
    onPass: async (event, result) => {
      if (tradingEngine) await tradingEngine.onFilterPass(event, result);
    },
    /**
     * Every liquidity reading the watchlist already paid for, handed to the
     * paper book. This is what makes paper tracking free.
     */
    onObservation: (mint, liquiditySol, atIso) => {
      if (!paperCfg.enabled) return;
      const before = paperBook.openPositions().find((p) => p.mint === mint);
      if (!before) return;
      const after = paperBook.observe(mint, { ts: atIso, liquiditySol });
      if (after && after.outcome !== "open") {
        paperLog.append({ event: "paper-close", ...after, state: undefined });
      }
    },
  });
  watchlist.start();

  // Reconciliation counters:
  //   detected === decided + dropped + notEvaluated + still-queued
  // `notEvaluated` joined this identity when the scheduler did. Leaving it out
  // would have made every scheduled run appear to lose tokens, which is exactly
  // the kind of quiet discrepancy that gets explained away rather than chased.
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

      /**
       * Shadow filters and paper execution, both fed the metrics object the
       * live filters just used. Neither fetches anything, and both run AFTER
       * the live decision is recorded so they cannot influence it.
       */
      if (shadowCfg.enabled && shadowSets.length > 0) {
        const shadow = evaluateShadows(event, metrics, result.decision === "PASS" ? "PASS" : "SKIP", shadowSets);
        shadowLog.append({ event: "shadow-eval", ...shadow });
      }

      if (paperCfg.enabled) {
        const { opened, refusal } = paperBook.open({
          mint: event.mint,
          at: new Date().toISOString(),
          liquiditySol: metrics.liquiditySol,
          liveVerdict: result.decision === "PASS" ? "PASS" : "REJECTED",
        });
        if (opened) {
          paperLog.append({
            event: "paper-open",
            mint: opened.mint,
            openedAt: opened.openedAt,
            liveVerdict: opened.liveVerdict,
            entryLiquiditySol: opened.entryLiquiditySol,
            entryProceedsSol: opened.entryProceedsSol,
            poolFraction: opened.poolFraction,
            openNow: paperBook.openCount,
          });
        } else if (refusal) {
          // Recorded, never silent - a cap applied quietly would bias the sample.
          paperLog.append({ event: "paper-refused", mint: refusal.mint, reason: refusal.reason });
        }
      }

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

  // Active-window schedule. A COST control: it decides whether the bot looks,
  // never what passes. Nothing below reads a filter threshold and nothing in
  // src/filters/ reads the schedule - keeping them independent is what lets the
  // outcome study stay interpretable, because "this token was skipped" has to
  // keep meaning exactly one thing.
  const schedule = config.schedule;
  if (schedule.enabled) {
    logger.warn(
      `*** SCHEDULE IS ON *** windows (UTC): ` +
        schedule.activeWindows.map((w) => `${w.days} ${w.start}-${w.end}`).join("; ") +
        ` = ${weeklyOpenHours(schedule).toFixed(1)}h/week (${((weeklyOpenHours(schedule) / 168) * 100).toFixed(0)}% of 24/7). ` +
        `Outside those hours detected tokens are NOT evaluated and are recorded to ` +
        `${config.logging.decisionsFile} as "outside-schedule" - so an idle window and a quiet ` +
        `night never look the same in the logs.`
    );
  } else {
    logger.info("Schedule is OFF - running continuously. Turn it on against scripts/hourly-histogram.ts, not a blog.");
  }
  let notEvaluated = 0;

  // The credit circuit breaker. Constructed here so a bad budget fails at
  // startup rather than at the moment it would have saved the plan.
  const breaker = new CreditBreaker(config.creditBudget);
  let creditHalted = 0;
  if (config.creditBudget.enabled) {
    const opening = breaker.decide(new Date());
    logger.warn(
      `*** CREDIT BREAKER IS ON *** budget ${config.creditBudget.dailyCredits.toLocaleString()} credits/day, ` +
        `${config.creditBudget.monthlyCredits.toLocaleString()}/month, warning at ` +
        `${Math.round(config.creditBudget.warnFraction * 100)}%. At the limit detection STOPS and every ` +
        `skipped token is recorded to ${config.logging.decisionsFile} as "credit-halt" - so a halt and a ` +
        `quiet night never look the same. Resuming from ${config.creditBudget.ledgerFile}: ${opening.detail}`
    );
  } else {
    logger.warn(
      "*** CREDIT BREAKER IS OFF *** nothing will stop an overrun. This is how the plan was emptied once already."
    );
  }

  watcher.on("newPool", (event: NewPoolEvent) => {
    detected++;

    const now = new Date();

    // The credit gate, ahead of the schedule gate and ahead of anything that
    // spends. It charges nothing itself: it reads the meter's own lifetime
    // credit counter and books the delta, so the two can never drift and no
    // call is priced twice.
    const meterSnapshot = getRpcMeter()?.snapshot(Date.now());
    if (meterSnapshot) breaker.chargeFromMeter(meterSnapshot.credits, now);
    const budget = breaker.decide(now);
    breaker.persistThrottled(Date.now());
    if (!budget.allowed) {
      creditHalted++;
      notEvaluated++;
      decisionLog.recordCreditHalt({
        mint: event.mint,
        signature: event.signature,
        source: event.source,
        detectedAt: event.detectedAt,
        reason: budget.reason,
        detail: budget.detail,
        resumesAt: budget.resumesAt,
        dayCredits: budget.dayCredits,
        monthCredits: budget.monthCredits,
      });
      // Same reasoning as the schedule gate below: the delay probe and outcome
      // tracker both spend, so a halt has to stop them too or it is not a halt.
      return;
    }

    // The gate. Checked per detection rather than on a timer so the window
    // boundary is exact, and evaluated BEFORE anything that costs an RPC call -
    // metrics collection is the ~110-call step this exists to avoid paying for.
    const verdict = evaluateSchedule(schedule, now);
    if (!verdict.active) {
      notEvaluated++;
      decisionLog.recordOutsideSchedule({
        mint: event.mint,
        signature: event.signature,
        source: event.source,
        detectedAt: event.detectedAt,
        reason: verdict.reason,
        detail: verdict.detail,
        nextOpenUtc: verdict.nextOpenUtc,
      });
      // The delay probe and outcome tracker are skipped too - both spend RPC
      // calls, and tracking what a token became when we never evaluated it
      // would put outcome data in the log for a decision that was never made.
      // Checkpoints ALREADY pending from before the window closed still run:
      // those belong to tokens that were evaluated, and dropping them would
      // throw away the measurement this bot exists to gather.
      return;
    }

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
        if (paperCfg.enabled) {
      const ps = summarise(paperBook);
      logger.info(
        `Paper book: ${ps.opened} opened (${ps.open} still open), ${ps.closed} closed, ` +
          `${ps.exitFailed} exit-failed, ${ps.abandoned} abandoned, ${ps.refused} refused ` +
          `(${ps.refusedByCap} by the ${paperCfg.maxOpenPositions}-position cap). ` +
          `Realised ${ps.realisedPnlSol.toFixed(4)} SOL. ` +
          `By live verdict - PASS: ${ps.byVerdict.PASS.closed} closed / ${ps.byVerdict.PASS.realisedPnlSol.toFixed(4)} SOL, ` +
          `REJECTED: ${ps.byVerdict.REJECTED.closed} closed / ${ps.byVerdict.REJECTED.realisedPnlSol.toFixed(4)} SOL.`
      );
      paperLog.append({ event: "paper-summary", ...ps });
    }

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
    decisionLog.recordQueueStats({
      detected,
      decided,
      dropped,
      notEvaluated,
      queued: s.queued,
      running: s.running,
    });
    const accounted = decided + dropped + notEvaluated + s.queued;
    // notEvaluated is split by cause. Rolling a credit halt into "outside
    // schedule" would hide the one of the two that needs someone to act.
    logger.info(
      `Final tally: detected=${detected} decided=${decided} dropped=${dropped} ` +
        `notEvaluated=${notEvaluated} (${notEvaluated - creditHalted} outside schedule, ` +
        `${creditHalted} credit-halted) stillQueued=${s.queued}. ` +
        `These are also in the decision log (event="queue-stats") so the run can be reconciled later.`
    );
    // The last word on spend, written before anything else can fail.
    breaker.persist();
    logger.info(`Credit ledger: ${breaker.decide(new Date()).detail}`);
    if (creditHalted > 0) {
      logger.warn(
        `*** ${creditHalted} token(s) went unevaluated because the credit breaker had HALTED detection. ` +
          `That is a budget event, not a quiet market - see event="credit-halt" in ${config.logging.decisionsFile}. ***`
      );
    }
    if (accounted !== detected) {
      // Says so rather than printing a tally that quietly does not add up.
      logger.warn(
        `Reconciliation gap: ${detected} detected but ${accounted} accounted for ` +
          `(difference ${detected - accounted}). Some tokens went somewhere this tally does not name.`
      );
    }
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
