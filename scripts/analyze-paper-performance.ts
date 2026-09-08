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

/** Ladder tiers as shipped in config/default.json. Passed in rather than read, to keep the analyzer pure and this script config-free. */
const DEFAULT_LADDER_TIERS = [2, 5, 10];

interface Args {
  tradesPath: string;
  decisionsPath: string;
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

const n = (v: number | null, digits = 2, suffix = ""): string =>
  v === null ? "unknown" : `${v.toFixed(digits)}${suffix}`;

function buildMarkdown(r: PerformanceReport, args: Args, notes: string[]): string {
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
  L.push(
    "**Realized funding capture is not reportable yet.** `PerpsTradeLog.recordClose()` " +
      "records only `pnlUsd`, which blends price movement, fees and funding into one " +
      "number with no way to separate them. Theoretical capture *is* computable from " +
      "`logs/funding-arb-history.json` via `src/analysis/fundingCapture.ts`, but a " +
      "realized-vs-theoretical rate needs one additive field (`fundingCollectedUsd`) on " +
      "the perps close record. See the session log for the recommendation.",
  );
  L.push("");

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

  const report = analyze(trades.records, decisions.records, DEFAULT_LADDER_TIERS, args.paperOnly);
  const markdown = buildMarkdown(report, args, notes);

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
  console.log(`\n  Report written to: ${args.outPath}`);
}

main();
