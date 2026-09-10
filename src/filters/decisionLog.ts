import { loadConfig } from "../config";
import { Logger, JsonlLog } from "../util/logger";
import { FilterResult, formatDecisionLine } from "./engine";

/**
 * Shape of a "never evaluated" record. Pure and exported so it can be tested
 * without constructing a DecisionLog (which loads config, and therefore needs
 * RPC_URL set).
 */
export function buildDroppedRecord(params: {
  mint: string;
  signature: string;
  source: string;
  detectedAt: string;
  queueWaitMs: number;
}) {
  return {
    event: "dropped",
    decision: "DROPPED",
    source: params.source,
    mint: params.mint,
    signature: params.signature,
    detectedAt: params.detectedAt,
    queueWaitMs: params.queueWaitMs,
    reasons: ["dropped - queue full, token was never evaluated"],
  };
}

/**
 * Writes every PASS/SKIP decision to both the console (so you can watch it
 * live) and logs/decisions.jsonl (so you can grep/replay/tune thresholds
 * later without re-running the bot). This is the file to stare at while you
 * do the "manually verify the filter logic is accurate" step from the
 * README non-negotiables - it never buys anything, it only records what it
 * would have done.
 */
export class DecisionLog {
  private logger: Logger;
  private jsonl: JsonlLog;

  constructor() {
    const config = loadConfig();
    this.logger = new Logger("filters", config.logging.level);
    this.jsonl = new JsonlLog(config.logging.decisionsFile, config.logging.maxLogFileSizeMB);
  }

  /**
   * `timing.detectionToDecisionMs` is wall-clock from the watcher seeing the
   * pool to this decision being made - including any time spent waiting in the
   * work queue. Every latency figure before this was an estimate; this is the
   * number to tune against.
   */
  record(result: FilterResult, timing?: { detectionToDecisionMs?: number; queueWaitMs?: number }): void {
    this.logger.info(formatDecisionLine(result));
    this.jsonl.append({
      decision: result.decision,
      source: result.source,
      mint: result.mint,
      signature: result.signature,
      reasons: result.reasons,
      metrics: result.metrics,
      evaluatedAt: result.evaluatedAt,
      detectionToDecisionMs: timing?.detectionToDecisionMs ?? null,
      queueWaitMs: timing?.queueWaitMs ?? null,
      stage1ElapsedMs: result.metrics.stage1ElapsedMs,
      stage2ElapsedMs: result.metrics.stage2ElapsedMs,
      totalMetricsMs: result.metrics.totalElapsedMs,
      activitySkippedEarly: result.metrics.activitySkippedEarly,
    });
  }

  /**
   * A token that was never evaluated because the work queue was full.
   *
   * Without this, dropped tokens leave NO trace in the decision log, so any
   * later analysis would compute PASS/SKIP over only the tokens that survived
   * the queue - a biased subset, and invisible in the data precisely when the
   * bot is most overloaded. Writing a record per drop makes the run
   * reconcilable after the fact: detected = decided + dropped.
   *
   * `decision` is the string "DROPPED", deliberately NOT one of the PASS/SKIP
   * values in the Decision type, so existing tallies cannot silently absorb
   * these as if they were real filter outcomes.
   */
  /**
   * A token the scheduler refused to look at.
   *
   * Recorded to decisions.jsonl, not just stdout, and with its own event name.
   * Without this, an idle window and a genuinely quiet night produce the same
   * thing in the logs - nothing - and every later analysis would read hours the
   * bot deliberately sat out as hours with no launches. That is the same
   * masking defect as a skipped test suite counted as a pass.
   *
   * It is deliberately NOT a SKIP: a SKIP means the filters looked and said no.
   * This token was never evaluated, and conflating the two would corrupt the
   * pass-rate denominator.
   */
  recordOutsideSchedule(params: {
    mint: string;
    signature: string;
    source: string;
    detectedAt: string;
    reason: string;
    detail: string;
    nextOpenUtc: string | null;
  }): void {
    this.logger.info(
      `NOT EVALUATED ${params.mint} (${params.source}) - ${params.detail}`
    );
    this.jsonl.append({
      event: "outside-schedule",
      decision: "NOT_EVALUATED",
      mint: params.mint,
      signature: params.signature,
      source: params.source,
      detectedAt: params.detectedAt,
      scheduleReason: params.reason,
      detail: params.detail,
      nextOpenUtc: params.nextOpenUtc,
    });
  }

  recordDropped(params: { mint: string; signature: string; source: string; detectedAt: string; queueWaitMs: number }): void {
    this.logger.warn(
      `[DROPPED] ${params.source.padEnd(7)} ${params.mint}  never evaluated - queue was full ` +
        `(waited ${params.queueWaitMs}ms). Recorded in the decision log so the run stays reconcilable.`
    );
    this.jsonl.append(buildDroppedRecord(params));
  }

  /**
   * A periodic/shutdown tally, written into the same log so totals survive a
   * crash and can be read back without replaying every line.
   */
  recordQueueStats(stats: {
    detected: number;
    decided: number;
    dropped: number;
    /** Detected while the scheduler was closed, so never evaluated. Optional: absent in runs logged before the scheduler existed. */
    notEvaluated?: number;
    queued: number;
    running: number;
  }): void {
    this.jsonl.append({ event: "queue-stats", ...stats });
  }

  /** For tests/tuning: replay everything logged so far. */
  readAll() {
    return this.jsonl.readAll();
  }
}
