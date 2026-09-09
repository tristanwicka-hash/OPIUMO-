/**
 * Reads logs/outcomes.jsonl + logs/decisions.jsonl and answers the question
 * the filters cannot answer about themselves: of the tokens we rejected, how
 * many were worth buying?
 *
 * Offline. Reads log files, prints a report, writes nothing but the report.
 *
 *   npm run report:outcomes
 *   npm run report:outcomes -- --min-sol 5 --min-multiple 3
 */

import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../src/config";
import { OutcomeRecord } from "../src/data/outcomeTracker";
import {
  DecisionLike,
  ThresholdSet,
  analyzeSkippedWinners,
  evaluateThresholds,
  sampleAdequacyWarning,
  summarizeOutcomes,
} from "../src/analysis/outcomeAnalysis";

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // A truncated final line is normal for a log being appended to live.
    }
  }
  return out;
}

function parseArgs(argv: string[]) {
  let minSol = 5;
  let minMultiple = 3;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--min-sol" && argv[i + 1]) minSol = Number(argv[++i]);
    if (argv[i] === "--min-multiple" && argv[i + 1]) minMultiple = Number(argv[++i]);
  }
  if (!Number.isFinite(minSol) || minSol <= 0) throw new Error("--min-sol must be a positive number");
  if (!Number.isFinite(minMultiple) || minMultiple <= 1) throw new Error("--min-multiple must be > 1");
  return { minSol, minMultiple };
}

function pct(x: number | null): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

function main() {
  const { minSol, minMultiple } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  const outcomeRecords = readJsonl<OutcomeRecord>(config.logging.outcomeFile);
  const decisions = readJsonl<DecisionLike>(config.logging.decisionsFile);

  if (outcomeRecords.length === 0) {
    console.log(
      `\nNo outcome records in ${config.logging.outcomeFile}.\n\n` +
        `The outcome tracker records what each token BECAME, at ${config.outcomeTracker.checkpointsSeconds
          .map((s) => `${s}s`)
          .join(", ")} after detection.\n` +
        `The first checkpoint therefore lands ${Math.round(
          Math.min(...config.outcomeTracker.checkpointsSeconds) / 60
        )} minutes after the bot starts seeing tokens - so an empty log right after a restart is expected, not a fault.\n`
    );
    return;
  }

  const winner = { minAbsoluteLiquiditySol: minSol, minLiquidityMultiple: minMultiple };
  const outcomes = summarizeOutcomes(outcomeRecords, winner);
  const report = analyzeSkippedWinners(decisions, outcomes, winner);

  console.log(`\n=== Outcome report ===\n`);
  console.log(`Outcome records:      ${outcomeRecords.length} across ${outcomes.size} tokens`);
  console.log(`Decisions:            ${decisions.length}`);
  console.log(`Joined + evaluable:   ${report.evaluableTokens}   (unevaluable: ${report.unevaluableTokens})`);
  console.log(
    `\nWinner defined as: peak liquidity >= ${minSol} SOL AND >= ${minMultiple}x its liquidity at detection.`
  );
  console.log(
    `  (Both conditions on purpose - a 3x on 0.002 SOL is noise, and a token already at 25 SOL that`
  );
  console.log(`   crawls to 32 SOL is not a move anyone could have traded.)\n`);

  console.log(`Passed the filters:   ${report.passed}`);
  console.log(`Skipped:              ${report.skipped}`);
  console.log(`Winners in sample:    ${report.winners}`);
  console.log(`  caught (passed):    ${report.passedWinners}`);
  console.log(`  MISSED (skipped):   ${report.skippedWinners}`);
  console.log(`\nSkipped-winner rate:  ${pct(report.skippedWinnerRate)}  (of everything rejected, this share ran)`);
  console.log(`Miss rate:            ${pct(report.missRate)}  (of all winners, this share was rejected)`);

  const warning = sampleAdequacyWarning(report.evaluableTokens, report.winners);
  if (warning) console.log(`\n!! ${warning}`);

  if (report.missedWinners.length > 0) {
    console.log(`\nRejected winners, biggest first:`);
    for (const w of report.missedWinners.slice(0, 15)) {
      console.log(
        `  ${w.mint.slice(0, 14)}...  ${(w.baselineLiquiditySol ?? 0).toFixed(3)} -> ` +
          `${(w.peakLiquiditySol ?? 0).toFixed(3)} SOL   ${(w.peakMultiple ?? 0).toFixed(2)}x`
      );
    }
  }

  // Candidate threshold sets, replayed against real outcomes. The current
  // production values are first so every alternative is read against them.
  const f = config.filters;
  const sets: ThresholdSet[] = [
    {
      label: "current (production)",
      minUniqueWallets: f.minUniqueWallets,
      minTransactionCount: f.minTransactionCount,
      maxTopHolderPercent: f.maxTopHolderPercent,
      minLiquiditySol: f.minLiquiditySol,
    },
    { label: "wallets/txs 10/15", minUniqueWallets: 10, minTransactionCount: 15, maxTopHolderPercent: f.maxTopHolderPercent, minLiquiditySol: f.minLiquiditySol },
    { label: "wallets/txs 5/10", minUniqueWallets: 5, minTransactionCount: 10, maxTopHolderPercent: f.maxTopHolderPercent, minLiquiditySol: f.minLiquiditySol },
    { label: "wallets/txs 3/5", minUniqueWallets: 3, minTransactionCount: 5, maxTopHolderPercent: f.maxTopHolderPercent, minLiquiditySol: f.minLiquiditySol },
    { label: "liquidity+concentration only", minUniqueWallets: 0, minTransactionCount: 0, maxTopHolderPercent: f.maxTopHolderPercent, minLiquiditySol: f.minLiquiditySol },
    { label: "liq >= 1 SOL, concentration only", minUniqueWallets: 0, minTransactionCount: 0, maxTopHolderPercent: f.maxTopHolderPercent, minLiquiditySol: 1 },
  ];

  const counterfactuals = evaluateThresholds(decisions, outcomes, sets);
  console.log(`\n=== Threshold counterfactuals ===\n`);
  console.log(`| threshold set | would pass | winners caught | losers in | precision | recall |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const c of counterfactuals) {
    console.log(
      `| ${c.set.label} | ${c.wouldPass} | ${c.winnersCaught} | ${c.losersAdmitted} | ${pct(c.precision)} | ${pct(c.recall)} |`
    );
  }
  const notEvaluable = counterfactuals[0]?.notEvaluable ?? 0;
  if (notEvaluable > 0) {
    console.log(
      `\n${notEvaluable} token(s) had incomplete decision-time metrics and could not be replayed against any set.`
    );
    console.log(`They are excluded rather than assumed to pass - the live engine fails closed, and so does this.`);
  }

  console.log(
    `\nThis is a counterfactual on a fixed sample, not a backtest. It says which tokens a rule would have`
  );
  console.log(
    `admitted - not the price obtainable, the slippage paid, or whether the position could have been exited.`
  );
  console.log(`All three make the real result worse than this table, never better.\n`);

  const outDir = "reports";
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `outcomes-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ report, counterfactuals }, null, 2));
  console.log(`Full report written to ${outPath}\n`);
}

main();
