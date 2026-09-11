/**
 * npm run backtest:trailing-v2
 *
 * Trailing stop compared against a fixed take-profit and against doing nothing,
 * over MULTI-HOUR histories, separately at each horizon.
 *
 * v1 ran on a median 14-minute window and found a fixed +100% take-profit beat
 * every trailing configuration. Trailing stops exist for multi-hour runners,
 * which that data could not contain, so the result answered a different
 * question. This uses the outcome tracker's 1h / 6h / 24h checkpoints.
 *
 * Read-only: opens log files and prints. No network, no order path.
 */
import {
  loadTokenSeries,
  cohort,
  describeGranularity,
  CHECKPOINT_1H,
  CHECKPOINT_6H,
  CHECKPOINT_24H,
  TokenSeries,
} from "../src/analysis/trailingCohorts";
import {
  runSeries,
  constantProductProceeds,
  Position,
  TrailingStopConfig,
} from "../src/trading/trailingStop";

const OUTCOME_FILES = ["logs/outcomes.jsonl"];

/**
 * The position size, as a fraction of the pool.
 *
 * 5% matches what the paper-execution book actually uses, so the slippage the
 * constant-product model applies here is the slippage a real exit of this size
 * would face - not a frictionless one.
 */
const POOL_FRACTION = 0.05;

interface StrategyResult {
  label: string;
  tokens: number;
  /** Sum of realised proceeds across every token, in SOL. */
  totalProceeds: number;
  totalEntry: number;
  exited: number;
  heldToEnd: number;
  exitFailed: number;
  /** Per-token multiple of entry, for the median. */
  multiples: number[];
  /** Exit trigger -> count. Empty for the non-trailing strategies. */
  triggers: Record<string, number>;
  /** How many tokens ever rose far enough for the trail to arm at all. */
  couldArm: number;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** "Do nothing": hold to the last observation and take whatever it is worth. */
function doNothing(series: TokenSeries[]): StrategyResult {
  const r: StrategyResult = {
    label: "do nothing (hold to last checkpoint)",
    tokens: 0, totalProceeds: 0, totalEntry: 0, exited: 0, heldToEnd: 0, exitFailed: 0, multiples: [], triggers: {}, couldArm: 0,
  };
  for (const s of series) {
    const entry = constantProductProceeds(s.observations[0].liquiditySol, POOL_FRACTION);
    const last = s.observations[s.observations.length - 1];
    const final = constantProductProceeds(last.liquiditySol, POOL_FRACTION);
    if (entry === null || final === null) continue;
    r.tokens++;
    r.totalEntry += entry;
    r.totalProceeds += final;
    r.heldToEnd++;
    r.multiples.push(final / entry);
  }
  return r;
}

/** Fixed take-profit: exit the first time proceeds reach entry * (1 + target). */
function fixedTakeProfit(series: TokenSeries[], targetPercent: number): StrategyResult {
  const r: StrategyResult = {
    label: `fixed take-profit +${targetPercent}%`,
    tokens: 0, totalProceeds: 0, totalEntry: 0, exited: 0, heldToEnd: 0, exitFailed: 0, multiples: [], triggers: {}, couldArm: 0,
  };
  for (const s of series) {
    const entry = constantProductProceeds(s.observations[0].liquiditySol, POOL_FRACTION);
    if (entry === null) continue;
    r.tokens++;
    r.totalEntry += entry;
    let realised: number | null = null;
    for (let i = 1; i < s.observations.length; i++) {
      const p = constantProductProceeds(s.observations[i].liquiditySol, POOL_FRACTION);
      if (p === null) continue;
      if (p >= entry * (1 + targetPercent / 100)) {
        realised = p;
        r.exited++;
        break;
      }
    }
    if (realised === null) {
      const last = s.observations[s.observations.length - 1];
      realised = constantProductProceeds(last.liquiditySol, POOL_FRACTION) ?? 0;
      r.heldToEnd++;
    }
    r.totalProceeds += realised;
    r.multiples.push(realised / entry);
  }
  return r;
}

function trailing(series: TokenSeries[], config: TrailingStopConfig, label: string): StrategyResult {
  const r: StrategyResult = {
    label, tokens: 0, totalProceeds: 0, totalEntry: 0, exited: 0, heldToEnd: 0, exitFailed: 0, multiples: [], triggers: {}, couldArm: 0,
  };
  for (const s of series) {
    const entryProceeds = constantProductProceeds(s.observations[0].liquiditySol, POOL_FRACTION);
    if (entryProceeds === null) continue;
    const position: Position = {
      mint: s.mint,
      entryTs: s.observations[0].ts,
      poolFraction: POOL_FRACTION,
      entryProceedsSol: entryProceeds,
    };
    const out = runSeries(position, s.observations.slice(1), config, constantProductProceeds);
    r.tokens++;
    r.totalEntry += entryProceeds;
    const key = out.result === "exited" ? (out.trigger ?? "unknown") : out.result;
    r.triggers[key] = (r.triggers[key] ?? 0) + 1;
    // Did this token EVER rise far enough for the trail to arm? If not, the
    // trail distance was never consulted and the config is not being tested.
    if (out.peakProceedsSol / entryProceeds >= 1 + config.activationPercent / 100) r.couldArm++;

    // EXIT_FAILED is counted separately and NEVER folded into a clean exit:
    // a position that could not be sold did not realise anything, and
    // averaging it in with successful exits is how an unsellable token starts
    // looking like a small loss instead of a total one.
    if (out.result === "exit-failed") {
      r.exitFailed++;
      r.totalProceeds += 0;
      r.multiples.push(0);
      continue;
    }
    if (out.result === "exited") r.exited++;
    else r.heldToEnd++;
    const realised = out.exitProceedsSol ?? out.finalProceedsSol ?? 0;
    r.totalProceeds += realised;
    r.multiples.push(realised / entryProceeds);
  }
  return r;
}

function printTable(results: StrategyResult[], horizonLabel: string): void {
  console.log(`\n${"=".repeat(78)}`);
  console.log(`  HORIZON: ${horizonLabel}`);
  console.log("=".repeat(78));
  if (results.length === 0 || results[0].tokens === 0) {
    console.log("  no tokens in this cohort - nothing to compare.");
    return;
  }
  console.log(
    `  ${"strategy".padEnd(38)} ${"tokens".padStart(7)} ${"total x".padStart(9)} ${"median x".padStart(9)} ${"exits".padStart(6)} ${"failed".padStart(7)}`
  );
  for (const r of results) {
    const totalX = r.totalEntry > 0 ? (r.totalProceeds / r.totalEntry).toFixed(3) : "n/a";
    const med = median(r.multiples);
    console.log(
      `  ${r.label.padEnd(38)} ${String(r.tokens).padStart(7)} ${totalX.padStart(9)} ` +
        `${(med === null ? "n/a" : med.toFixed(3)).padStart(9)} ${String(r.exited).padStart(6)} ${String(r.exitFailed).padStart(7)}`
    );
  }
  // The trail's own diagnostics. Without these the table above is misleading:
  // three trail configs with near-identical totals look like "trail distance
  // does not matter", when the real reason is that the trail almost never
  // fires and the hard stop is doing the work.
  const trailRows = results.filter((r) => r.label.startsWith("trailing"));
  if (trailRows.length > 0) {
    console.log("");
    console.log("  WHAT ACTUALLY TRIGGERED THE EXITS (trailing rows):");
    for (const r of trailRows) {
      const parts = Object.entries(r.triggers).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`);
      const armPct = r.tokens > 0 ? ((r.couldArm / r.tokens) * 100).toFixed(1) : "n/a";
      console.log(`    ${r.label.padEnd(34)} ${parts.join("  ")}`);
      console.log(`    ${"".padEnd(34)} only ${r.couldArm} token(s) (${armPct}%) ever rose enough for the trail to ARM`);
    }
  }

  const best = [...results].sort((a, b) => b.totalProceeds / b.totalEntry - a.totalProceeds / a.totalEntry)[0];
  const nothing = results.find((r) => r.label.startsWith("do nothing"));
  console.log("");
  if (best && nothing) {
    if (best.label === nothing.label) {
      console.log(`  VERDICT: doing NOTHING beat every exit strategy at this horizon.`);
    } else {
      const lift = (best.totalProceeds / best.totalEntry) - (nothing.totalProceeds / nothing.totalEntry);
      console.log(`  VERDICT: best is "${best.label}", ${lift >= 0 ? "+" : ""}${lift.toFixed(3)}x vs doing nothing.`);
    }
  }
}

function main(): void {
  const loaded = loadTokenSeries(OUTCOME_FILES);
  console.log("OPIUMO trailing stop v2 - multi-hour horizons");
  console.log(`Read ${OUTCOME_FILES.join(", ")}`);
  console.log(
    `  ${loaded.recordsRead.toLocaleString()} checkpoint record(s), ` +
      `${loaded.droppedFailedCheckpoints.toLocaleString()} dropped as failed reads, ` +
      `${loaded.unparseable.toLocaleString()} unparseable, ` +
      `${loaded.droppedNoBaseline.toLocaleString()} token(s) dropped with no baseline`
  );
  console.log(`  ${loaded.series.length.toLocaleString()} token(s) with a usable series`);

  const cohorts: [string, number][] = [
    [">= 1h", CHECKPOINT_1H],
    [">= 6h", CHECKPOINT_6H],
    [">= 24h", CHECKPOINT_24H],
  ];

  console.log("\nCOHORT SIZES (tokens with a successful checkpoint at that horizon):");
  for (const [label, secs] of cohorts) {
    const c = cohort(loaded.series, secs);
    // A cohort is limited by how long the bot has been running, not only by
    // what survived. Printing the detection window makes a narrow slice
    // visible instead of letting it read as a representative sample.
    const ds = c.map((s) => s.detectedAt).sort();
    const window = ds.length > 0 ? `detected ${ds[0].slice(0, 16)}Z .. ${ds[ds.length - 1].slice(0, 16)}Z` : "";
    console.log(`  ${label.padEnd(8)} ${String(c.length.toLocaleString()).padStart(7)}   ${window}`);
  }
  const allDs = loaded.series.map((s) => s.detectedAt).sort();
  if (allDs.length > 0) {
    console.log(`  ${"(all)".padEnd(8)} ${String(loaded.series.length.toLocaleString()).padStart(7)}   detected ${allDs[0].slice(0, 16)}Z .. ${allDs[allDs.length - 1].slice(0, 16)}Z`);
  }

  console.log("");
  console.log(describeGranularity());

  console.log("");
  console.log(
    "SAMPLE BIAS: these are tokens the bot DETECTED, not tokens it would have bought - " +
      "the filters pass almost nothing, so this is the detection population. The paper " +
      "execution book is a different and more biased sample again: its 50-position cap was " +
      "binding hard before it was raised to 400, so early records are whatever arrived while " +
      "the book had room, which is not random with respect to launch timing."
  );

  for (const [label, secs] of cohorts) {
    const c = cohort(loaded.series, secs);
    if (c.length === 0) {
      console.log(`\n${"=".repeat(78)}\n  HORIZON: ${label}\n${"=".repeat(78)}`);
      console.log(`  EMPTY - no token has a successful checkpoint at this horizon yet.`);
      console.log(`  Not a result about trailing stops. There is nothing to measure.`);
      continue;
    }
    const results: StrategyResult[] = [
      doNothing(c),
      fixedTakeProfit(c, 100),
      fixedTakeProfit(c, 50),
      trailing(c, { hardStopPercent: -50, activationPercent: 30, trailPercent: 20, persistenceObservations: 1, minHoldMs: 0 }, "trailing: arm +30%, trail 20%"),
      trailing(c, { hardStopPercent: -50, activationPercent: 50, trailPercent: 30, persistenceObservations: 1, minHoldMs: 0 }, "trailing: arm +50%, trail 30%"),
      trailing(c, { hardStopPercent: -50, activationPercent: 100, trailPercent: 40, persistenceObservations: 1, minHoldMs: 0 }, "trailing: arm +100%, trail 40%"),
    ];
    printTable(results, `${label}  (${c.length.toLocaleString()} tokens)`);
  }

  console.log("");
  console.log(
    "Read the per-horizon tables separately. Pooling them would let the 1h cohort, which is " +
      "six times larger, decide a question that is only about the 24h one."
  );
}

main();
