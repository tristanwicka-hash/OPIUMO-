/**
 * Late-entry replay tests. Offline, synthetic readings.
 *
 * Load-bearing: delay 0 with the book's fraction reproduces a recorded exit;
 * a collapsed pool at the delay is NOT entered and is counted as an avoided
 * drain; a pool with no reading after the delay is no-reading, never a zero;
 * held-to-end is reported apart from exits; rates are null below the floor.
 */
import { replayPosition, summariseDelay, reproductionCheck, isDrained, entryReading, ClosedPosition, Reading, MIN_FOR_RATE } from "../src/analysis/lateEntry";
import { constantProductProceeds, runSeries } from "../src/trading/trailingStop";
let pass = 0, fail = 0;
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  PASS: ${n}`); } else { fail++; console.log(`  FAIL: ${n}${d ? " -- " + d : ""}`); } };
const T0 = Date.parse("2026-09-11T00:00:00Z");
const trailing = { hardStopPercent: -50, activationPercent: 30, trailPercent: 20, persistenceObservations: 2, minHoldMs: 60_000 };
const rd = (sec: number, sol: number): Reading => ({ tMs: T0 + sec * 1000, sol });
const pos = (o: Partial<ClosedPosition> = {}): ClosedPosition => ({ mint: "M", openedAt: new Date(T0).toISOString(), closedAt: new Date(T0 + 150_000).toISOString(), entryLiquiditySol: 5, entryProceedsSol: constantProductProceeds(5, 0.05)!, exitProceedsSol: 0.01, poolFraction: 0.05, outcome: "closed", ...o });

console.log("\n=== a drain: t=0 enters and loses; 60s does not enter ===");
{
  const drain = [rd(30, 0.05), rd(60, 0.004), rd(90, 0.003), rd(120, 0.003), rd(150, 0.003)];
  const c = pos({ exitProceedsSol: constantProductProceeds(0.004, 0.05)! });
  check("the position is classed as an instant drain", isDrained(c));
  // Same collapse but 20 minutes after open: a fade, not an instant drain. The time bound is load-bearing.
  check("the same collapse 20 minutes later is NOT an instant drain", !isDrained(pos({ exitProceedsSol: constantProductProceeds(0.004, 0.05)!, closedAt: new Date(T0 + 20 * 60_000).toISOString() })));
  const t0 = replayPosition(c, drain, 0, { stakeSol: 0.2, trailing });
  check("t=0 flat 0.2 into a 5-SOL pool is entered and loses almost everything", t0.status === "entered" && t0.netSol !== null && t0.netSol < -0.19, JSON.stringify(t0));
  const d60 = replayPosition(c, drain, 60, { stakeSol: 0.2, trailing });
  check("at 60s the pool is 0.004 SOL: NOT entered, counted as collapsed", d60.status === "not-entered-pool-collapsed" && d60.entryAtSec === 60 && d60.entryLiquiditySol === 0.004);
  const s = summariseDelay([d60]);
  check("that counts as a drain avoided", s.drainsAvoided === 1 && s.drainsStillHit === 0 && s.drainsTotal === 1 && s.entered === 0);
  const s0 = summariseDelay([t0]);
  check("...and at t=0 as a drain still hit", s0.drainsStillHit === 1 && s0.drainsAvoided === 0);
}

console.log("\n=== a runner: later entry buys higher, stop replayed identically ===");
{
  const run = [rd(30, 6), rd(60, 8), rd(90, 12), rd(120, 15), rd(150, 20), rd(180, 26), rd(210, 20), rd(240, 18), rd(270, 15), rd(300, 14)];
  const c = pos({ exitProceedsSol: 0.9, closedAt: new Date(T0 + 300_000).toISOString() });
  const a = replayPosition(c, run, 0, { stakeSol: 0.2, trailing });
  const b = replayPosition(c, run, 90, { stakeSol: 0.2, trailing });
  check("both entered", a.status === "entered" && b.status === "entered");
  check("entering at 90s buys at 12 SOL and takes a smaller share (0.2/12)", b.entryLiquiditySol === 12 && b.entryAtSec === 90);
  check("the later entry realises less than the t=0 entry on the same run", (b.netSol ?? 0) < (a.netSol ?? 0), `${a.netSol} vs ${b.netSol}`);
  check("t=0 exited via the trail", a.result === "exited");
}

console.log("\n=== reading gaps and honesty ===");
{
  const sparse = [rd(45, 4), rd(100, 4)];
  const c = pos();
  check("entry at delay 60 uses the FIRST reading at or after 60s (100s), not an interpolation", entryReading(c, sparse, 60)?.tMs === T0 + 100_000);
  const none = replayPosition(c, [rd(30, 4)], 60, { stakeSol: 0.2, trailing });
  check("no reading at or after the delay -> no-reading, not entered, not zero", none.status === "no-reading" && none.netSol === null);
  const held = replayPosition(pos(), [rd(30, 5), rd(60, 5.2), rd(90, 5.1)], 0, { stakeSol: 0.2, trailing });
  check("a series that ends before the stop fires is held-to-end, valued at the last reading", held.result === "held-to-end" && held.realisedSol !== null && Math.abs(held.realisedSol - constantProductProceeds(5.1, 0.2 / 5)!) < 1e-12);
  check("summary reports held-to-end separately", summariseDelay([held]).heldToEnd === 1);
  check("win rate is null below the floor", summariseDelay([held]).winRate === null && MIN_FOR_RATE === 30);
  const many = Array.from({ length: 30 }, (_, i) => replayPosition(pos({ mint: "M" + i }), i % 2 ? [rd(30, 5), rd(60, 9), rd(90, 12), rd(120, 8), rd(150, 7)] : [rd(30, 5), rd(60, 2), rd(90, 1.5)], 0, { stakeSol: 0.2, trailing }));
  check("at the floor a win rate is shown", summariseDelay(many).winRate !== null);
}

console.log("\n=== reproduction: the book's own fraction and readings give the book's own exit ===");
{
  const readings = [rd(30, 5), rd(60, 2.1), rd(90, 1.9), rd(120, 1.8)];
  // What the paper book would have recorded: runSeries at 5% from the recorded entry.
  const out = runSeries({ mint: "M", entryTs: new Date(T0).toISOString(), poolFraction: 0.05, entryProceedsSol: constantProductProceeds(5, 0.05)! }, readings.map((r) => ({ ts: new Date(r.tMs).toISOString(), liquiditySol: r.sol })), trailing, constantProductProceeds);
  const c = pos({ exitProceedsSol: out.exitProceedsSol! });
  const rep = reproductionCheck([c], new Map([["M", readings]]), trailing);
  check("exact reproduction", rep.compared === 1 && rep.exact === 1 && rep.off === 0, JSON.stringify(rep));
  const wrong = reproductionCheck([pos({ exitProceedsSol: 0.5 })], new Map([["M", readings]]), trailing);
  check("a recorded exit the readings cannot produce is reported OFF with an example", wrong.off === 1 && wrong.examplesOff.length === 1);
  const noSeries = reproductionCheck([c], new Map(), trailing);
  check("no readings -> counted as noSeries, not compared", noSeries.noSeries === 1 && noSeries.compared === 0);
}
console.log(`\nTotal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
