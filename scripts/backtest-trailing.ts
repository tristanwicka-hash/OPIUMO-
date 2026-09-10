/**
 * npm run backtest:trailing
 *
 * Runs the trailing stop against OPIUMO's OWN recorded pool histories, from
 * logs/watchlist.jsonl. Read-only: it opens log files and prints. It places no
 * orders and makes no network calls.
 *
 * The series it reads are the watchlist's liquidity observations - the densest
 * real history this bot has. They are NOT a fabricated price series; if there
 * is not enough history the script says so and stops rather than inventing one.
 *
 * Options:
 *   --min-observations N   Minimum observations for a token to be tested (default 10)
 *   --pool-fraction F      Position as a fraction of the pool (default 0.05)
 *   --json                 Emit raw results
 */
import fs from "fs";
import path from "path";
import { TrailingStopConfig, constantProductProceeds, naiveProceeds } from "../src/trading/trailingStop";
import { TokenSeries, backtest, formatReport, BacktestReport } from "../src/analysis/trailingStopBacktest";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

/** Liquidity observations per mint, oldest first, from the watchlist log. */
function loadSeries(minObservations: number): { series: TokenSeries[]; totalMints: number; totalObs: number } {
  const file = path.resolve(process.cwd(), "logs", "watchlist.jsonl");
  if (!fs.existsSync(file)) return { series: [], totalMints: 0, totalObs: 0 };

  const byMint = new Map<string, { ts: string; liquiditySol: number }[]>();
  let totalObs = 0;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let r: any;
    try {
      r = JSON.parse(t);
    } catch {
      continue; // a live file can end mid-write
    }
    if (!r.mint || typeof r.liquiditySol !== "number") continue;
    if (!["added", "checked", "promoted", "evicted"].includes(r.event)) continue;
    const list = byMint.get(r.mint) ?? [];
    list.push({ ts: r.ts, liquiditySol: r.liquiditySol });
    byMint.set(r.mint, list);
    totalObs++;
  }

  const series: TokenSeries[] = [];
  for (const [mint, obs] of byMint) {
    obs.sort((a, b) => a.ts.localeCompare(b.ts));
    if (obs.length >= minObservations) series.push({ mint, observations: obs });
  }
  return { series, totalMints: byMint.size, totalObs };
}

function main(): void {
  const minObservations = arg("min-observations", 10);
  const poolFraction = arg("pool-fraction", 0.05);

  const { series, totalMints, totalObs } = loadSeries(minObservations);

  if (series.length === 0) {
    console.error(
      `Not enough recorded history to backtest.\n` +
        `  logs/watchlist.jsonl holds ${totalObs} observation(s) across ${totalMints} mint(s), and none has ` +
        `${minObservations}+.\n` +
        `  Nothing is fabricated to fill the gap - the decision logic and its tests stand on their own ` +
        `(npm run test:trailing), and this becomes runnable as the watchlist accumulates history.`
    );
    process.exit(1);
  }

  const spans = series.map((s) => (Date.parse(s.observations[s.observations.length - 1].ts) - Date.parse(s.observations[0].ts)) / 60000);
  spans.sort((a, b) => a - b);
  const sampleNote =
    `Sample: ${series.length} token(s) with ${minObservations}+ observations, out of ${totalMints} mint(s) ` +
    `and ${totalObs} observation(s) in logs/watchlist.jsonl.\n` +
    `Observed span per token: median ${spans[Math.floor(spans.length / 2)].toFixed(0)} min, ` +
    `max ${spans[spans.length - 1].toFixed(0)} min. Position modelled at ${(poolFraction * 100).toFixed(1)}% of the pool.\n` +
    `THIS IS A SHORT WINDOW. It tests intra-hour behaviour on a small sample, not multi-hour runners.`;

  // Explicit parameter sets. No defaults anywhere - every number here was chosen
  // for this sweep and appears in the report next to its result.
  const sets: { label: string; config: TrailingStopConfig }[] = [
    { label: "tight (arm 20, trail 15)", config: { hardStopPercent: -50, activationPercent: 20, trailPercent: 15, persistenceObservations: 2, minHoldMs: 60_000 } },
    { label: "medium (arm 50, trail 25)", config: { hardStopPercent: -50, activationPercent: 50, trailPercent: 25, persistenceObservations: 2, minHoldMs: 60_000 } },
    { label: "loose (arm 100, trail 40)", config: { hardStopPercent: -50, activationPercent: 100, trailPercent: 40, persistenceObservations: 2, minHoldMs: 60_000 } },
    { label: "medium, no wick guard", config: { hardStopPercent: -50, activationPercent: 50, trailPercent: 25, persistenceObservations: 1, minHoldMs: 0 } },
  ];

  const reports: BacktestReport[] = sets.map((s) =>
    backtest(series, poolFraction, s.config, constantProductProceeds, 100, s.label)
  );

  // The same middle set priced NAIVELY, to show what ignoring slippage does.
  reports.push(
    backtest(series, poolFraction, sets[1].config, naiveProceeds, 100, "medium, NAIVE pricing (no slippage)")
  );

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(reports.map((r) => r.summary), null, 2));
    return;
  }
  console.log(formatReport(reports, sampleNote));
}

main();
