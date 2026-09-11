/**
 * npm run report:rug-split
 *
 * Re-splits the closed paper positions: which would have been caught by rug
 * checks 1-3 (mint authority live, freeze authority live, risky extensions,
 * creator still holding LP) versus tokens that simply did not pump. Pooling
 * them hides what the filters could actually catch.
 *
 * A second, descriptive split is printed alongside because the first turns
 * out to be empty on Pump.fun (see APPROVALS 28): "drained" - the pool fell to
 * DRAIN_RATIO of entry within DRAIN_MINUTES - versus "faded". That is an
 * OUTCOME shape, not a check that could have fired at entry, and it is
 * labelled as such.
 *
 * Read-only over the logs. Parses JSON, never greps.
 */
import fs from "fs";
import path from "path";

export const DRAIN_RATIO = 0.05;
export const DRAIN_MINUTES = 10;

interface Close { mint: string; openedAt: string; closedAt: string; outcome: string; entryProceedsSol: number; exitProceedsSol: number | null; peakProceedsSol: number; exitReason: string; observations: number }
interface Decision { mint?: string; source?: string; metrics?: Record<string, any> | null }

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* counted below */ } }
  return out;
}

export function wouldBeCaught(m: Record<string, any> | null | undefined, maxCreatorLpPercent: number): string[] {
  const reasons: string[] = [];
  if (!m) return reasons;
  if (m.mintAuthorityRenounced === false) reasons.push("mint authority live");
  if (m.freezeAuthorityRenounced === false) reasons.push("freeze authority live");
  if (Array.isArray(m.riskyTokenExtensions) && m.riskyTokenExtensions.length > 0) reasons.push("risky token extensions");
  if (typeof m.creatorLpPercent === "number" && m.creatorLpPercent > maxCreatorLpPercent) reasons.push("creator still holds LP");
  if (m.lpBurned === false) reasons.push("LP not burned");
  return reasons;
}

export function isDrained(c: Close): boolean {
  if (c.exitProceedsSol === null || !(c.entryProceedsSol > 0)) return false;
  const minutes = (Date.parse(c.closedAt) - Date.parse(c.openedAt)) / 60_000;
  return c.exitProceedsSol / c.entryProceedsSol <= DRAIN_RATIO && minutes <= DRAIN_MINUTES;
}

function summarise(label: string, rows: Close[]): string {
  if (rows.length === 0) return `  ${label.padEnd(44)} n=0`;
  const staked = rows.reduce((a, r) => a + r.entryProceedsSol, 0);
  const returned = rows.reduce((a, r) => a + (r.exitProceedsSol ?? 0), 0);
  const ratios = rows.map((r) => (r.exitProceedsSol ?? 0) / r.entryProceedsSol).sort((a, b) => a - b);
  const mins = rows.map((r) => (Date.parse(r.closedAt) - Date.parse(r.openedAt)) / 60_000).sort((a, b) => a - b);
  const med = (xs: number[]) => xs[Math.floor(xs.length / 2)];
  const wins = rows.filter((r) => (r.exitProceedsSol ?? 0) > r.entryProceedsSol).length;
  return `  ${label.padEnd(44)} n=${String(rows.length).padStart(4)}  staked ${staked.toFixed(2).padStart(7)}  returned ${returned.toFixed(2).padStart(6)}  net ${(returned - staked).toFixed(2).padStart(7)} (${(((returned - staked) / staked) * 100).toFixed(0).padStart(4)}%)  wins ${String(wins).padStart(3)}  median exit ${med(ratios).toFixed(4)}x  median ${med(mins).toFixed(1)} min`;
}

function main(): void {
  const files = fs.readdirSync("logs").filter((f) => /^decisions.*\.jsonl$/.test(f)).sort().map((f) => path.join("logs", f));
  const decisions = files.flatMap((f) => readJsonl<Decision>(f));
  const byMint = new Map<string, Decision>();
  for (const d of decisions) if (d.mint && !byMint.has(d.mint)) byMint.set(d.mint, d);
  const closesAll = readJsonl<Close & { event: string }>("logs/paper-positions.jsonl").filter((r) => r.event === "paper-close" && r.outcome === "closed" && r.exitProceedsSol !== null);
  const seen = new Set<string>(); const closes: Close[] = [];
  for (const c of closesAll) { const k = `${c.mint}|${c.openedAt}`; if (!seen.has(k)) { seen.add(k); closes.push(c); } }
  const cfg = JSON.parse(fs.readFileSync("config/default.json", "utf-8"));
  const maxLp = cfg.filters.maxCreatorLpPercent;

  const caught: Close[] = [], notCaught: Close[] = [], unknownRenounce: Close[] = [];
  const reasonCount = new Map<string, number>();
  for (const c of closes) {
    const m = byMint.get(c.mint)?.metrics ?? null;
    const r = wouldBeCaught(m, maxLp);
    if (r.length) { caught.push(c); for (const x of r) reasonCount.set(x, (reasonCount.get(x) ?? 0) + 1); }
    else notCaught.push(c);
    if (!m || m.mintAuthorityRenounced === null || m.mintAuthorityRenounced === undefined) unknownRenounce.push(c);
  }
  const sources = new Map<string, number>();
  for (const c of closes) { const s = byMint.get(c.mint)?.source ?? "unknown"; sources.set(s, (sources.get(s) ?? 0) + 1); }

  console.log("Closed paper positions, re-split by what rug checks 1-3 would have caught");
  console.log("=".repeat(120));
  console.log(`  ${closes.length} closed positions with an exit; sources: ${[...sources].map(([k, v]) => `${k} ${v}`).join(", ")}; ${unknownRenounce.length} with renounce status UNKNOWN (unchecked, not safe)`);
  console.log();
  console.log(summarise("WOULD HAVE BEEN CAUGHT by checks 1-3", caught));
  for (const [k, v] of reasonCount) console.log(`      ${k}: ${v}`);
  console.log(summarise("NOT caught - passed 1-3 (or unknown)", notCaught));
  console.log();
  console.log(`  Descriptive split, NOT a check that could fire at entry - outcome shape only:`);
  const drained = closes.filter(isDrained), faded = closes.filter((c) => !isDrained(c));
  console.log(summarise(`DRAINED (<= ${DRAIN_RATIO * 100}% of entry within ${DRAIN_MINUTES} min)`, drained));
  console.log(summarise("FADED or ran (everything else)", faded));
  console.log();
  console.log(`  Reading: on Pump.fun every launch arrives renounced and LP does not exist before graduation, so checks 1-3 have`);
  console.log(`  nothing to catch here by construction; the drained group is what a post-launch check (bundle, first-minute`);
  console.log(`  sell pressure) would have to catch, and it is ${closes.length ? ((drained.length / closes.length) * 100).toFixed(0) : "?"}% of positions and ${caught.length + notCaught.length ? ((drained.reduce((a, r) => a + r.entryProceedsSol - (r.exitProceedsSol ?? 0), 0) / closes.reduce((a, r) => a + r.entryProceedsSol - (r.exitProceedsSol ?? 0), 0)) * 100).toFixed(0) : "?"}% of the money lost.`);
}
main();
