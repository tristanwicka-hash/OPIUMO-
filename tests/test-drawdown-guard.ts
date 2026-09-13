/**
 * OPIUMO test: the drawdown kill switch (offline, pure).
 *
 * The load-bearing checks are the ones that make it a kill switch rather than
 * a warning: a halt SURVIVES a restart, it has its own reason string, an
 * override lasts one named day and no longer, and clearing it requires a human
 * to sign for it. Plus a replay of a real losing stretch.
 */
import fs from "fs";
import path from "path";
import { DrawdownConfig, DrawdownState, emptyState, applyRealised, evaluateDrawdown, markHalted, clearHalt, grantOverride, rollTo, validateDrawdownConfig, utcDay } from "../src/risk/drawdownGuard";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` - ${d}` : ""}`); } };
const CFG: DrawdownConfig = { enabled: true, maxDailyLoss: 1, maxTotalLoss: 2, maxPeakDrawdown: 1.5, unit: "SOL" };
const D1 = new Date("2026-09-13T10:00:00Z"), D2 = new Date("2026-09-14T10:00:00Z");

console.log("\nConfig");
check("limits must be positive numbers and the unit must be stated", validateDrawdownConfig(CFG).length === 0 && validateDrawdownConfig({ ...CFG, maxDailyLoss: -1 }).length === 1 && validateDrawdownConfig({ ...CFG, unit: "" }).length === 1);
check("a zero limit is refused - it would halt before the first trade", validateDrawdownConfig({ ...CFG, maxTotalLoss: 0 }).length === 1);

console.log("\nThe limits");
let s = emptyState(D1);
check("a fresh ledger is not halted", evaluateDrawdown(s, CFG, D1).halted === false);
s = applyRealised(s, -0.6, D1);
check("a loss inside the limit does not halt, and says where it stands", !evaluateDrawdown(s, CFG, D1).halted && /within limits/.test(evaluateDrawdown(s, CFG, D1).detail));
s = applyRealised(s, -0.5, D1);
let dec = evaluateDrawdown(s, CFG, D1);
check("crossing the DAILY limit halts, with its own reason and the numbers in it", dec.halted && dec.reason === "daily-loss-limit" && /lost 1\.1000 SOL today, limit is 1 SOL/.test(dec.detail) && /DRAWDOWN HALT/.test(dec.detail));
check("the unit is in the message, so a SOL limit is never read as dollars", /SOL/.test(dec.detail));

let t = emptyState(D1);
t = applyRealised(t, 1, D1); t = applyRealised(t, -1.6, D1);
const peak = evaluateDrawdown(t, { ...CFG, maxDailyLoss: 99, maxTotalLoss: 99 }, D1);
check("peak drawdown fires on a fall from a HIGH-WATER MARK even while total P&L is only slightly negative", peak.halted && peak.reason === "peak-drawdown-limit" && Math.abs(peak.drawdownFromPeak - 1.6) < 1e-9);

console.log("\nIt survives a restart - the point of the whole thing");
let halted = markHalted(s, dec, D1);
check("the halt is written onto the state", halted.halted !== null && halted.halted!.reason === "daily-loss-limit");
const reloaded: DrawdownState = JSON.parse(JSON.stringify(halted));
const after = evaluateDrawdown(reloaded, CFG, D1);
check("a state round-tripped through JSON (i.e. a restart) comes back HALTED", after.halted && after.reason === "already-halted" && /survived a restart/.test(after.detail));
const tomorrow = evaluateDrawdown(reloaded, CFG, D2);
check("the halt does NOT expire at midnight - the money did not come back", tomorrow.halted && tomorrow.reason === "already-halted");
check("the daily figure DOES roll over, so a new day starts clean once the halt is cleared", rollTo(reloaded, D2).dayPnl === 0 && rollTo(reloaded, D2).totalPnl === reloaded.totalPnl);
check("marking halted twice never overwrites the original halt", markHalted(halted, { ...dec, reason: "total-loss-limit", detail: "different" }, D2).halted!.reason === "daily-loss-limit");

console.log("\nManual override: one named day, written down");
let o = grantOverride(reloaded, utcDay(D1), "Tristan", "watching it by hand", D1);
const overridden = evaluateDrawdown(o, CFG, D1);
check("an override lifts an existing halt for its day, and says who and why", !overridden.halted && overridden.reason === "manual-override" && /by Tristan/.test(overridden.detail) && /watching it by hand/.test(overridden.detail));
check("...and warns the halt comes back", /returns tomorrow/.test(overridden.detail));
check("the override does NOT apply the next day - a forgotten override cannot disable the switch forever", evaluateDrawdown(o, CFG, D2).halted === true);
check("rolling into a new day drops a stale override", rollTo(o, D2).override === null);
let threw = 0;
for (const f of [() => grantOverride(reloaded, "13-09-2026", "T", "n", D1), () => grantOverride(reloaded, utcDay(D1), "", "n", D1), () => grantOverride(reloaded, utcDay(D1), "T", "", D1)]) { try { f(); } catch { threw++; } }
check("an override with a bad date, no author or no reason is refused", threw === 3);
threw = 0; try { clearHalt(reloaded, "", ""); } catch { threw = 1; }
check("clearing a halt anonymously is refused - it is a decision and must be attributable", threw === 1);
check("a cleared halt is gone but the P&L that caused it is NOT reset", clearHalt(reloaded, "Tristan", "reviewed").halted === null && clearHalt(reloaded, "Tristan", "reviewed").totalPnl === reloaded.totalPnl);

console.log("\nDisabled");
check("disabled means never halted, whatever the losses", evaluateDrawdown(s, { ...CFG, enabled: false }, D1).halted === false);

console.log("\nReplay: a real losing stretch from the paper book");
{
  // The actual closed paper positions, oldest first: the losing stretch that
  // exists on disk rather than a stretch invented to make the switch fire.
  const file = path.join("logs", "paper-positions.jsonl");
  const pnls: number[] = [];
  if (fs.existsSync(file)) {
    for (const l of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l);
        if (r.event === "paper-close" && r.outcome === "closed" && typeof r.exitProceedsSol === "number" && typeof r.entryProceedsSol === "number") pnls.push(r.exitProceedsSol - r.entryProceedsSol);
      } catch { /* partial */ }
    }
  }
  if (pnls.length < 20) check("SKIPPED: fewer than 20 closed paper positions on disk to replay", true);
  else {
    const cfg: DrawdownConfig = { enabled: true, maxDailyLoss: 0.5, maxTotalLoss: 1, maxPeakDrawdown: 0.75, unit: "SOL" };
    let st = emptyState(D1); let haltedAfter = -1; let haltDetail = "";
    for (let i = 0; i < pnls.length; i++) {
      st = applyRealised(st, pnls[i], D1);
      const d = evaluateDrawdown(st, cfg, D1);
      if (d.halted) { haltedAfter = i + 1; haltDetail = d.detail; st = markHalted(st, d, D1); break; }
    }
    check(`the switch fires part-way through ${pnls.length} real closed positions, not at the end`, haltedAfter > 0 && haltedAfter < pnls.length, `halted after ${haltedAfter}`);
    console.log(`       halted after ${haltedAfter} of ${pnls.length} real positions: ${haltDetail}`);
    // Everything after the halt must be refused, which is the whole value of it.
    let refusedAfter = 0;
    for (let i = haltedAfter; i < pnls.length; i++) if (evaluateDrawdown(st, cfg, D1).halted) refusedAfter++;
    check("every position after the halt would have been refused", refusedAfter === pnls.length - haltedAfter);
    const avoided = pnls.slice(haltedAfter).reduce((a, x) => a + x, 0);
    console.log(`       it would have sat out the remaining ${pnls.length - haltedAfter} position(s), whose net was ${avoided.toFixed(4)} SOL`);
    check("the replay is over REAL recorded positions, not a synthetic stretch", pnls.length > 100);
  }
}

console.log("\nStructural");
const src = fs.readFileSync(path.join(__dirname, "..", "src", "risk", "drawdownGuard.ts"), "utf-8");
check("pure: no clock, no filesystem, no config load", !/Date\.now\(\)|readFileSync|writeFileSync|loadConfig/.test(src));
check("the halt reason strings are distinct from any other quiet reason", /daily-loss-limit/.test(src) && /peak-drawdown-limit/.test(src) && /already-halted/.test(src));

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
