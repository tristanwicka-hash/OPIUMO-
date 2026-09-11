/**
 * Log integrity invariants.
 *
 * OPIUMO already reconciles `detected = decided + dropped + notEvaluated +
 * stillQueued` and warns when it does not balance. That idea was one counter in
 * one bot; this makes it a rule over every log.
 *
 * ## The invariants, and which of them were learned the hard way
 *
 *  1. PARSEABLE     - every non-empty line is JSON. A line that is not is
 *                     counted, never skipped: a silent skip changes the
 *                     denominator of every rate computed from the file.
 *  2. TIMESTAMPED   - every record carries a time. A record that cannot be
 *                     placed in time cannot be reconciled against anything.
 *  3. ORDERED       - timestamps never go backwards by more than the
 *                     concurrency window. NOT strict monotonicity: these logs
 *                     have concurrent appenders (the watchlist checks up to
 *                     maxChecksPerTick tokens at once and each stamps its own
 *                     observation time), so small reversals are the normal
 *                     signature of parallel writes finishing out of order.
 *                     Measured 2026-09-11 across 51,644 watchlist records:
 *                     6,213 reversals, median 0.92s, p95 5.5s, max 69s, and
 *                     across 37,295 outcome records with 21,602 replayed after
 *                     a restart: 11 reversals, max 1.4s.
 *                     A strict version flagged 6,224 records that were all
 *                     correct, which is the failure mode that gets an
 *                     integrity check switched off. What a real defect looks
 *                     like is a reversal of MINUTES or hours - a clock change,
 *                     or a replayed record written with a stale timestamp -
 *                     so the invariant is a bound, and the largest reversal
 *                     seen is reported even when it is inside that bound.
 *  4. NO FIXTURES   - no test identifier appears in a production log. 156
 *                     fixture-mint records sat in logs/trades.jsonl for two
 *                     days before anyone looked.
 *  5. SCHEMA        - each event type carries the fields its readers assume.
 *                     A missing field reads as `undefined`, which is neither
 *                     the value nor an error, and arithmetic on it produces
 *                     NaN that prints as a number.
 *  6. REFERENTIAL   - no record refers to a state that never existed. A close
 *                     with no open is the case that matters: it means either a
 *                     lost record or a double count, and only one of those is
 *                     recoverable.
 *
 * ## Quarantine, never delete
 *
 * Nothing here removes a record. Violations are reported with counts and
 * examples, and `quarantinePlan()` describes what would be moved where. The
 * 156 fixture records were quarantined rather than deleted for the same
 * reason: a bad record is evidence of how it got there.
 */
import fs from "fs";
import path from "path";

export type InvariantId =
  | "parseable"
  | "timestamped"
  | "ordered"
  | "no-fixtures"
  | "schema"
  | "referential";

export interface Violation {
  invariant: InvariantId;
  file: string;
  /** 1-indexed line, when the violation belongs to one. */
  line: number | null;
  detail: string;
  /** The offending line, truncated. */
  excerpt: string;
}

export interface FileReport {
  file: string;
  lines: number;
  records: number;
  violations: Violation[];
  /** Largest backwards jump seen, in ms. Reported even when within tolerance. */
  maxReversalMs: number;
  /** How many timestamps went backwards at all, tolerated or not. */
  reversals: number;
}

const EXCERPT = 160;

/** See the ORDERED invariant above for where 120s comes from. */
export const DEFAULT_ORDER_TOLERANCE_MS = 120_000;

/** Timestamp field names, in the order they are trusted. */
const TS_FIELDS = ["ts", "at", "evaluatedAt", "detectedAt", "openedAt"];

export function timestampOf(record: any): string | null {
  for (const f of TS_FIELDS) {
    const v = record?.[f];
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return v;
  }
  return null;
}

/**
 * Fields each event must carry.
 *
 * Keyed by the record's `event`, falling back to `decision` for the filter
 * decisions, which predate the event field. Unknown event types are NOT
 * violations - a new event should not fail the build the day it is added -
 * but they are counted so a typo in an event name is visible.
 */
export const SCHEMA: Record<string, string[]> = {
  "rejected-buy": ["mint", "reasons"],
  "failed-execution": ["mint", "action", "error"],
  "abandoned": ["mint", "sellFailureCount"],
  "outside-schedule": ["mint", "decision", "scheduleReason"],
  "credit-halt": ["mint", "decision", "budgetReason", "dayCredits", "monthCredits"],
  "queue-stats": ["detected", "decided", "dropped"],
  "dropped": ["mint"],
  "shadow-eval": ["mint", "liveDecision", "shadows"],
  "paper-open": ["mint", "openedAt", "entryProceedsSol"],
  "paper-close": ["mint", "openedAt", "outcome"],
  "paper-refused": ["mint", "reason"],
  PASS: ["mint", "reasons", "metrics"],
  SKIP: ["mint", "reasons", "metrics"],
};

function kindOf(record: any): string | null {
  if (typeof record?.event === "string") return record.event;
  if (record?.decision === "PASS" || record?.decision === "SKIP") return record.decision;
  return null;
}

export interface CheckOptions {
  /** Fixture identifiers that must never appear. Anything under 6 chars is ignored. */
  fixtureMarkers?: string[];
  /**
   * How far a timestamp may go backwards before it counts as a violation.
   * Default 120s: two orders of magnitude above the measured p95 reversal of
   * 5.5s, and far below anything that would indicate a clock change.
   */
  orderToleranceMs?: number;
}

/**
 * Runs every invariant over one file.
 *
 * Reads line by line rather than parsing the whole file, so a 21MB log does not
 * have to be held twice and a single bad line does not lose the rest.
 */
export function checkFile(file: string, opts: CheckOptions = {}): FileReport {
  const report: FileReport = { file, lines: 0, records: 0, violations: [], maxReversalMs: 0, reversals: 0 };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err: any) {
    report.violations.push({
      invariant: "parseable",
      file,
      line: null,
      detail: `could not read the file: ${err?.message ?? err}`,
      excerpt: "",
    });
    return report;
  }

  const markers = (opts.fixtureMarkers ?? []).map((m) => m.trim()).filter((m) => m.length >= 6);
  const tolerance = opts.orderToleranceMs ?? DEFAULT_ORDER_TOLERANCE_MS;
  let lastTs: number | null = null;
  const opens = new Set<string>();
  const closesWithoutOpen: string[] = [];

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    report.lines++;
    const lineNo = i + 1;
    const excerpt = raw.slice(0, EXCERPT);

    let record: any;
    try {
      record = JSON.parse(raw);
    } catch (err: any) {
      report.violations.push({
        invariant: "parseable",
        file,
        line: lineNo,
        detail: `not JSON: ${err?.message ?? err}`,
        excerpt,
      });
      continue;
    }
    report.records++;

    // 4. fixtures - checked on the raw line so a marker nested anywhere counts.
    for (const marker of markers) {
      if (raw.includes(marker)) {
        report.violations.push({
          invariant: "no-fixtures",
          file,
          line: lineNo,
          detail: `contains the fixture identifier "${marker}"`,
          excerpt,
        });
      }
    }

    // 2 + 3. time
    const ts = timestampOf(record);
    if (ts === null) {
      report.violations.push({
        invariant: "timestamped",
        file,
        line: lineNo,
        detail: `no parseable timestamp in any of: ${TS_FIELDS.join(", ")}`,
        excerpt,
      });
    } else {
      const t = Date.parse(ts);
      if (lastTs !== null && t < lastTs) {
        const backMs = lastTs - t;
        report.reversals++;
        report.maxReversalMs = Math.max(report.maxReversalMs, backMs);
        if (backMs > tolerance) {
          report.violations.push({
            invariant: "ordered",
            file,
            line: lineNo,
            detail:
              `timestamp ${ts} is ${(backMs / 1000).toFixed(1)}s earlier than the high-water mark ` +
              `(${new Date(lastTs).toISOString()}), beyond the ${(tolerance / 1000).toFixed(0)}s ` +
              `concurrency tolerance - too large to be parallel writes finishing out of order`,
            excerpt,
          });
        }
      }
      lastTs = lastTs === null ? t : Math.max(lastTs, t);
    }

    // 5. schema
    const kind = kindOf(record);
    if (kind !== null && SCHEMA[kind]) {
      const missing = SCHEMA[kind].filter((f) => !(f in record));
      if (missing.length > 0) {
        report.violations.push({
          invariant: "schema",
          file,
          line: lineNo,
          detail: `${kind} is missing required field(s): ${missing.join(", ")}`,
          excerpt,
        });
      }
    }

    // 6. referential - a close needs an open. Tracked in file order, which is
    // why the ordering bound matters: badly out-of-order records would make a
    // valid pair look broken.
    if (kind === "paper-open" && typeof record.mint === "string") opens.add(record.mint);
    if (kind === "paper-close" && typeof record.mint === "string" && !opens.has(record.mint)) {
      closesWithoutOpen.push(record.mint);
      report.violations.push({
        invariant: "referential",
        file,
        line: lineNo,
        detail: `paper-close for ${record.mint} with no preceding paper-open in this file`,
        excerpt,
      });
    }
  }

  return report;
}

/** Every production log, excluding nested test scratch directories. */
export function productionLogs(dir = "logs"): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(dir, e.name))
    .sort();
}

export interface QuarantineAction {
  file: string;
  lines: number[];
  destination: string;
  reason: string;
}

/**
 * What WOULD be moved, and where. Performs nothing.
 *
 * Quarantine is a two-step operation on purpose: a bad record is evidence of
 * how it got there, and a tool that deletes on sight destroys the only copy of
 * the thing you need to diagnose.
 */
export function quarantinePlan(reports: FileReport[], quarantineDir = "logs/quarantine"): QuarantineAction[] {
  const actions: QuarantineAction[] = [];
  for (const r of reports) {
    const byInvariant = new Map<InvariantId, number[]>();
    for (const v of r.violations) {
      if (v.line === null) continue;
      const list = byInvariant.get(v.invariant) ?? [];
      list.push(v.line);
      byInvariant.set(v.invariant, list);
    }
    for (const [invariant, lines] of byInvariant) {
      actions.push({
        file: r.file,
        lines: [...new Set(lines)].sort((a, b) => a - b),
        destination: path.join(quarantineDir, `${path.basename(r.file, ".jsonl")}.${invariant}.jsonl`),
        reason: `${lines.length} record(s) violating "${invariant}"`,
      });
    }
  }
  return actions;
}
