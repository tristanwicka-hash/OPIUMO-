/**
 * Delay-probe report - answers the top open question in the roadmap: how
 * long after detection should the bot wait before evaluating a token?
 *
 *   npm run report:delay-probe
 *   npm run report:delay-probe -- --file logs/delay-probe.jsonl
 *   npm run report:delay-probe -- --out reports/my-delay-report.md
 *   npm run report:delay-probe -- --min-wallets 20 --min-txs 30 --max-top-holder 20
 *
 * Note the space after `--` when passing flags through npm.
 *
 * Deliberately does NOT call loadConfig(): this reads a local log file only,
 * and needing an RPC endpoint configured just to read a jsonl file would be
 * absurd (the same reasoning as analyze-paper-performance.ts). No network
 * calls of any kind.
 */
import fs from "fs";
import path from "path";
import {
  analyzeDelayProbe,
  DelayProbeRecord,
  DelayProbeReport,
  DelayBucketReport,
  MetricStats,
  DEFAULT_THRESHOLDS,
} from "../src/analysis/delayProbeAnalysis";

interface Args {
  filePath: string;
  outPath: string;
  minWallets: number;
  minTxs: number;
  maxTopHolder: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number): number => {
    const v = get(flag);
    if (v === undefined) return fallback;
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    filePath: get("--file") ?? "logs/delay-probe.jsonl",
    outPath: get("--out") ?? path.join("reports", `delay-probe-${stamp}.md`),
    minWallets: num("--min-wallets", DEFAULT_THRESHOLDS.minUniqueWallets),
    minTxs: num("--min-txs", DEFAULT_THRESHOLDS.minTransactionCount),
    maxTopHolder: num("--max-top-holder", DEFAULT_THRESHOLDS.maxTopHolderPercent),
  };
}

/** Same three-way split as analyze-paper-performance.ts's readJsonl: missing
 * file, empty file, and unparseable lines all mean something different when
 * deciding whether to trust the report that follows. */
function readJsonl(filePath: string): { records: DelayProbeRecord[]; missing: boolean; badLines: number } {
  if (!fs.existsSync(filePath)) return { records: [], missing: true, badLines: 0 };
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const records: DelayProbeRecord[] = [];
  let badLines = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as DelayProbeRecord);
    } catch {
      badLines++;
    }
  }
  return { records, missing: false, badLines };
}

const n = (v: number | null, digits = 1, suffix = ""): string => (v === null ? "n/a" : `${v.toFixed(digits)}${suffix}`);

function metricRow(label: string, s: MetricStats, suffix = ""): string {
  return `| ${label} | ${s.sampleSize} | ${s.nullCount} | ${n(s.min, 1, suffix)} | ${n(s.median, 1, suffix)} | ${n(
    s.p90,
    1,
    suffix,
  )} | ${n(s.max, 1, suffix)} |`;
}

function bucketSection(b: DelayBucketReport): string[] {
  const L: string[] = [];
  L.push(`### ${b.delaySeconds}s after detection`);
  L.push("");
  L.push(`Scheduled ${b.scheduled} -> ${b.ok} completed, ${b.errored} errored, ${b.dropped} dropped (queue full).`);
  L.push("");
  L.push(
    `**Would-pass rate at current thresholds: ${n(b.passRate.passRatePercent, 1, "%")}** ` +
      `(${b.passRate.passed}/${b.passRate.evaluable} evaluable observations - the rest were missing at least one of the three filtered metrics).`,
  );
  L.push("");
  L.push("| Metric | n | null | min | median | p90 | max |");
  L.push("|---|---|---|---|---|---|---|");
  L.push(metricRow("Unique wallets", b.uniqueWallets));
  L.push(metricRow("Transaction count", b.transactionCount));
  L.push(metricRow("Top holder %", b.topHolderPercent, "%"));
  L.push(metricRow("Liquidity (SOL)", b.liquiditySol));
  L.push("");
  return L;
}

function buildMarkdown(r: DelayProbeReport, args: Args, missing: boolean, badLines: number): string[] {
  const L: string[] = [];
  L.push("# Delay-probe report");
  L.push("");
  L.push(`Generated: ${new Date().toISOString()}`);
  L.push(`Source:    \`${args.filePath}\``);
  L.push(
    `Thresholds evaluated: minUniqueWallets=${r.thresholds.minUniqueWallets}, ` +
      `minTransactionCount=${r.thresholds.minTransactionCount}, maxTopHolderPercent=${r.thresholds.maxTopHolderPercent}`,
  );
  L.push("");

  if (missing) {
    L.push(
      `> \`${args.filePath}\` does not exist yet. The delay probe writes here once the bot runs live ` +
        "with `delayProbe.enabled: true` (the shipped default) - nothing to analyze until then.",
    );
    return L;
  }

  if (r.totalRecords === 0) {
    L.push(`> \`${args.filePath}\` exists but is empty - no observations recorded yet.`);
    return L;
  }

  L.push("## Coverage");
  L.push("");
  L.push(`- ${r.totalRecords} lines read (${r.coverageLines} coverage lines, ${r.buckets.reduce((s, b) => s + b.scheduled, 0)} observations)`);
  L.push(`- ${r.distinctMints} distinct mints observed`);
  if (badLines > 0) L.push(`- **${badLines} line(s) could not be parsed as JSON and were skipped.**`);
  if (r.malformedRecords > 0) L.push(`- **${r.malformedRecords} record(s) had no usable delaySeconds and were excluded.**`);
  L.push("");

  if (r.buckets.length === 0) {
    L.push("No observations at any delay yet - only coverage lines (or nothing) in the file.");
    return L;
  }

  L.push("## Pass rate by delay");
  L.push("");
  L.push("The number that actually answers the question: how much older does a token need to be");
  L.push("before the filters are even evaluable, and how many pass once they are.");
  L.push("");
  L.push("| Delay | Would-pass rate | Evaluable / OK / scheduled |");
  L.push("|---|---|---|");
  for (const b of r.buckets) {
    L.push(
      `| ${b.delaySeconds}s | ${n(b.passRate.passRatePercent, 1, "%")} | ${b.passRate.evaluable} / ${b.ok} / ${b.scheduled} |`,
    );
  }
  L.push("");

  L.push("## Detail by delay");
  L.push("");
  for (const b of r.buckets) L.push(...bucketSection(b));

  L.push(
    "> Picking a delay: look for where the pass rate stops climbing and the metric medians stop moving " +
      "much between buckets - that's the point where waiting longer buys accuracy that isn't there yet, " +
      "not the point where waiting less makes the filters stop being self-contradictory. Also weigh entry " +
      "price against it: every extra second is more of the move already gone (see Strategy-and-Roadmap.md).",
  );
  L.push("");

  return L;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { records, missing, badLines } = readJsonl(args.filePath);
  const report = analyzeDelayProbe(records, {
    minUniqueWallets: args.minWallets,
    minTransactionCount: args.minTxs,
    maxTopHolderPercent: args.maxTopHolder,
  });

  const lines = buildMarkdown(report, args, missing, badLines);
  const markdown = lines.join("\n") + "\n";

  console.log(markdown);

  if (!missing) {
    fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
    fs.writeFileSync(args.outPath, markdown);
    console.log(`\nWritten to ${args.outPath}`);
  }
}

main();
