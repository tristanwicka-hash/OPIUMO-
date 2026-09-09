/**
 * Offline, deterministic, no network, no RNG - same convention as the rest of
 * this repo's suites.
 *
 * The load-bearing tests here are the ones that stop the analysis flattering
 * itself: a missing baseline must never become a zero, an incomplete
 * decision-time metric must never be assumed to pass, and a 3x on dust must
 * never count as a winner. Each of those, if it silently went the other way,
 * would produce a confident number pointing the wrong direction.
 */

import { OutcomeRecord } from "../src/data/outcomeTracker";
import {
  DecisionLike,
  DEFAULT_WINNER,
  ThresholdSet,
  analyzeSkippedWinners,
  evaluateThresholds,
  sampleAdequacyWarning,
  summarizeOutcomes,
} from "../src/analysis/outcomeAnalysis";

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

function rec(over: Partial<OutcomeRecord> & { mint: string }): OutcomeRecord {
  return {
    source: "pumpfun",
    signature: "sig",
    detectedAt: "2026-09-09T00:00:00.000Z",
    checkpointSeconds: 3600,
    actualElapsedMs: 3600_000,
    ok: true,
    error: null,
    liquiditySol: 1,
    baselineLiquiditySol: 1,
    replayedAfterRestart: false,
    ...over,
  };
}

function decision(mint: string, d: string, metrics?: DecisionLike["metrics"]): DecisionLike {
  return { mint, decision: d, metrics: metrics ?? null };
}

console.log("=== summarizeOutcomes ===\n");

console.log("-- peak is taken across checkpoints, not the last reading --");
{
  const out = summarizeOutcomes([
    rec({ mint: "A", checkpointSeconds: 3600, liquiditySol: 10, baselineLiquiditySol: 1 }),
    rec({ mint: "A", checkpointSeconds: 21600, liquiditySol: 40, baselineLiquiditySol: 1 }),
    rec({ mint: "A", checkpointSeconds: 86400, liquiditySol: 2, baselineLiquiditySol: 1 }),
  ]);
  const a = out.get("A")!;
  check("peak is the max seen (40), not the final reading (2)", a.peakLiquiditySol === 40, `got ${a.peakLiquiditySol}`);
  check("multiple uses the peak", a.peakMultiple === 40, `got ${a.peakMultiple}`);
  check("counts all three checkpoints", a.checkpointsObserved === 3);
  check("a token that went 1 -> 40 SOL is a winner", a.isWinner);
}

console.log("\n-- null baseline stays null and never becomes a zero (this is the load-bearing one) --");
{
  const out = summarizeOutcomes([rec({ mint: "B", liquiditySol: 50, baselineLiquiditySol: null })]);
  const b = out.get("B")!;
  check("baseline stays null", b.baselineLiquiditySol === null);
  check("multiple is null, not Infinity", b.peakMultiple === null, `got ${b.peakMultiple}`);
  check("token is marked NOT evaluable", !b.evaluable);
  check("an unmeasurable token is not counted as a winner", !b.isWinner);
}

console.log("\n-- a zero baseline is also refused rather than divided by --");
{
  const out = summarizeOutcomes([rec({ mint: "C", liquiditySol: 50, baselineLiquiditySol: 0 })]);
  const c = out.get("C")!;
  check("zero baseline is not evaluable", !c.evaluable);
  check("no Infinity multiple", c.peakMultiple === null, `got ${c.peakMultiple}`);
}

console.log("\n-- failed readings are ignored, but don't erase a good one --");
{
  const out = summarizeOutcomes([
    rec({ mint: "D", checkpointSeconds: 3600, ok: false, liquiditySol: null, error: "rpc failed", baselineLiquiditySol: 2 }),
    rec({ mint: "D", checkpointSeconds: 21600, liquiditySol: 12, baselineLiquiditySol: 2 }),
  ]);
  const d = out.get("D")!;
  check("peak comes from the successful reading", d.peakLiquiditySol === 12);
  check("only successful readings are counted", d.checkpointsObserved === 1, `got ${d.checkpointsObserved}`);
  check("still evaluable", d.evaluable);
}

console.log("\n-- BOTH winner conditions are required (the dust-multiple trap from real data) --");
{
  // Straight from the first real sample: 0.002 -> 0.005 SOL is a 3.47x that
  // represents three thousandths of a SOL. It must not read as a winner.
  const dust = summarizeOutcomes([rec({ mint: "DUST", liquiditySol: 0.005, baselineLiquiditySol: 0.002 })]).get("DUST")!;
  check("big multiple on dust is NOT a winner (fails the absolute floor)", !dust.isWinner, `multiple=${dust.peakMultiple}`);
  check("...but it is still evaluable and its multiple is reported honestly", dust.evaluable && (dust.peakMultiple ?? 0) > 2);

  // The mirror case, also from real data: 25.3 -> 32.3 SOL. Large, but no move to trade.
  const flat = summarizeOutcomes([rec({ mint: "FLAT", liquiditySol: 32.3, baselineLiquiditySol: 25.3 })]).get("FLAT")!;
  check("big absolute with a small multiple is NOT a winner (fails the multiple)", !flat.isWinner, `multiple=${flat.peakMultiple}`);

  // And the genuine one: 0.278 -> 4.348 SOL, 15.6x. Real growth, but peaks under the 5 SOL floor.
  const real = summarizeOutcomes([rec({ mint: "REAL", liquiditySol: 4.348, baselineLiquiditySol: 0.278 })]).get("REAL")!;
  check(
    "15x that peaks just under the 5 SOL floor is not a winner at the default definition",
    !real.isWinner,
    `peak=${real.peakLiquiditySol} multiple=${real.peakMultiple}`
  );
  const looser = summarizeOutcomes([rec({ mint: "REAL", liquiditySol: 4.348, baselineLiquiditySol: 0.278 })], {
    minAbsoluteLiquiditySol: 4,
    minLiquidityMultiple: 3,
  }).get("REAL")!;
  check("...and IS one when the floor is lowered - the definition is what moves, not the data", looser.isWinner);
}

console.log("\n=== analyzeSkippedWinners ===\n");
{
  const outcomes = summarizeOutcomes([
    rec({ mint: "W1", liquiditySol: 60, baselineLiquiditySol: 1 }), // winner, skipped
    rec({ mint: "W2", liquiditySol: 30, baselineLiquiditySol: 2 }), // winner, passed
    rec({ mint: "L1", liquiditySol: 0.002, baselineLiquiditySol: 0.002 }), // loser, skipped
    rec({ mint: "L2", liquiditySol: 0.5, baselineLiquiditySol: 1 }), // loser, skipped
    rec({ mint: "U1", liquiditySol: 99, baselineLiquiditySol: null }), // unevaluable
  ]);
  const decisions = [
    decision("W1", "SKIP"),
    decision("W2", "PASS"),
    decision("L1", "SKIP"),
    decision("L2", "SKIP"),
    decision("U1", "SKIP"),
  ];
  const r = analyzeSkippedWinners(decisions, outcomes);

  check("evaluable count excludes the unmeasurable token", r.evaluableTokens === 4, `got ${r.evaluableTokens}`);
  check("the unmeasurable token is reported, not silently dropped", r.unevaluableTokens === 1);
  check("skipped counted correctly", r.skipped === 3, `got ${r.skipped}`);
  check("passed counted correctly", r.passed === 1);
  check("winners counted correctly", r.winners === 2, `got ${r.winners}`);
  check("one winner was missed", r.skippedWinners === 1);
  check("one winner was caught", r.passedWinners === 1);
  check("skipped-winner rate is 1/3", Math.abs((r.skippedWinnerRate ?? 0) - 1 / 3) < 1e-9, `${r.skippedWinnerRate}`);
  check("miss rate is 1/2", r.missRate === 0.5, `${r.missRate}`);
  check("the missed winner is listed for inspection", r.missedWinners.length === 1 && r.missedWinners[0].mint === "W1");
}

console.log("\n-- only the FIRST decision per mint counts (that's the live t+0 one) --");
{
  const outcomes = summarizeOutcomes([rec({ mint: "X", liquiditySol: 50, baselineLiquiditySol: 1 })]);
  const r = analyzeSkippedWinners([decision("X", "SKIP"), decision("X", "PASS")], outcomes);
  check("a later duplicate decision does not flip the verdict", r.skippedWinners === 1 && r.passedWinners === 0);
  check("the token is only counted once", r.evaluableTokens === 1);
}

console.log("\n-- no winners at all yields null rates, not zeros --");
{
  const outcomes = summarizeOutcomes([rec({ mint: "L", liquiditySol: 0.002, baselineLiquiditySol: 0.002 })]);
  const r = analyzeSkippedWinners([decision("L", "SKIP")], outcomes);
  check("missRate is null when there were no winners to miss", r.missRate === null);
  check("skippedWinnerRate is 0 (we did skip things), not null", r.skippedWinnerRate === 0);
}

console.log("\n=== evaluateThresholds ===\n");
{
  const outcomes = summarizeOutcomes([
    rec({ mint: "W", liquiditySol: 60, baselineLiquiditySol: 1 }),
    rec({ mint: "L", liquiditySol: 0.01, baselineLiquiditySol: 0.01 }),
  ]);
  const decisions = [
    decision("W", "SKIP", { uniqueWallets: 4, transactionCount: 8, topHolderPercent: 5, liquiditySol: 6 }),
    decision("L", "SKIP", { uniqueWallets: 25, transactionCount: 40, topHolderPercent: 5, liquiditySol: 6 }),
  ];
  const sets: ThresholdSet[] = [
    { label: "strict 20/30", minUniqueWallets: 20, minTransactionCount: 30, maxTopHolderPercent: 20, minLiquiditySol: 5 },
    { label: "loose 3/5", minUniqueWallets: 3, minTransactionCount: 5, maxTopHolderPercent: 20, minLiquiditySol: 5 },
  ];
  const [strict, loose] = evaluateThresholds(decisions, outcomes, sets);

  check("strict set admits only the loser", strict.wouldPass === 1 && strict.losersAdmitted === 1);
  check("strict set catches no winners", strict.winnersCaught === 0 && strict.recall === 0);
  check("loose set admits both", loose.wouldPass === 2, `got ${loose.wouldPass}`);
  check("loose set catches the winner", loose.winnersCaught === 1);
  check("loose set's precision reflects the loser it let in", loose.precision === 0.5, `${loose.precision}`);
  check("loose set recall is 1", loose.recall === 1);
  check("winnersMissed is consistent with recall", loose.winnersMissed === 0 && strict.winnersMissed === 1);
}

console.log("\n-- incomplete decision metrics fail CLOSED, never assumed to pass --");
{
  const outcomes = summarizeOutcomes([rec({ mint: "W", liquiditySol: 60, baselineLiquiditySol: 1 })]);
  const sets: ThresholdSet[] = [
    { label: "anything", minUniqueWallets: 0, minTransactionCount: 0, maxTopHolderPercent: 100, minLiquiditySol: 0 },
  ];

  const missingOne = evaluateThresholds(
    [decision("W", "SKIP", { uniqueWallets: 4, transactionCount: 8, topHolderPercent: null, liquiditySol: 6 })],
    outcomes,
    sets
  )[0];
  check("a single null metric makes the token notEvaluable", missingOne.notEvaluable === 1);
  check("...and it is NOT counted as passing, even against a threshold set that accepts anything", missingOne.wouldPass === 0);

  const noMetrics = evaluateThresholds([decision("W", "SKIP")], outcomes, sets)[0];
  check("a decision with no metrics at all is also notEvaluable", noMetrics.notEvaluable === 1 && noMetrics.wouldPass === 0);
}

console.log("\n=== sampleAdequacyWarning ===\n");
check("small sample warns", sampleAdequacyWarning(40, 2) !== null);
check("large sample with too few winners still warns", sampleAdequacyWarning(5000, 3) !== null);
check("large sample with enough winners does not warn", sampleAdequacyWarning(5000, 40) === null);
check(
  "the small-sample warning names the actual count so it can't be read as boilerplate",
  (sampleAdequacyWarning(40, 2) ?? "").includes("40")
);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
