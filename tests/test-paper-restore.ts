/**
 * The paper book survives a restart. Offline, temp directory only.
 *
 * Before this, PaperBook lived only in memory: logs/paper-positions.jsonl held
 * 5,191 paper-open rows against 827 paper-close rows, because every restart
 * dropped the open book and nothing could ever close those positions.
 *
 * The restart is simulated the way it happens in production: book 1 writes its
 * rows through JsonlLog with the same row builder the pipeline uses, the book
 * is thrown away, and book 2 is rebuilt from the file alone.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { PaperBook, PaperConfig, PaperPosition, openRowsFromLog, paperOpenRow } from "../src/trading/paperExecution";
import { readPaperLog } from "../src/trading/paperBookStore";
import { TrailingStopConfig } from "../src/trading/trailingStop";
import { venuePricing } from "../src/analysis/venueModels";
import { JsonlLog } from "../src/util/logger";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " -- " + detail : ""}`); console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
function section(t: string): void { console.log(`\n=== ${t} ===\n`); }

const T0 = Date.UTC(2026, 8, 14, 12, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const TRAIL: TrailingStopConfig = { hardStopPercent: -50, activationPercent: 30, trailPercent: 20, persistenceObservations: 2, minHoldMs: 60_000 };
const CFG: PaperConfig = {
  poolFraction: 0.05, maxOpenPositions: 5, includeRejected: true, trailing: TRAIL,
  raisedTakeProfit: { enabled: true, venues: ["pumpfun"], raisedDropPercent: 30, takeProfitPercent: 50, persistenceObservations: 2, minHoldMs: 60_000 },
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opiumo-paper-restore-"));
const logFile = path.join(dir, "paper-positions.jsonl");

section("book 1 opens positions, closes one, and logs exactly as production does");

const book1 = new PaperBook(CFG, venuePricing);
const log1 = new JsonlLog(logFile, 20);
const opens: [string, number, "PASS" | "REJECTED", string | undefined][] = [
  ["PF", 2, "REJECTED", "pumpfun"],
  ["RAY", 8, "PASS", "raydium"],
  ["UNK", 4, "REJECTED", undefined],
  ["GONE", 3, "REJECTED", "raydium"],
];
opens.forEach(([mint, liq, verdict, source], i) => {
  const { opened } = book1.open({ mint, at: at(i), liquiditySol: liq, liveVerdict: verdict, source });
  log1.append(paperOpenRow(opened!, book1.openCount));
});
// GONE drains to zero after the minimum hold and closes; the close row is written the way index.ts writes it.
let gone: PaperPosition | null = null;
for (const s of [70, 71, 72]) gone = book1.observe("GONE", { ts: at(s), liquiditySol: 0.001 }) ?? gone; // null once closed
check("GONE closed in book 1", gone !== null && gone.outcome !== "open", `outcome=${gone?.outcome}`);
log1.append({ event: "paper-close", ...gone!, state: undefined });
// A row as written before venue/pricingModel/exitRule existed - 3,720 of the rows on disk look like this.
log1.append({ event: "paper-open", mint: "LEGACY", openedAt: at(5), liveVerdict: "REJECTED", entryLiquiditySol: 1, entryProceedsSol: 0.047, poolFraction: 0.05, openNow: 4 });
check("book 1 has 3 open before the restart", book1.openCount === 3, `open=${book1.openCount}`);

section("restart: a new book, rebuilt from the file alone");

const read = readPaperLog(logFile);
const book2 = new PaperBook(CFG, venuePricing);
const r = book2.restore(openRowsFromLog(read.rows), at(100));
check("opens minus closes: 4 positions come back (3 tracked + the legacy row)", r.restored === 4 && book2.openCount === 4, JSON.stringify(r));
check("the closed position does NOT come back", !book2.openPositions().some((p) => p.mint === "GONE"));
check("nothing skipped", r.skipped.length === 0, JSON.stringify(r.skipped));

const byMint = new Map(book2.openPositions().map((p) => [p.mint, p]));
for (const before of book1.openPositions()) {
  const after = byMint.get(before.mint);
  const same = (k: keyof PaperPosition) => after !== undefined && after[k] === before[k];
  check(`${before.mint}: openedAt, verdict, venue, exit rule, entry and pool fraction all come back exactly`,
    same("openedAt") && same("liveVerdict") && same("venue") && same("exitRule") && same("entryProceedsSol") && same("entryLiquiditySol") && same("poolFraction") && same("pricingModel"),
    JSON.stringify({ before: { ...before, state: undefined }, after: after && { ...after, state: undefined } }));
  check(`${before.mint}: marked as restored, with what could not be carried over`, !!after?.restored && /restart from entry/.test(after.restored.note));
}
check("the Pump.fun position keeps the raised-stop rule it opened under", byMint.get("PF")?.exitRule === "raised-stop-or-take-profit" && !!byMint.get("PF")?.raisedState);

const legacy = byMint.get("LEGACY");
check("legacy row: restored with venue unknown and the trailing rule", legacy?.venue === null && legacy?.exitRule === "trailing");
check("legacy row: the re-derived exit rule is counted and noted, not silent", r.exitRuleInferred === 1 && /re-derived/.test(legacy?.restored?.note ?? ""));
check("legacy row: entry is the RECORDED value, not a re-price", legacy?.entryProceedsSol === 0.047);

section("a restored position behaves like the original");

const drain = [[65, 1.0], [66, 0.1], [67, 0.01]] as const;
let e1: PaperPosition | null = null, e2: PaperPosition | null = null;
for (const [s, liq] of drain) { e1 = book1.observe("RAY", { ts: at(s), liquiditySol: liq }) ?? e1; e2 = book2.observe("RAY", { ts: at(s), liquiditySol: liq }) ?? e2; }
check("the same drain closes RAY in both books", e1?.outcome === "closed" && e2?.outcome === "closed", `${e1?.outcome} / ${e2?.outcome}`);
check("with the same exit proceeds and reason", e1?.exitProceedsSol != null && e1?.exitProceedsSol === e2?.exitProceedsSol && e1?.exitReason === e2?.exitReason, `${e1?.exitReason} / ${e2?.exitReason}`);

section("rotation: an open in a rotated file, its close in the current file");

const rotDir = fs.mkdtempSync(path.join(os.tmpdir(), "opiumo-paper-rot-"));
const rotCurrent = path.join(rotDir, "paper-positions.jsonl");
const rows = fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
const closeIdx = rows.findIndex((l) => JSON.parse(l).event === "paper-close");
fs.writeFileSync(path.join(rotDir, "paper-positions.2026-09-14T11-00-00-000Z.jsonl"), rows.slice(0, closeIdx).join("\n") + "\n");
fs.writeFileSync(rotCurrent, rows.slice(closeIdx).join("\n") + "\n");
fs.writeFileSync(path.join(rotDir, "other-log.jsonl"), rows.join("\n") + "\n");
const rotRead = readPaperLog(rotCurrent);
check("both files are read, rotated first, and an unrelated log is not", rotRead.files.length === 2 && /2026-09-14T11/.test(rotRead.files[0]) && rotRead.files[1] === rotCurrent, JSON.stringify(rotRead.files));
const rotBook = new PaperBook(CFG, venuePricing);
const rr = rotBook.restore(openRowsFromLog(rotRead.rows), at(100));
check("the same 4 come back across the rotation, GONE still closed", rr.restored === 4 && !rotBook.openPositions().some((p) => p.mint === "GONE"), JSON.stringify(rr));

section("fail closed: bad rows are skipped with a reason, never invented");

fs.appendFileSync(logFile, '{"ts":"2026-09-14T12:10:00Z","event":"paper-open","mint":"TRUNC\n');
fs.appendFileSync(logFile, JSON.stringify({ event: "paper-open", mint: "ZERO", openedAt: at(9), liveVerdict: "REJECTED", entryLiquiditySol: 1, entryProceedsSol: 0, poolFraction: 0.05 }) + "\n");
const bad = readPaperLog(logFile);
check("a truncated line is counted, not thrown on", bad.unparseable === 1, `unparseable=${bad.unparseable}`);
const book3 = new PaperBook(CFG, venuePricing);
const r3 = book3.restore(openRowsFromLog(bad.rows), at(100));
check("a zero entry is skipped with its reason", r3.skipped.some((s) => s.mint === "ZERO" && /not positive/.test(s.reason)) && !book3.openPositions().some((p) => p.mint === "ZERO"));
const again = book3.restore(openRowsFromLog(bad.rows), at(101));
check("restoring twice does not duplicate", again.restored === 0 && book3.openCount === 4 && again.skipped.filter((s) => /already open/.test(s.reason)).length === 4);
check("a missing log restores nothing and does not throw", readPaperLog(path.join(dir, "nope.jsonl")).rows.length === 0);

section("the cap is not applied to positions that already exist, and still refuses new ones");

const tight = new PaperBook({ ...CFG, maxOpenPositions: 2 }, venuePricing);
const rt = tight.restore(openRowsFromLog(read.rows), at(100));
check("all 4 restored even though the cap is 2", rt.restored === 4 && tight.openCount === 4);
const refused = tight.open({ mint: "NEW", at: at(200), liquiditySol: 5, liveVerdict: "PASS", source: "raydium" });
check("a new open is refused by the cap", refused.opened === null && /cap reached/.test(refused.refusal?.reason ?? ""));

section("WIRED, not just correct: the bot calls restore at startup, before anything observes");

const index = fs.readFileSync(path.join("src", "index.ts"), "utf-8");
const restoreAt = index.indexOf("paperBook.restore(");
check("src/index.ts calls paperBook.restore on the book it runs", restoreAt > 0);
check("fed from readPaperLog(paperCfg.logFile)", /readPaperLog\(paperCfg\.logFile\)/.test(index));
check("before the watchlist starts feeding observations", restoreAt > 0 && restoreAt < index.indexOf("watchlist.start()"));
check("the pipeline writes paper-open rows with the shared builder", /paperOpenRow\(opened/.test(fs.readFileSync(path.join("src", "graph", "pipelineGraph.ts"), "utf-8")));

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(rotDir, { recursive: true, force: true });

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:\n  " + failures.join("\n  ")); process.exit(1); }
