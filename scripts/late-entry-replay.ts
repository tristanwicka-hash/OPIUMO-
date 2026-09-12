/**
 * npm run replay:late-entry [-- --stake 0.2 --delays 0,60,90,120 --out reports/x.md]
 * Read-only over logs/paper-positions.jsonl and logs/watchlist.jsonl. Changes nothing live.
 */
import fs from "fs";
import path from "path";
import { ClosedPosition, Reading, replayPosition, summariseDelay, reproductionCheck, formatReport, isDrained } from "../src/analysis/lateEntry";

const arg = (f: string) => { const i = process.argv.indexOf(f); return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined; };
function readJsonl<T>(file: string): T[] { const out: T[] = []; for (const l of fs.readFileSync(file, "utf-8").split("\n")) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* counted elsewhere */ } } return out; }

function main(): void {
  const stake = Number(arg("--stake") ?? 0.2);
  const delays = (arg("--delays") ?? "0,60,90,120").split(",").map(Number);
  const cfg = JSON.parse(fs.readFileSync("config/default.json", "utf-8"));
  const trailing = cfg.paperExecution.trailing;

  const paper = readJsonl<ClosedPosition & { event: string; liveVerdict?: string }>("logs/paper-positions.jsonl").filter((r) => r.event === "paper-close" && r.outcome === "closed" && r.exitProceedsSol !== null);
  const seen = new Set<string>(); const closes: (ClosedPosition & { liveVerdict?: string })[] = [];
  for (const c of paper) { const k = `${c.mint}|${c.openedAt}`; if (!seen.has(k)) { seen.add(k); closes.push(c); } }
  const wl = readJsonl<{ ts: string; event: string; mint: string; liquiditySol?: number | null }>("logs/watchlist.jsonl");
  const readingsByMint = new Map<string, Reading[]>();
  const gaps: number[] = [];
  for (const r of wl) {
    // "checked" only: that is the reading the paper book was fed (watchlist.ts onObservation). "promoted" repeats the last reading under a new timestamp and "added" is the t=0 baseline the book already holds.
    if (r.event !== "checked" || typeof r.liquiditySol !== "number") continue;
    if (!readingsByMint.has(r.mint)) readingsByMint.set(r.mint, []);
    readingsByMint.get(r.mint)!.push({ tMs: Date.parse(r.ts), sol: r.liquiditySol });
  }
  for (const c of closes) { const rs = (readingsByMint.get(c.mint) ?? []).map((x) => x.tMs).sort((a, b) => a - b); for (let i = 1; i < rs.length; i++) gaps.push((rs[i] - rs[i - 1]) / 1000); }
  gaps.sort((a, b) => a - b);

  const rep = reproductionCheck(closes, readingsByMint, trailing);
  const reports = delays.map((d) => summariseDelay(closes.map((c) => replayPosition(c, readingsByMint.get(c.mint) ?? [], d, { stakeSol: stake, trailing }))));
  const text = formatReport(reports, rep, {
    positions: closes.length, drained: closes.filter(isDrained).length,
    firstOpened: closes.map((c) => c.openedAt).sort()[0] ?? null, lastClosed: closes.map((c) => c.closedAt ?? "").sort().pop() || null,
    readingGapMedianSec: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
    allRejected: closes.every((c) => c.liveVerdict === "REJECTED"), stakeSol: stake,
  });
  console.log(text);
  const out = arg("--out"); if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, "```\n" + text + "\n```\n"); console.log(`\nWritten to ${out}`); }
}
main();
