/**
 * Replay harness: run recorded decisions through the CURRENT filter code.
 *
 * Evaluating a filter change used to mean changing it and waiting days. Every
 * decision this bot has ever made is already on disk with the metrics it was
 * made from, so the same question can be answered in seconds against 32,000
 * real tokens instead of a hunch and a week.
 *
 * ## Rotated files are most of the data
 *
 * The logs rotate. The last time someone read `decisions.jsonl` alone they
 * looked at 2,110 of 17,186 records - 15,076 were in rotated files and were
 * silently missing from the answer. `decisionLogFiles()` therefore globs the
 * rotated siblings too, and `loadRecords()` reports how many files it read so
 * a partial read is visible rather than assumed.
 *
 * ## Unreplayable is a category, not a pass and not a fail
 *
 * A record written before a metric existed cannot be replayed through code
 * that reads that metric. Counting it as either outcome would be a fabricated
 * result, so it is its own bucket, and the report names the missing field.
 *
 * The distinction that matters: `null` means "checked, and unknown" - the
 * filters handle it and it replays fine. A field that is ABSENT means the
 * record predates it. `null` is data; missing is not.
 *
 * ## Zero network
 *
 * This replays recorded data. If it ever needs to fetch something, the design
 * is wrong - so it imports no RPC client, and a structural test enforces that.
 */
import fs from "fs";
import path from "path";
import { TokenMetrics } from "../data/tokenMetrics";
import { FiltersConfig } from "../config";
import { evaluateFilters, FilterResult } from "../filters/engine";
import { NewPoolEvent } from "../watcher/types";

export const DEFAULT_DECISIONS_FILE = "logs/decisions.jsonl";

/**
 * Every metric field the current filter code reads.
 *
 * Hand-maintained, and `tests/test-replay.ts` scans src/filters/engine.ts for
 * `metrics.<field>` references and fails if this list drifts from it. Without
 * that, adding a filter rule would silently start producing replays that look
 * complete and are not.
 */
export const REQUIRED_METRIC_FIELDS = [
  "liquiditySol",
  "topHolderPercent",
  "devWalletPercent",
  "mintAuthorityRenounced",
  "freezeAuthorityRenounced",
  "riskyTokenExtensions",
  "creatorLpPercent",
  "lpCheckApplicable",
  "uniqueWallets",
  "transactionCount",
  "stale",
] as const;

/** A decision as it was written to the log. */
export interface RecordedDecision {
  ts: string;
  decision: "PASS" | "SKIP";
  source: string;
  mint: string;
  signature: string;
  reasons: string[];
  metrics: Record<string, unknown>;
  evaluatedAt: string;
}

// --- reading -------------------------------------------------------------

/**
 * The live decision log plus every rotated sibling, oldest first.
 *
 * Rotation names them `decisions.<ISO>.jsonl`, so lexical order over the
 * rotated set is chronological; the live file is always newest and goes last.
 */
export function decisionLogFiles(liveFile = DEFAULT_DECISIONS_FILE): string[] {
  const dir = path.dirname(liveFile);
  const base = path.basename(liveFile, ".jsonl");
  if (!fs.existsSync(dir)) return [];
  const rotated = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(`${base}.`) && n.endsWith(".jsonl") && n !== path.basename(liveFile))
    .sort()
    .map((n) => path.join(dir, n));
  return fs.existsSync(liveFile) ? [...rotated, liveFile] : rotated;
}

export interface LoadResult {
  records: RecordedDecision[];
  filesRead: string[];
  /** Lines that were not JSON at all. Counted, never skipped silently. */
  unparseableLines: number;
  /** Parsed JSON that was not a filter decision - queue-stats, dropped, outside-schedule. */
  nonDecisionRecords: number;
}

/**
 * Reads every decision record from the given files.
 *
 * Only PASS/SKIP records are decisions. queue-stats, dropped and
 * outside-schedule rows share the file and are counted separately - a replay
 * that quietly included them would report a denominator nobody could
 * reconcile against the bot's own tally.
 */
export function loadRecords(files: string[]): LoadResult {
  const records: RecordedDecision[] = [];
  let unparseableLines = 0;
  let nonDecisionRecords = 0;
  const filesRead: string[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    filesRead.push(file);
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        unparseableLines++;
        continue;
      }
      if (parsed?.decision !== "PASS" && parsed?.decision !== "SKIP") {
        nonDecisionRecords++;
        continue;
      }
      records.push(parsed as RecordedDecision);
    }
  }
  return { records, filesRead, unparseableLines, nonDecisionRecords };
}

// --- replaying -----------------------------------------------------------

export type ReplayOutcome = "unchanged" | "now-passes" | "now-skips" | "same-verdict-new-reasons" | "unreplayable";

export interface ReplayedRecord {
  mint: string;
  ts: string;
  outcome: ReplayOutcome;
  before: "PASS" | "SKIP" | null;
  after: "PASS" | "SKIP" | null;
  beforeReasons: string[];
  afterReasons: string[];
  /** Set only when outcome is "unreplayable". */
  missingFields: string[];
}

/** Which required metric fields this record does not carry at all. */
export function missingMetricFields(metrics: Record<string, unknown> | undefined | null): string[] {
  if (!metrics || typeof metrics !== "object") return [...REQUIRED_METRIC_FIELDS];
  // `null` is a value - "checked, unknown" - and replays fine. Absent is not.
  return REQUIRED_METRIC_FIELDS.filter((f) => !(f in metrics));
}

/**
 * Replays one record through the current filter code.
 *
 * The event fields are reconstructed from the record. Only mint, source and
 * signature are read by evaluateFilters, and all three are recorded.
 */
export function replayRecord(record: RecordedDecision, filters: FiltersConfig): ReplayedRecord {
  const missing = missingMetricFields(record.metrics);
  if (missing.length > 0) {
    return {
      mint: record.mint,
      ts: record.ts,
      outcome: "unreplayable",
      before: record.decision,
      after: null,
      beforeReasons: record.reasons ?? [],
      afterReasons: [],
      missingFields: missing,
    };
  }

  const event = {
    mint: record.mint,
    source: record.source,
    signature: record.signature,
  } as unknown as NewPoolEvent;

  const result: FilterResult = evaluateFilters(event, record.metrics as unknown as TokenMetrics, filters);
  const before = record.decision;
  const after = result.decision;
  const beforeReasons = record.reasons ?? [];

  let outcome: ReplayOutcome;
  if (before !== after) {
    outcome = after === "PASS" ? "now-passes" : "now-skips";
  } else if (
    beforeReasons.length !== result.reasons.length ||
    beforeReasons.some((r, i) => r !== result.reasons[i])
  ) {
    // Same verdict, different reasons. Worth its own bucket: it means a rule
    // changed behaviour on this token without changing the outcome, which is
    // exactly what you want to see before it starts changing outcomes.
    outcome = "same-verdict-new-reasons";
  } else {
    outcome = "unchanged";
  }

  return {
    mint: record.mint,
    ts: record.ts,
    outcome,
    before,
    after,
    beforeReasons,
    afterReasons: result.reasons,
    missingFields: [],
  };
}

export interface ReplaySummary {
  total: number;
  unchanged: number;
  nowPasses: number;
  nowSkips: number;
  sameVerdictNewReasons: number;
  unreplayable: number;
  /** Missing-field name -> how many records lacked it. */
  missingFieldCounts: Record<string, number>;
  /** Failing rule -> how many records it is the reason for, after the replay. */
  reasonCounts: Record<string, number>;
  /** How many replayable records had NO failing rule at all. */
  passingAfter: number;
  /** The records whose verdict changed, capped for reporting. */
  changed: ReplayedRecord[];
}

export function replayAll(
  records: RecordedDecision[],
  filters: FiltersConfig,
  opts: { maxChangedExamples?: number } = {}
): ReplaySummary {
  const cap = opts.maxChangedExamples ?? 20;
  const s: ReplaySummary = {
    total: records.length,
    unchanged: 0,
    nowPasses: 0,
    nowSkips: 0,
    sameVerdictNewReasons: 0,
    unreplayable: 0,
    missingFieldCounts: {},
    reasonCounts: {},
    passingAfter: 0,
    changed: [],
  };

  for (const record of records) {
    const r = replayRecord(record, filters);
    switch (r.outcome) {
      case "unchanged":
        s.unchanged++;
        break;
      case "now-passes":
        s.nowPasses++;
        break;
      case "now-skips":
        s.nowSkips++;
        break;
      case "same-verdict-new-reasons":
        s.sameVerdictNewReasons++;
        break;
      case "unreplayable":
        s.unreplayable++;
        for (const f of r.missingFields) s.missingFieldCounts[f] = (s.missingFieldCounts[f] ?? 0) + 1;
        break;
    }
    if (r.outcome !== "unreplayable") {
      if (r.afterReasons.length === 0) s.passingAfter++;
      // Counted by rule, not by full string: "too few transactions (4 < min 30)"
      // and "(7 < min 30)" are the same rule and must not be two rows.
      for (const reason of r.afterReasons) {
        const rule = ruleOf(reason);
        s.reasonCounts[rule] = (s.reasonCounts[rule] ?? 0) + 1;
      }
    }
    if ((r.outcome === "now-passes" || r.outcome === "now-skips") && s.changed.length < cap) {
      s.changed.push(r);
    }
  }
  return s;
}

/**
 * Strips the measured values out of a reason so it groups by rule.
 *
 * Parsed structurally rather than by matching known prefixes: a new rule
 * should group correctly on the day it is added, not on the day someone
 * remembers to add it here.
 */
export function ruleOf(reason: string): string {
  return reason.replace(/\s*\([^)]*\)\s*$/, "").trim();
}
