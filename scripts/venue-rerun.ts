/**
 * npm run rerun:venue [-- --out reports/venue-rerun-YYYY-MM-DD.md]
 *
 * NIGHT-PROMPT-V5 Project 2. Re-runs every paper result under venue-correct
 * pricing (bonding curve for Pump.fun, constant product for Raydium), on the
 * same closed positions and the same watchlist readings the originals used:
 * sizing (item 27), the trailing stop v1 sets and v2 horizons, late entry
 * (item 34), the -50% hard stop, and adds exit rules defined on SOL raised.
 * Winners-vs-losers (item 38) is re-run by `npm run report:what-separates -- --venue`.
 *
 * Read-only over logs/. Changes nothing live.
 */
import fs from "fs";
import path from "path";
import {
  loadPaperData, replayOne, replayPyramid, summarise, currentStopRule, doNothingRule, fixedTakeProfitRule, raisedStopRule, raisedTrailRule, eitherRule,
  flatStake, poolFractionStake, price, Row, Summary, ExitRule, TaggedClose, MIN_FOR_RATE,
} from "../src/analysis/venueRerun";
import { Reading } from "../src/analysis/lateEntry";
import { loadTokenSeries, cohort, CHECKPOINT_1H, CHECKPOINT_6H, CHECKPOINT_24H } from "../src/analysis/trailingCohorts";
import { venueOf } from "../src/analysis/venueModels";
import { TrailingStopConfig } from "../src/trading/trailingStop";

const arg = (f: string) => { const i = process.argv.indexOf(f); return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined; };
const L: string[] = [];
const say = (s = "") => L.push(s);
const sol = (x: number | null, d = 2) => (x === null ? "n/a" : x.toFixed(d));
const pct = (x: number | null) => (x === null ? "n/a" : `${x.toFixed(1)}%`);

function table(title: string, rows: Array<[string, Summary]>): void {
  say(`  ${title}`);
  say(`  ${"rule / strategy".padEnd(52)} ${"entered".padStart(7)} ${"staked".padStart(7)} ${"returned".padStart(9)} ${"net".padStart(8)} ${"net%".padStart(7)} ${"wins".padStart(5)} ${"win%".padStart(6)} ${"exited".padStart(7)} ${"held".padStart(5)} ${"median".padStart(7)} ${"worst".padStart(7)} ${"best".padStart(7)}  drains n/net/exited`);
  for (const [label, s] of rows) {
    say(`  ${label.padEnd(52)} ${String(s.entered).padStart(7)} ${sol(s.staked).padStart(7)} ${sol(s.realised).padStart(9)} ${sol(s.net).padStart(8)} ${pct(s.netPct).padStart(7)} ${String(s.wins).padStart(5)} ${(s.winRate === null ? "n/a" : s.winRate.toFixed(1)).padStart(6)} ${String(s.exited).padStart(7)} ${String(s.heldToEnd).padStart(5)} ${sol(s.medianNet, 3).padStart(7)} ${sol(s.largestLoss, 3).padStart(7)} ${sol(s.largestWin, 3).padStart(7)}  ${s.drains}/${sol(s.drainNet)}/${s.drainsExited}`);
  }
  say();
}

function main(): void {
  const cfg = JSON.parse(fs.readFileSync("config/default.json", "utf-8"));
  const trailing: TrailingStopConfig = cfg.paperExecution.trailing;
  const data = loadPaperData("logs");
  const R = (m: string): Reading[] => data.readingsByMint.get(m) ?? [];
  const closes = data.closes;
  const pf = closes.filter((t) => t.venue === "pumpfun").length, ray = closes.filter((t) => t.venue === "raydium").length;
  const stop = currentStopRule(trailing);

  say("Every paper result, re-run under venue pricing (APPROVALS 37) - and a stop the curve can actually trigger");
  say("=".repeat(118));
  say(`  ${closes.length} closed paper positions with a venue (pumpfun ${pf}, raydium ${ray}${data.unknownVenue ? `; ${data.unknownVenue} with no venue EXCLUDED` : ""}), opened ${data.firstOpened} -> closed ${data.lastClosed}.`);
  say(`  Readings: the watchlist's "checked" liquidity observations after each open. Pricing: Pump.fun = bonding curve (virtual reserves = real + 30 SOL, 1% fee each way); Raydium = constant product on real SOL.`);
  say(`  "held" = the rule never fired inside the recorded readings; the position is VALUED at its last reading, which assumes it could still be sold into the curve then. Win rates are withheld below ${MIN_FOR_RATE} entered.`);
  say();
  say("  SAMPLE BIAS - read before any number below:");
  const capTotal = Object.values(data.capRefusals).reduce((a, b) => a + b, 0);
  say(`    The book opened ${data.opens} positions and REFUSED ${capTotal} open attempts because its cap was full (${Object.entries(data.capRefusals).map(([k, v]) => `${v} while the cap was ${k}`).join(", ")}).`);
  say(`    Every closed position analysed here was opened while the cap was 50, i.e. it arrived when a slot happened to be free. Tokens launched in a busy minute were far more likely to be refused than tokens launched in a quiet one, so this is not a random sample of launches - it over-represents quiet minutes. Nothing below corrects for that; it cannot be corrected from these logs.`);
  say(`    Every position is a token the LIVE filters rejected (includeRejected: true, 0 passes). One day of one market.`);
  say();

  // ---- A. reproduce item 37 --------------------------------------------------
  const flat02 = flatStake(0.2);
  const bookRows = closes.map((t) => replayOne(t, R(t.c.mint), "book", stop, flat02));
  const venueRows = closes.map((t) => replayOne(t, R(t.c.mint), "venue", stop, flat02));
  table("A. SAME POSITIONS, SAME STOP, FLAT 0.2 SOL - book model vs venue model (item 37 reproduced from this code path)", [["book: constant product on real SOL", summarise(bookRows)], ["venue: bonding curve / constant product", summarise(venueRows)]]);

  // ---- B. sizing (item 27) under venue -------------------------------------------
  const sizing: Array<[string, Summary]> = [
    ["5% of pool at entry, current stop (the book's own sizing)", summarise(closes.map((t) => replayOne(t, R(t.c.mint), "venue", stop, poolFractionStake(0.05))))],
    ["5% of pool, only pools >= 0.4 SOL (same pools as flat)", summarise(closes.map((t) => replayOne(t, R(t.c.mint), "venue", stop, (L0) => (L0 >= 0.4 ? 0.05 * L0 : null))))],
    ["flat 0.2 SOL (skip if > 50% of pool), current stop", summarise(venueRows)],
    ["pyramid 0.2 + 0.2 per 2x of the first tranche, max 3 units", summarise(closes.map((t) => replayPyramid(t, R(t.c.mint), "venue", stop, 0.2, 3)))],
  ];
  table("B. SIZING under venue pricing (item 27 re-run; exits = current stop on the position's value)", sizing);
  const sizingBook: Array<[string, Summary]> = [
    ["5% of pool at entry (book model, for the record)", summarise(closes.map((t) => replayOne(t, R(t.c.mint), "book", stop, poolFractionStake(0.05))))],
    ["flat 0.2 (book model, for the record)", summarise(bookRows)],
  ];
  table("   ...the same two under the BOOK model, so the move is visible", sizingBook);

  // ---- C. exit rules under venue --------------------------------------------------
  const rules: ExitRule[] = [
    stop, doNothingRule, fixedTakeProfitRule(100), fixedTakeProfitRule(50), fixedTakeProfitRule(30),
    raisedStopRule(30), raisedStopRule(50), raisedStopRule(70),
    raisedTrailRule(30, 20, 30), raisedTrailRule(30, 20, 50), raisedTrailRule(50, 25, 50),
    eitherRule(raisedStopRule(50), fixedTakeProfitRule(100)), eitherRule(raisedStopRule(30), fixedTakeProfitRule(50)),
  ];
  const ruleRows = new Map<string, Row[]>();
  for (const r of rules) ruleRows.set(r.label, closes.map((t) => replayOne(t, R(t.c.mint), "venue", r, flat02)));
  table("C. EXIT RULES under venue pricing, flat 0.2 SOL at t=0 (value stops vs stops on SOL RAISED)", rules.map((r) => [r.label, summarise(ruleRows.get(r.label)!)] as [string, Summary]));
  say("  Rule definitions:");
  for (const r of rules) say(`    ${r.label.padEnd(44)} ${r.describe}`);
  say();
  const pfRows = (label: string) => ruleRows.get(label)!.filter((r) => r.venue === "pumpfun");
  table("   ...Pump.fun positions only", rules.map((r) => [r.label, summarise(pfRows(r.label))] as [string, Summary]));
  if (ray > 0) table("   ...Raydium positions only", rules.map((r) => [r.label, summarise(ruleRows.get(r.label)!.filter((x) => x.venue === "raydium"))] as [string, Summary]));

  // ---- D. the -50% hard stop re-read ------------------------------------------------
  const L0s = closes.map((t) => t.c.entryLiquiditySol).sort((a, b) => a - b);
  const below = closes.filter((t) => t.venue === "pumpfun" && t.c.entryLiquiditySol < 12.4).length;
  const cur = ruleRows.get(stop.label)!;
  say("D. THE -50% HARD STOP, RE-READ UNDER THE CURVE");
  say(`  Entry liquidity (SOL raised) across the ${closes.length} positions: min ${sol(L0s[0], 3)}, median ${sol(L0s[Math.floor(L0s.length / 2)], 3)}, max ${sol(L0s[L0s.length - 1], 3)}.`);
  say(`  A Pump.fun position bought below 12.4 SOL raised has a curve floor above 50% of the stake, so -50% on VALUE cannot fire on a drain: ${below} of ${pf} Pump.fun entries (${pct((below / Math.max(1, pf)) * 100)}) are below it.`);
  say(`  Under venue pricing the current stop exited ${cur.filter((r) => r.result === "exited").length} of ${cur.filter((r) => r.entered).length} entered positions and left ${cur.filter((r) => r.result === "held-to-end").length} held; of the ${cur.filter((r) => r.entered && r.drain).length} instant drains it exited ${cur.filter((r) => r.entered && r.drain && r.result === "exited").length}.`);
  say(`  The raised-stop rules exit on the pool's SOL, which has no floor: raised-stop -50% exited ${ruleRows.get("raised-stop -50%")!.filter((r) => r.entered && r.drain && r.result === "exited").length} of the same drains.`);
  say();

  // ---- E. late entry (item 34) under venue ----------------------------------------------
  const late: Array<[string, Summary]> = [0, 60, 90, 120].map((d) => [`delay ${d}s, flat 0.2, current stop`, summarise(closes.map((t) => replayOne(t, R(t.c.mint), "venue", stop, flat02, d)))] as [string, Summary]);
  table("E. LATE ENTRY under venue pricing (item 34 re-run)", late);
  const lateRaised: Array<[string, Summary]> = [0, 60, 90, 120].map((d) => [`delay ${d}s, flat 0.2, raised-stop -50% OR take-profit +100%`, summarise(closes.map((t) => replayOne(t, R(t.c.mint), "venue", eitherRule(raisedStopRule(50), fixedTakeProfitRule(100)), flat02, d)))] as [string, Summary]);
  table("   ...with the raised stop instead", lateRaised);

  // ---- F. multi-hour horizons (trailing v2) under venue ---------------------------------
  say("F. MULTI-HOUR HORIZONS from the outcome tracker's 1h / 6h / 24h checkpoints (trailing v2 re-run), 5% of pool at the detection-time baseline");
  say("   Each token has ONE reading at the horizon, so every exit rule realises the same value there - only 'do nothing' (value at the checkpoint) is meaningful. Exit rules cannot be tested on one reading; the watchlist series above are where they are tested.");
  const loaded = loadTokenSeries(["logs/outcomes.jsonl"]);
  const venueByMint = new Map<string, "pumpfun" | "raydium">();
  for (const f of fs.readdirSync("logs").filter((x) => /^decisions.*\.jsonl$/.test(x))) for (const l of fs.readFileSync(path.join("logs", f), "utf-8").split("\n")) { if (!l.trim()) continue; try { const d = JSON.parse(l); const v = venueOf(d.source); if (d.mint && v && !venueByMint.has(d.mint)) venueByMint.set(d.mint, v); } catch { /* skip */ } }
  const hRows: Array<[string, Summary]> = [];
  for (const [label, h] of [["1h", CHECKPOINT_1H], ["6h", CHECKPOINT_6H], ["24h", CHECKPOINT_24H]] as const) {
    const co = cohort(loaded.series, h).filter((s) => venueByMint.has(s.mint) && s.observations.length >= 2 && s.observations[0].liquiditySol > 0);
    const asTagged: TaggedClose[] = co.map((s) => ({ c: { mint: s.mint, openedAt: s.observations[0].ts, closedAt: null, entryLiquiditySol: s.observations[0].liquiditySol, entryProceedsSol: 0, exitProceedsSol: null, poolFraction: 0.05, outcome: "closed" }, venue: venueByMint.get(s.mint)! }));
    const readings = new Map<string, Reading[]>(co.map((s) => [s.mint, s.observations.filter((o) => o.ts !== s.observations[0].ts || true).slice(1).filter((o) => Date.parse(o.ts) - Date.parse(s.observations[0].ts) >= h * 1000 - 1).map((o) => ({ tMs: Date.parse(o.ts), sol: o.liquiditySol }))]));
    for (const model of ["book", "venue"] as const) hRows.push([`${label.padEnd(4)} ${model.padEnd(5)} value at the ${label} checkpoint (${co.length} tokens)`, summarise(asTagged.map((t) => replayOne(t, readings.get(t.c.mint)!, model, doNothingRule, poolFractionStake(0.05))))]);
  }
  table("   value at each horizon, book model vs venue model (a token appears in every horizon it has a checkpoint for)", hRows);

  // ---- G. per-token ------------------------------------------------------------------------
  say("G. PER-TOKEN (Pump.fun, flat 0.2, venue pricing): net SOL under the current stop, do nothing, raised-stop -50%, raised-stop -50% OR take-profit +100%");
  say(`  ${"mint".padEnd(46)} ${"L0".padStart(7)} ${"floor".padStart(6)} ${"drain".padStart(5)} ${"current".padStart(8)} ${"nothing".padStart(8)} ${"raised50".padStart(8)} ${"r50|tp100".padStart(9)}  current-stop reason`);
  const byMint = (label: string) => new Map(ruleRows.get(label)!.map((r) => [r.mint, r]));
  const mCur = byMint(stop.label), mNo = byMint(doNothingRule.label), mR50 = byMint("raised-stop -50%"), mEither = byMint("raised-stop -50% OR take-profit +100%");
  const perToken = closes.filter((t) => mCur.get(t.c.mint)?.entered).sort((a, b) => (mEither.get(b.c.mint)!.net ?? 0) - (mEither.get(a.c.mint)!.net ?? 0));
  for (const t of perToken) {
    const c = mCur.get(t.c.mint)!;
    say(`  ${t.c.mint.padEnd(46)} ${sol(c.L0, 3).padStart(7)} ${sol(c.floor, 2).padStart(6)} ${(c.drain ? "yes" : "").padStart(5)} ${sol(c.net, 3).padStart(8)} ${sol(mNo.get(t.c.mint)!.net, 3).padStart(8)} ${sol(mR50.get(t.c.mint)!.net, 3).padStart(8)} ${sol(mEither.get(t.c.mint)!.net, 3).padStart(9)}  ${c.result === "exited" ? c.reason.slice(0, 60) : "held: " + c.reason.slice(0, 54)}`);
  }
  say();
  say("  Nothing here changes live config. The stop config is a threshold decision (APPROVALS 43).");
  console.log(L.join("\n"));
  const out = arg("--out"); if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, "```\n" + L.join("\n") + "\n```\n"); console.log(`\nWritten to ${out}`); }
}
main();
