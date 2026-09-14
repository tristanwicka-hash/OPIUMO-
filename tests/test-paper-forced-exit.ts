/**
 * Stale-observation and max-hold exits for the paper book. Offline, no clock.
 *
 * A paper position only ever closed from a watchlist observation, so a token
 * the watchlist stopped reading stayed open forever. `PaperBook.expire` closes
 * those at their last known proceeds with a distinct exitReason.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { PaperBook, PaperConfig, PaperPosition, ForcedExitConfig, summarise } from "../src/trading/paperExecution";
import { lastWatchlistReadings } from "../src/trading/paperBookStore";
import { constantProductProceeds, TrailingStopConfig } from "../src/trading/trailingStop";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " -- " + detail : ""}`); console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
function section(t: string): void { console.log(`\n=== ${t} ===\n`); }

const MIN = 60_000, HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 14, 12, 0, 0);
const at = (ms: number) => new Date(T0 + ms).toISOString();

const TRAIL: TrailingStopConfig = { hardStopPercent: -50, activationPercent: 30, trailPercent: 20, persistenceObservations: 2, minHoldMs: 60_000 };
const CFG: PaperConfig = { poolFraction: 0.05, maxOpenPositions: 10, includeRejected: true, trailing: TRAIL };
const FX: ForcedExitConfig = { enabled: true, staleObservationMs: 6 * HOUR, maxHoldMs: 24 * HOUR };
const cp = (liq: number) => constantProductProceeds(liq, 0.05) as number;

section("max-hold: a position still being observed closes when held too long, at its last observed proceeds");

{
  const b = new PaperBook(CFG, constantProductProceeds);
  b.open({ mint: "HOLD", at: at(0), liquiditySol: 10, liveVerdict: "PASS" });
  // Observed every 30 min at +10% (inside every stop), right up to the limit.
  let t = 30 * MIN;
  for (; t < 24 * HOUR; t += 30 * MIN) b.observe("HOLD", { ts: at(t), liquiditySol: 11 });
  const lastObs = t - 30 * MIN;
  check("the exit rule never fired on its own", b.openCount === 1);
  check("nothing closes one second before the limit", b.expire(at(24 * HOUR - 1000), FX).length === 0 && b.openCount === 1);
  const [p] = b.expire(at(24 * HOUR), FX);
  check("closes at exactly the limit", p?.mint === "HOLD" && b.openCount === 0);
  check("outcome is closed", p?.outcome === "closed");
  check("exitReason is distinct: starts max-hold:", /^max-hold: held 24\.0h \(limit 24\.0h\)/.test(p?.exitReason ?? ""), p?.exitReason ?? "");
  check("and says the exit rule never fired", /exit rule never fired/.test(p?.exitReason ?? ""));
  check("exit proceeds = the LAST OBSERVED proceeds, not entry", Math.abs((p?.exitProceedsSol ?? 0) - cp(11)) < 1e-12 && p?.exitProceedsSol !== p?.entryProceedsSol, `${p?.exitProceedsSol} vs ${cp(11)}`);
  check("forcedExit record: rule, held, silence, price source", p?.forcedExit?.rule === "max-hold" && p.forcedExit.heldMs === 24 * HOUR && p.forcedExit.silentMs === 24 * HOUR - lastObs && /last observation at/.test(p.forcedExit.priceSource), JSON.stringify(p?.forcedExit));
  check("counted as a closed position in the summary, with its P&L", summarise(b).closed === 1 && Math.abs(summarise(b).realisedPnlSol - (cp(11) - cp(10))) < 1e-12);
  check("an observation after the close does nothing", b.observe("HOLD", { ts: at(25 * HOUR), liquiditySol: 1 }) === null);
  check("a second sweep closes nothing", b.expire(at(30 * HOUR), FX).length === 0 && b.closedPositions().length === 1);
}

section("stale-observation: a position that stops being observed closes after the silence limit");

{
  const b = new PaperBook(CFG, constantProductProceeds);
  b.open({ mint: "DARK", at: at(0), liquiditySol: 10, liveVerdict: "REJECTED" });
  b.observe("DARK", { ts: at(1 * MIN), liquiditySol: 9 });
  b.observe("DARK", { ts: at(2 * MIN), liquiditySol: 8.5 }); // -15%: inside the -50% hard stop
  check("still open after its last observation", b.openCount === 1 && b.openPositions()[0].lastObservedAt === at(2 * MIN));
  check("not closed one second before 6h of silence", b.expire(at(2 * MIN + 6 * HOUR - 1000), FX).length === 0);
  const [p] = b.expire(at(2 * MIN + 6 * HOUR), FX);
  check("closed at 6h of silence", p?.mint === "DARK" && b.openCount === 0);
  check("exitReason is distinct: starts stale-observation:", /^stale-observation: no observation for 6\.0h \(limit 6\.0h\)/.test(p?.exitReason ?? ""), p?.exitReason ?? "");
  check("exit proceeds = proceeds at the last reading (8.5 SOL)", Math.abs((p?.exitProceedsSol ?? 0) - cp(8.5)) < 1e-12);
  check("forcedExit rule is stale-observation, silence measured from the last reading", p?.forcedExit?.rule === "stale-observation" && p.forcedExit.silentMs === 6 * HOUR && p.forcedExit.heldMs === 6 * HOUR + 2 * MIN);
}

section("which fires, and when neither may");

{
  const b = new PaperBook(CFG, constantProductProceeds);
  b.open({ mint: "NEVER", at: at(0), liquiditySol: 10, liveVerdict: "PASS" });
  const [p] = b.expire(at(6 * HOUR), FX);
  check("opened and never observed: silence counts from entry", p?.forcedExit?.rule === "stale-observation" && p.forcedExit.silentMs === 6 * HOUR);
  check("and closes at its entry valuation, which says so", p?.exitProceedsSol === p?.entryProceedsSol && /entry valuation/.test(p?.forcedExit?.priceSource ?? ""));

  const both = new PaperBook(CFG, constantProductProceeds);
  both.open({ mint: "BOTH", at: at(0), liquiditySol: 10, liveVerdict: "PASS" });
  both.observe("BOTH", { ts: at(1 * MIN), liquiditySol: 10 });
  check("when both limits are past, stale-observation is the one recorded", both.expire(at(48 * HOUR), FX)[0]?.forcedExit?.rule === "stale-observation");

  const off = new PaperBook(CFG, constantProductProceeds);
  off.open({ mint: "OFF", at: at(0), liquiditySol: 10, liveVerdict: "PASS" });
  check("enabled=false forces nothing, ever", off.expire(at(1000 * HOUR), { ...FX, enabled: false }).length === 0 && off.openCount === 1);

  const rule = new PaperBook(CFG, constantProductProceeds);
  rule.open({ mint: "RUG", at: at(0), liquiditySol: 10, liveVerdict: "REJECTED" });
  let c: PaperPosition | null = null;
  for (const m of [2, 3]) c = rule.observe("RUG", { ts: at(m * MIN), liquiditySol: 0.1 }) ?? c;
  check("an observation that trips the exit rule still closes by the RULE, not forced", c?.outcome === "closed" && !c.forcedExit && /hard stop/.test(c.exitReason ?? ""), c?.exitReason ?? "");
  check("and the sweep then has nothing to close", rule.expire(at(100 * HOUR), FX).length === 0);
}

section("restored positions: a real last reading, or no price at all - never a made-up 0%");

{
  const rows = [
    { mint: "SEEDED", openedAt: at(0), liveVerdict: "REJECTED" as const, venue: null, entryLiquiditySol: 10, entryProceedsSol: cp(10), poolFraction: 0.05 },
    { mint: "BLIND", openedAt: at(0), liveVerdict: "REJECTED" as const, venue: null, entryLiquiditySol: 10, entryProceedsSol: cp(10), poolFraction: 0.05 },
    { mint: "EARLY", openedAt: at(10 * MIN), liveVerdict: "PASS" as const, venue: null, entryLiquiditySol: 10, entryProceedsSol: cp(10), poolFraction: 0.05 },
  ];
  const seeds = new Map([
    ["SEEDED", { ts: at(40 * MIN), liquiditySol: 3 }],
    ["EARLY", { ts: at(5 * MIN), liquiditySol: 50 }], // BEFORE its open: not a reading of this position
  ]);
  const b = new PaperBook({ ...CFG, drawdown: { enabled: true, maxDailyLoss: 1000, maxTotalLoss: 1000, maxPeakDrawdown: 1000, unit: "SOL" } }, constantProductProceeds);
  const r = b.restore(rows, at(20 * HOUR), seeds);
  check("one seeded; a reading from before the open is ignored", r.lastObservationSeeded === 1, JSON.stringify(r));
  const seeded = b.openPositions().find((p) => p.mint === "SEEDED")!;
  check("the seeded position carries the reading's time and value", seeded.lastObservedAt === at(40 * MIN) && Math.abs((seeded.lastProceedsSol ?? 0) - cp(3)) < 1e-12 && /seeded from the reading/.test(seeded.restored?.note ?? ""));
  check("seeding does not step the exit rule (-70% would be a hard stop)", b.openCount === 3);

  const closed = b.expire(at(20 * HOUR), FX);
  const by = new Map(closed.map((p) => [p.mint, p]));
  check("all three are stale and all close in one sweep", closed.length === 3 && b.openCount === 0);
  check("SEEDED closes at its last real reading", Math.abs((by.get("SEEDED")?.exitProceedsSol ?? 0) - cp(3)) < 1e-12 && /last observation at/.test(by.get("SEEDED")?.forcedExit?.priceSource ?? ""));
  check("BLIND (no reading) closes with NO exit price, and says why", by.get("BLIND")?.exitProceedsSol === null && /no logged reading/.test(by.get("BLIND")?.exitReason ?? ""));
  check("EARLY is treated as never read too", by.get("EARLY")?.exitProceedsSol === null);
  const s = summarise(b);
  check("realised P&L counts only the priced close", s.closed === 3 && Math.abs(s.realisedPnlSol - (cp(3) - cp(10))) < 1e-12, JSON.stringify(s));
  check("the drawdown guard sees the priced close and not the unpriced ones", Math.abs((b.drawdownState?.totalPnl ?? 0) - (cp(3) - cp(10))) < 1e-9 /* the guard rounds to 10 dp */, String(b.drawdownState?.totalPnl));
}

section("lastWatchlistReadings: latest real reading per mint, across rotation, failed reads skipped");

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opiumo-forced-exit-"));
  const file = path.join(dir, "watchlist.jsonl");
  const row = (ts: number, mint: string, liq: number | null, event = "checked") => JSON.stringify({ ts: at(ts), event, mint, liquiditySol: liq });
  fs.writeFileSync(path.join(dir, "watchlist.2026-09-14T11-00-00-000Z.jsonl"), [row(1, "A", 5), row(2, "B", 7)].join("\n") + "\n");
  fs.writeFileSync(file, [row(3, "A", 4), row(4, "A", null), row(5, "A", 9, "promoted"), row(6, "C", 1), "garbage \"checked\""].join("\n") + "\n");
  const m = lastWatchlistReadings(file, new Set(["A", "B"]));
  check("A: the latest CHECKED reading with a value (4), not the failed read or a promoted row", m.get("A")?.liquiditySol === 4 && m.get("A")?.ts === at(3), JSON.stringify(m.get("A")));
  check("B: found in the rotated file", m.get("B")?.liquiditySol === 7);
  check("C: not asked for, not returned", !m.has("C") && m.size === 2);
  fs.rmSync(dir, { recursive: true, force: true });
}

section("WIRED, not just correct");

{
  const index = fs.readFileSync(path.join("src", "index.ts"), "utf-8");
  const cfg = JSON.parse(fs.readFileSync(path.join("config", "default.json"), "utf-8")).paperExecution.forcedExit;
  check("config has forcedExit with both limits and an interval", cfg?.enabled === true && cfg.staleObservationMs > 0 && cfg.maxHoldMs > 0 && cfg.checkIntervalMs > 0, JSON.stringify(cfg));
  check("src/index.ts calls paperBook.expire with the config block", /paperBook\.expire\(new Date\(\)\.toISOString\(\), forcedExit\)/.test(index));
  check("forced closes are logged through the same close path as rule closes", /for \(const p of closed\) recordPaperClose\(p\)/.test(index) && /recordPaperClose\(after\)/.test(index));
  const startupSweep = index.search(/^\s*sweep\(\);\s*$/m); // an uncommented call on its own line
  check("swept once at startup, AFTER the restore", startupSweep > 0 && startupSweep > index.indexOf("paperBook.restore("));
  check("then on a timer that is unref'd (must not keep a detection-off process alive)", /setInterval\(sweep, forcedExit\.checkIntervalMs\)\.unref/.test(index));
  check("the restore is seeded from the watchlist log", /lastWatchlistReadings\(config\.logging\.watchlistFile/.test(index));
}

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:\n  " + failures.join("\n  ")); process.exit(1); }
