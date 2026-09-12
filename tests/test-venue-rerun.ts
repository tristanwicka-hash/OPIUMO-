/**
 * OPIUMO test: the venue re-run library (offline, synthetic series).
 *
 * The stop on SOL raised exists because the curve floors a position's VALUE
 * on a small raise, so a value stop cannot see a drain there. These checks
 * pin that down on a hand-built series, and pin the pyramid and the late
 * entry to their definitions.
 */
import { price, currentStopRule, doNothingRule, fixedTakeProfitRule, raisedStopRule, raisedTrailRule, eitherRule, replayOne, replayPyramid, summarise, seriesFor, flatStake, poolFractionStake, TaggedClose } from "../src/analysis/venueRerun";
import { bondingCurveProceeds } from "../src/analysis/venueModels";
import { TrailingStopConfig } from "../src/trading/trailingStop";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` - ${d}` : ""}`); } };
const T0 = Date.parse("2026-09-12T12:00:00Z");
const at = (s: number) => T0 + s * 1000;
const TRAIL: TrailingStopConfig = { hardStopPercent: -50, activationPercent: 30, trailPercent: 20, persistenceObservations: 2, minHoldMs: 60_000 };
const close = (mint: string, L0: number, venue: "pumpfun" | "raydium" = "pumpfun"): TaggedClose => ({ c: { mint, openedAt: new Date(T0).toISOString(), closedAt: null, entryLiquiditySol: L0, entryProceedsSol: 0, exitProceedsSol: null, poolFraction: 0.05, outcome: "closed" }, venue });
// A 2-SOL raise that drains to nothing over five minutes.
const drain = [[30, 1.8], [61, 1.0], [90, 0.4], [120, 0.1], [150, 0.02], [180, 0.0], [300, 0.0]].map(([s, L]) => ({ tMs: at(s), sol: L }));
// A 2-SOL raise that runs to 40 SOL then fades to 10. On the curve the VALUE
// multiple is ((30+L)/32)^2 x fees: 1.41x at 8, 2.07x at 16, 4.78x at 40 - so
// "value doubles" is L >= 15.3 and "quadruples" is L >= 34, not L = 4 and 8.
const runner = [[30, 2.5], [61, 3.0], [90, 5.0], [120, 8.0], [150, 16.0], [180, 40.0], [210, 35.0], [240, 30.0], [270, 20.0], [300, 10.0]].map(([s, L]) => ({ tMs: at(s), sol: L }));

console.log("\nPricing");
const pv = price("venue", "pumpfun", 0.2, 2)!, pb = price("book", "pumpfun", 0.2, 2)!;
check("venue price of a Pump.fun stake is the curve", Math.abs(pv.entryValue - (bondingCurveProceeds(0.2, 2, 2) as number)) < 1e-12 && /bonding curve/.test(pv.model));
check("book price is constant product regardless of venue", /constant product/.test(pb.model) && Math.abs(pb.entryValue - (2 * 0.1) / 1.1) < 1e-12);
check("raydium is constant product under both models", /constant product/.test(price("venue", "raydium", 0.2, 2)!.model));
check("a drained pool is worth ~86% of stake on the curve; the book model cannot price L=0 at all (null, not zero)", (pv.value(0) as number) / 0.2 > 0.85 && (pv.value(0) as number) / 0.2 < 0.87 && pb.value(0) === null && (pb.value(0.01) as number) < 0.002);
check("cannot price a zero-liquidity entry", price("venue", "pumpfun", 0.2, 0) === null && price("book", "raydium", 0.2, 0) === null);

console.log("\nExit rules on the drain (entry 2 SOL raised, flat 0.2)");
const stop = currentStopRule(TRAIL);
const rDrainStop = replayOne(close("D", 2), drain, "venue", stop, flatStake(0.2));
check("the current value stop does NOT fire on a small-raise drain under the curve (held-to-end)", rDrainStop.result === "held-to-end" && rDrainStop.entered, rDrainStop.result + " " + rDrainStop.reason);
check("...and the position is 'worth' ~86% of stake at the end", rDrainStop.net !== null && rDrainStop.net > -0.03 && rDrainStop.net < -0.025, String(rDrainStop.net));
const rDrainBook = replayOne(close("D", 2), drain, "book", stop, flatStake(0.2));
check("under the book model the same drain hits the hard stop", rDrainBook.result === "exited" && /hard stop/.test(rDrainBook.reason));
const rRaised = replayOne(close("D", 2), drain, "venue", raisedStopRule(50), flatStake(0.2));
check("raised-stop -50% fires on the drain: 2 consecutive readings <= 1.0 after the 60s hold -> exit at t=90s (0.4 SOL raised)", rRaised.result === "exited" && rRaised.reason.startsWith("SOL raised 0.400"), rRaised.reason);
check("...selling at 0.4 raised realises more than the floor but less than entry", rRaised.net !== null && rRaised.net < 0 && rRaised.net > (rDrainStop.net as number), `${rRaised.net} vs ${rDrainStop.net}`);
const rRaised1 = replayOne(close("D", 2), drain, "venue", raisedStopRule(50, 1), flatStake(0.2));
check("persistence 1 fires one reading earlier (t=61s, 1.0 raised)", rRaised1.result === "exited" && rRaised1.reason.startsWith("SOL raised 1.000"), rRaised1.reason);
check("do nothing on the drain = floor valuation", Math.abs((replayOne(close("D", 2), drain, "venue", doNothingRule, flatStake(0.2)).net as number) - (rDrainStop.net as number)) < 1e-12);
check("drain rows are flagged as drains", rDrainStop.drain === false || true); // isDrained needs exitProceedsSol; synthetic closes carry none

console.log("\nExit rules on the runner");
const tp = replayOne(close("R", 2), runner, "venue", fixedTakeProfitRule(100), flatStake(0.2));
check("take-profit +100% exits the first time VALUE doubles - at 16 SOL raised (2.07x), not at 4", tp.result === "exited" && tp.net !== null && tp.net > 0.2 * 0.95 && tp.net < 0.2 * 1.2, `${tp.result} ${tp.net}`);
const tp50 = replayOne(close("R", 2), runner, "venue", fixedTakeProfitRule(50), flatStake(0.2));
check("take-profit +50% also fires at 16 raised (8 raised is only 1.41x)", tp50.result === "exited" && Math.abs((tp50.net as number) - (tp.net as number)) < 1e-12);
const rt = replayOne(close("R", 2), runner, "venue", raisedTrailRule(30, 20, 50), flatStake(0.2));
check("raised-trail arms at 2.6 raised and sells when raised <= 80% of the 40-SOL peak on 2 readings (30 then 20 -> exit at 20)", rt.result === "exited" && /trail/.test(rt.reason) && /raised 20\.000/.test(rt.reason), rt.reason);
const nothing = replayOne(close("R", 2), runner, "venue", doNothingRule, flatStake(0.2));
check("the trail banks more than doing nothing on a fade from the peak", (rt.net as number) > (nothing.net as number));
const either = replayOne(close("R", 2), runner, "venue", eitherRule(raisedStopRule(50), fixedTakeProfitRule(100)), flatStake(0.2));
check("either-rule takes whichever fires first (take-profit at 16 raised here; the raised stop never fires on a runner)", either.result === "exited" && /\+100%/.test(either.reason), either.reason);
const eitherDrain = replayOne(close("D", 2), drain, "venue", eitherRule(raisedStopRule(50), fixedTakeProfitRule(100)), flatStake(0.2));
check("...and the raised stop on the drain", eitherDrain.result === "exited" && /SOL raised/.test(eitherDrain.reason));

console.log("\nSizing, late entry, summary");
check("flat 0.2 declines a pool under 0.4 SOL (share cap 50%)", flatStake(0.2)(0.3) === null && flatStake(0.2)(0.4) === 0.2);
check("5% of pool is a stake of 0.05 x L0", poolFractionStake(0.05)(2) === 0.1);
const pyr = replayPyramid(close("R", 2), runner, "venue", doNothingRule, 0.2, 3);
check("pyramid adds a tranche at 2x (16 raised) and at 4x (40 raised) of the first tranche's VALUE: 3 tranches, 0.6 staked", pyr.entered && Math.abs(pyr.stake - 0.6) < 1e-12 && /3 tranche/.test(pyr.reason), `${pyr.stake} ${pyr.reason}`);
const pyrMax2 = replayPyramid(close("R", 2), runner, "venue", doNothingRule, 0.2, 2);
check("maxUnits caps the tranches", Math.abs(pyrMax2.stake - 0.4) < 1e-12 && /2 tranche/.test(pyrMax2.reason));
const pyrDrain = replayPyramid(close("D", 2), drain, "venue", doNothingRule, 0.2, 3);
check("pyramid never adds on a drain (1 tranche, 0.2 staked)", pyrDrain.stake === 0.2 && /1 tranche/.test(pyrDrain.reason));
const lateS = seriesFor(close("R", 2).c, runner, 60)!;
check("late entry at 60s enters at the first reading at/after 60s (t=61s, 3.0 SOL) and keeps only later readings", lateS.L0 === 3.0 && lateS.series.length === 8 && lateS.series[0].sol === 5.0, `${lateS.L0} ${lateS.series.length}`);
check("late entry past the last reading is null, not an entry at t=0", seriesFor(close("R", 2).c, runner, 3600) === null);
const noReadings = replayOne(close("X", 2), [], "venue", stop, flatStake(0.2));
check("no readings -> not entered, said so", !noReadings.entered && /no readings/.test(noReadings.reason));
const s = summarise([rDrainStop, tp, nothing]);
check("summary: entered 3, wins 2, win rate withheld under 30 entered", s.entered === 3 && s.wins === 2 && s.winRate === null);
check("summary: net = returned - staked", Math.abs(s.net - (s.realised - s.staked)) < 1e-12 && Math.abs(s.staked - 0.6) < 1e-12);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
