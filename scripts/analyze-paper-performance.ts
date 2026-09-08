/**
 * Paper-trading performance report.
 *
 *   npm run report:paper
 *   npm run report:paper -- --trades logs/paper-trades.jsonl --decisions logs/decisions.jsonl
 *   npm run report:paper -- --out reports/my-report.md
 *   npm run report:paper -- --real          # analyse trades.jsonl instead of paper
 *
 * Note the space after `--` when passing flags through npm.
 *
 * Reads local log files, computes the stats in src/analysis/paperPerformance.ts,
 * prints a summary to the console and writes a markdown report under reports/.
 *
 * Deliberately does NOT call loadConfig(): config validation throws when
 * RPC_URL is unset, and needing an RPC endpoint to read a local file would be
 * absurd. Defaults are the conventional repo paths and every one is
 * overridable by flag. This tool makes no network calls of any kind.
 */
import fs from "fs";
import path from "path";
import {
  analyze,
  PerformanceReport,
  TradeRecord,
  DecisionRecord,
} from "../src/analysis/paperPerformance";
import {
  summarizeFundingCapture,
  FundingCaptureSummary,
  FundingSampleLike,
  PerpsCloseRecord,
} from "../src/analysis/fundingCapture";

/** Ladder tiers as shipped in config/default.json. Passed in rather than read, to keep the analyzer pure and this script config-free. */
const DEFAULT_LADDER_TIERS = [2, 5, 10];

interface Args {
  tradesPath: string;
  decisionsPath: string;
  perpsPath: string;
  fundingHistoryPath: string;
  outPath: string;
  paperOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const real = argv.includes("--real");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    tradesPath: get("--trades") ?? (real ? "logs/trades.jsonl" : "logs/paper-trades.jsonl"),
    decisionsPath: get("--decisions") ?? "logs/decisions.jsonl",
    perpsPath: get("--perps") ?? "logs/perps-trades.jsonl",
    fundingHistoryPath: get("--funding-history") ?? "logs/funding-arb-history.json",
    outPath: get("--out") ?? path.join("reports", `${real ? "real" : "paper"}-performance-${stamp}.md`),
    paperOnly: !real,
  };
}

/**
 * Read a .jsonl file. Distinguishes "file missing" from "file empty" from
 * "line unparseable" - all three mean different things when you're deciding
 * whether to trust a report, and a silent empty array would hide all of them.
 */
function readJsonl<T>(filePath: string): { records: T[]; missing: boolean; badLines: number } {
  if (!fs.existsSync(filePath)) return { records: [], missing: true, badLines: 0 };
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const records: T[] = [];
  let badLines = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      badLines++;
    }
  }
  return { records, missing: false, badLines };
}

/**
 * The funding history file is keyed by Drift marketIndex ("0"), while the perps
 * trade log names markets by symbol ("SOL-PERP"). Rather than pull in the config
 * (which would drag RPC_URL validation into an offline tool), map them here:
 * with a single market in the history - the shipped configuration - its samples
 * apply to every market in the log. With several, an explicit --funding-market-map
 * is required rather than guessing which index is which symbol.
 */
function loadFundingSamples(
  historyPath: string,
  marketsInLog: string[],
  explicitMap: string | undefined,
): { samples: Record<string, FundingSampleLike[]>; note: string | null } {
  if (!fs.existsSync(historyPath)) return { samples: {}, note: null };
  let parsed: Record<string, FundingSampleLike[]>;
  try {
    parsed = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
  } catch {
    return { samples: {}, note: `Funding history \`${historyPath}\` could not be parsed - funding capture skipped.` };
  }

  const indices = Object.keys(parsed);
  if (indices.length === 0) return { samples: {}, note: null };

  if (explicitMap) {
    const out: Record<string, FundingSampleLike[]> = {};
    for (const pair of explicitMap.split(",")) {
      const [symbol, idx] = pair.split("=").map((x) => x.trim());
      if (symbol && idx && parsed[idx]) out[symbol] = parsed[idx];
    }
    return { samples: out, note: null };
  }

  if (indices.length === 1) {
    const only = parsed[indices[0]];
    const out: Record<string, FundingSampleLike[]> = {};
    for (const m of marketsInLog) out[m] = only;
    return {
      samples: out,
      note:
        marketsInLog.length > 0
          ? `Funding history holds one market (index ${indices[0]}); its settlements were applied to ${marketsInLog.join(", ")}.`
          : null,
    };
  }

  return {
    samples: {},
    note:
      `Funding history holds ${indices.length} markets (indices ${indices.join(", ")}) and no ` +
      "--funding-market-map was given, so funding capture was skipped rather than guessing " +
      'which index is which symbol. Pass e.g. --funding-market-map "SOL-PERP=0".',
  };
}

const n = (v: number | null, digits = 2, suffix = ""): string =>
  v === null ? "unknown" : `${v.toFixed(digits)}${suffix}`;

function buildMarkdown(r: PerformanceReport, args: Args, notes: string[], funding: FundingCaptureSummary | null): string {
  const L: string[] = [];
  L.push(`# ${args.paperOnly ? "Paper" : "Real"}-trading performance report`);
  L.push("");
  L.push(`Generated: ${new Date().toISOString()}`);
  L.push(`Trades:    \`${args.tradesPath}\``);
  L.push(`Decisions: \`${args.decisionsPath}\``);
  L.push("");

  if (notes.length > 0) {
    L.push("## Data notes");
    L.push("");
    for (const note of notes) L.push(`- ${note}`);
    L.push("");
  }

  L.push("## Headline");
  L.push("");
  L.push("| Metric | Value |");
  L.push("|---|---|");
  L.push(`| Closed positions | ${r.closedPositions} |`);
  L.push(`| Still open | ${r.openPositions} |`);
  L.push(`| Win rate | ${n(r.winRatePercent, 1, "%")} |`);
  L.push(`| Average win | ${n(r.averageWinPercent, 1, "%")} |`);
  L.push(`| Average loss | ${n(r.averageLossPercent, 1, "%")} |`);
  L.push(`| **Expectancy per trade** | **${n(r.expectancyPercent, 2, "%")}** |`);
  L.push(`| Total P&L | ${r.totalPnlSol.toFixed(6)} SOL |`);
  L.push(`| Max drawdown | ${r.maxDrawdownSol.toFixed(6)} SOL (${n(r.maxDrawdownPercent, 1, "%")} of peak) |`);
  L.push(`| Median time in position | ${n(r.medianHoldingHours, 2, "h")} |`);
  L.push(`| Max time in position | ${n(r.maxHoldingHours, 2, "h")} |`);
  L.push("");
  L.push(
    "Expectancy = win_rate x avg_win% - loss_rate x avg_loss%, in percentage points " +
      "per trade. Positive means the strategy makes money on average; it is the single " +
      "number that matters most, and a high win rate with negative expectancy is a losing strategy.",
  );
  L.push("");

  L.push("## Win / loss breakdown");
  L.push("");
  L.push("| | Count | % of closed |");
  L.push("|---|---|---|");
  const pct = (c: number) => (r.closedPositions > 0 ? ((c / r.closedPositions) * 100).toFixed(1) + "%" : "n/a");
  L.push(`| Wins | ${r.wins} | ${pct(r.wins)} |`);
  L.push(`| Losses | ${r.losses} | ${pct(r.losses)} |`);
  L.push(`| Break-even | ${r.breakEven} | ${pct(r.breakEven)} |`);
  L.push("");

  L.push("## Exit-ladder tier hit rate");
  L.push("");
  L.push("How often each take-profit tier fired, as a share of closed positions.");
  L.push("");
  L.push("| Tier | Positions hit | % of closed |");
  L.push("|---|---|---|");
  for (const t of r.ladderTiers) {
    L.push(`| ${t.tier}x | ${t.positionsHit} | ${t.percentOfClosed.toFixed(1)}% |`);
  }
  L.push("");

  L.push("## How positions were closed");
  L.push("");
  L.push("| Exit kind | Positions | % of closed |");
  L.push("|---|---|---|");
  for (const kind of Object.keys(r.exitKindCounts) as Array<keyof typeof r.exitKindCounts>) {
    L.push(`| ${kind} | ${r.exitKindCounts[kind]} | ${r.exitKindPercentOfClosed[kind].toFixed(1)}% |`);
  }
  L.push("");
  if (r.exitKindCounts["unclassified"] > 0) {
    L.push(
      `> **${r.exitKindCounts["unclassified"]} exit(s) could not be classified.** Their ` +
        "`reason` text did not match any pattern the exit logic writes. Worth reading " +
        "the raw log lines - either a new exit path exists, or the wording changed.",
    );
    L.push("");
  }

  L.push("## Funding-rate arbitrage");
  L.push("");
  if (!funding || funding.closes === 0) {
    L.push("No closed perp positions found in `" + args.perpsPath + "` - nothing to measure yet.");
    L.push("");
  } else {
    L.push("| Metric | Value |");
    L.push("|---|---|");
    L.push(`| Closed perp positions | ${funding.closes} |`);
    L.push(`| ...with a realized figure | ${funding.closesWithRealized} |`);
    L.push(`| Theoretical funding (gross) | ${funding.totalTheoreticalUsd === null ? "unknown" : "$" + funding.totalTheoreticalUsd.toFixed(4)} |`);
    L.push(`| Realized fees + funding (net) | ${funding.totalRealizedUsd === null ? "unknown" : "$" + funding.totalRealizedUsd.toFixed(4)} |`);
    L.push(`| **Capture rate** | **${n(funding.overallCaptureRatePercent, 1, "%")}** |`);
    L.push("");
    L.push(
      "Capture rate is realized / theoretical. The realized figure comes from Drift's " +
        "`calculateFeesAndFundingPnl()` and is **net of trading fees**, while the theoretical " +
        "figure is **gross** funding implied by the observed rates. A rate below 100% is " +
        "usually fees eating the carry - which is exactly what `estimatedRoundTripCostBps` " +
        "exists to guard against - not a measurement error.",
    );
    L.push("");
    L.push("| Market | Closed | Hours | Settlements | Theoretical | Realized | Capture |");
    L.push("|---|---|---|---|---|---|---|");
    for (const c of funding.perClose) {
      L.push(
        `| ${c.market} | ${c.closedAt ?? "?"} | ${c.holdingHours.toFixed(1)} | ${c.settlementsInWindow} | ` +
          `${c.theoreticalUsd === null ? "unknown" : "$" + c.theoreticalUsd.toFixed(4)} | ` +
          `${c.realizedUsd === null ? "unknown" : "$" + c.realizedUsd.toFixed(4)} | ` +
          `${n(c.captureRatePercent, 1, "%")} |`,
      );
    }
    L.push("");
    const unexplained = funding.perClose.filter((c) => c.unavailableReason !== null);
    if (unexplained.length > 0) {
      L.push("Why some rows show `unknown`:");
      L.push("");
      for (const c of unexplained) L.push(`- **${c.market}** (${c.closedAt ?? "?"}): ${c.unavailableReason}`);
      L.push("");
    }
  }

  L.push("## Filter decisions");
  L.push("");
  L.push("| Metric | Value |");
  L.push("|---|---|");
  L.push(`| Decisions logged | ${r.decisionsTotal} |`);
  L.push(`| PASS | ${r.decisionsPassed} |`);
  L.push(`| SKIP | ${r.decisionsSkipped} |`);
  L.push("");
  if (r.topSkipReasons.length > 0) {
    L.push("### Top SKIP reasons");
    L.push("");
    L.push("The rule rejecting the most tokens is the first place to look when tuning.");
    L.push("");
    L.push("| Reason | Count |");
    L.push("|---|---|");
    for (const s of r.topSkipReasons.slice(0, 20)) L.push(`| ${s.reason} | ${s.count} |`);
    L.push("");
  }

  L.push("## Operational events");
  L.push("");
  L.push("| Event | Count |");
  L.push("|---|---|");
  L.push(`| Rejected buys | ${r.rejectedBuys} |`);
  L.push(`| Failed executions | ${r.failedExecutions} |`);
  L.push(`| Abandoned positions | ${r.abandoned} |`);
  L.push(`| Reconciliation mismatches | ${r.reconciliationMismatches} |`);
  L.push(`| Records skipped (wrong paper/real flag) | ${r.skippedNonPaperRecords} |`);
  L.push("");
  if (r.abandoned > 0) {
    L.push(`> **${r.abandoned} abandoned position(s)** hit the consecutive-sell-failure limit and need manual review.`);
    L.push("");
  }

  return L.join("\n") + "\n";
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const trades = readJsonl<TradeRecord>(args.tradesPath);
  const decisions = readJsonl<DecisionRecord>(args.decisionsPath);

  const notes: string[] = [];
  if (trades.missing) notes.push(`Trade log \`${args.tradesPath}\` does not exist - no trades to analyse. This is expected before the first run.`);
  else if (trades.records.length === 0) notes.push(`Trade log \`${args.tradesPath}\` exists but is empty.`);
  if (decisions.missing) notes.push(`Decision log \`${args.decisionsPath}\` does not exist.`);
  else if (decisions.records.length === 0) notes.push(`Decision log \`${args.decisionsPath}\` exists but is empty.`);
  if (trades.badLines > 0) notes.push(`${trades.badLines} unparseable line(s) in the trade log were skipped.`);
  if (decisions.badLines > 0) notes.push(`${decisions.badLines} unparseable line(s) in the decision log were skipped.`);

  // Perps / funding-arb side. Independent of the spot logs above: a run may have
  // one, both, or neither.
  const perps = readJsonl<PerpsCloseRecord>(args.perpsPath);
  if (perps.badLines > 0) notes.push(`${perps.badLines} unparseable line(s) in the perps log were skipped.`);
  const marketsInLog = [...new Set(perps.records.map((r) => r.market).filter((m): m is string => !!m))];
  const explicitMap = process.argv.includes("--funding-market-map")
    ? process.argv[process.argv.indexOf("--funding-market-map") + 1]
    : undefined;
  const { samples, note: fundingNote } = loadFundingSamples(args.fundingHistoryPath, marketsInLog, explicitMap);
  if (fundingNote) notes.push(fundingNote);
  const funding = perps.missing ? null : summarizeFundingCapture(perps.records, samples);

  const report = analyze(trades.records, decisions.records, DEFAULT_LADDER_TIERS, args.paperOnly);
  const markdown = buildMarkdown(report, args, notes, funding);

  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  fs.writeFileSync(args.outPath, markdown);

  // Console summary - the same headline numbers, so you don't have to open the file.
  console.log(`=== ${args.paperOnly ? "Paper" : "Real"}-trading performance ===`);
  for (const note of notes) console.log(`  note: ${note}`);
  console.log(`  Closed positions:  ${report.closedPositions} (${report.openPositions} still open)`);
  console.log(`  Win rate:          ${n(report.winRatePercent, 1, "%")}  (${report.wins}W / ${report.losses}L)`);
  console.log(`  Average win:       ${n(report.averageWinPercent, 1, "%")}`);
  console.log(`  Average loss:      ${n(report.averageLossPercent, 1, "%")}`);
  console.log(`  Expectancy/trade:  ${n(report.expectancyPercent, 2, "%")}`);
  console.log(`  Total P&L:         ${report.totalPnlSol.toFixed(6)} SOL`);
  console.log(`  Max drawdown:      ${report.maxDrawdownSol.toFixed(6)} SOL (${n(report.maxDrawdownPercent, 1, "%")} of peak)`);
  console.log(`  Time in position:  median ${n(report.medianHoldingHours, 2, "h")}, max ${n(report.maxHoldingHours, 2, "h")}`);
  for (const t of report.ladderTiers) {
    console.log(`  ${`Ladder ${t.tier}x hit:`.padEnd(18)} ${t.positionsHit} (${t.percentOfClosed.toFixed(1)}% of closed)`);
  }
  console.log(`  Decisions:         ${report.decisionsPassed} PASS / ${report.decisionsSkipped} SKIP`);
  if (funding && funding.closes > 0) {
    console.log(`  Perp closes:       ${funding.closes} (${funding.closesWithRealized} with a realized figure)`);
    console.log(`  Funding capture:   ${n(funding.overallCaptureRatePercent, 1, "%")} (realized net of fees / theoretical gross)`);
  }
  console.log(`\n  Report written to: ${args.outPath}`);
}

main();
