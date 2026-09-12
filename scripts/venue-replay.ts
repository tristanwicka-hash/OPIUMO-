/**
 * npm run replay:venue
 *
 * Project F: the paper book priced every position with constant-product
 * slippage on the pool's real SOL. Pump.fun is a bonding curve. This tags
 * every closed paper position by venue (from its decision record), replays
 * each from t=0 on the watchlist's readings with a flat 0.2 SOL stake under
 * BOTH models - the book's real-balance constant product and the venue-correct
 * model (bonding curve for Pump.fun, constant product for Raydium) - with the
 * same trailing-stop config, and reports whether the loss figure moves.
 *
 * Read-only. Changes nothing live.
 */
import fs from "fs";
import path from "path";
import { runSeries, constantProductProceeds, Position, ProceedsFn } from "../src/trading/trailingStop";
import { proceedsFor, venueOf, Venue, bondingCurveFloorFraction } from "../src/analysis/venueModels";
import { ClosedPosition, Reading, isDrained } from "../src/analysis/lateEntry";
import { DEFAULT_MAX_POOL_SHARE } from "../src/analysis/sizingBacktest";

const arg = (f: string) => { const i = process.argv.indexOf(f); return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined; };
function readJsonl<T>(file: string): T[] { const out: T[] = []; for (const l of fs.readFileSync(file, "utf-8").split("\n")) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* counted elsewhere */ } } return out; }

interface Row { mint: string; venue: Venue; entered: boolean; staked: number; realised: number | null; net: number | null; result: string | null; drain: boolean; floor: number }

function replay(c: ClosedPosition, venue: Venue, readings: Reading[], model: "book" | "venue", stake: number, trailing: any): Row {
  const t0 = Date.parse(c.openedAt);
  const L0 = c.entryLiquiditySol;
  const floor = venue === "pumpfun" ? bondingCurveFloorFraction(L0) : 0;
  const base: Row = { mint: c.mint, venue, entered: false, staked: 0, realised: null, net: null, result: null, drain: isDrained(c), floor };
  const f = stake / L0;
  if (f > DEFAULT_MAX_POOL_SHARE) return base; // same share cap as the sizing backtest: a stake that IS the pool is not entered
  let fn: ProceedsFn, entryProceeds: number | null;
  if (model === "book") { fn = constantProductProceeds; entryProceeds = constantProductProceeds(L0, f); }
  else { const p = proceedsFor(venue, stake, L0); fn = p.fn; entryProceeds = p.entryProceedsSol; }
  if (entryProceeds === null) return base;
  const series = readings.filter((r) => r.tMs > t0).sort((a, b) => a.tMs - b.tMs).map((r) => ({ ts: new Date(r.tMs).toISOString(), liquiditySol: r.sol }));
  const pos: Position = { mint: c.mint, entryTs: c.openedAt, poolFraction: f, entryProceedsSol: entryProceeds };
  const out = runSeries(pos, series, trailing, fn);
  const realised = out.result === "exited" ? out.exitProceedsSol : out.result === "held-to-end" ? out.finalProceedsSol : null;
  return { ...base, entered: true, staked: stake, realised, net: realised === null ? null : realised - stake, result: out.result };
}

function summarise(rows: Row[]) {
  const e = rows.filter((r) => r.entered && r.net !== null);
  const staked = e.reduce((a, r) => a + r.staked, 0), realised = e.reduce((a, r) => a + (r.realised ?? 0), 0);
  const sorted = [...e].sort((a, b) => (a.net ?? 0) - (b.net ?? 0));
  return {
    entered: e.length, notEntered: rows.length - e.length, staked, realised, net: realised - staked, netPct: staked ? ((realised - staked) / staked) * 100 : null,
    wins: e.filter((r) => (r.net ?? 0) > 0).length, heldToEnd: e.filter((r) => r.result === "held-to-end").length, exited: e.filter((r) => r.result === "exited").length,
    largestLoss: sorted[0]?.net ?? null, largestWin: sorted[sorted.length - 1]?.net ?? null,
    drainNet: e.filter((r) => r.drain).reduce((a, r) => a + (r.net ?? 0), 0), drains: e.filter((r) => r.drain).length,
  };
}

function main(): void {
  const stake = Number(arg("--stake") ?? 0.2);
  const cfg = JSON.parse(fs.readFileSync("config/default.json", "utf-8")); const trailing = cfg.paperExecution.trailing;
  const paper = readJsonl<ClosedPosition & { event: string }>("logs/paper-positions.jsonl").filter((r) => r.event === "paper-close" && r.outcome === "closed" && r.exitProceedsSol !== null);
  const seen = new Set<string>(); const closes: ClosedPosition[] = [];
  for (const c of paper) { const k = `${c.mint}|${c.openedAt}`; if (!seen.has(k)) { seen.add(k); closes.push(c); } }
  const venueByMint = new Map<string, Venue>();
  for (const f of fs.readdirSync("logs").filter((x) => /^decisions.*\.jsonl$/.test(x))) for (const d of readJsonl<{ mint?: string; source?: string }>(path.join("logs", f))) { const v = venueOf(d.source); if (d.mint && v && !venueByMint.has(d.mint)) venueByMint.set(d.mint, v); }
  const readingsByMint = new Map<string, Reading[]>();
  for (const r of readJsonl<{ ts: string; event: string; mint: string; liquiditySol?: number | null }>("logs/watchlist.jsonl")) { if (r.event !== "checked" || typeof r.liquiditySol !== "number") continue; if (!readingsByMint.has(r.mint)) readingsByMint.set(r.mint, []); readingsByMint.get(r.mint)!.push({ tMs: Date.parse(r.ts), sol: r.liquiditySol }); }

  const tagged = closes.map((c) => ({ c, venue: venueByMint.get(c.mint) ?? null }));
  const unknown = tagged.filter((t) => t.venue === null).length;
  const byVenue: Record<string, number> = {}; for (const t of tagged) byVenue[t.venue ?? "unknown"] = (byVenue[t.venue ?? "unknown"] ?? 0) + 1;
  const known = tagged.filter((t): t is { c: ClosedPosition; venue: Venue } => t.venue !== null);
  const book = summarise(known.map((t) => replay(t.c, t.venue, readingsByMint.get(t.c.mint) ?? [], "book", stake, trailing)));
  const venue = summarise(known.map((t) => replay(t.c, t.venue, readingsByMint.get(t.c.mint) ?? [], "venue", stake, trailing)));
  const floors = known.filter((t) => t.venue === "pumpfun").map((t) => bondingCurveFloorFraction(t.c.entryLiquiditySol)).sort((a, b) => a - b);

  const L: string[] = [];
  const sol = (x: number | null, d = 2) => (x === null ? "n/a" : x.toFixed(d));
  L.push("Slippage by venue - the same positions, the same readings, the same stop, two pricing models");
  L.push("=".repeat(104));
  L.push(`  ${closes.length} closed paper positions; venue from the decision record: ${Object.entries(byVenue).map(([k, v]) => `${k} ${v}`).join(", ")}${unknown ? ` (${unknown} with no venue are EXCLUDED)` : ""}.`);
  L.push(`  Flat ${stake} SOL at t=0, share cap ${DEFAULT_MAX_POOL_SHARE * 100}%, trailing stop ${JSON.stringify(trailing)} replayed on the watchlist readings.`);
  L.push("");
  L.push(`  ${"model".padEnd(58)} ${"entered".padStart(7)} ${"staked".padStart(7)} ${"returned".padStart(9)} ${"net".padStart(8)} ${"net%".padStart(7)} ${"wins".padStart(5)} ${"exited".padStart(7)} ${"held-to-end".padStart(12)} ${"largest loss".padStart(13)} ${"largest win".padStart(12)}  drains: n / net`);
  for (const [label, s] of [["BOOK: constant product on real SOL (every venue)", book], ["VENUE: bonding curve (Pump.fun) / constant product (Raydium)", venue]] as const) {
    L.push(`  ${label.padEnd(58)} ${String(s.entered).padStart(7)} ${sol(s.staked).padStart(7)} ${sol(s.realised).padStart(9)} ${sol(s.net).padStart(8)} ${(s.netPct === null ? "n/a" : s.netPct.toFixed(1) + "%").padStart(7)} ${String(s.wins).padStart(5)} ${String(s.exited).padStart(7)} ${String(s.heldToEnd).padStart(12)} ${sol(s.largestLoss, 3).padStart(13)} ${sol(s.largestWin, 3).padStart(12)}  ${s.drains} / ${sol(s.drainNet)}`);
  }
  L.push("");
  L.push(`  Pump.fun price FLOOR at the entry liquidities seen (fraction of stake a full drain returns, fees included): min ${sol(floors[0] ?? null, 3)}, median ${sol(floors[Math.floor(floors.length / 2)] ?? null, 3)}, max ${sol(floors[floors.length - 1] ?? null, 3)}.`);
  L.push(`  Under the curve a position whose pool drains cannot lose more than 1 - floor; the -50% hard stop fires only when the floor is below 50%, i.e. entry liquidity above ${(30 / Math.sqrt(0.5) - 30).toFixed(1)} SOL raised.`);
  L.push("");
  L.push("  READ THIS FIRST:");
  L.push("    - Held-to-end positions never triggered the stop within the readings and are valued at their LAST reading. Under the curve that is most of them: a token bought at 2 SOL raised and drained to nothing still prices at ~81% of the stake on the curve, and no rule in the book sells it.");
  L.push("    - The curve's floor is real on-chain mechanics (virtual reserves, verified live 2026-09-12), but it assumes the token can still be SOLD INTO THE CURVE at that state. A migrated token, or one whose curve account is closed, is a different question this replay does not answer.");
  L.push("    - Every position is a token the live filters rejected. One day of one market.");
  console.log(L.join("\n"));
  const out = arg("--out"); if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, "```\n" + L.join("\n") + "\n```\n"); console.log(`\nWritten to ${out}`); }
}
main();
