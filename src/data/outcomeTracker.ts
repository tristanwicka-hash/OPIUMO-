import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { loadConfig, OutcomeTrackerConfig } from "../config";
import { Logger, JsonlLog } from "../util/logger";
import { WorkQueue } from "../util/workQueue";
import { NewPoolEvent } from "../watcher/types";
import { getPumpFunLiquiditySol } from "./tokenMetrics";

/**
 * What actually HAPPENED to each token the bot saw.
 *
 * ## Why this exists
 *
 * Every other measurement in this repo describes the moment of the decision:
 * what the metrics were, whether the filters passed, how long collection took.
 * None of it records the only thing that decides whether a filter is any good -
 * whether the tokens it rejected went on to be worth buying.
 *
 * Without that, "0% pass rate" is unreadable. It means the filters are working
 * perfectly if none of the rejects went anywhere, and means they are throwing
 * away money if some did. Those are opposite conclusions from the same number,
 * and no amount of threshold tuning can tell them apart - which is exactly the
 * trap `Options-Trading-Research.md` names: moving a number until the output
 * looks nicer is not tuning, it is fitting noise.
 *
 * So this records outcomes and nothing else. It does not score, rank, or judge
 * a token, and deliberately does not define "winner" - that belongs in analysis
 * (`src/analysis/outcomeAnalysis.ts`), where the definition can be changed and
 * re-run against the same raw record. Collectors record facts; analysis decides
 * what they mean.
 *
 * ## Why it can track EVERY token when the delay probe samples 8%
 *
 * An outcome check needs one number - the bonding curve's SOL balance - which
 * is a single `getBalance` call. Full metric collection is ~5 batched calls and
 * fetches holder sets and transaction histories the outcome question does not
 * need. At roughly a fifth of the cost per observation and three checkpoints
 * instead of five, tracking 100% of detections costs less RPC than the delay
 * probe does at 8%. Coverage matters more here than it does for the probe: a
 * sampled outcome study answers "what happened to a random 8%", but the
 * question worth answering is "did we miss a winner", and winners are rare
 * enough (1-2% in the first look at real data) that sampling them at 8% would
 * mean seeing almost none.
 *
 * ## Surviving a restart
 *
 * The delay probe's longest checkpoint is 2 hours and it keeps pending work in
 * `setTimeout` only, so a restart silently drops it. At a 24-hour horizon that
 * failure mode would eat essentially every observation - this bot gets
 * restarted far more often than once a day. So pending checkpoints are written
 * to disk and reloaded at startup: due ones fire immediately, future ones are
 * rescheduled for their remaining time, and ones missed by more than
 * `lateToleranceMs` are recorded as missed rather than taken late and quietly
 * treated as on-time.
 */

export interface OutcomeRecord {
  mint: string;
  source: string;
  signature: string;
  detectedAt: string;
  /** Scheduled age of this checkpoint, from outcomeTracker.checkpointsSeconds. */
  checkpointSeconds: number;
  /** Real age when the reading was taken - timer drift, queue wait, and restart replay all show up here. */
  actualElapsedMs: number;
  ok: boolean;
  error: string | null;
  /** The whole point: bonding-curve SOL at this checkpoint. */
  liquiditySol: number | null;
  /**
   * Liquidity at detection, carried on every record so a multiple is
   * computable from one line without joining back to another log. Null when
   * the t+0 reading itself failed - which must stay distinguishable from a
   * real zero, since "we could not measure the baseline" and "the baseline was
   * nothing" support completely different conclusions.
   */
  baselineLiquiditySol: number | null;
  /** True when this reading was replayed after a restart rather than fired live. */
  replayedAfterRestart: boolean;
}

interface PendingCheckpoint {
  event: NewPoolEvent;
  checkpointSeconds: number;
  /** Absolute epoch ms this is due - survives restarts, unlike a relative timer. */
  dueAtMs: number;
  baselineLiquiditySol: number | null;
}

interface CheckpointJob extends PendingCheckpoint {
  replayedAfterRestart: boolean;
}

export class OutcomeTracker {
  private readonly connection: Connection;
  private readonly config: OutcomeTrackerConfig;
  private readonly logger: Logger;
  private readonly jsonl: JsonlLog;
  private readonly queue: WorkQueue<CheckpointJob>;
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Keyed `${mint}:${checkpointSeconds}` so a replayed checkpoint can't be scheduled twice. */
  private readonly pending = new Map<string, PendingCheckpoint>();
  private readonly statePath: string;

  private scheduled = 0;
  private completed = 0;
  private missed = 0;
  private replayed = 0;
  private stopped = false;

  constructor(connection: Connection, configOverride?: Partial<OutcomeTrackerConfig>) {
    const appConfig = loadConfig();
    this.connection = connection;
    this.config = { ...appConfig.outcomeTracker, ...configOverride };
    this.logger = new Logger("outcomes", appConfig.logging.level);
    this.jsonl = new JsonlLog(appConfig.logging.outcomeFile, appConfig.logging.maxLogFileSizeMB);
    this.statePath = this.config.pendingStateFile;

    this.queue = new WorkQueue<CheckpointJob>({
      maxConcurrent: this.config.maxConcurrentChecks,
      maxQueued: this.config.maxQueuedChecks,
      onDrop: (job) => {
        // Same reasoning as the delay probe: a dropped observation is
        // survivable but must never be invisible, because the ones dropped are
        // the ones arriving at the busiest moments - exactly the sample bias
        // that would make a rare-winner rate look lower than it is.
        this.missed++;
        this.write(job, null, "dropped - outcome queue full, reading never taken");
      },
      onError: (job, err: any) => {
        this.logger.error(
          `outcome check failed for ${job.event.mint} at ${job.checkpointSeconds}s: ${err?.message || err}`
        );
      },
      worker: (job) => this.runCheck(job),
    });
  }

  /**
   * Reload checkpoints left pending by a previous process. Call once at
   * startup, before any new detections arrive.
   */
  restorePending(nowMs = Date.now()): void {
    if (!this.config.enabled) return;
    let raw: string;
    try {
      if (!fs.existsSync(this.statePath)) return;
      raw = fs.readFileSync(this.statePath, "utf8");
    } catch (err: any) {
      this.logger.warn(`could not read pending outcome state: ${err?.message || err}`);
      return;
    }

    let parsed: PendingCheckpoint[];
    try {
      parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("expected an array");
    } catch (err: any) {
      // A corrupt state file must not stop the bot from starting. Losing
      // pending checkpoints is a data gap; failing to boot is an outage.
      this.logger.warn(`pending outcome state is unreadable, starting fresh: ${err?.message || err}`);
      return;
    }

    let restored = 0;
    for (const p of parsed) {
      if (!p?.event?.mint || typeof p.dueAtMs !== "number") continue;
      const key = this.keyOf(p.event.mint, p.checkpointSeconds);
      if (this.pending.has(key)) continue;

      const overdueMs = nowMs - p.dueAtMs;
      if (overdueMs > this.config.lateToleranceMs) {
        // Taking a 24h reading three days late and filing it as a 24h reading
        // would silently corrupt the very distribution this exists to measure.
        this.missed++;
        this.write(
          { ...p, replayedAfterRestart: true },
          null,
          `missed - checkpoint was due ${Math.round(overdueMs / 1000)}s ago, beyond lateToleranceMs`
        );
        continue;
      }

      this.pending.set(key, p);
      this.armTimer(p, Math.max(0, p.dueAtMs - nowMs), true);
      restored++;
      this.replayed++;
    }

    if (restored > 0 || this.missed > 0) {
      this.logger.info(
        `restored ${restored} pending outcome checkpoint(s) from a previous run` +
          (this.missed > 0 ? `, ${this.missed} were too late to take and were recorded as missed` : "")
      );
    }
    this.persist();
  }

  /**
   * Schedule every checkpoint for one detected token. Returns immediately and
   * can never block or fail the live decision path.
   */
  schedule(event: NewPoolEvent, baselineLiquiditySol: number | null): void {
    if (!this.config.enabled || this.stopped) return;
    if (this.config.sampleRate < 1 && Math.random() >= this.config.sampleRate) return;
    if (this.pending.size >= this.config.maxPendingCheckpoints) {
      this.logger.warn(
        `not tracking outcomes for ${event.mint}: ${this.pending.size} checkpoints already pending ` +
          `(outcomeTracker.maxPendingCheckpoints)`
      );
      return;
    }

    const nowMs = Date.now();
    for (const checkpointSeconds of this.config.checkpointsSeconds) {
      const key = this.keyOf(event.mint, checkpointSeconds);
      if (this.pending.has(key)) continue;
      const p: PendingCheckpoint = {
        event,
        checkpointSeconds,
        dueAtMs: nowMs + checkpointSeconds * 1000,
        baselineLiquiditySol,
      };
      this.pending.set(key, p);
      this.armTimer(p, checkpointSeconds * 1000, false);
      this.scheduled++;
    }
    this.persist();
  }

  private keyOf(mint: string, checkpointSeconds: number): string {
    return `${mint}:${checkpointSeconds}`;
  }

  private armTimer(p: PendingCheckpoint, delayMs: number, replayedAfterRestart: boolean): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.queue.push({ ...p, replayedAfterRestart });
    }, delayMs);
    // Never hold the process open for a pending measurement.
    timer.unref?.();
    this.timers.add(timer);
  }

  private async runCheck(job: CheckpointJob): Promise<void> {
    const detectedAtMs = Date.parse(job.event.detectedAt);
    let liquiditySol: number | null = null;
    let error: string | null = null;

    try {
      if (job.event.source === "pumpfun" && job.event.poolAddress) {
        liquiditySol = await getPumpFunLiquiditySol(this.connection, new PublicKey(job.event.poolAddress));
      } else {
        // Raydium outcome tracking needs the vault pair rather than a plain
        // balance read. Recorded as an explicit reason rather than a silent
        // null so the gap is visible in analysis instead of looking like a
        // failed read.
        error = `outcome tracking not implemented for source "${job.event.source}" (needs a vault-pair read, not a balance read)`;
      }
    } catch (err: any) {
      error = err?.message || String(err);
    }

    this.pending.delete(this.keyOf(job.event.mint, job.checkpointSeconds));
    this.persist();
    this.write(job, liquiditySol, error, detectedAtMs);
    if (liquiditySol !== null) this.completed++;
  }

  private write(job: CheckpointJob, liquiditySol: number | null, error: string | null, detectedAtMs?: number): void {
    const parsedDetectedAt = detectedAtMs ?? Date.parse(job.event.detectedAt);
    const record: OutcomeRecord = {
      mint: job.event.mint,
      source: job.event.source,
      signature: job.event.signature,
      detectedAt: job.event.detectedAt,
      checkpointSeconds: job.checkpointSeconds,
      actualElapsedMs: Number.isNaN(parsedDetectedAt) ? -1 : Date.now() - parsedDetectedAt,
      ok: liquiditySol !== null,
      error,
      liquiditySol,
      baselineLiquiditySol: job.baselineLiquiditySol,
      replayedAfterRestart: job.replayedAfterRestart,
    };
    this.jsonl.append(record as unknown as Record<string, unknown>);
  }

  /** Pending checkpoints, written atomically so a crash mid-write can't corrupt the file. */
  private persist(): void {
    if (!this.config.enabled) return;
    try {
      const dir = path.dirname(this.statePath);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.pending.values()]));
      fs.renameSync(tmp, this.statePath);
    } catch (err: any) {
      // Losing persistence degrades this to the delay probe's behaviour
      // (in-memory only). Worth a warning, never worth crashing the bot.
      this.logger.warn(`could not persist pending outcome state: ${err?.message || err}`);
    }
  }

  stats() {
    return {
      scheduled: this.scheduled,
      completed: this.completed,
      missed: this.missed,
      replayedAfterRestart: this.replayed,
      pendingCheckpoints: this.pending.size,
      pendingTimers: this.timers.size,
      ...this.queue.stats(),
    };
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    // Pending checkpoints stay on disk deliberately: the next run replays them.
    this.persist();
  }
}
