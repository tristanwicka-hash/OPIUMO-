/**
 * npm run backtest:sizing
 *
 *   npm run backtest:sizing                          flat 0.2, pyramid 0.2 x2 up to 3 units, vs the 5% baseline
 *   npm run backtest:sizing -- --flat 0.1 --unit 0.2 --step 2 --max-units 4
 *   npm run backtest:sizing -- --max-share 1e9         no share cap: put 0.2 into any pool, however small
 *   npm run backtest:sizing -- --log logs/paper-positions.jsonl --out reports/sizing.md
 *
 * Read-only over the paper-execution log. No network, no config, no order
 * path, and it does NOT touch paperExecution.poolFraction - the live paper
 * book keeps sizing at 5% whatever this prints.
 */
import fs from "fs";
import path from "path";
import {
  ClosedPaperRecord,
  Strategy,
  poolFractionStrategy,
  flatStakeStrategy,
  pyramidStrategy,
  naiveRatioReuse,
  DEFAULT_MAX_POOL_SHARE,
  runSizingBacktest,
  formatReport,
} from "../src/analysis/sizingBacktest";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const num = (flag: string, dflt: number): number => {
  const v = arg(flag);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${flag} must be a number, got "${v}"`);
  return n;
};

/** Parses every line; a line that is not JSON is COUNTED, never skipped silently. */
function readCloses(file: string): { closes: ClosedPaperRecord[]; badLines: number; lines: number } {
  const raw = fs.readFileSync(file, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const closes: ClosedPaperRecord[] = [];
  let badLines = 0;
  const seen = new Set<string>();
  for (const l of lines) {
    let r: any;
    try { r = JSON.parse(l); } catch { badLines++; continue; }
    if (r?.event !== "paper-close") continue;
    const key = `${r.mint}|${r.openedAt}`;
    if (seen.has(key)) continue; // a replayed close is the same position, not a second one
    seen.add(key);
    closes.push(r as ClosedPaperRecord);
  }
  return { closes, badLines, lines: lines.length };
}

function main(): void {
  const file = arg("--log") ?? "logs/paper-positions.jsonl";
  if (!fs.existsSync(file)) {
    console.error(`No paper log at ${file}. The paper book has not written anything, so there is nothing to size.`);
    process.exit(1);
  }
  const flat = num("--flat", 0.2);
  const unit = num("--unit", 0.2);
  const step = num("--step", 2);
  const maxUnits = num("--max-units", 3);
  const maxShare = num("--max-share", DEFAULT_MAX_POOL_SHARE);

  const { closes, badLines, lines } = readCloses(file);
  console.log(`Read ${lines} line(s) from ${file}: ${closes.length} distinct paper-close record(s)${badLines ? `, ${badLines} UNPARSEABLE line(s) - counted, not ignored` : ""}.`);
  if (closes.length === 0) {
    console.log("No closed paper positions. Nothing to compare.");
    return;
  }
  const baselineFraction = closes[0].poolFraction;
  const mixed = closes.some((c) => c.poolFraction !== baselineFraction);
  if (mixed) console.log(`  NOTE: records carry more than one poolFraction; the baseline row uses ${baselineFraction} (first record).`);

  const strategies: Strategy[] = [
    poolFractionStrategy(baselineFraction),
    // The flat stake skips pools smaller than flat/maxShare; this row is the baseline on the pools it did enter.
    poolFractionStrategy(baselineFraction, flat / maxShare),
    flatStakeStrategy(flat, maxShare),
    pyramidStrategy({ unitSol: unit, stepMultiple: step, maxUnits, maxPoolShare: maxShare }),
    naiveRatioReuse(flat),
  ];
  const result = runSizingBacktest(closes, strategies);
  const text = formatReport(result);
  console.log("\n" + text);

  // The paper book's own accounting treats realizable-at-entry as the stake.
  // Printed so the two conventions can be reconciled instead of argued about.
  const usable = closes.filter((c) => c.outcome === "closed" && c.exitProceedsSol !== null);
  const bookStaked = usable.reduce((a, c) => a + c.entryProceedsSol, 0);
  const bookReturned = usable.reduce((a, c) => a + (c.exitProceedsSol ?? 0), 0);
  console.log(`\n  RECONCILIATION: the paper book's own figure (stake = realizable proceeds at entry) is ${(bookReturned - bookStaked).toFixed(2)} SOL on ${bookStaked.toFixed(2)} staked (${(((bookReturned - bookStaked) / bookStaked) * 100).toFixed(1)}%).`);
  console.log(`  The baseline row above counts the stake as f*L0 (SOL actually put in), which is 1+f times larger - both are the same positions.`);

  const out = arg("--out");
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, "```\n" + text + "\n```\n");
    console.log(`\nWritten to ${out}`);
  }
}
main();
