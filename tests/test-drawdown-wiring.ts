/**
 * Is the drawdown kill switch actually WIRED to anything?
 *
 * ## Why this file exists
 *
 * `tests/test-drawdown-guard.ts` proves the guard's logic is correct, and it
 * passed every time. On 2026-09-13 an audit asked a different question of every
 * component - "has this ever actually run?" - and found that
 * `src/risk/drawdownGuard.ts` was imported by NOTHING except that test. 172
 * lines of loss-limit logic, copy-pasted into three repos, and not one bot
 * called it. Three bots record positions; none of them could ever have been
 * stopped by the thing built to stop them.
 *
 * A correct component nothing calls is not a safety net. It is a document about
 * one, and it is indistinguishable from a working safety net in a green suite.
 *
 * So these tests assert the CONNECTION, not the logic:
 *   - a book with the guard on stops opening positions once a limit is hit,
 *   - the halt survives being rebuilt from persisted state,
 *   - a book with the guard OFF behaves exactly as it did before it was wired,
 *   - and an unreadable state file refuses rather than starting from zero.
 *
 * Offline. No clock, no network.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { PaperBook, PaperConfig } from "../src/trading/paperExecution";
import { constantProductProceeds, TrailingStopConfig } from "../src/trading/trailingStop";
import { loadDrawdownState, saveDrawdownState } from "../src/risk/drawdownStore";
import { emptyState, DrawdownState } from "../src/risk/drawdownGuard";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  PASS: ${n}`); } else { fail++; console.log(`  FAIL: ${n}${d ? " -- " + d : ""}`); } };
const section = (t: string) => console.log(`\n=== ${t} ===\n`);

const T0 = Date.UTC(2026, 8, 13, 12, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const TRAIL: TrailingStopConfig = { hardStopPercent: -50, activationPercent: 30, trailPercent: 20, persistenceObservations: 2, minHoldMs: 60_000 };
const BASE: PaperConfig = { poolFraction: 0.05, maxOpenPositions: 10, includeRejected: true, trailing: TRAIL };
const GUARD = { enabled: true, maxDailyLoss: 0.05, maxTotalLoss: 0.2, maxPeakDrawdown: 0.2, unit: "SOL" };

/** Open a position and drive it to a loss big enough to trip the hard stop. */
function loseOne(b: PaperBook, mint: string, t: number): void {
  b.open({ mint, at: at(t), liquiditySol: 10, liveVerdict: "PASS" });
  // Collapse the pool: hard stop is -50%, and it needs two consecutive
  // readings past the minimum hold.
  b.observe(mint, { ts: at(t + 61), liquiditySol: 1 });
  b.observe(mint, { ts: at(t + 122), liquiditySol: 1 });
  b.observe(mint, { ts: at(t + 183), liquiditySol: 1 });
}

section("with the guard OFF, nothing changes");
{
  const b = new PaperBook(BASE, constantProductProceeds);
  loseOne(b, "A", 0);
  check("no drawdown state exists at all", b.drawdownState === null);
  const r = b.open({ mint: "B", at: at(400), liquiditySol: 10, liveVerdict: "PASS" });
  check("the book keeps opening positions", r.opened !== null, r.refusal?.reason);
}

section("with the guard ON, a breach stops the book");
{
  const b = new PaperBook({ ...BASE, drawdown: { ...GUARD, state: emptyState(new Date(T0)) } }, constantProductProceeds);
  check("state exists once the guard is on", b.drawdownState !== null);
  loseOne(b, "A", 0);
  const st = b.drawdownState!;
  check("the realised loss reached the guard", st.totalPnl < 0, `totalPnl=${st.totalPnl}`);
  check("the trade was counted", st.trades === 1);
  check("the book recorded a halt", st.halted !== null, JSON.stringify(st.halted));
  const r = b.open({ mint: "B", at: at(400), liquiditySol: 10, liveVerdict: "PASS" });
  check("a HALTED book refuses to open anything", r.opened === null);
  check("and the refusal names the halt, so it never reads like a slow night", (r.refusal?.reason ?? "").includes("DRAWDOWN HALT"));
  check("the refusal is recorded, not silent", (r.refusal?.reason ?? "").length > 0);
  check("the halt reason is a real limit, not a generic message", ["daily-loss-limit", "total-loss-limit", "peak-drawdown-limit"].includes(st.halted!.reason));
}

section("the halt survives a restart");
{
  const b1 = new PaperBook({ ...BASE, drawdown: { ...GUARD, state: emptyState(new Date(T0)) } }, constantProductProceeds);
  loseOne(b1, "A", 0);
  const persisted = b1.drawdownState!;
  check("there is something to persist", persisted.halted !== null);

  // Rebuild the book from the saved state, exactly as a restart does.
  const b2 = new PaperBook({ ...BASE, drawdown: { ...GUARD, state: persisted } }, constantProductProceeds);
  const r = b2.open({ mint: "C", at: at(1000), liquiditySol: 10, liveVerdict: "PASS" });
  check("the rebuilt book is still halted", r.opened === null);
  check("a restart does NOT clear the kill switch", (r.refusal?.reason ?? "").includes("DRAWDOWN HALT"));
}

section("the halt is checked BEFORE every other refusal reason");
{
  // A full book AND a halted book. The reason returned must be the halt: a
  // halt reported as "position cap reached" would be read as a busy night.
  const halted: DrawdownState = { ...emptyState(new Date(T0)), halted: { at: at(0), reason: "total-loss-limit", detail: "test halt" } };
  const b = new PaperBook({ ...BASE, maxOpenPositions: 0, drawdown: { ...GUARD, state: halted } }, constantProductProceeds);
  const r = b.open({ mint: "D", at: at(0), liquiditySol: 10, liveVerdict: "PASS" });
  check("the halt wins over the position cap", (r.refusal?.reason ?? "").includes("DRAWDOWN HALT"), r.refusal?.reason);
}

section("the state file refuses rather than starting from zero");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dds-"));
  const f = path.join(dir, "drawdown-state.json");

  const missing = loadDrawdownState(f, new Date(T0));
  check("a MISSING file is a genuine fresh start", missing.ok && missing.fresh && missing.state.halted === null);

  fs.writeFileSync(f, "{ this is not json");
  const broken = loadDrawdownState(f);
  check("a TRUNCATED file refuses", broken.ok === false);
  check("and says why, naming the risk", !broken.ok && broken.reason.includes("must not clear a halt"));

  fs.writeFileSync(f, JSON.stringify({ version: 99, day: "2026-09-13", totalPnl: 0 }));
  const wrongVersion = loadDrawdownState(f);
  check("an unknown state version refuses rather than guessing", wrongVersion.ok === false);

  const good: DrawdownState = { ...emptyState(new Date(T0)), totalPnl: -3, halted: { at: at(0), reason: "total-loss-limit", detail: "d" } };
  saveDrawdownState(good, f);
  const back = loadDrawdownState(f);
  check("a saved halt round-trips", back.ok && back.state.halted !== null && back.state.totalPnl === -3);
  check("and is not marked fresh", back.ok && back.fresh === false);
  fs.rmSync(dir, { recursive: true, force: true });
}

section("the shipped config leaves it OFF");
{
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "default.json"), "utf-8"));
  const d = cfg.paperExecution?.drawdown;
  check("the config carries a drawdown block", !!d);
  check("it is DISABLED in the shipped config - decided (a) by Tristan 2026-09-14 while the book collects", d?.enabled === false);

  // THE STANDING RULE, ENFORCED (APPROVALS 50a, decided 2026-09-14).
  //
  //   The drawdown guard goes on BEFORE any flag that permits real money.
  //   Before, never after.
  //
  // This is the assertion that makes it a rule rather than a note. It is
  // deliberately expressed as an implication - guard off IMPLIES money off -
  // so it stays green today (both off) and goes red the moment someone flips a
  // money flag without switching the guard on first. That is the exact
  // sequence the rule exists to prevent, and it is the one nobody will
  // remember to check on the day it happens.
  const moneyOn = cfg.trading?.enabled === true || cfg.perps?.enabled === true || cfg.fundingArb?.enabled === true;
  const paperOff = cfg.trading?.paperTrading === false;
  const guardOn = d?.enabled === true;
  check(
    "STANDING RULE: no real-money flag may be on while the drawdown guard is off",
    !(moneyOn && !guardOn),
    `trading.enabled=${cfg.trading?.enabled} perps=${cfg.perps?.enabled} fundingArb=${cfg.fundingArb?.enabled} guard=${d?.enabled}`
  );
  check(
    "STANDING RULE: paperTrading may not be turned off while the drawdown guard is off",
    !(paperOff && !guardOn),
    `paperTrading=${cfg.trading?.paperTrading} guard=${d?.enabled}`
  );
  // And the rule must be written where it will be READ at that moment, not
  // only in APPROVALS where nobody is looking when they edit a config value.
  check("the rule is written beside the flag it governs, in config/default.json",
    /DRAWDOWN GUARD GOES ON FIRST/i.test(cfg.trading?._comment ?? ""));
  check("and in the repo's working agreement",
    /DRAWDOWN GUARD GOES ON BEFORE THE MONEY DOES/i.test(fs.readFileSync(path.join(__dirname, "..", "CLAUDE.md"), "utf-8")));
  check("its limits are positive numbers, because they are LOSS limits", d.maxDailyLoss > 0 && d.maxTotalLoss > 0 && d.maxPeakDrawdown > 0);
  check("and the unit is stated, so a SOL limit is never read as dollars", typeof d.unit === "string" && d.unit.length > 0);
}

section("the guard is imported by production code, not only by tests");
{
  // The assertion that would have caught the original finding. If the wiring is
  // ever removed, this file's other tests would still pass on the pure logic -
  // this one would not.
  const files = ["src/trading/paperExecution.ts", "src/index.ts", "src/config.ts"];
  const importers = files.filter((f) => /risk\/drawdown(Guard|Store)/.test(fs.readFileSync(path.join(__dirname, "..", f), "utf-8")));
  check("drawdownGuard/Store is imported by production source", importers.length >= 2, `importers: ${importers.join(", ") || "NONE - the guard is dead code again"}`);
  check("PaperBook itself is one of them", importers.includes("src/trading/paperExecution.ts"));
}

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
