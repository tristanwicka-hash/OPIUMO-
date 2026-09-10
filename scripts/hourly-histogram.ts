/**
 * npm run histogram
 *
 * Prints detections per hour of day (UTC) from OPIUMO's own decision logs.
 * Read-only: it opens log files and writes nothing. Safe to run while the bot
 * is running.
 *
 * This is the measurement that should decide the schedule window. The
 * trading-hours research found no credible published hourly distribution for
 * Solana memecoins - the one source with specific hours derives them from 200
 * personal trades. Those are hypotheses. This is what actually happened here.
 *
 * Options:
 *   --gap-minutes N   Gap treated as the bot being down (default 10)
 *   --min-hours N     Observation needed before an hour is ranked (default 1)
 *   --file PATH       Read one specific log instead of logs/decisions*.jsonl
 *   --json            Emit the raw histogram as JSON
 */
import fs from "fs";
import path from "path";
import {
  DecisionRecord,
  buildHistogram,
  formatHistogram,
  DEFAULT_GAP_MINUTES,
} from "../src/analysis/hourlyHistogram";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Every decisions log, ROTATED ONES INCLUDED.
 *
 * The rotated files are not history to be ignored - at the time of writing they
 * held 15,076 of the 17,186 records. Reading only logs/decisions.jsonl would
 * have measured the most recent few hours and called it the distribution.
 */
function decisionLogFiles(): string[] {
  const explicit = arg("file");
  if (explicit) return [explicit];

  const dir = path.resolve(process.cwd(), "logs");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("decisions") && f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f))
    .sort();
}

function readRecords(files: string[]): { records: DecisionRecord[]; malformed: number } {
  const records: DecisionRecord[] = [];
  let malformed = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as DecisionRecord);
      } catch {
        // A JSONL file being appended to by a live process can end mid-line.
        // Counted and reported, never silently dropped.
        malformed++;
      }
    }
  }
  return { records, malformed };
}

function main(): void {
  const gapMinutes = Number(arg("gap-minutes") ?? DEFAULT_GAP_MINUTES);
  const minHours = Number(arg("min-hours") ?? 1);

  const files = decisionLogFiles();
  if (files.length === 0) {
    console.error("No decision logs found in logs/. Nothing to measure.");
    process.exit(1);
  }

  const { records, malformed } = readRecords(files);
  const histogram = buildHistogram(records, { gapMinutes });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(histogram, null, 2));
    return;
  }

  console.log(`Read ${records.length} records from ${files.length} file(s):`);
  for (const f of files) console.log(`  ${path.relative(process.cwd(), f)}`);
  if (malformed > 0) console.log(`  (${malformed} unparseable line(s) skipped - a live file can end mid-write)`);
  console.log("");
  console.log(formatHistogram(histogram, minHours));

  console.log("");
  console.log("Read this before turning the scheduler on:");
  console.log(
    `  - ${histogram.daysSpanned} days of data. A single unusual day moves an hourly bucket a long way ` +
      `when there are only a few days in it.`
  );
  console.log(
    "  - This measures WHEN CANDIDATES APPEAR, which sets credit burn. It does NOT measure when the good"
  );
  console.log(
    "    ones appear - only the outcome tracker can answer that, and it needs more data. Cutting hours on"
  );
  console.log("    this table is a defensible cost decision, not a strategy improvement.");
  console.log(
    `  - Hours marked "never seen" were not quiet, they were never observed. Do not schedule around them.`
  );
}

main();
