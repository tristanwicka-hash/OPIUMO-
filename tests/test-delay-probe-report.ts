/**
 * src/analysis/delayProbeAnalysis.ts - pure aggregation, no fs/network. Feeds
 * scripts/analyze-delay-probe.ts, which is the tool that actually answers
 * the roadmap's top open question (what delay to evaluate tokens at), so
 * getting the arithmetic right here matters more than most report code.
 *
 * Run with: npm run test:delay-probe-report
 */
import { analyzeDelayProbe, DelayProbeRecord, DEFAULT_THRESHOLDS } from "../src/analysis/delayProbeAnalysis";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    pass++;
  } else {
    console.error(`  FAIL: ${name}`);
    fail++;
  }
}

function ok(delaySeconds: number, overrides: Partial<DelayProbeRecord> = {}): DelayProbeRecord {
  return {
    mint: overrides.mint ?? `mint-${Math.random()}`,
    delaySeconds,
    actualElapsedMs: delaySeconds * 1000,
    ok: true,
    error: null,
    uniqueWalletCount: 25,
    transactionCount: 40,
    topHolderPercent: 15,
    liquiditySol: 12,
    ...overrides,
  };
}

function main() {
  console.log("=== Delay-probe report analysis (offline) ===");

  // ---------------------------------------------------------------
  console.log("\n-- empty input --");
  {
    const r = analyzeDelayProbe([]);
    check("no records -> totalRecords 0", r.totalRecords === 0);
    check("no records -> no buckets", r.buckets.length === 0);
    check("no records -> zero distinct mints", r.distinctMints === 0);
  }

  // ---------------------------------------------------------------
  console.log("\n-- coverage lines are counted separately, never treated as observations --");
  {
    const records: DelayProbeRecord[] = [
      { event: "probe-stats", delaySeconds: NaN as any, actualElapsedMs: 0, ok: true, error: null, uniqueWalletCount: null, transactionCount: null, topHolderPercent: null, liquiditySol: null, mint: "" } as any,
      ok(30),
    ];
    const r = analyzeDelayProbe(records);
    check("coverage line counted", r.coverageLines === 1);
    check("coverage line did not become a bucket observation", r.buckets.find((b) => b.delaySeconds === 30)!.scheduled === 1);
    check("totalRecords still counts everything read", r.totalRecords === 2);
  }

  // ---------------------------------------------------------------
  console.log("\n-- dropped vs errored are told apart, and both excluded from stats --");
  {
    const records: DelayProbeRecord[] = [
      ok(30),
      { mint: "m2", delaySeconds: 30, actualElapsedMs: -1, ok: false, error: "dropped - probe queue full, observation never taken", uniqueWalletCount: null, transactionCount: null, topHolderPercent: null, liquiditySol: null },
      { mint: "m3", delaySeconds: 30, actualElapsedMs: 30500, ok: false, error: "RPC timeout after 20000ms", uniqueWalletCount: null, transactionCount: null, topHolderPercent: null, liquiditySol: null },
    ];
    const r = analyzeDelayProbe(records);
    const b = r.buckets[0];
    check("scheduled counts everything", b.scheduled === 3);
    check("exactly one dropped", b.dropped === 1);
    check("exactly one errored (not counted as dropped)", b.errored === 1);
    check("exactly one ok", b.ok === 1);
    check("stats only reflect the ok record", b.uniqueWallets.sampleSize === 1);
  }

  // ---------------------------------------------------------------
  console.log("\n-- median/p90/min/max on a known distribution --");
  {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const records = values.map((v) => ok(30, { uniqueWalletCount: v }));
    const r = analyzeDelayProbe(records);
    const stats = r.buckets[0].uniqueWallets;
    check("sample size matches", stats.sampleSize === 10);
    check("min is 10", stats.min === 10);
    check("max is 100", stats.max === 100);
    check("median of 10 values averages the middle two (50 & 60 -> 55)", stats.median === 55);
    check("p90 is a high value, not the max itself for this method", stats.p90 !== null && stats.p90! >= 80 && stats.p90! <= 100);
  }

  // ---------------------------------------------------------------
  console.log("\n-- null values are counted, never averaged in as zero --");
  {
    const records = [
      ok(30, { uniqueWalletCount: 20 }),
      ok(30, { uniqueWalletCount: null }),
      ok(30, { uniqueWalletCount: 40 }),
    ];
    const r = analyzeDelayProbe(records);
    const stats = r.buckets[0].uniqueWallets;
    check("nullCount is 1", stats.nullCount === 1);
    check("sampleSize excludes the null", stats.sampleSize === 2);
    check("median is over {20,40} only, not {20,0,40}", stats.median === 30);
  }

  // ---------------------------------------------------------------
  console.log("\n-- pass rate: only fully-evaluable OK observations count, thresholds are exact boundaries --");
  {
    const records = [
      // Exactly at threshold on all three -> passes (>=, >=, <=)
      ok(30, { uniqueWalletCount: 20, transactionCount: 30, topHolderPercent: 20 }),
      // One point short on wallets -> fails
      ok(30, { uniqueWalletCount: 19, transactionCount: 30, topHolderPercent: 20 }),
      // Missing a required field entirely -> excluded from evaluable, not counted as a fail
      ok(30, { uniqueWalletCount: 25, transactionCount: null, topHolderPercent: 10 }),
    ];
    const r = analyzeDelayProbe(records, DEFAULT_THRESHOLDS);
    const p = r.buckets[0].passRate;
    check("evaluable excludes the record with a null field", p.evaluable === 2);
    check("exactly one of the evaluable two passed", p.passed === 1);
    check("passRatePercent is 50%", p.passRatePercent === 50);
  }

  // ---------------------------------------------------------------
  console.log("\n-- pass rate is null, not 0%, when nothing is evaluable --");
  {
    const records = [ok(30, { transactionCount: null })];
    const r = analyzeDelayProbe(records);
    check("evaluable is 0", r.buckets[0].passRate.evaluable === 0);
    check("passRatePercent is null, not 0 (0% would imply a real failing measurement)", r.buckets[0].passRate.passRatePercent === null);
  }

  // ---------------------------------------------------------------
  console.log("\n-- multiple delays: separate buckets, sorted ascending regardless of input order --");
  {
    const records = [ok(300), ok(30), ok(120), ok(30)];
    const r = analyzeDelayProbe(records);
    check("three buckets", r.buckets.length === 3);
    check("sorted ascending", r.buckets.map((b) => b.delaySeconds).join(",") === "30,120,300");
    check("30s bucket has both 30s observations", r.buckets[0].scheduled === 2);
  }

  // ---------------------------------------------------------------
  console.log("\n-- distinct mints are counted across the whole file, not per bucket --");
  {
    const records = [ok(30, { mint: "A" }), ok(120, { mint: "A" }), ok(30, { mint: "B" })];
    const r = analyzeDelayProbe(records);
    check("2 distinct mints even though A appears twice", r.distinctMints === 2);
  }

  // ---------------------------------------------------------------
  console.log("\n-- a record with an unusable delaySeconds is excluded, not silently grouped under NaN --");
  {
    const records = [ok(30), { ...ok(30), delaySeconds: NaN }];
    const r = analyzeDelayProbe(records);
    check("malformedRecords counted the NaN one", r.malformedRecords === 1);
    check("no NaN bucket leaked through", r.buckets.every((b) => !Number.isNaN(b.delaySeconds)));
    check("the good record's bucket is unaffected", r.buckets[0].scheduled === 1);
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
