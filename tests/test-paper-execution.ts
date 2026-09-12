/**
 * Paper execution + shadow filter tests. Offline, no clock, no network.
 *
 * Two load-bearing sections:
 *   - NO ORDER PATH may be reachable from paper execution (structural, grepped)
 *   - ZERO added RPC: shadow evaluation must not import or touch a Connection
 */
import fs from "fs";
import path from "path";
import { PaperBook, PaperConfig, summarise } from "../src/trading/paperExecution";
import { constantProductProceeds, unsellable, TrailingStopConfig } from "../src/trading/trailingStop";
import { venuePricing, bondingCurveProceeds, bondingCurveFloorFraction } from "../src/analysis/venueModels";
import { evaluateShadows, tally, uncheckedFields, ShadowSet } from "../src/filters/shadowFilters";
import { loadConfig } from "../src/config";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " -- " + detail : ""}`); console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
function section(t: string): void { console.log(`\n=== ${t} ===\n`); }

const T0 = Date.UTC(2026, 8, 11, 12, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const obs = (s: number, liq: number) => ({ ts: at(s), liquiditySol: liq });

const TRAIL: TrailingStopConfig = {
  hardStopPercent: -50, activationPercent: 30, trailPercent: 20,
  persistenceObservations: 2, minHoldMs: 60_000,
};
const CFG: PaperConfig = { poolFraction: 0.05, maxOpenPositions: 3, includeRejected: true, trailing: TRAIL };
const book = () => new PaperBook(CFG, constantProductProceeds);

section("entry uses REALIZABLE PROCEEDS, never the headline price");

const b = book();
const { opened } = b.open({ mint: "A", at: at(0), liquiditySol: 10, liveVerdict: "PASS" });
check("a position opens", opened !== null);
const headline = 10 * 0.05;
check("entry proceeds are BELOW the headline share of the pool", (opened as any).entryProceedsSol < headline);
check("and match the constant-product model", Math.abs((opened as any).entryProceedsSol - (constantProductProceeds(10, 0.05) as number)) < 1e-12);
check("the raw pool liquidity is also recorded", (opened as any).entryLiquiditySol === 10);
check("the live verdict travels with the position", (opened as any).liveVerdict === "PASS");

section("VENUE PRICING (APPROVALS 37): Pump.fun on the bonding curve, Raydium on constant product, unknown falls back and says so");

const bv = new PaperBook(CFG, venuePricing);
const pf = bv.open({ mint: "PF", at: at(0), liquiditySol: 2, liveVerdict: "REJECTED", source: "pumpfun" }).opened!;
const ray = bv.open({ mint: "RAY", at: at(0), liquiditySol: 2, liveVerdict: "REJECTED", source: "raydium" }).opened!;
const unk = bv.open({ mint: "UNK", at: at(0), liquiditySol: 2, liveVerdict: "REJECTED" }).opened!;
check("venue is recorded on the position", pf.venue === "pumpfun" && ray.venue === "raydium" && unk.venue === null);
check("the pricing model is recorded on every position", /bonding curve/.test(pf.pricingModel) && /constant-product/.test(ray.pricingModel) && /venue unknown/.test(unk.pricingModel));
const stake = 0.05 * 2;
check("Pump.fun entry proceeds = curve round trip of a 5%-of-pool stake (fees included)", Math.abs(pf.entryProceedsSol - (bondingCurveProceeds(stake, 2, 2) as number)) < 1e-12);
check("Raydium entry proceeds = constant product, exactly as before", Math.abs(ray.entryProceedsSol - (constantProductProceeds(2, 0.05) as number)) < 1e-12);
check("unknown venue = constant product, exactly as before", Math.abs(unk.entryProceedsSol - (constantProductProceeds(2, 0.05) as number)) < 1e-12);
// Drain both pools to zero after the minimum hold.
for (const [i, liq] of [[61, 1.0], [62, 0.2], [63, 0], [64, 0]] as [number, number][]) {
  bv.observe("PF", obs(i, liq)); bv.observe("RAY", obs(i, liq)); bv.observe("UNK", obs(i, liq));
}
const pfAfter = [...bv.openPositions(), ...bv.closedPositions()].find((p) => p.mint === "PF")!;
const rayAfter = bv.closedPositions().find((p) => p.mint === "RAY");
check("a Raydium position drained to zero hits the -50% hard stop", !!rayAfter && rayAfter.outcome === "closed" && /hard stop/.test(rayAfter.exitReason ?? ""));
check("a Pump.fun position bought at 2 SOL raised and drained to zero does NOT hit -50%: the curve floors it", pfAfter.outcome === "open", pfAfter.exitReason ?? pfAfter.outcome);
const floorProceeds = bondingCurveProceeds(stake, 2, 0) as number;
check("...its last valuation is the curve's floor for that stake (~86% of it at 2 SOL raised; the 1-SOL floor fraction is a slightly lower ~81%)", pfAfter.lastProceedsSol !== null && Math.abs(pfAfter.lastProceedsSol - floorProceeds) < 1e-12 && floorProceeds / stake > 0.85 && floorProceeds / stake < 0.87 && bondingCurveFloorFraction(2) > 0.8 && bondingCurveFloorFraction(2) < 0.82, `${pfAfter.lastProceedsSol} vs ${floorProceeds}, floor(1 SOL)=${bondingCurveFloorFraction(2)}`);
// A large-raise Pump.fun entry CAN still hit the stop: floor below 50% above 12.4 SOL raised.
const bigBook = new PaperBook(CFG, venuePricing);
bigBook.open({ mint: "BIG", at: at(0), liquiditySol: 40, liveVerdict: "REJECTED", source: "pumpfun" });
for (const [i, liq] of [[61, 10], [62, 0], [63, 0]] as [number, number][]) bigBook.observe("BIG", obs(i, liq));
const big = bigBook.closedPositions().find((p) => p.mint === "BIG");
check("a Pump.fun position bought at 40 SOL raised and drained DOES hit -50% (floor there is ~18%)", !!big && big.outcome === "closed" && /hard stop/.test(big.exitReason ?? ""));
check("a plain ProceedsFn still works as one model for every venue", book().open({ mint: "ONE", at: at(0), liquiditySol: 10, liveVerdict: "PASS", source: "pumpfun" }).opened!.pricingModel === "single model for every venue");

section("UNKNOWN liquidity is refused, never treated as zero or invented");

const bn = book();
const r = bn.open({ mint: "N", at: at(0), liquiditySol: null, liveVerdict: "PASS" });
check("no position is opened", r.opened === null);
check("the refusal says liquidity could not be read", (r.refusal?.reason ?? "").includes("null"));
check("it is recorded, not silent", bn.refusalList().length === 1);
const bu = new PaperBook(CFG, unsellable);
check("an unsellable pool is refused at entry", bu.open({ mint: "U", at: at(0), liquiditySol: 10, liveVerdict: "PASS" }).opened === null);

section("THE CAP IS REPORTED, NOT APPLIED SILENTLY");

const bc = new PaperBook({ ...CFG, maxOpenPositions: 2 }, constantProductProceeds);
bc.open({ mint: "1", at: at(0), liquiditySol: 10, liveVerdict: "PASS" });
bc.open({ mint: "2", at: at(0), liquiditySol: 10, liveVerdict: "PASS" });
const third = bc.open({ mint: "3", at: at(0), liquiditySol: 10, liveVerdict: "PASS" });
check("the third is refused at a cap of 2", third.opened === null);
check("open count stays at the cap", bc.openCount === 2);
check("the refusal names the cap", (third.refusal?.reason ?? "").includes("cap reached"));
check("and explains why silent capping would bias the sample", (third.refusal?.reason ?? "").includes("biasing"));
check("the summary counts cap refusals separately", summarise(bc).refusedByCap === 1);
check("a duplicate mint is refused too", bc.open({ mint: "1", at: at(0), liquiditySol: 10, liveVerdict: "PASS" }).opened === null);

section("tracking to close, on observations it does not fetch");

const bt = book();
bt.open({ mint: "R", at: at(0), liquiditySol: 10, liveVerdict: "PASS" });
for (const o of [obs(60, 14), obs(120, 16), obs(180, 11), obs(240, 10.5)]) bt.observe("R", o);
const closedR = bt.closedPositions().find((p) => p.mint === "R");
check("the position closed", closedR?.outcome === "closed", closedR?.exitReason ?? undefined);
check("an exit price is recorded", (closedR?.exitProceedsSol ?? 0) > 0);
check("the peak is tracked", (closedR?.peakProceedsSol ?? 0) > (closedR?.entryProceedsSol ?? 0));
check("observations are counted", (closedR?.observations ?? 0) === 4);
check("it is no longer open", bt.openCount === 0);
check("observing an unknown mint is a no-op", bt.observe("nope", obs(300, 5)) === null);

section("ABANDONED is not a close - the stop never fired");

const ba = book();
ba.open({ mint: "X", at: at(0), liquiditySol: 10, liveVerdict: "REJECTED" });
ba.observe("X", obs(60, 12));
const ab = ba.abandon("X", at(120), "watchlist evicted the token");
check("outcome is abandoned", ab?.outcome === "abandoned");
check("NOT closed", ab?.outcome !== "closed");
check("no exit price is invented", ab?.exitProceedsSol === null);
check("the reason says it is not an exit", (ab?.exitReason ?? "").includes("NOT an exit"));
const sa = summarise(ba);
check("abandoned is counted separately", sa.abandoned === 1 && sa.closed === 0);
check("and contributes nothing to realised P&L", sa.realisedPnlSol === 0);

section("results split by what the LIVE filters decided");

const bs = book();
bs.open({ mint: "P", at: at(0), liquiditySol: 10, liveVerdict: "PASS" });
bs.open({ mint: "J", at: at(0), liquiditySol: 10, liveVerdict: "REJECTED" });
for (const m of ["P", "J"]) for (const o of [obs(60, 14), obs(120, 16), obs(180, 11), obs(240, 10.5)]) bs.observe(m, o);
const ss = summarise(bs);
check("both closed", ss.closed === 2);
check("PASS results are tallied on their own", ss.byVerdict.PASS.closed === 1);
check("REJECTED results are tallied on their own", ss.byVerdict.REJECTED.closed === 1);
check(
  "which is the comparison that makes a 0% pass rate readable",
  ss.byVerdict.PASS.realisedPnlSol !== undefined && ss.byVerdict.REJECTED.realisedPnlSol !== undefined
);
const bex = new PaperBook({ ...CFG, includeRejected: false }, constantProductProceeds);
check("includeRejected=false refuses rejected tokens", bex.open({ mint: "J2", at: at(0), liquiditySol: 10, liveVerdict: "REJECTED" }).opened === null);

section("SHADOW FILTERS: zero added RPC, and unchecked fields are named");

const live = loadConfig().filters;
const loose: ShadowSet[] = [
  { id: "half-liquidity", rationale: "half the liquidity floor", filters: { ...live, minLiquiditySol: live.minLiquiditySol / 2 } },
  { id: "no-activity", rationale: "drop the activity floors", filters: { ...live, minUniqueWallets: 0, minTransactionCount: 0 } },
];
const metrics: any = {
  mint: "M", fetchedAt: at(0), decimals: 6, liquiditySol: 3,
  topHolderPercent: 5, devWalletPercent: 1,
  mintAuthorityRenounced: true, freezeAuthorityRenounced: true,
  uniqueWallets: null, transactionCount: null, riskyTokenExtensions: [], stale: false,
};
const ev = evaluateShadows({ mint: "M" } as any, metrics, "SKIP", loose);
check("every set is evaluated", ev.shadows.length === 2);
check("the live decision is carried alongside", ev.liveDecision === "SKIP");
check("unchecked fields are named", ev.shadows[0].uncheckedFields.includes("uniqueWallets"));
check("and both missing ones appear", ev.shadows[0].uncheckedFields.includes("transactionCount"));
check("a fully-populated fetch has no unchecked fields",
  uncheckedFields({ ...metrics, uniqueWallets: 5, transactionCount: 9 }).length === 0);
check("null liquidity is reported unchecked", uncheckedFields({ ...metrics, liquiditySol: null }).includes("liquiditySol"));

const t = tally([ev, ev, { ...ev, liveDecision: "PASS" as const }], ["half-liquidity", "no-activity"]);
check("live pass rate is computed", Math.abs((t.live.passRate as number) - 1 / 3) < 1e-9);
check("each shadow set is tallied", t.shadows.length === 2);
check("passes reached with unchecked fields are counted separately",
  t.shadows.every((s) => s.passedWithUnchecked <= s.passed));
check("an empty sample yields a NULL pass rate, not 0",
  tally([], ["half-liquidity"]).shadows[0].passRate === null);

section("NO ORDER PATH IS REACHABLE FROM PAPER EXECUTION");

// Comments are stripped BEFORE scanning. These modules describe at length what
// they refuse to do ("no wallet, no Keypair, no signing"), and a guard that
// matched prose would fail on the documentation of its own guarantee.
const readRaw = (f: string) => fs.readFileSync(path.resolve(process.cwd(), f), "utf-8");
const read = (f: string) =>
  readRaw(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
// Deliberately specific. A bare /wallet/ matched the METRIC names
// devWalletPercent and uniqueWallets, which are read-only measurements, not
// order paths - a guard that cries wolf on those gets loosened by the next
// person to hit it. These patterns each indicate an actual ability to sign or
// send.
const ORDER = /\bswap\b|sendTransaction|signTransaction|\bKeypair\b|privateKey|walletPrivateKey|wallet\.sign|jupiter|placeOrder|buildTransaction|VersionedTransaction|SpotTradingEngine/i;
for (const f of ["src/trading/paperExecution.ts", "src/filters/shadowFilters.ts"]) {
  check(`${f} contains no order-placing vocabulary`, !ORDER.test(read(f)), f);
  check(`${f} imports no Connection`, !/from\s+["'].*(rpc\/connection|@solana\/web3\.js)["']/.test(read(f)));
}
check(
  "paperExecution imports nothing from the live trading engine",
  !/from\s+["'].*engine["']/.test(read("src/trading/paperExecution.ts"))
);
check(
  "shadowFilters is SYNCHRONOUS - it cannot await a network call",
  !/async\s+function|await\s/.test(read("src/filters/shadowFilters.ts"))
);
check(
  "shadowFilters never constructs a Connection",
  !/new Connection|getConnection/.test(read("src/filters/shadowFilters.ts"))
);

section("APPROVALS 43: raised-stop OR take-profit for Pump.fun, trailing stop for everyone else (paper book only)");

{
  const RTP = { enabled: true, venues: ["pumpfun"], raisedDropPercent: 30, takeProfitPercent: 50, persistenceObservations: 2, minHoldMs: 60_000 };
  const cfgR: PaperConfig = { poolFraction: 0.05, maxOpenPositions: 10, includeRejected: true, trailing: TRAIL, raisedTakeProfit: RTP };
  const br = new PaperBook(cfgR, venuePricing);
  const pf = br.open({ mint: "PF", at: at(0), liquiditySol: 2, liveVerdict: "REJECTED", source: "pumpfun" }).opened!;
  const ray = br.open({ mint: "RAY", at: at(0), liquiditySol: 2, liveVerdict: "REJECTED", source: "raydium" }).opened!;
  const unk = br.open({ mint: "UNK", at: at(0), liquiditySol: 2, liveVerdict: "REJECTED" }).opened!;
  check("a Pump.fun position opens under raised-stop-or-take-profit and records it on the row", pf.exitRule === "raised-stop-or-take-profit" && pf.raisedState !== undefined);
  check("a Raydium position keeps the trailing stop", ray.exitRule === "trailing" && ray.raisedState === undefined);
  check("an unknown venue keeps the trailing stop", unk.exitRule === "trailing");

  // Drain: 2 SOL raised -> 1.8 (30s) -> 1.0 (61s) -> 0.4 (90s). Stop line = 1.4.
  br.observe("PF", obs(30, 1.8));
  check("30s: inside the hold, still open", br.openPositions().some((p) => p.mint === "PF"));
  br.observe("PF", obs(61, 1.0));
  check("61s: first breach after the hold, not yet persistent - still open", br.openPositions().some((p) => p.mint === "PF"));
  const drained = br.observe("PF", obs(90, 0.4))!;
  check("90s: second consecutive breach -> closed by the raised stop, with the reason on the row", drained.outcome === "closed" && /^raised-stop: SOL raised 0\.400 <= 1\.400/.test(drained.exitReason ?? ""), drained.exitReason ?? "");
  check("...the exit is priced on the curve at 0.4 raised (about 86-90% of entry), not zero", drained.exitProceedsSol !== null && drained.exitProceedsSol / drained.entryProceedsSol > 0.85 && drained.exitProceedsSol / drained.entryProceedsSol < 0.95, String(drained.exitProceedsSol));
  // The same drain under the trailing value stop on the curve never fires (this is why the rule exists).
  const bt = new PaperBook({ ...cfgR, raisedTakeProfit: null }, venuePricing);
  bt.open({ mint: "PF", at: at(0), liquiditySol: 2, liveVerdict: "REJECTED", source: "pumpfun" });
  bt.observe("PF", obs(30, 1.8)); bt.observe("PF", obs(61, 1.0)); bt.observe("PF", obs(90, 0.4)); bt.observe("PF", obs(120, 0.0));
  check("the same drain under the trailing value stop is still open at 0 SOL raised (curve floor)", bt.openPositions().some((p) => p.mint === "PF"));

  // Runner: 2 -> 8 (1.41x, below +50%) -> 16 (2.07x) - take-profit fires at 16, no hold, no persistence.
  const b2 = new PaperBook(cfgR, venuePricing);
  const r = b2.open({ mint: "R", at: at(0), liquiditySol: 2, liveVerdict: "REJECTED", source: "pumpfun" }).opened!;
  b2.observe("R", obs(5, 8));
  check("+41% is not +50%: still open", b2.openPositions().some((p) => p.mint === "R"));
  const tp = b2.observe("R", obs(10, 16))!;
  check("value >= entry x 1.5 -> closed by take-profit inside the hold and on the first reading (no persistence)", tp.outcome === "closed" && /^take-profit:/.test(tp.exitReason ?? "") && tp.exitProceedsSol !== null && tp.exitProceedsSol >= r.entryProceedsSol * 1.5, tp.exitReason ?? "");

  // Wick: one breach then recovery resets the streak.
  const b3 = new PaperBook(cfgR, venuePricing);
  b3.open({ mint: "W", at: at(0), liquiditySol: 2, liveVerdict: "REJECTED", source: "pumpfun" });
  b3.observe("W", obs(61, 1.0)); b3.observe("W", obs(90, 1.9)); const w = b3.observe("W", obs(120, 1.0))!;
  check("a breach, a recovery, a breach: streak reset, still open", w.outcome === "open" && w.raisedState?.consecutiveBreaches === 1);
  // Readings inside the hold do not count toward the streak.
  const b4 = new PaperBook(cfgR, venuePricing);
  b4.open({ mint: "H", at: at(0), liquiditySol: 2, liveVerdict: "REJECTED", source: "pumpfun" });
  b4.observe("H", obs(10, 1.0)); b4.observe("H", obs(30, 1.0)); const h = b4.observe("H", obs(61, 1.0))!;
  check("two breaches inside the hold and one after: streak is 1, still open", h.outcome === "open" && h.raisedState?.consecutiveBreaches === 1, String(h.raisedState?.consecutiveBreaches));
  // Unsellable -> EXIT_FAILED, never a clean exit.
  const b5 = new PaperBook(cfgR, unsellable as any);
  b5.open({ mint: "U", at: at(0), liquiditySol: 2, liveVerdict: "REJECTED", source: "pumpfun" });
  check("an unsellable Pump.fun position under the rule cannot even open (entry realises nothing)", b5.openPositions().length === 0);
  // Disabled -> every new position is trailing.
  const b6 = new PaperBook({ ...cfgR, raisedTakeProfit: { ...RTP, enabled: false } }, venuePricing);
  const off = b6.open({ mint: "PF", at: at(0), liquiditySol: 2, liveVerdict: "REJECTED", source: "pumpfun" }).opened!;
  check("enabled=false -> a Pump.fun position opens under the trailing stop", off.exitRule === "trailing");
  // The live config carries the block and it validates.
  const live = loadConfig();
  const lr = live.paperExecution.raisedTakeProfit;
  check("config/default.json enables the rule for pumpfun only: -30% raised / +50% take-profit / persist 2 / hold 60 s", !!lr && lr.enabled && lr.venues.join() === "pumpfun" && lr.raisedDropPercent === 30 && lr.takeProfitPercent === 50 && lr.persistenceObservations === 2 && lr.minHoldMs === 60_000);
  check("raisedExit.ts has no order path (no Jupiter, no Connection, no signing)", !/jupiter|Connection|sendTransaction|signTransaction|Keypair/.test(read("src/trading/raisedExit.ts")));
}

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (failures.length) { console.log("\nFailures:"); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail > 0 ? 1 : 0);
