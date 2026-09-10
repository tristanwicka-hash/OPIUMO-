/**
 * One unambiguous final summary line for a multi-suite run.
 *
 * ## Why this exists
 *
 * A multi-suite run prints one `Total: N passed, M failed` per suite. Reading
 * the LAST one and calling it the repo's count has now produced two wrong
 * reports - a cloud session and a local session both understated a repo by
 * reporting its final suite's total as the whole. That is a reporting defect,
 * not carelessness: nothing in the output said "this is one suite of three",
 * and the last line of a run is exactly where a reader looks for the answer.
 *
 * So the runner ends with a single line that covers every suite, and it is the
 * only line in the output that starts with SUMMARY.
 *
 * ## Suites that report no count are named, never counted as zero
 *
 * Some suites (live-network checks, mostly) print PASS/FAIL prose and no
 * `Total:` line at all. Treating those as "0 passed" would understate the run
 * in the same way the original defect did, so they are counted separately and
 * named. Unknown stays unknown.
 */

export interface SuiteTotals {
  /** False when the suite printed no `Total:` line at all. */
  reported: boolean;
  pass: number;
  fail: number;
  skip: number;
  /** How many `Total:` lines were found. >1 means they were summed. */
  lines: number;
}

const TOTAL_RE = /^Total:\s*(\d+)\s+passed,\s*(\d+)\s+failed(?:,\s*(\d+)\s+skipped)?/gm;

/** Pulls the assertion counts out of one suite's captured output. */
export function parseTotals(output: string): SuiteTotals {
  const t: SuiteTotals = { reported: false, pass: 0, fail: 0, skip: 0, lines: 0 };
  for (const m of output.matchAll(TOTAL_RE)) {
    t.reported = true;
    t.lines++;
    t.pass += Number(m[1]);
    t.fail += Number(m[2]);
    t.skip += Number(m[3] ?? 0);
  }
  return t;
}

export type SuiteOutcome = "pass" | "fail" | "skip";

export interface SuiteRecord {
  name: string;
  outcome: SuiteOutcome;
  totals: SuiteTotals;
}

export interface RunAggregate {
  suites: number;
  suitesPassed: number;
  suitesFailed: number;
  suitesSkipped: number;
  assertionsPassed: number;
  assertionsFailed: number;
  assertionsSkipped: number;
  /** Suites that printed a `Total:` line - the ones the assertion counts came from. */
  suitesReportingCounts: number;
  /** Named, not silently zeroed. */
  suitesWithoutCounts: string[];
}

export function aggregate(records: SuiteRecord[]): RunAggregate {
  const agg: RunAggregate = {
    suites: records.length,
    suitesPassed: 0,
    suitesFailed: 0,
    suitesSkipped: 0,
    assertionsPassed: 0,
    assertionsFailed: 0,
    assertionsSkipped: 0,
    suitesReportingCounts: 0,
    suitesWithoutCounts: [],
  };
  for (const r of records) {
    if (r.outcome === "pass") agg.suitesPassed++;
    else if (r.outcome === "fail") agg.suitesFailed++;
    else agg.suitesSkipped++;

    if (r.totals.reported) {
      agg.suitesReportingCounts++;
      agg.assertionsPassed += r.totals.pass;
      agg.assertionsFailed += r.totals.fail;
      agg.assertionsSkipped += r.totals.skip;
    } else {
      agg.suitesWithoutCounts.push(r.name);
    }
  }
  return agg;
}

/**
 * The final line. Deliberately one line, deliberately prefixed SUMMARY, and
 * deliberately carrying the suite count - so it cannot be mistaken for, or
 * confused with, any single suite's `Total:`.
 */
export function formatSummary(repo: string, agg: RunAggregate): string {
  const parts = [
    `SUMMARY ${repo}: ${agg.suites} suites`,
    `${agg.suitesPassed} passed`,
    `${agg.suitesFailed} failed`,
    `${agg.suitesSkipped} skipped`,
  ];
  let line =
    `${parts[0]} (${parts.slice(1).join(", ")})` +
    ` | assertions across all suites: ${agg.assertionsPassed} passed, ` +
    `${agg.assertionsFailed} failed, ${agg.assertionsSkipped} skipped` +
    ` (from ${agg.suitesReportingCounts}/${agg.suites} suites reporting a count`;
  line +=
    agg.suitesWithoutCounts.length > 0
      ? `; no count from: ${agg.suitesWithoutCounts.join(", ")})`
      : ")";
  return line;
}
