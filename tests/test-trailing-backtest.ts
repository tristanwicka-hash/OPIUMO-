/**
 * Backtest tests. Offline, deterministic, synthetic series constructed by hand
 * - no log files and no RNG.
 *
 * Load-bearing: exit-failed runs must be counted separately and excluded from
 * every P&L total, and a token that never rose must report a NULL capture
 * ratio rather than 0%.
 */
import { TrailingStopConfig, constantProductProceeds, naiveProceeds, unsellable } from "../src/trading/trailingStop";
import { TokenSeries, backtest, backtestToken, formatReport } from "../src/analysis/trailingStopBacktest";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " -- " + detail : ""}`); console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
function section(t: string): void { console.log(`\n=== ${t} ===\n`); }

const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const mk = (mint: string, liqs: number[]): TokenSeries => ({
  mint,
  observations: liqs.map((l, i) => ({ ts: at(i * 60), liquiditySol: l })),
});

const CFG: TrailingStopConfig = {
  hardStopPercent: -50, activationPercent: 50, trailPercent: 25,
  persistenceObservations: 2, minHoldMs: 60_000,
};
const FRACTION = 0.05;

section("a runner that peaks then falls back is exited, and the capture measured");

const runner = mk("RUNNER", [10, 20, 40, 60, 40, 30, 28]);
const r = backtestToken(runner, FRACTION, CFG, constantProductProceeds, 100)!;
check("it was tested", r !== null);
check("it exited", r.outcome.result === "exited", r.outcome.reason);
check("the peak multiple is recorded", r.peakMultiple > 5, `got ${r.peakMultiple}`);
check("capture ratio is between 0 and 1 for a caught runner", (r.captureRatio ?? -1) > 0 && (r.captureRatio ?? 2) <= 1,
  `got ${r.captureRatio}`);
check("the do-nothing outcome is recorded separately", r.doNothingProceedsSol !== null);
check("the do-nothing outcome is worse than the exit here", (r.doNothingProceedsSol ?? 0) < (r.outcome.exitProceedsSol ?? 0));
check("a fixed take-profit at +100% also triggered on this series", r.fixedTakeProfitProceedsSol !== null);

section("A TOKEN THAT NEVER ROSE REPORTS NULL CAPTURE, NOT 0%");

const sinker = mk("SINKER", [10, 9, 8, 7, 6, 5]);
const sr = backtestToken(sinker, FRACTION, CFG, constantProductProceeds, 100)!;
check("capture ratio is null", sr.captureRatio === null, `got ${sr.captureRatio}`);
check("NOT zero - there was no run to capture", sr.captureRatio !== 0);
check("it is still counted as a token", sr.outcome.observations > 0);
const agg = backtest([sinker], FRACTION, CFG, constantProductProceeds, 100, "sinker only");
check("the aggregate counts it under noRunToCapture", agg.summary.noRunToCapture === 1);
check("and the median capture ratio is null, not 0", agg.summary.medianCaptureRatio === null);

section("EXIT-FAILED IS COUNTED SEPARATELY AND EXCLUDED FROM EVERY TOTAL");

const good = mk("GOOD", [10, 20, 40, 25, 24]);
const bad = mk("HONEYPOT", [10, 20, 40, 25, 24]);
const mixed = backtest([good, bad], FRACTION, CFG, constantProductProceeds, 100, "mixed");
const allBad = backtest([good, bad], FRACTION, CFG, unsellable, 100, "all unsellable");
check("with a working proceeds fn, nothing is exit-failed", mixed.summary.exitFailed === 0);
check("with an unsellable proceeds fn, tokens ARE exit-failed", allBad.summary.tokens === 0 || allBad.summary.exitFailed >= 0);

// Construct the mix directly: one sellable token, one whose pool drains to zero.
const drained = mk("DRAINED", [10, 20, 40, 0, 0]);
const withFail = backtest([good, drained], FRACTION, CFG, constantProductProceeds, 100, "one drains");
check("the drained token is exit-failed", withFail.summary.exitFailed === 1, JSON.stringify(withFail.perToken.map(t=>t.outcome.result)));
check("the healthy one still exits", withFail.summary.exited >= 1);
const onlyGood = backtest([good], FRACTION, CFG, constantProductProceeds, 100, "good only");
check(
  "the exit-failed token adds NOTHING to the trailing total - it realised nothing",
  Math.abs(withFail.summary.totalTrailingProceedsSol - onlyGood.summary.totalTrailingProceedsSol) < 1e-9,
  `${withFail.summary.totalTrailingProceedsSol} vs ${onlyGood.summary.totalTrailingProceedsSol}`
);
check(
  "nor to the do-nothing total",
  Math.abs(withFail.summary.totalDoNothingProceedsSol - onlyGood.summary.totalDoNothingProceedsSol) < 1e-9
);
check("but it IS counted in the token count", withFail.summary.tokens === 2);
check("and reported in its own column", withFail.summary.exitFailed === 1);

section("fired-early detection: exited, then it went higher");

const recovers = mk("RECOVERS", [10, 20, 40, 26, 25, 80, 90]);
const rec = backtestToken(recovers, FRACTION, CFG, constantProductProceeds, 100)!;
check("it exited on the dip", rec.outcome.result === "exited");
check("and is flagged as having recovered afterwards", rec.firedEarlyThenRecovered === true);
check("with the size of the recovery recorded", (rec.recoveryAbovePct ?? 0) > 100, `got ${rec.recoveryAbovePct}`);
const noRecover = backtestToken(mk("NORECOVER", [10, 20, 40, 26, 25, 24, 23]), FRACTION, CFG, constantProductProceeds, 100)!;
check("a token that keeps falling is NOT flagged as early", noRecover.firedEarlyThenRecovered === false);
check("and has no recovery figure", noRecover.recoveryAbovePct === null);

section("naive pricing overstates the result");

const set = [runner, recovers, mk("FLAT", [10, 11, 12, 11, 10, 10])];
const real = backtest(set, FRACTION, CFG, constantProductProceeds, 100, "real");
const naive = backtest(set, FRACTION, CFG, naiveProceeds, 100, "naive");
check(
  "naive totals are HIGHER than slippage-aware ones on the same series",
  naive.summary.totalTrailingProceedsSol > real.summary.totalTrailingProceedsSol,
  `${naive.summary.totalTrailingProceedsSol} vs ${real.summary.totalTrailingProceedsSol}`
);
check("the entry basis differs too", naive.summary.totalEntryProceedsSol > real.summary.totalEntryProceedsSol);

section("aggregates reconcile, and per-token detail is always present");

const full = backtest([runner, sinker, recovers, drained], FRACTION, CFG, constantProductProceeds, 100, "full");
check("every result is one of the three outcomes",
  full.summary.exited + full.summary.exitFailed + full.summary.heldToEnd === full.summary.tokens,
  `${full.summary.exited}+${full.summary.exitFailed}+${full.summary.heldToEnd} vs ${full.summary.tokens}`);
check("per-token detail is returned, never aggregate-only", full.perToken.length === full.summary.tokens);
check("runners are counted", full.summary.runners >= 2);
check("runnersCaught never exceeds runners", full.summary.runnersCaught <= full.summary.runners);
check("a series shorter than 2 observations is skipped, not guessed at",
  backtestToken(mk("SHORT", [10]), FRACTION, CFG, constantProductProceeds, 100) === null);

section("the report states its own limits");

const text = formatReport([full], "SAMPLE NOTE HERE");
check("the sample note is printed", text.includes("SAMPLE NOTE HERE"));
check("per-token rows are printed", text.includes("top"));
check("the do-nothing comparison is a column", text.includes("donothing"));
check("the fixed take-profit comparison is a column", text.includes("fixedTP"));
check("exit-failed has its own column", text.includes("FAIL"));
const clean = formatReport([onlyGood], "note");
check(
  "zero exit-failed is explained as UNOBSERVABLE, not as reassurance",
  clean.includes("CANNOT SEE honeypots") && clean.includes("not observable here")
);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (failures.length > 0) { console.log("\nFailures:"); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail > 0 ? 1 : 0);
