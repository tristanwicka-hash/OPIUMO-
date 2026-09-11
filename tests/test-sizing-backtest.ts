/**
 * Sizing backtest tests. Offline, deterministic, hand-built records.
 *
 * Load-bearing: the recorded exit proceeds must be reproduced EXACTLY by the
 * baseline (the inversion is the same formula backwards); a flat stake must
 * NOT be the recorded ratio times the stake (that is the trap); a rug loses
 * the stake and nothing else; non-closed records are excluded from totals and
 * counted; rates are null below the floor, never 0.
 */
import {
  ClosedPaperRecord, proceeds, recoverLiquidity, liquidityPath,
  poolFractionStrategy, flatStakeStrategy, pyramidStrategy, naiveRatioReuse,
  evaluateStrategy, runSizingBacktest, formatReport, MIN_FOR_RATE, DEFAULT_MAX_POOL_SHARE,
} from "../src/analysis/sizingBacktest";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " -- " + detail : ""}`); console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
function section(t: string): void { console.log(`\n=== ${t} ===\n`); }
const close = (x: number, y: number, eps = 1e-9) => Math.abs(x - y) < eps;

const F = 0.05;
/** A record as the paper book would have written it, from a pool path. */
function rec(mint: string, L0: number, Lexit: number, Lpeak: number, extra: Partial<ClosedPaperRecord> = {}): ClosedPaperRecord {
  return {
    mint, openedAt: "2026-09-10T21:00:00.000Z", closedAt: "2026-09-10T21:10:00.000Z", liveVerdict: "REJECTED",
    entryLiquiditySol: L0, entryProceedsSol: proceeds(L0, F)!, poolFraction: F, outcome: "closed",
    exitProceedsSol: proceeds(Lexit, F), exitReason: "hard stop", peakProceedsSol: proceeds(Math.max(Lpeak, L0), F)!, ...extra,
  };
}

section("the model and its exact inverse");
{
  check("5% of a 10-SOL pool realises 10*0.05/1.05", close(proceeds(10, F)!, 0.47619047619));
  check("inverse recovers the pool", close(recoverLiquidity(proceeds(10, F)!, F)!, 10));
  check("inverse of a zero exit is zero, not null", recoverLiquidity(0, F) === 0);
  check("a non-positive fraction is null", proceeds(10, 0) === null && recoverLiquidity(1, -1) === null);
  const p = liquidityPath(rec("a", 9.048949054, 0.126242826, 9.048949054))!;
  check("liquidity path recovers entry/exit/peak", close(p.entry, 9.048949054) && close(p.exit, 0.126242826, 1e-6) && close(p.peak, 9.048949054, 1e-6));
  check("a non-closed record has no path", liquidityPath(rec("b", 1, 1, 1, { outcome: "abandoned" })) === null);
  check("a closed record with null exit has no path", liquidityPath(rec("c", 1, 1, 1, { exitProceedsSol: null })) === null);
}

section("baseline reproduces what the paper book recorded");
{
  const r = rec("base", 9.048949054, 0.126242826, 9.048949054);
  const rep = evaluateStrategy([r], poolFractionStrategy(F));
  check("returned equals the recorded exit proceeds exactly", close(rep.returnedSol, r.exitProceedsSol!, 1e-9), `${rep.returnedSol} vs ${r.exitProceedsSol}`);
  check("staked is f*L0", close(rep.stakedSol, F * 9.048949054));
  check("entry fraction is the record's", rep.entryFractionRange!.min === F && rep.entryFractionRange!.max === F);
}

section("THE TRAP: a flat stake is not the recorded ratio times the stake");
{
  // A 2-SOL pool that doubled to 4 at exit.
  const r = rec("dbl", 2, 4, 4);
  const flat = evaluateStrategy([r], flatStakeStrategy(0.2));
  const wrong = evaluateStrategy([r], naiveRatioReuse(0.2));
  // 0.2 into 2 SOL owns 10% of the tokens; at L=4 that realises 4*0.1/1.1 = 0.3636, not 0.4.
  check("constant-product return is 0.2 * 4/(2+0.2)", close(flat.returnedSol, 0.2 * 4 / 2.2), `${flat.returnedSol}`);
  check("the naive model claims 0.4", close(wrong.returnedSol, 0.4));
  check("the naive model is marked wrong in the report", wrong.wrong === true && !flat.wrong);
  check("the gap is visible: naive > correct", wrong.netSol > flat.netSol);
  // Into an 85-SOL pool the flat stake is a tiny share and the two nearly agree.
  const big = rec("big", 85, 170, 170);
  const fb = evaluateStrategy([big], flatStakeStrategy(0.2));
  const wb = evaluateStrategy([big], naiveRatioReuse(0.2));
  check("in a deep pool the flat stake's share is tiny", fb.entryFractionRange!.max < 0.003);
  // The gap is exactly returned * f/(1+f): tiny when f is tiny.
  check("...and the gap is the share itself, under 0.25% of what came back", Math.abs(wb.returnedSol - fb.returnedSol) < wb.returnedSol * 0.0025, `${wb.returnedSol - fb.returnedSol}`);
  check("the flat stake takes a SMALLER share of a deep pool than 5%", fb.entryFractionRange!.max < F);
  check("...and a LARGER share of a thin pool than 5%", evaluateStrategy([rec("thin", 1, 1, 1)], flatStakeStrategy(0.2)).entryFractionRange!.min > F);
}

section("a stake that IS the pool is not entered, and is counted");
{
  // 0.2 SOL into a pool observed at 0.0016 SOL: 125x the pool. The real run's
  // best flat position was exactly this, and it outweighed every other win.
  const dust = rec("dust", 0.0016, 4.85, 4.85);
  const capped = evaluateStrategy([dust], flatStakeStrategy(0.2));
  check("default cap skips it", capped.positions === 0 && capped.skipped === 1);
  check("...so nothing is staked or returned from it", capped.stakedSol === 0 && capped.returnedSol === 0);
  const uncapped = evaluateStrategy([dust], flatStakeStrategy(0.2, 1e9));
  check("with no cap it is entered and returns nearly the whole pool", uncapped.positions === 1 && uncapped.returnedSol > 4.8 && uncapped.returnedSol < 4.85, `${uncapped.returnedSol}`);
  check("the default cap is half the pool", DEFAULT_MAX_POOL_SHARE === 0.5);
  const half = evaluateStrategy([rec("half", 0.4, 0.8, 0.8)], flatStakeStrategy(0.2));
  check("exactly at the cap is entered", half.positions === 1 && half.skipped === 0);
  const py = evaluateStrategy([dust], pyramidStrategy({ unitSol: 0.2, stepMultiple: 2, maxUnits: 3 }));
  check("the pyramid applies the same cap to its first unit", py.positions === 0 && py.skipped === 1);
  const text = formatReport(runSizingBacktest([dust], [flatStakeStrategy(0.2)]));
  check("the report names the not-entered count", /NOT ENTERED: 1 position/.test(text));
  check("a skip is not a null - the wrong model still enters it", evaluateStrategy([dust], naiveRatioReuse(0.2)).positions === 1);
}

section("the baseline can be restricted to the pools the flat stake entered");
{
  const recs = [rec("dust", 0.0016, 4.85, 4.85), rec("ok", 2, 4, 4)];
  const all = evaluateStrategy(recs, poolFractionStrategy(F));
  const matched = evaluateStrategy(recs, poolFractionStrategy(F, 0.2 / 0.5));
  const flat = evaluateStrategy(recs, flatStakeStrategy(0.2));
  check("unrestricted baseline sizes both", all.positions === 2 && all.skipped === 0);
  check("matched baseline skips the same pool the flat stake skipped", matched.positions === 1 && matched.skipped === 1 && flat.positions === 1 && flat.skipped === 1);
  check("...and its label says so", /same pools as flat/.test(matched.label));
}

section("a rug loses the stake, whatever the stake");
{
  const rug = rec("rug", 85, 0.001, 85);
  const pf = evaluateStrategy([rug], poolFractionStrategy(F));
  const fl = evaluateStrategy([rug], flatStakeStrategy(0.2));
  check("pool-fraction loses ~4.25 SOL on an 85-SOL rug", pf.netSol < -4.2 && pf.netSol > -4.25, `${pf.netSol}`);
  check("flat loses ~0.2 SOL on the same rug", fl.netSol < -0.199 && fl.netSol > -0.2, `${fl.netSol}`);
  check("the loss can never exceed the stake", fl.netSol >= -0.2 && pf.netSol >= -pf.stakedSol);
  check("worst position is identified", fl.worst!.mint === "rug" && close(fl.worst!.stakedSol, 0.2));
}

section("pyramid adds only on levels the pool actually reached");
{
  const cfg = { unitSol: 0.2, stepMultiple: 2, maxUnits: 3 };
  const never = evaluateStrategy([rec("flat", 2, 1.5, 1.9)], pyramidStrategy(cfg));
  check("no doubling -> one tranche, 0.2 staked", close(never.stakedSol, 0.2));
  const once = evaluateStrategy([rec("once", 2, 3, 4.5)], pyramidStrategy(cfg));
  check("peak 2.25x -> two tranches, 0.4 staked", close(once.stakedSol, 0.4), `${once.stakedSol}`);
  // Second tranche bought at level 4 (10%... 0.2/4 = 5% of tokens), exit at 3: 3*0.05/1.05.
  const expected = proceeds(3, 0.2 / 2)! + proceeds(3, 0.2 / 4)!;
  check("each tranche is valued at the exit with its own fraction", close(once.returnedSol, expected), `${once.returnedSol} vs ${expected}`);
  const capped = evaluateStrategy([rec("moon", 1, 50, 100)], pyramidStrategy(cfg));
  check("max units caps the tranches", close(capped.stakedSol, 0.6));
  check("a bad config (step <= 1) sizes nothing", evaluateStrategy([rec("x", 1, 2, 2)], pyramidStrategy({ ...cfg, stepMultiple: 1 })).positions === 0);
}

section("exclusions are counted, never folded in; rates are null below the floor");
{
  const records = [
    rec("ok1", 2, 4, 4), rec("ok2", 2, 0.01, 2),
    rec("aband", 2, 2, 2, { outcome: "abandoned", exitProceedsSol: null }),
    rec("failed", 2, 2, 2, { outcome: "exit-failed", exitProceedsSol: null }),
  ];
  const b = runSizingBacktest(records, [flatStakeStrategy(0.2)]);
  check("two evaluated", b.evaluated === 2);
  check("two excluded with reasons", b.excluded.count === 2 && b.excluded.reasons["outcome abandoned"] === 1 && b.excluded.reasons["outcome exit-failed"] === 1, JSON.stringify(b.excluded));
  check("excluded records are not in the strategy total", b.reports[0].positions === 2);
  check("win rate is null below the floor, not 50%", b.reports[0].winRate === null && b.reports[0].wins === 1);
  check("the floor is 30", MIN_FOR_RATE === 30);
  const many = Array.from({ length: MIN_FOR_RATE }, (_, i) => rec(`m${i}`, 2, i % 2 ? 4 : 0.5, 4));
  const rm = evaluateStrategy(many, flatStakeStrategy(0.2));
  check("at the floor a rate is shown", rm.winRate !== null && close(rm.winRate, 0.5));
  const empty = runSizingBacktest([], [flatStakeStrategy(0.2)]);
  check("no records -> net% null, not 0", empty.reports[0].netPercent === null && empty.reports[0].worst === null);
  check("sample limits on nothing are null, not zero-hours", empty.sample.spanHours === null && empty.sample.entryLiquidity === null);
}

section("the report says what the sample is");
{
  const b = runSizingBacktest([rec("a", 2, 4, 4), rec("b", 85, 0.001, 85)], [poolFractionStrategy(F), flatStakeStrategy(0.2), naiveRatioReuse(0.2)]);
  const text = formatReport(b);
  check("reject-pile warning is printed when every verdict is REJECTED", /reject pile, not a random sample/.test(text));
  check("the wrong model is flagged with !!", /!! WRONG/.test(text));
  check("largest single loss is printed per strategy", (text.match(/largest single loss/g) ?? []).length === 3);
  check("net without the best position is printed", /net WITHOUT that one position/.test(text));
  check("the exit-point assumption is stated", /same at any fixed stake/.test(text));
  check("the pyramid flattery is stated", /flatters it/.test(text));
  check("the doubled count is printed", /1 positions ever reached 2x/.test(text));
  check("it says live sizing is untouched", /Nothing here changes live sizing/.test(text));
}

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failures:\n  " + failures.join("\n  ")); process.exit(1); }
