/**
 * Replays recorded decisions through the current filter code.
 *
 *   npm run replay
 *   npm run replay -- --set minTransactionCount=15 --set minUniqueWallets=10
 *   npm run replay -- --sweep minTransactionCount=5,10,15,20,30
 *
 * Read-only and offline: it reads logs/ and prints. It changes no config, and
 * `--set` applies to the replay only - nothing is written back.
 */
import { loadConfig, FiltersConfig } from "../src/config";
import {
  decisionLogFiles,
  loadRecords,
  replayAll,
  ReplaySummary,
  DEFAULT_DECISIONS_FILE,
} from "../src/replay/replay";

function parseArgs(argv: string[]) {
  const sets: [string, number][] = [];
  let sweep: { key: string; values: number[] } | null = null;
  let file = DEFAULT_DECISIONS_FILE;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--set") {
      const [k, v] = String(argv[++i] ?? "").split("=");
      const n = Number(v);
      if (!k || !Number.isFinite(n)) throw new Error(`--set needs key=number, got ${JSON.stringify(argv[i])}`);
      sets.push([k, n]);
    } else if (a === "--sweep") {
      const [k, list] = String(argv[++i] ?? "").split("=");
      const values = String(list ?? "").split(",").map(Number);
      if (!k || values.length === 0 || values.some((n) => !Number.isFinite(n))) {
        throw new Error(`--sweep needs key=n1,n2,n3, got ${JSON.stringify(argv[i])}`);
      }
      sweep = { key: k, values };
    } else if (a === "--file") {
      file = String(argv[++i] ?? DEFAULT_DECISIONS_FILE);
    }
  }
  return { sets, sweep, file };
}

function applyOverrides(filters: FiltersConfig, sets: [string, number][]): FiltersConfig {
  const out: any = { ...filters };
  for (const [k, v] of sets) {
    if (!(k in out)) {
      throw new Error(
        `filters.${k} does not exist. Known keys: ${Object.keys(filters).filter((x) => !x.startsWith("_")).join(", ")}`
      );
    }
    out[k] = v;
  }
  return out as FiltersConfig;
}

function pct(n: number, of: number): string {
  return of === 0 ? "n/a" : `${((n / of) * 100).toFixed(2)}%`;
}

function printSummary(s: ReplaySummary, label: string): void {
  const replayable = s.total - s.unreplayable;
  console.log(`\n${"=".repeat(72)}`);
  console.log(label);
  console.log("=".repeat(72));
  console.log(`  records            ${s.total.toLocaleString()}`);
  console.log(`  replayable         ${replayable.toLocaleString()}`);
  console.log(
    `  UNREPLAYABLE       ${s.unreplayable.toLocaleString()}` +
      (s.unreplayable > 0 ? "  <- neither passed nor failed; the record lacks a metric the current code reads" : "")
  );
  if (s.unreplayable > 0) {
    for (const [field, n] of Object.entries(s.missingFieldCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`      missing ${field}: ${n.toLocaleString()}`);
    }
  }
  console.log(`  unchanged          ${s.unchanged.toLocaleString()}`);
  console.log(`  CHANGED to PASS    ${s.nowPasses.toLocaleString()}`);
  console.log(`  CHANGED to SKIP    ${s.nowSkips.toLocaleString()}`);
  console.log(`  same verdict, different reasons  ${s.sameVerdictNewReasons.toLocaleString()}`);
  console.log(`\n  would PASS under this config: ${s.passingAfter.toLocaleString()} of ${replayable.toLocaleString()} (${pct(s.passingAfter, replayable)})`);

  console.log(`\n  what is actually blocking them (by rule, replayable records only):`);
  const rows = Object.entries(s.reasonCounts).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    console.log("    (nothing - every replayable record passes)");
  }
  for (const [rule, n] of rows) {
    console.log(`    ${String(n).padStart(7)} (${pct(n, replayable).padStart(7)})  ${rule}`);
  }

  if (s.changed.length > 0) {
    console.log(`\n  first ${s.changed.length} changed verdict(s):`);
    for (const c of s.changed) {
      console.log(`    ${c.ts}  ${c.mint}  ${c.before} -> ${c.after}`);
      if (c.afterReasons.length > 0) console.log(`      now: ${c.afterReasons.join("; ")}`);
    }
  }
}

function main() {
  const { sets, sweep, file } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  const files = decisionLogFiles(file);
  const loaded = loadRecords(files);

  console.log(`Read ${loaded.filesRead.length} decision log file(s):`);
  for (const f of loaded.filesRead) console.log(`  ${f}`);
  console.log(
    `  ${loaded.records.length.toLocaleString()} decision record(s), ` +
      `${loaded.nonDecisionRecords.toLocaleString()} non-decision row(s) (queue-stats/dropped/outside-schedule), ` +
      `${loaded.unparseableLines.toLocaleString()} unparseable line(s)`
  );
  if (loaded.records.length === 0) {
    console.log("\nNothing to replay.");
    return;
  }

  if (sweep) {
    console.log(`\nSweeping filters.${sweep.key} over ${sweep.values.join(", ")}`);
    console.log(`(every other threshold stays at its configured value)\n`);
    const base = applyOverrides(config.filters, sets);
    console.log(`  ${sweep.key.padEnd(24)} would pass    of replayable`);
    for (const v of sweep.values) {
      const s = replayAll(loaded.records, applyOverrides(base, [[sweep.key, v]]), { maxChangedExamples: 0 });
      const replayable = s.total - s.unreplayable;
      console.log(
        `  ${String(v).padEnd(24)} ${String(s.passingAfter).padStart(10)}    ${pct(s.passingAfter, replayable)}`
      );
    }
    console.log(
      `\nThis is what those thresholds WOULD have done against recorded data. It is not a\n` +
        `prediction, and a threshold that passes more tokens is not automatically better.`
    );
    return;
  }

  const filters = applyOverrides(config.filters, sets);
  const label =
    sets.length === 0
      ? "REPLAY: recorded decisions through the CURRENT config"
      : `REPLAY with overrides: ${sets.map(([k, v]) => `${k}=${v}`).join(", ")}`;
  printSummary(replayAll(loaded.records, filters), label);
}

main();
