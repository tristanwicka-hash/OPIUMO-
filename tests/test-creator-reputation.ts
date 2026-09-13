/**
 * OPIUMO test: creator wallet reputation (offline, synthetic).
 *
 * The load-bearing checks are the ones that stop this inventing an edge:
 * reputation is POINT-IN-TIME (a launch is never scored on its own outcome),
 * a rate is never printed below the 30-per-group floor, "unknown" is never
 * counted as a good or bad outcome, and the filter is off by default.
 */
import fs from "fs";
import path from "path";
import { LaunchRecord, buildStore, classifyFate, priorStats, summariseGroup, wouldRefuse, DEFAULT_FATES, DEFAULT_CREATOR_FILTER, MIN_PER_GROUP } from "../src/analysis/creatorReputation";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` - ${d}` : ""}`); } };
const T0 = Date.parse("2026-09-13T12:00:00Z");
const at = (min: number) => T0 + min * 60_000;
const r = (sol: number, min: number) => ({ tMs: at(min), sol });

console.log("\nFate classification");
check("a pool that collapses to 10% of entry within the window is DRAINED", classifyFate(2, T0, [r(1.8, 1), r(0.2, 5)]).fate === "drained");
check("a pool that reaches 3x is RAN, even if it later collapses - the two are not the same animal", classifyFate(2, T0, [r(6, 2), r(0.1, 8)]).fate === "ran");
check("a pool that wanders without doing either is FLAT", classifyFate(2, T0, [r(2.2, 1), r(1.7, 5)]).fate === "flat");
check("a collapse AFTER the drain window is not 'drained in minutes'", classifyFate(2, T0, [r(2, 1), r(0.1, 60)]).fate === "flat");
check("no readings, or no entry liquidity, is UNKNOWN - never a fate", classifyFate(2, T0, []).fate === "unknown" && classifyFate(null, T0, [r(1, 1)]).fate === "unknown" && classifyFate(0, T0, [r(1, 1)]).fate === "unknown");
check("readings BEFORE the launch are ignored", classifyFate(2, T0, [{ tMs: at(-10), sol: 0.01 }, r(2, 5)]).fate === "flat");
check("the peak multiple is reported alongside the fate", Math.abs((classifyFate(2, T0, [r(5, 1)]).peakMultiple ?? 0) - 2.5) < 1e-9);

console.log("\nThe store");
const recs: LaunchRecord[] = [
  { mint: "m1", creator: "A", at: "2026-09-13T01:00:00Z", fate: "drained", entrySol: 2, peakMultiple: 1 },
  { mint: "m2", creator: "A", at: "2026-09-13T02:00:00Z", fate: "drained", entrySol: 2, peakMultiple: 1 },
  { mint: "m3", creator: "A", at: "2026-09-13T03:00:00Z", fate: "ran", entrySol: 2, peakMultiple: 4 },
  { mint: "m4", creator: "B", at: "2026-09-13T01:30:00Z", fate: "flat", entrySol: 2, peakMultiple: 1.1 },
  { mint: "m5", creator: "C", at: "2026-09-13T04:00:00Z", fate: "unknown", entrySol: null, peakMultiple: null },
];
const store = buildStore(recs);
check("counts per creator, with first and last seen", store.get("A")!.launches === 3 && store.get("A")!.drained === 2 && store.get("A")!.ran === 1 && store.get("A")!.firstSeen === "2026-09-13T01:00:00Z" && store.get("A")!.lastSeen === "2026-09-13T03:00:00Z");
check("drain rate is over launches with a KNOWN fate", Math.abs((store.get("A")!.drainRate ?? 0) - 2 / 3) < 1e-9);
check("a creator whose only launch is unknown has a null drain rate, not 0", store.get("C")!.drainRate === null && store.get("C")!.unknown === 1);

console.log("\nPoint in time - the check that stops this inventing an edge");
const p3 = priorStats(recs, "A", "2026-09-13T03:00:00Z");
check("scoring A's third launch sees only the two before it", p3.priorLaunches === 2 && p3.priorDrained === 2 && p3.priorDrainRate === 1);
check("A's FIRST launch has no prior history at all", priorStats(recs, "A", "2026-09-13T01:00:00Z").priorLaunches === 0);
check("a launch never counts itself: A's third is 'ran', yet its prior drain rate is 100%", p3.priorDrainRate === 1 && store.get("A")!.drainRate !== 1);
check("an unknown-fate prior counts as a launch but not as a known outcome", priorStats([...recs, { mint: "m6", creator: "A", at: "2026-09-13T00:30:00Z", fate: "unknown", entrySol: null, peakMultiple: null }], "A", "2026-09-13T01:00:00Z").priorLaunches === 1 && priorStats([...recs, { mint: "m6", creator: "A", at: "2026-09-13T00:30:00Z", fate: "unknown", entrySol: null, peakMultiple: null }], "A", "2026-09-13T01:00:00Z").priorKnown === 0);

console.log("\nThe 30-per-group floor");
const many = (n: number, fate: LaunchRecord["fate"]) => Array.from({ length: n }, () => ({ fate }));
const thin = summariseGroup("thin", many(29, "ran"));
check(`a group of 29 reports NO rate and says how short it is (floor ${MIN_PER_GROUP})`, thin.ranRate === null && thin.drainedRate === null && /INSUFFICIENT: 29/.test(thin.note ?? ""));
const fat = summariseGroup("fat", [...many(20, "ran"), ...many(20, "drained")]);
check("a group of 40 reports rates", fat.ranRate === 0.5 && fat.drainedRate === 0.5 && fat.note === null);
const withUnknown = summariseGroup("mixed", [...many(30, "ran"), ...many(100, "unknown")]);
check("unknown-fate launches are excluded from n and from every rate - they are not counted as failures", withUnknown.n === 30 && withUnknown.ranRate === 1);

console.log("\nThe filter, which is OFF");
check("disabled by default, and a disabled filter refuses nothing", DEFAULT_CREATOR_FILTER.enabled === false && wouldRefuse({ priorLaunches: 9, priorDrainRate: 1 }, DEFAULT_CREATOR_FILTER).refuse === false);
const on = { ...DEFAULT_CREATOR_FILTER, enabled: true };
check("refuses a creator over the drain limit, naming the numbers", wouldRefuse({ priorLaunches: 3, priorDrainRate: 0.67 }, on).refuse && /drained 67% of 3 prior launch/.test(wouldRefuse({ priorLaunches: 3, priorDrainRate: 0.67 }, on).reason));
check("passes a creator under the limit", !wouldRefuse({ priorLaunches: 4, priorDrainRate: 0.25 }, on).refuse);
check("too little history PASSES - unknown is not a reason to refuse an entry", !wouldRefuse({ priorLaunches: 1, priorDrainRate: 1 }, on).refuse && /not enough history/.test(wouldRefuse({ priorLaunches: 1, priorDrainRate: 1 }, on).reason));
check("no prior launch with a known fate PASSES, and says so", !wouldRefuse({ priorLaunches: 3, priorDrainRate: null }, on).refuse && /unknown is not a reason to refuse/.test(wouldRefuse({ priorLaunches: 3, priorDrainRate: null }, on).reason));
check("exactly at the limit is not over it", !wouldRefuse({ priorLaunches: 4, priorDrainRate: 0.5 }, on).refuse);

console.log("\nStructural");
const src = fs.readFileSync(path.join(__dirname, "..", "src", "analysis", "creatorReputation.ts"), "utf-8");
check("the module is pure: no network, no config, no clock", !/fetch\(|Connection|loadConfig|Date\.now\(\)/.test(src));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "default.json"), "utf-8"));
check("config has the block and it is disabled", cfg.paperExecution.creatorReputation.enabled === false && cfg.paperExecution.creatorReputation.minPriorLaunches === 2);
const engine = fs.readFileSync(path.join(__dirname, "..", "src", "filters", "engine.ts"), "utf-8");
const dlog = fs.readFileSync(path.join(__dirname, "..", "src", "filters", "decisionLog.ts"), "utf-8");
check("the creator reaches the decision row, from the event the watcher already resolved", /creator: event\.creator \?\? null/.test(engine) && /creator: result\.creator \?\? null/.test(dlog));
check("nothing in the live filter path consults the reputation store yet", !/creatorReputation|wouldRefuse/.test(engine));
const backfill = fs.readFileSync(path.join(__dirname, "..", "scripts", "backfill-creators.ts"), "utf-8");
check("the backfill cannot spend without an explicit cap", /Refusing to spend without --max-calls/.test(backfill) && /if \(calls >= maxCalls\) break;/.test(backfill));
check("the backfill reads the fee payer from STATIC keys, so a versioned transaction resolves", /staticAccountKeys\?\.\[0\]/.test(backfill));

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
