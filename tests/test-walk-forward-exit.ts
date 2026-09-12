/**
 * OPIUMO test: the walk-forward on synthetic positions (offline).
 *
 * The walk-forward exists so a rule picked as "best row of a table" is scored
 * on data it was not picked on. These checks pin the mechanics that make that
 * true: the split is chronological, the choice is made on one half only, the
 * score is taken on the OTHER half, and both directions are reported.
 */
import { walkForward, splitChronologically, candidateRules, PROPOSED_LABEL } from "../scripts/walk-forward-exit";
import { ExitRule, TaggedClose, currentStopRule, doNothingRule, MIN_FOR_RATE } from "../src/analysis/venueRerun";
import { Reading } from "../src/analysis/lateEntry";
import { TrailingStopConfig } from "../src/trading/trailingStop";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` - ${d}` : ""}`); } };
const TRAIL: TrailingStopConfig = { hardStopPercent: -50, activationPercent: 30, trailPercent: 20, persistenceObservations: 2, minHoldMs: 60_000 };
const T0 = Date.parse("2026-09-12T00:00:00Z");
const close = (mint: string, openedAtMs: number): TaggedClose => ({ c: { mint, openedAt: new Date(openedAtMs).toISOString(), closedAt: null, entryLiquiditySol: 2, entryProceedsSol: 0, exitProceedsSol: null, poolFraction: 0.05, outcome: "closed" }, venue: "pumpfun" });
const series = (openedAtMs: number, path: number[]): Reading[] => path.map((L, i) => ({ tMs: openedAtMs + (i + 1) * 30_000, sol: L }));

// 80 positions, one per minute. In the first half every token runs 2 -> 16 SOL
// and fades; in the second half every token drains. A take-profit wins the
// first half and loses nothing on the second; "do nothing" loses both.
const N = 80;
const closes: TaggedClose[] = []; const readings = new Map<string, Reading[]>();
for (let i = 0; i < N; i++) {
  const t = T0 + i * 60_000; const m = `M${String(i).padStart(3, "0")}`;
  closes.push(close(m, t));
  readings.set(m, series(t, i < N / 2 ? [3, 8, 16, 40, 20, 5, 1] : [1.8, 1.0, 0.4, 0.1, 0.02, 0, 0]));
}
const R = (m: string) => readings.get(m) ?? [];
const rules = candidateRules(TRAIL);
const proposed = rules.find((r) => r.label === PROPOSED_LABEL)!;
const shuffled = [...closes].reverse();

console.log("\nSplit");
const { a, b } = splitChronologically(shuffled);
check("the split is by open time, not input order: half A holds the first 40 opens", a.length === 40 && a.every((t) => Date.parse(t.c.openedAt) < T0 + 40 * 60_000) && b.every((t) => Date.parse(t.c.openedAt) >= T0 + 40 * 60_000));
check("an explicit split point is honoured", splitChronologically(closes, 10).a.length === 10 && splitChronologically(closes, 10).b.length === 70);

console.log("\nWalk-forward");
const wf = walkForward(shuffled, R, rules, currentStopRule(TRAIL), proposed);
const [d1, d2] = wf.directions;
check("two directions: choose on A score on B, then choose on B score on A", d1.chooseOn === "A" && d1.scoreOn === "B" && d2.chooseOn === "B" && d2.scoreOn === "A");
check("in-sample tables are sorted best first", d1.inSample.every((h, i, arr) => i === 0 || (arr[i - 1].summary.netPct ?? -Infinity) >= (h.summary.netPct ?? -Infinity)));
check("the chosen rule is the best ELIGIBLE in-sample row, and every candidate is eligible here (40 entered >= floor)", d1.chosen === d1.inSample[0].label && d1.eligible === rules.length && MIN_FOR_RATE <= 40);
check("half A (runners): the chosen rule is a take-profit family rule and the current stop is not chosen", /take-profit/.test(d1.chosen) && d1.chosen !== "current stop");
check("out-of-sample scores are taken on the OTHER half: the take-profit chosen on the runner half loses on the drain half (never fires), and the raised stop chosen on the drain half never fires on the runner half", d1.chosenOutOfSample.entered === 40 && d1.chosenOutOfSample.net < 0 && d1.chosenOutOfSample.exited === 0 && d2.chosenOutOfSample.entered === 40 && d2.chosenOutOfSample.exited === 0 && /raised-stop/.test(d2.chosen), `${d1.chosen} -> net ${d1.chosenOutOfSample.net.toFixed(3)} exited ${d1.chosenOutOfSample.exited}; ${d2.chosen} -> exited ${d2.chosenOutOfSample.exited}`);
// The drain half: every position ends at 0 raised, so a rule that exits on the raised stop realises more than one that holds to the end.
check("on the drain half (scored out of sample from A) the proposed rule beats the current stop, which cannot fire on the curve", d1.proposedEdgePct !== null && d1.proposedEdgePct > 0 && d1.currentOutOfSample.exited === 0 && d1.proposedOutOfSample.exited === 40, `${d1.proposedEdgePct} ${d1.currentOutOfSample.exited} ${d1.proposedOutOfSample.exited}`);
check("edge = proposed net% - current net% on the held-out half, computed from those two summaries", d1.proposedEdgePct !== null && Math.abs(d1.proposedEdgePct - ((d1.proposedOutOfSample.netPct ?? 0) - (d1.currentOutOfSample.netPct ?? 0))) < 1e-9);
check("verdict is YES only when the proposed rule beats the current stop on BOTH held-out halves", wf.proposedBeatsCurrentBothHalves === (d1.proposedEdgePct! > 0 && d2.proposedEdgePct! > 0));
check("choiceStable is false unless both directions chose exactly the proposed label", wf.choiceStable === (d1.chosen === PROPOSED_LABEL && d2.chosen === PROPOSED_LABEL));

console.log("\nVerdict needs BOTH halves");
{
  // Half A drains (the proposed rule beats the current stop there); half B runs to 40 SOL and STAYS,
  // so the take-profit banks +50% early while the current stop rides to 4.8x - the current stop wins B.
  const mixed: TaggedClose[] = []; const rd = new Map<string, Reading[]>();
  for (let i = 0; i < N; i++) {
    const t = T0 + i * 60_000; const m = `X${String(i).padStart(3, "0")}`;
    mixed.push(close(m, t));
    rd.set(m, series(t, i < N / 2 ? [1.8, 1.0, 0.4, 0.1, 0.02, 0, 0] : [3, 8, 16, 40, 40, 40, 40]));
  }
  const w = walkForward(mixed, (m) => rd.get(m) ?? [], rules, currentStopRule(TRAIL), proposed);
  const [e1, e2] = w.directions;
  // e1 is chosen on A (drains) and scored on B (runners): the take-profit banks +107% where riding to 40 SOL makes +378%, so proposed < current there. e2 is scored on A (drains): proposed > current.
  check("proposed beats current on the drain half (scored in e2) but not on the runner half (scored in e1)", e1.scoreOn === "B" && e1.proposedEdgePct !== null && e1.proposedEdgePct < 0 && e2.scoreOn === "A" && e2.proposedEdgePct !== null && e2.proposedEdgePct > 0, `${e1.proposedEdgePct} ${e2.proposedEdgePct}`);
  check("...so the verdict is NO: one good half is not enough", w.proposedBeatsCurrentBothHalves === false);
}

console.log("\nEligibility floor");
// Only 20 positions: nothing reaches the 30-entered floor, so nothing is eligible - the walk-forward must say so, not pick a rule on 10 positions.
let threw = false; try { walkForward(closes.slice(0, 20), R, rules, currentStopRule(TRAIL), proposed); } catch { threw = true; }
check("with no eligible rule the walk-forward refuses rather than choosing on a sample under the floor", threw);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
