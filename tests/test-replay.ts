/**
 * OPIUMO test: the replay harness (offline).
 *
 * The harness answers threshold questions in seconds against recorded data
 * instead of days of waiting, which makes it load-bearing for every future
 * filter decision - and makes a quietly wrong answer expensive.
 *
 * The three ways it could be wrong while looking right, all covered here:
 *
 *   1. Reading only the live log. 15,076 of 17,186 records were in ROTATED
 *      files the last time someone forgot, so the honest-looking answer was
 *      computed from 12% of the data.
 *   2. Treating an unreplayable record as a pass or a fail. A record written
 *      before a metric existed has no verdict under code that reads it, and
 *      inventing one is a fabricated result.
 *   3. Drifting from the live filter engine. If replaying the SAME config over
 *      recorded decisions does not reproduce the recorded verdicts, the
 *      harness is lying and every answer it has given is suspect.
 *
 * Offline: fixtures on disk in a temp dir, no network, no real logs touched.
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  decisionLogFiles,
  loadRecords,
  replayRecord,
  replayAll,
  missingMetricFields,
  ruleOf,
  REQUIRED_METRIC_FIELDS,
  RecordedDecision,
} from "../src/replay/replay";
import { evaluateFilters } from "../src/filters/engine";
import { FiltersConfig } from "../src/config";
import { assertNoProductionWrites } from "./no-production-writes";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`);
  }
}

const FILTERS: FiltersConfig = {
  minLiquiditySol: 5,
  maxTopHolderPercent: 20,
  maxDevWalletPercent: 10,
  requireMintAuthorityRenounced: true,
  requireFreezeAuthorityRenounced: true,
  minUniqueWallets: 20,
  minTransactionCount: 30,
  minUniqueWalletToTxRatio: 0.15,
  rejectRiskyTokenExtensions: true,
  maxCreatorLpPercent: 1,
} as FiltersConfig;

/** A metrics object with every required field present and passing. */
function goodMetrics(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mint: "M",
    fetchedAt: "2026-09-11T00:00:00Z",
    decimals: 6,
    liquiditySol: 50,
    topHolderPercent: 5,
    devWalletPercent: 1,
    mintAuthorityRenounced: true,
    freezeAuthorityRenounced: true,
    riskyTokenExtensions: [],
    creatorLpPercent: 0,
    lpCheckApplicable: false,
    uniqueWallets: 40,
    transactionCount: 60,
    stale: false,
    warnings: [],
    ...over,
  };
}

function rec(over: Partial<RecordedDecision> = {}): RecordedDecision {
  return {
    ts: "2026-09-11T00:00:00Z",
    decision: "SKIP",
    source: "pumpfun",
    mint: "Mint1",
    signature: "sig1",
    reasons: [],
    metrics: goodMetrics(),
    evaluatedAt: "2026-09-11T00:00:00Z",
    ...over,
  };
}

/**
 * Evaluates a condition that might throw, and treats a throw as false.
 *
 * A mutation test caught this suite crashing instead of going red: with the
 * rotated-file glob disabled, `files[2]` was undefined and path.basename()
 * threw before the Total line was printed. A suite that dies reports nothing,
 * and "no result" is indistinguishable from "no problem".
 */
function safe(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

/** replayAll, likewise. An empty summary is not a passing one. */
function safeReplayAll(rs: RecordedDecision[]) {
  try {
    return replayAll(rs, FILTERS);
  } catch {
    return { total: -1, unchanged: -1, nowPasses: -1, nowSkips: -1, sameVerdictNewReasons: -1,
             unreplayable: -1, missingFieldCounts: {} as Record<string, number>,
             reasonCounts: {} as Record<string, number>, passingAfter: -1, changed: [] as any[] };
  }
}

/** replayRecord, with a throw surfaced as a distinguishable result rather than a crash. */
function safeReplay(r: RecordedDecision) {
  try {
    return replayRecord(r, FILTERS);
  } catch (e) {
    return { outcome: "<threw>" as any, after: "<threw>" as any, missingFields: [] as string[], beforeReasons: [], afterReasons: [] };
  }
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opiumo-replay-"));
}
function writeLog(file: string, rows: unknown[]): void {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

console.log("=== OPIUMO test: replay harness (offline) ===");

console.log("\n-- rotated files are read, not just the live one --");
{
  // The failure this exists to prevent: an answer computed from 12% of the data
  // that looks exactly like an answer computed from all of it.
  const dir = tmpdir();
  const live = path.join(dir, "decisions.jsonl");
  writeLog(path.join(dir, "decisions.2026-09-09T23-22-31-356Z.jsonl"), [rec({ mint: "old1" }), rec({ mint: "old2" })]);
  writeLog(path.join(dir, "decisions.2026-09-10T10-00-00-000Z.jsonl"), [rec({ mint: "mid1" })]);
  writeLog(live, [rec({ mint: "new1" })]);

  const files = decisionLogFiles(live);
  check("all three files are found", files.length === 3, files.join(", "));
  check("the live file is read last, being newest", safe(() => path.basename(files[2]) === "decisions.jsonl"));
  check("rotated files come in chronological order", safe(() => path.basename(files[0]).includes("09-09")));

  const loaded = loadRecords(files);
  check("every record is loaded, not just the live one", loaded.records.length === 4, `${loaded.records.length}`);
  check("  ...and 3 of the 4 came from rotated files", loaded.records.filter((r) => r.mint !== "new1").length === 3);
}

console.log("\n-- non-decision rows and junk are counted, never silently dropped --");
{
  const dir = tmpdir();
  const live = path.join(dir, "decisions.jsonl");
  fs.writeFileSync(
    live,
    [
      JSON.stringify(rec({ mint: "a" })),
      JSON.stringify({ event: "queue-stats", detected: 5 }),
      JSON.stringify({ event: "outside-schedule", decision: "NOT_EVALUATED", mint: "b" }),
      JSON.stringify({ event: "dropped", mint: "c" }),
      "{not json at all",
      "",
      JSON.stringify(rec({ mint: "d" })),
    ].join("\n") + "\n"
  );
  const loaded = loadRecords([live]);
  check("only PASS/SKIP rows count as decisions", loaded.records.length === 2, `${loaded.records.length}`);
  check("non-decision rows are counted separately", loaded.nonDecisionRecords === 3, `${loaded.nonDecisionRecords}`);
  check("unparseable lines are counted, not ignored", loaded.unparseableLines === 1);
  check("a blank line is neither", loaded.records.length + loaded.nonDecisionRecords + loaded.unparseableLines === 6);
  // NOT_EVALUATED is deliberately not a decision: a token nobody evaluated has
  // no verdict to compare against, and counting it would inflate the base.
  check("a NOT_EVALUATED row never enters the replay set", !loaded.records.some((r) => r.mint === "b"));
}

console.log("\n-- a missing log file is not an empty result --");
{
  const dir = tmpdir();
  check("no files means no files", decisionLogFiles(path.join(dir, "decisions.jsonl")).length === 0);
  const loaded = loadRecords([path.join(dir, "nope.jsonl")]);
  check("an unreadable file is not reported as read", loaded.filesRead.length === 0);
}

console.log("\n-- unreplayable is its own category, never a pass and never a fail --");
{
  // `null` is a value: "checked, and unknown". The filters handle it. A field
  // that is ABSENT means the record predates the metric.
  const nulls = rec({ metrics: goodMetrics({ topHolderPercent: null, devWalletPercent: null }) });
  check("a null metric is replayable", safeReplay(nulls).outcome !== "unreplayable");
  check("  ...and produces a real verdict", safeReplay(nulls).after === "SKIP");

  const missing = goodMetrics();
  delete (missing as any).creatorLpPercent;
  const r = safeReplay(rec({ metrics: missing }));
  check("an ABSENT metric is unreplayable", r.outcome === "unreplayable");
  check("it has no 'after' verdict at all", r.after === null);
  check("  ...not a PASS", (r.after as unknown) !== "PASS");
  check("  ...and not a SKIP", (r.after as unknown) !== "SKIP");
  check("it names the field that is missing", r.missingFields.join(",") === "creatorLpPercent");

  check("a record with no metrics object is unreplayable, not empty-passing",
    safeReplay(rec({ metrics: undefined as any })).outcome === "unreplayable");
  check("  ...and reports every required field as missing",
    missingMetricFields(undefined).length === REQUIRED_METRIC_FIELDS.length);
}

console.log("\n-- the replay agrees with the live engine, or it is lying --");
{
  // The self-check. Replaying the SAME config over recorded decisions must
  // reproduce the recorded verdicts exactly. Any drift means every answer the
  // harness has ever given is suspect, so it is asserted rather than assumed.
  const cases = [
    goodMetrics(),
    goodMetrics({ liquiditySol: 0.5 }),
    goodMetrics({ topHolderPercent: 90 }),
    goodMetrics({ uniqueWallets: 2, transactionCount: 3 }),
    goodMetrics({ stale: true }),
    goodMetrics({ liquiditySol: null, topHolderPercent: null }),
    goodMetrics({ mintAuthorityRenounced: false }),
  ];
  let agreed = 0;
  for (const m of cases) {
    const live = evaluateFilters({ mint: "M", source: "pumpfun", signature: "s" } as any, m as any, FILTERS);
    // Record exactly what the engine said, then replay it.
    const replayed = replayRecord(
      rec({ decision: live.decision, reasons: live.reasons, metrics: m }),
      FILTERS
    );
    if (replayed.outcome === "unchanged" && replayed.after === live.decision) agreed++;
  }
  check(`all ${cases.length} recorded verdicts replay identically under the same config`, agreed === cases.length, `${agreed}/${cases.length}`);
}

console.log("\n-- a changed threshold is reported as a changed direction --");
{
  const records = [
    rec({ decision: "SKIP", reasons: ["too few transactions (10 < min 30)"], metrics: goodMetrics({ transactionCount: 10 }) }),
    rec({ decision: "SKIP", reasons: ["too few transactions (2 < min 30)"], metrics: goodMetrics({ transactionCount: 2 }) }),
  ];
  const relaxed = { ...FILTERS, minTransactionCount: 5 };
  const s = replayAll(records, relaxed);
  check("the token above the new threshold now passes", s.nowPasses === 1, `${s.nowPasses}`);
  // Still a SKIP - but its reason now reads "min 5" where the record said
  // "min 30", so it belongs in the reasons bucket rather than unchanged.
  // Anything else would report a threshold change as having touched nothing.
  check("the one still below it stays a SKIP", s.nowPasses + s.nowSkips === 1 && s.sameVerdictNewReasons === 1, JSON.stringify(s));
  check("  ...and is not reported as untouched", s.unchanged === 0, `${s.unchanged}`);
  check("the changed record is listed with both verdicts", s.changed[0]?.before === "SKIP" && s.changed[0]?.after === "PASS");
  check("passingAfter counts only replayable passes", s.passingAfter === 1);

  // Tightening must be reported too, not just loosening.
  const tightened = { ...FILTERS, minLiquiditySol: 1000 };
  const t = replayAll([rec({ decision: "PASS", reasons: [], metrics: goodMetrics() })], tightened);
  check("a record that now fails is reported as now-skips", t.nowSkips === 1);
}

console.log("\n-- a same-verdict change of reasons is its own bucket --");
{
  // A rule that changed behaviour without changing the outcome is exactly what
  // you want to see BEFORE it starts changing outcomes.
  const r = rec({
    decision: "SKIP",
    reasons: ["liquidity too low (0.50 SOL < min 5 SOL)"],
    metrics: goodMetrics({ liquiditySol: 0.5, topHolderPercent: 90 }),
  });
  const s = replayAll([r], FILTERS);
  check("still a SKIP, but for different reasons", s.sameVerdictNewReasons === 1, JSON.stringify(s));
  check("it is not counted as unchanged", s.unchanged === 0);
  check("and not as a direction change", s.nowPasses === 0 && s.nowSkips === 0);
}

console.log("\n-- unreplayable records are excluded from every rate --");
{
  const broken = goodMetrics();
  delete (broken as any).uniqueWallets;
  const s = safeReplayAll([rec(), rec({ metrics: broken })]);
  check("both records are in the total", s.total === 2);
  check("one is unreplayable", s.unreplayable === 1);
  check("the unreplayable one is not counted as passing", s.passingAfter === 1, `${s.passingAfter}`);
  check("nor does it contribute a blocking reason", Object.values(s.reasonCounts).every((n) => n <= 1));
  check("the missing field is named and counted", s.missingFieldCounts["uniqueWallets"] === 1);
}

console.log("\n-- reasons group by rule, not by measured value --");
{
  check("the measured values are stripped", ruleOf("too few transactions (4 < min 30)") === "too few transactions");
  check("  ...whatever the numbers are", ruleOf("too few transactions (17 < min 30)") === "too few transactions");
  check("a reason with no parenthetical is unchanged", ruleOf("activity metrics not collected") === "activity metrics not collected");
  check("only a TRAILING parenthetical is stripped", ruleOf("liquidity unknown (could not fetch pool balance)") === "liquidity unknown");

  const s = replayAll(
    [
      rec({ metrics: goodMetrics({ transactionCount: 4 }) }),
      rec({ metrics: goodMetrics({ transactionCount: 17 }) }),
    ],
    FILTERS
  );
  check("two different measurements of one rule are one row", s.reasonCounts["too few transactions"] === 2, JSON.stringify(s.reasonCounts));
}

console.log("\n-- the required-field list matches what the engine actually reads --");
{
  // Without this, adding a filter rule silently starts producing replays that
  // look complete and are not: the new field would be absent from old records
  // and nothing would classify them as unreplayable.
  const src = fs
    .readFileSync("src/filters/engine.ts", "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const read = new Set<string>();
  for (const m of src.matchAll(/\bmetrics\.([a-zA-Z][a-zA-Z0-9_]*)/g)) read.add(m[1]);

  // Fields the engine reads but that are not filter INPUTS - they are carried
  // through onto the result or used for reporting only.
  const notInputs = new Set(["mint", "fetchedAt", "decimals", "warnings", "holderSource", "holderCreditsSpent", "activitySkippedEarly"]);
  const engineInputs = [...read].filter((f) => !notInputs.has(f)).sort();
  const declared = [...REQUIRED_METRIC_FIELDS].map(String).sort();

  const missingFromList = engineInputs.filter((f) => !declared.includes(f));
  const staleInList = declared.filter((f) => !engineInputs.includes(f));
  check(
    "every metric the engine reads is in REQUIRED_METRIC_FIELDS",
    missingFromList.length === 0,
    `not declared: ${missingFromList.join(", ")}`
  );
  check(
    "and nothing in the list has stopped being read",
    staleInList.length === 0,
    `declared but unread: ${staleInList.join(", ")}`
  );
}

console.log("\n-- the harness cannot reach the network --");
{
  const src = fs
    .readFileSync("src/replay/replay.ts", "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  check("it imports no Solana web3 client", !/@solana\/web3\.js/.test(src));
  check("it names no Connection", !/\bConnection\b/.test(src));
  check("it calls no fetch", !/\bfetch\s*\(/.test(src));
  check("it imports nothing from src/rpc", !/from\s+["'][^"']*\/rpc\//.test(src));
  check("it imports nothing from src/data other than the metrics TYPE",
    !/import\s+\{[^}]*\}\s+from\s+["']\.\.\/data\/(?!tokenMetrics)/.test(src));
}

assertNoProductionWrites(check, ["opiumo-replay-", "Mint1", "sig1"]);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
