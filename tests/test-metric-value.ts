/**
 * Metric-value analysis tests. Offline, deterministic, hand-built records.
 *
 * Load-bearing: a metric never fetched is EXCLUDED and counted, never read as
 * zero; verdicts are `insufficient` below the floor however striking the
 * numbers look; the attribution says when it does not add up; the statistics
 * reproduce textbook values.
 */
import {
  normalCdf, mannWhitney, fisherExact, assessNumeric, assessBoolean, positionsNeeded,
  joinPaperSample, joinOutcomeSample, joinPromotedSample, attribute, num, bool,
  MIN_PER_GROUP, RECONCILE_TOLERANCE, METRIC_COST, DecisionRecord, PaperClose, OutcomeRecord, WatchlistEvent, MeterRecord,
} from "../src/analysis/metricValue";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " -- " + detail : ""}`); console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
function section(t: string): void { console.log(`\n=== ${t} ===\n`); }
const close = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

section("statistics reproduce known values");
{
  check("Phi(0) = 0.5", close(normalCdf(0), 0.5, 1e-6));
  check("Phi(1.96) = 0.975", close(normalCdf(1.96), 0.975, 1e-3));
  check("Phi(-1.96) = 0.025", close(normalCdf(-1.96), 0.025, 1e-3));
  // Winners all above losers: U = n1*n2, AUC = 1.
  const sep = mannWhitney([10, 11, 12], [1, 2, 3, 4])!;
  check("perfect separation: AUC 1, U = n1*n2", sep.auc === 1 && sep.u === 12);
  const same = mannWhitney([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])!;
  check("identical groups: AUC 0.5, p = 1", close(same.auc, 0.5, 1e-9) && close(same.pTwoSided, 1, 1e-6));
  // Textbook: A = {1,3,5}, B = {2,4,6}: U_A = 3 (1<2,4,6 -> 0... count A>B pairs: 3>2 (1), 5>2,5>4 (2) => 3)
  const tb = mannWhitney([1, 3, 5], [2, 4, 6])!;
  check("U counts winner>loser pairs (3 of 9)", tb.u === 3 && close(tb.auc, 1 / 3, 1e-9));
  check("ties count half", close(mannWhitney([1, 2], [1, 2])!.auc, 0.5, 1e-9));
  check("an empty group is null, not 0.5", mannWhitney([], [1, 2]) === null);
  // Fisher: [[1,9],[11,3]] -> two-sided p ~ 0.0028 (classic tea-tasting-like table from R docs: fisher.test(matrix(c(1,9,11,3),2)) p=0.002759)
  const f = fisherExact(1, 9, 11, 3);
  check("Fisher exact matches R for [[1,9],[11,3]]", close(f.pTwoSided, 0.002759, 2e-4), f.pTwoSided.toFixed(6));
  check("Fisher on a balanced table is p = 1", close(fisherExact(5, 5, 5, 5).pTwoSided, 1, 1e-9));
  check("Fisher rates are per row", close(f.winnerRate, 0.1, 1e-9) && close(f.loserRate, 11 / 14, 1e-9));
}

section("verdicts: insufficient below the floor, however striking");
{
  const w = [100, 101, 102], l = [1, 2, 3, 4, 5];
  const r = assessNumeric("x", w, l);
  check("3 vs 5 perfectly separated is still INSUFFICIENT", r.verdict === "insufficient" && r.auc === null, r.because);
  check("the floor is 30 per group", MIN_PER_GROUP === 30);
  const W = Array.from({ length: 30 }, (_, i) => 50 + i), Lo = Array.from({ length: 30 }, (_, i) => i);
  const s = assessNumeric("x", W, Lo);
  check("30 vs 30 separated -> SEPARATES with AUC 1", s.verdict === "separates" && s.auc === 1);
  const n = assessNumeric("x", Array.from({ length: 40 }, (_, i) => i % 7), Array.from({ length: 40 }, (_, i) => (i + 3) % 7));
  check("same distribution -> NO EVIDENCE", n.verdict === "no evidence", `${n.auc} ${n.aucCi95}`);
  const b = assessBoolean("flag", Array(30).fill(true), Array(30).fill(false));
  check("boolean perfectly separated -> SEPARATES", b.verdict === "separates" && close(b.auc!, 1, 1e-9));
  const bc = assessBoolean("flag", Array(30).fill(true), Array(30).fill(true));
  check("boolean constant -> NO EVIDENCE with p = 1", bc.verdict === "no evidence" && close(bc.pTwoSided!, 1, 1e-9));
}

section("null is excluded and COUNTED, never read as zero");
{
  const w = [5, null, undefined, 7, NaN] as (number | null | undefined)[];
  const l = [1, 2, null];
  const r = assessNumeric("m", w, l);
  check("two winners have a value, three are missing", r.winnersWithValue === 2 && r.winnersMissing === 3);
  check("two losers have a value, one missing", r.losersWithValue === 2 && r.losersMissing === 1);
  check("the winner median ignores the missing (6, not 2.4)", r.winnerMedian === 6);
  const b = assessBoolean("f", [true, null, undefined], [false, false, null]);
  check("boolean missing counted", b.winnersWithValue === 1 && b.winnersMissing === 2 && b.losersMissing === 1);
  const rec: DecisionRecord = { ts: "x", mint: "m", metrics: { liquiditySol: 0, topHolderPercent: null, mintAuthorityRenounced: false } };
  check("num reads 0 as 0, null as null", num(rec, "liquiditySol") === 0 && num(rec, "topHolderPercent") === null && num(rec, "nope") === null);
  check("bool reads false as false, absent as null", bool(rec, "mintAuthorityRenounced") === false && bool(rec, "freezeAuthorityRenounced") === null);
  check("positionsNeeded: 30 winners at 2.8% fetch and 7% win rate is ~15,307", positionsNeeded(0.028, 0.07) === Math.ceil(30 / (0.028 * 0.07)));
  check("positionsNeeded with no fetches is null, not infinity or 0", positionsNeeded(0, 0.07) === null);
}

section("joins: winners by exit>entry, first decision per mint, unjoined counted");
{
  const decisions: DecisionRecord[] = [
    { ts: "1", mint: "A", metrics: { liquiditySol: 1 } },
    { ts: "2", mint: "A", metrics: { liquiditySol: 99 } }, // a later re-evaluation; the FIRST is used
    { ts: "3", mint: "B", metrics: { liquiditySol: 2 } },
  ];
  const closes: PaperClose[] = [
    { mint: "A", openedAt: "t1", outcome: "closed", entryProceedsSol: 1, exitProceedsSol: 2 },
    { mint: "A", openedAt: "t1", outcome: "closed", entryProceedsSol: 1, exitProceedsSol: 2 }, // replayed duplicate
    { mint: "B", openedAt: "t2", outcome: "closed", entryProceedsSol: 1, exitProceedsSol: 0.1 },
    { mint: "C", openedAt: "t3", outcome: "closed", entryProceedsSol: 1, exitProceedsSol: 5 },   // no decision
    { mint: "B", openedAt: "t4", outcome: "abandoned", entryProceedsSol: 1, exitProceedsSol: null },
  ];
  const s = joinPaperSample(closes, decisions);
  check("one winner (A), one loser (B)", s.winners.length === 1 && s.losers.length === 1);
  check("the FIRST decision for A is used", num(s.winners[0], "liquiditySol") === 1);
  check("C has no decision -> unjoined 1", s.unjoined === 1);
  const outcomes: OutcomeRecord[] = [
    { mint: "A", checkpointSeconds: 3600, ok: true, liquiditySol: 4, baselineLiquiditySol: 1 },
    { mint: "B", checkpointSeconds: 3600, ok: true, liquiditySol: 1, baselineLiquiditySol: 1 },
    { mint: "B", checkpointSeconds: 21600, ok: true, liquiditySol: 9, baselineLiquiditySol: 1 }, // wrong checkpoint
    { mint: "D", checkpointSeconds: 3600, ok: false, liquiditySol: null, baselineLiquiditySol: 1 }, // failed read: excluded
    { mint: "E", checkpointSeconds: 3600, ok: true, liquiditySol: 5, baselineLiquiditySol: 0 },     // zero baseline: excluded
    { mint: "F", checkpointSeconds: 3600, ok: true, liquiditySol: 5, baselineLiquiditySol: 1 },     // no decision
  ];
  const o = joinOutcomeSample(outcomes, decisions, 3600, 2);
  check("outcome sample: A wins (4x), B loses (1x), F unjoined", o.winners.length === 1 && o.losers.length === 1 && o.unjoined === 1);
  const events: WatchlistEvent[] = [
    { ts: "1", event: "activity-resolved", mint: "A", liquiditySol: 1, uniqueWallets: 5 },
    { ts: "2", event: "activity-resolved", mint: "B", liquiditySol: 3, uniqueWallets: 1 },  // 6h = 9 -> 3x: winner
    { ts: "3", event: "holder-resolved", mint: "A", liquiditySol: 1, topHolderPercent: 4 },
  ];
  const p = joinPromotedSample(events, outcomes, "activity-resolved", 21600, 2);
  check("promoted sample uses the 6h checkpoint vs liquidity at the event", p.winners.length === 1 && p.winners[0].mint === "B" && p.unjoined === 1);
}

section("attribution: adds up or says it does not");
{
  const meter: MeterRecord = {
    startedAt: "2026-09-11T00:00:00.000Z", at: "2026-09-11T02:00:00.000Z", rpcCalls: 1000, httpRequests: 900,
    methods: [{ method: "getBalance", calls: 600, share: 0.6 }, { method: "getTransaction", calls: 300, share: 0.3 }, { method: "getAccountInfo", calls: 100, share: 0.1 }],
  };
  const good = attribute(meter, { outcomeCheckpoints: 300, watchlistChecks: 200, stage1Liquidity: 100, stage1Renounce: 100, detectionsParsed: 90, activitySamples: 10, activitySampleSize: 20, holderTopFetches: 0, holderDevFetches: 0 });
  check("attributed 1000/1000 reconciles", good.attributed === 1000 && good.reconciles && good.unattributed === 0);
  check("window hours from the meter timestamps", good.windowHours === 2);
  check("activity credits = samples x (1 + sample size)", good.rows.find((r) => r.purpose.startsWith("wallet-activity"))!.credits === 210);
  const bad = attribute(meter, { outcomeCheckpoints: 300, watchlistChecks: 0, stage1Liquidity: 100, stage1Renounce: 100, detectionsParsed: 90, activitySamples: 10, activitySampleSize: 20, holderTopFetches: 0, holderDevFetches: 0 });
  check("200 missing does NOT reconcile", !bad.reconciles && bad.unattributed === 200);
  check("tolerance is 5%", RECONCILE_TOLERANCE === 0.05);
  check("filter-metric rows are marked", good.rows.filter((r) => r.isFilterMetric).length === 5 && good.rows.filter((r) => !r.isFilterMetric).length === 3);
  check("the activity sample costs 21 credits per token in the cost table", METRIC_COST.uniqueWallets.credits === 21);
  check("every cost names its RPC method", Object.values(METRIC_COST).every((c) => /get[A-Z]/.test(c.method)));
}

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failures:\n  " + failures.join("\n  ")); process.exit(1); }
