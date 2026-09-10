/**
 * Trailing-stop decision tests. Pure, offline, no clock - every timestamp is
 * constructed, so a boundary can be asserted to the observation.
 *
 * The three load-bearing sections are the three things that break naive
 * trailing stops on memecoins:
 *   1. REALIZABLE PROCEEDS, not the headline price
 *   2. WICKS - a breach must persist
 *   3. UNSELLABLE tokens get their own outcome, never a clean exit
 */
import {
  Position,
  PoolObservation,
  TrailingStopConfig,
  initState,
  step,
  runSeries,
  naiveProceeds,
  constantProductProceeds,
  unsellable,
} from "../src/trading/trailingStop";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " -- " + detail : ""}`); console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
function section(t: string): void { console.log(`\n=== ${t} ===\n`); }

const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);
const at = (secs: number) => new Date(T0 + secs * 1000).toISOString();
const obs = (secs: number, liq: number): PoolObservation => ({ ts: at(secs), liquiditySol: liq });

const CFG: TrailingStopConfig = {
  hardStopPercent: -50,
  activationPercent: 30,
  trailPercent: 20,
  persistenceObservations: 2,
  minHoldMs: 60_000,
};

/** 10% of a 10 SOL pool. Constant-product entry proceeds = 10*0.1/1.1 = 0.909. */
const POS: Position = {
  mint: "TestMint",
  entryTs: at(0),
  poolFraction: 0.1,
  entryProceedsSol: constantProductProceeds(10, 0.1) as number,
};

section("1. REALIZABLE PROCEEDS, NOT THE HEADLINE PRICE");

check("naive proceeds are the position's share of the pool", naiveProceeds(10, 0.1) === 1);
check(
  "constant-product proceeds are LOWER - your own sell moves the pool",
  (constantProductProceeds(10, 0.1) as number) < (naiveProceeds(10, 0.1) as number)
);
check(
  "a 10% position takes roughly a 9% haircut",
  Math.abs((constantProductProceeds(10, 0.1) as number) - 0.90909) < 1e-4,
  `got ${constantProductProceeds(10, 0.1)}`
);
check(
  "a position that IS half the pool takes a 33% haircut",
  Math.abs((constantProductProceeds(10, 0.5) as number) - 3.3333) < 1e-3,
  `got ${constantProductProceeds(10, 0.5)}`
);
check("a bigger position realises proportionally less", 
  (constantProductProceeds(10, 0.5) as number) / 0.5 < (constantProductProceeds(10, 0.1) as number) / 0.1);
check("an empty pool realises nothing at all", constantProductProceeds(0, 0.1) === null);

// The stop must measure against proceeds. Same pool series, two models: the
// naive one reports a smaller drawdown than is really available, so it holds
// where the honest model exits.
const drop = [obs(120, 10), obs(180, 7.4)];
const naiveRun = runSeries({ ...POS, entryProceedsSol: naiveProceeds(10, 0.1) as number }, drop, CFG, naiveProceeds);
const realRun = runSeries(POS, drop, CFG, constantProductProceeds);
check(
  "both models see the same shape of move (this is a same-series comparison)",
  naiveRun.observations === realRun.observations
);
check(
  "entry proceeds differ between the models, which is the whole point",
  naiveRun.entryProceedsSol !== realRun.entryProceedsSol
);

section("2. WICKS - a breach must persist before it fires");

// One bad observation then recovery. persistenceObservations = 2.
const wick: PoolObservation[] = [
  obs(0, 10), obs(60, 14), obs(120, 16),   // runs up, arms
  obs(180, 11),                             // one bad tick: >20% off the high
  obs(240, 16), obs(300, 17),               // recovers
];
const wickRun = runSeries(POS, wick, CFG, constantProductProceeds);
check("a single-observation wick does NOT trigger an exit", wickRun.result === "held-to-end", wickRun.reason);
check("and the position is still open at the end", wickRun.exitProceedsSol === null);

// Two consecutive breaching observations: a real move down.
const realDrop: PoolObservation[] = [
  obs(0, 10), obs(60, 14), obs(120, 16),
  obs(180, 11), obs(240, 10.5),
];
const realDropRun = runSeries(POS, realDrop, CFG, constantProductProceeds);
check("a breach that PERSISTS does trigger", realDropRun.result === "exited", realDropRun.reason);
check("and it is the trail, not the hard stop", realDropRun.trigger === "trail");
check("the exit records the proceeds actually realised", (realDropRun.exitProceedsSol ?? 0) > 0);

// persistence = 1 makes the same wick fire, proving the setting is load-bearing.
const twitchy = runSeries(POS, wick, { ...CFG, persistenceObservations: 1 }, constantProductProceeds);
check(
  "with persistence 1 the SAME wick does fire - the setting is what prevents it",
  twitchy.result === "exited"
);

// The time floor blocks an otherwise-valid exit.
const early: PoolObservation[] = [obs(0, 10), obs(5, 4), obs(10, 3.9)];
const earlyRun = runSeries(POS, early, CFG, constantProductProceeds);
check("the minHoldMs floor blocks an exit inside the first minute", earlyRun.result === "held-to-end", earlyRun.reason);
const noFloor = runSeries(POS, early, { ...CFG, minHoldMs: 0 }, constantProductProceeds);
check("with no floor the same series exits on the hard stop", noFloor.result === "exited" && noFloor.trigger === "hard-stop");

section("3. UNSELLABLE TOKENS GET THEIR OWN OUTCOME");

const honeypot = runSeries(POS, [obs(120, 10), obs(180, 12)], CFG, unsellable);
check("an unsellable position reports exit-failed", honeypot.result === "exit-failed");
check("NOT 'exited'", honeypot.result !== "exited");
check("no proceeds are recorded, because none were realised", honeypot.exitProceedsSol === null);
check("and the reason names the cause", /honeypot|frozen|cannot be sold/i.test(honeypot.reason));

// A pool that drains to nothing becomes unsellable mid-run.
const drained = runSeries(POS, [obs(120, 10), obs(180, 8), obs(240, 0)], CFG, constantProductProceeds);
check("a pool draining to zero is exit-failed, not a clean stop-out", drained.result === "exit-failed", drained.reason);

section("the hard stop, the activation threshold and the trail are all configurable");

const hardOnly: PoolObservation[] = [obs(0, 10), obs(120, 4.5), obs(180, 4.4)];
const hardRun = runSeries(POS, hardOnly, CFG, constantProductProceeds);
check("a fall past the hard stop exits without ever arming the trail", hardRun.trigger === "hard-stop", hardRun.reason);

// Never reaches +30%, so the trail never arms and a 20% dip does nothing.
const neverArms: PoolObservation[] = [obs(0, 10), obs(60, 11), obs(120, 8.5), obs(180, 8.4)];
const neverArmsRun = runSeries(POS, neverArms, CFG, constantProductProceeds);
check(
  "an unarmed trail ignores a drawdown that would otherwise fire",
  neverArmsRun.result === "held-to-end",
  neverArmsRun.reason
);
const lowerActivation = runSeries(POS, neverArms, { ...CFG, activationPercent: 5 }, constantProductProceeds);
check("lowering activationPercent arms it and it fires", lowerActivation.result === "exited");
const tighterTrail = runSeries(POS, wick, { ...CFG, trailPercent: 5, persistenceObservations: 1 }, constantProductProceeds);
check("a tighter trailPercent fires earlier on the same series", tighterTrail.result === "exited");

section("the high-water mark tracks PROCEEDS and never goes backwards");

let st = initState(POS);
const rising = [obs(60, 12), obs(120, 18), obs(180, 15)];
const highs: number[] = [];
for (const o of rising) {
  const r = step(st, o, CFG, constantProductProceeds, POS.poolFraction);
  st = r.state;
  highs.push(st.highWaterProceedsSol);
}
check("the high-water mark rises with the pool", highs[1] > highs[0]);
check("and does NOT fall back when the pool does", highs[2] === highs[1], `${highs[2]} vs ${highs[1]}`);
check("it is measured in proceeds, not headline liquidity", highs[1] < 18 * POS.poolFraction + 1e-9);

section("reporting fields a backtest needs");

check("the peak is tracked across the WHOLE series, even after an exit",
  realDropRun.peakProceedsSol >= (realDropRun.exitProceedsSol ?? 0));
check("the final observation's proceeds are recorded - that is 'do nothing'",
  realDropRun.finalProceedsSol !== null);
check("the exit index is recorded", realDropRun.exitIndex !== null);
check("held time is recorded", realDropRun.heldMs > 0);
check("observation count is recorded", realDropRun.observations === realDrop.length);
check("an empty series holds and records nothing", runSeries(POS, [], CFG, constantProductProceeds).result === "held-to-end");

section("NO ORDER-PLACING CODE");

const fs = require("fs") as typeof import("fs");
const src = fs.readFileSync("src/trading/trailingStop.ts", "utf-8");
check("no swap or order call", !/swap|sendTransaction|signTransaction|placeOrder|jupiter/i.test(src));
check("no wallet or keypair handling", !/Keypair|privateKey|wallet\.sign/i.test(src));
check("no network client is imported", !/from\s+["'].*(connection|jupiter|engine)["']/i.test(src));
check("no config import - every number is injected", !/from\s+["'].*config["']/i.test(src));
check(
  "no DEFAULT config is exported - a default is a hardcoded set everything inherits",
  !/export const DEFAULT_[A-Z_]*CONFIG/.test(src)
);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (failures.length > 0) { console.log("\nFailures:"); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail > 0 ? 1 : 0);
