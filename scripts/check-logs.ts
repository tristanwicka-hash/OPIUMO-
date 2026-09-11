/**
 * npm run check:logs
 *
 * Runs the log-integrity invariants over EVERY production log, including
 * rotated files. Read-only: it reports and, with --plan, describes what a
 * quarantine would move. It never deletes and never writes into a log.
 *
 * Exit 0 when clean, 1 when any invariant is violated - so it can be used as a
 * gate, not just as a report.
 */
import { checkFile, productionLogs, quarantinePlan, FileReport, InvariantId } from "../src/analysis/logIntegrity";

/**
 * Identifiers that only ever appear in tests. Same list the shared test guard
 * uses; if one of these is in a production log, a test wrote there.
 */
const FIXTURE_MARKERS = [
  "Mint111111111111111111111111111111111111111",
  "Pool111111111111111111111111111111111111111",
  "Creator1111111111111111111111111111111111111",
  "FixtureMint",
  "test-fixture",
];

function main(): void {
  const planOnly = process.argv.includes("--plan");
  const files = productionLogs("logs");
  if (files.length === 0) {
    console.log("No production logs found in logs/.");
    return;
  }

  console.log(`Log integrity — ${files.length} production log(s) in logs/ (rotated files included)`);
  console.log("");

  const reports: FileReport[] = [];
  for (const file of files) {
    const r = checkFile(file, { fixtureMarkers: FIXTURE_MARKERS });
    reports.push(r);
    const counts = new Map<InvariantId, number>();
    for (const v of r.violations) counts.set(v.invariant, (counts.get(v.invariant) ?? 0) + 1);
    const summary =
      r.violations.length === 0
        ? "clean"
        : [...counts.entries()].map(([k, n]) => `${k}=${n}`).join("  ");
    // The largest reversal is printed even when it is inside tolerance, so
    // disorder that is growing is visible before it becomes a violation.
    const drift =
      r.reversals > 0
        ? `  [${r.reversals} reversal(s), max ${(r.maxReversalMs / 1000).toFixed(1)}s]`
        : "";
    console.log(
      `  ${r.violations.length === 0 ? "OK  " : "BAD "} ${file.padEnd(50)} ` +
        `${String(r.records).padStart(7)} record(s)  ${summary}${drift}`
    );
  }

  const all = reports.flatMap((r) => r.violations);
  console.log("");
  if (all.length === 0) {
    console.log(`All ${reports.reduce((a, r) => a + r.records, 0).toLocaleString()} records satisfy every invariant.`);
    return;
  }

  console.log(`${"=".repeat(74)}`);
  console.log(`  ${all.length.toLocaleString()} VIOLATION(S)`);
  console.log("=".repeat(74));

  const byInvariant = new Map<InvariantId, typeof all>();
  for (const v of all) {
    const list = byInvariant.get(v.invariant) ?? [];
    list.push(v);
    byInvariant.set(v.invariant, list);
  }
  for (const [invariant, list] of [...byInvariant.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n--- ${invariant}: ${list.length.toLocaleString()} ---`);
    // Examples, not the whole list: a report nobody can read gets ignored.
    for (const v of list.slice(0, 3)) {
      console.log(`    ${v.file}:${v.line ?? "-"}  ${v.detail}`);
      if (v.excerpt) console.log(`      ${v.excerpt}`);
    }
    if (list.length > 3) console.log(`    ... and ${(list.length - 3).toLocaleString()} more`);
  }

  console.log("");
  console.log("QUARANTINE PLAN (nothing has been moved - a bad record is evidence of how it got there):");
  for (const a of quarantinePlan(reports)) {
    console.log(`  ${a.file}  ->  ${a.destination}`);
    console.log(`    ${a.reason}; lines ${a.lines.slice(0, 8).join(", ")}${a.lines.length > 8 ? ", ..." : ""}`);
  }
  if (!planOnly) process.exitCode = 1;
}

main();
