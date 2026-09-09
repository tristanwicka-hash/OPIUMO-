import { Connection } from "@solana/web3.js";
import { loadConfig, DelayProbeConfig } from "../config";
import { Logger, JsonlLog } from "../util/logger";
import { WorkQueue } from "../util/workQueue";
import { NewPoolEvent } from "../watcher/types";
import { collectTokenMetrics, TokenMetrics } from "./tokenMetrics";

/**
 * Delayed re-measurement of tokens the watcher already detected.
 *
 * ## Why this exists
 *
 * The bot evaluates a token a few hundred milliseconds after it launches. At
 * that age it structurally CANNOT satisfy `minUniqueWallets` (20) or
 * `minTransactionCount` (30) - nobody has had time to trade it yet. So the
 * filters reject essentially everything, and no threshold tuning can fix that,
 * because the problem is *when* we look, not *what* we look for.
 *
 * Rather than guess a better delay, this re-collects metrics for the same
 * token at several ages and writes each observation to its own log. The right
 * evaluation delay can then be read off real data.
 *
 * ## What it deliberately does NOT do
 *
 * Nothing here feeds a PASS/SKIP, a trade, or the decision log. The live t+0
 * pipeline runs exactly as before and never waits on a probe. This is a
 * parallel observer, and it is safe to switch off (`delayProbe.enabled`).
 *
 * ## Concurrency
 *
 * Probes run on their OWN bounded WorkQueue, separate from the live pipeline's.
 * Sharing one queue would let a burst of measurements delay real decisions -
 * the latency we just cut from 20s to ~200ms. Separate queues keep the live
 * path's budget intact while still capping probe work, so the process-wide
 * ceiling is `polling.maxConcurrentTokens + delayProbe.maxConcurrentProbes`
 * (2 + 3 by default) rather than unbounded.
 *
 * Throughput: at ~20 detections/min x 3 observations each, the probe must
 * sustain ~1 observation/second. Batching the transaction fetches
 * (getParsedTransactions) cut a single observation from ~101 HTTP round trips
 * to ~5, and a longer per-call timeout stopped ~29% of observations being
 * abandoned mid-flight. Under sustained overload the queue still sheds work -
 * see onDrop, which records what it shed.
 */
export interface DelayProbeRecord {
  mint: string;
  source: string;
  signature: string;
  detectedAt: string;
  /** The scheduled age, from delayProbe.delaysSeconds. */
  delaySeconds: number;
  /** What the age actually was when collection finished - timer drift plus queue wait. */
  actualElapsedMs: number;
  /** How long the probe waited for a free concurrency slot. */
  queueWaitMs: number;
  /** False when metric collection threw outright. */
  ok: boolean;
  error: string | null;
  uniqueWalletCount: number | null;
  transactionCount: number | null;
  topHolderPercent: number | null;
  liquiditySol: number | null;
  devWalletPercent: number | null;
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
  /** Per-metric fetch failures, so a null can be told apart from a real zero. */
  warnings: string[];
  collectionMs: number | null;
}

interface ProbeJob {
  event: NewPoolEvent;
  delaySeconds: number;
  queuedAt: number;
}

export class DelayProbe {
  private readonly connection: Connection;
  private readonly config: DelayProbeConfig;
  private readonly logger: Logger;
  private readonly jsonl: JsonlLog;
  private readonly queue: WorkQueue<ProbeJob>;
  /** Timers still pending, so shutdown can cancel them and memory stays bounded. */
  private readonly timers = new Set<NodeJS.Timeout>();
  private pendingTokens = 0;
  private scheduled = 0;
  private completed = 0;
  private skippedAtCapacity = 0;
  private dropped = 0;
  private skippedBySampling = 0;
  private stopped = false;

  constructor(connection: Connection, configOverride?: Partial<DelayProbeConfig>) {
    const appConfig = loadConfig();
    this.connection = connection;
    this.config = { ...appConfig.delayProbe, ...configOverride };
    this.logger = new Logger("delay-probe", appConfig.logging.level);
    this.jsonl = new JsonlLog(appConfig.logging.delayProbeFile, appConfig.logging.maxLogFileSizeMB);

    this.queue = new WorkQueue<ProbeJob>({
      maxConcurrent: this.config.maxConcurrentProbes,
      maxQueued: this.config.maxQueuedProbes,
      onDrop: (job) => {
        // Nothing downstream depends on a measurement, so dropping one is
        // survivable - but it must never be invisible. A silently missing
        // observation biases the sample toward whatever the probe happened to
        // keep up with, which is exactly the wrong direction: the tokens dropped
        // are the ones arriving during the busiest moments. Written as a record
        // with ok:false so analysis can reconcile scheduled vs observed.
        this.dropped++;
        this.jsonl.append({
          mint: job.event.mint,
          source: job.event.source,
          signature: job.event.signature,
          detectedAt: job.event.detectedAt,
          delaySeconds: job.delaySeconds,
          actualElapsedMs: -1,
          queueWaitMs: Date.now() - job.queuedAt,
          ok: false,
          error: "dropped - probe queue full, observation never taken",
          uniqueWalletCount: null,
          transactionCount: null,
          topHolderPercent: null,
          liquiditySol: null,
          devWalletPercent: null,
          mintAuthorityRenounced: null,
          freezeAuthorityRenounced: null,
          warnings: [],
          collectionMs: null,
        });
        this.logger.warn(
          `probe queue full - dropped the ${job.delaySeconds}s observation for ${job.event.mint} (recorded)`
        );
      },
      onError: (job, err: any) => {
        this.logger.error(`probe failed for ${job.event.mint} at ${job.delaySeconds}s: ${err?.message || err}`);
      },
      worker: (job) => this.runProbe(job),
    });
  }

  /**
   * Schedule every configured observation for one detected token. Returns
   * immediately - the caller (an event handler) is never blocked, and a probe
   * failure can never propagate into the live path.
   */
  schedule(event: NewPoolEvent): void {
    if (!this.config.enabled || this.stopped) return;

    // Sampling, not throttling. Measuring every detected token needs ~22 RPC
    // calls/second at the observed launch rate, which exceeds the plan's limit
    // and degenerates into 429 retries and timed-out observations - i.e. trying
    // to measure everything measured almost nothing. A sampled token is
    // measured at FULL accuracy; only coverage is reduced, which is the correct
    // trade when the goal is a representative sample rather than an audit.
    if (Math.random() >= this.config.sampleRate) {
      this.skippedBySampling++;
      return;
    }

    if (this.pendingTokens >= this.config.maxPendingTokens) {
      this.skippedAtCapacity++;
      this.logger.warn(
        `not scheduling probes for ${event.mint}: ${this.pendingTokens} tokens already pending ` +
          `(delayProbe.maxPendingTokens). Detection is outpacing measurement.`
      );
      return;
    }

    this.pendingTokens++;
    let remaining = this.config.delaysSeconds.length;

    for (const delaySeconds of this.config.delaysSeconds) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.queue.push({ event, delaySeconds, queuedAt: Date.now() });
        remaining--;
        if (remaining === 0) this.pendingTokens--;
      }, delaySeconds * 1000);

      // Never hold the process open just for a pending measurement.
      timer.unref?.();
      this.timers.add(timer);
      this.scheduled++;
    }
  }

  private async runProbe(job: ProbeJob): Promise<void> {
    const startedAt = Date.now();
    const detectedAtMs = Date.parse(job.event.detectedAt);
    const queueWaitMs = startedAt - job.queuedAt;

    let metrics: TokenMetrics | null = null;
    let error: string | null = null;
    try {
      // Reuses the live collection pipeline rather than duplicating it, but
      // forces the activity metrics: they are the entire point of the
      // measurement, and the two-stage gate would otherwise skip them for any
      // token already failing a stage-1 rule (currently all of them).
      metrics = await collectTokenMetrics(
        this.connection,
        job.event,
        // A probe is not latency-critical, so it gets a longer per-call budget
        // than the live path. Timing out at 8s wasted the whole observation
        // (~29% of them in the first live run) along with every call already
        // spent on it - slower and less accurate at the same time.
        { metricsFetchTimeoutMs: this.config.fetchTimeoutMs },
        undefined,
        { forceActivityMetrics: true }
      );
    } catch (err: any) {
      error = err?.message || String(err);
    }

    const record: DelayProbeRecord = {
      mint: job.event.mint,
      source: job.event.source,
      signature: job.event.signature,
      detectedAt: job.event.detectedAt,
      delaySeconds: job.delaySeconds,
      actualElapsedMs: Number.isNaN(detectedAtMs) ? -1 : Date.now() - detectedAtMs,
      queueWaitMs,
      ok: metrics !== null,
      error,
      uniqueWalletCount: metrics?.uniqueWallets ?? null,
      transactionCount: metrics?.transactionCount ?? null,
      topHolderPercent: metrics?.topHolderPercent ?? null,
      liquiditySol: metrics?.liquiditySol ?? null,
      devWalletPercent: metrics?.devWalletPercent ?? null,
      mintAuthorityRenounced: metrics?.mintAuthorityRenounced ?? null,
      freezeAuthorityRenounced: metrics?.freezeAuthorityRenounced ?? null,
      warnings: metrics?.warnings ?? [],
      collectionMs: metrics?.totalElapsedMs ?? null,
    };

    this.jsonl.append(record as unknown as Record<string, unknown>);
    this.completed++;

    this.logger.debug(
      `probe ${job.delaySeconds}s ${job.event.mint}: wallets=${record.uniqueWalletCount ?? "?"} ` +
        `txs=${record.transactionCount ?? "?"} liq=${record.liquiditySol ?? "?"}`
    );
  }

  stats() {
    return {
      scheduled: this.scheduled,
      completed: this.completed,
      pendingTimers: this.timers.size,
      pendingTokens: this.pendingTokens,
      skippedAtCapacity: this.skippedAtCapacity,
      droppedObservations: this.dropped,
      skippedBySampling: this.skippedBySampling,
      sampleRate: this.config.sampleRate,
      ...this.queue.stats(),
    };
  }

  /**
   * Write a tally into the observation log itself, so analysis can reconcile
   * coverage without having to know what the config said at run time:
   * detected = sampled + skippedBySampling, and sampled x delays = completed +
   * dropped + still-pending.
   */
  recordStats(detected: number): void {
    if (!this.config.enabled) return;
    this.jsonl.append({ event: "probe-stats", detected, ...this.stats() });
  }

  /** Cancel every pending observation. Safe to call more than once. */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
