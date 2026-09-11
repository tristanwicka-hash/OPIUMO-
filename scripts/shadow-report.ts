/**
 * npm run report:shadow
 *
 * Is the pass rate limited by the thresholds or by the data? Read-only, offline.
 */
import { loadConfig } from "../src/config";
import { loadShadowRecords, summarise } from "../src/analysis/shadowReport";

function pct(n: number, of: number): string {
  return of === 0 ? "n/a" : `${((n / of) * 100).toFixed(2)}%`;
}

function main(): void {
  const config = loadConfig();
  const file = config.shadowFilters.logFile;
  const { records, unparseable } = loadShadowRecords(file);
  const s = summarise(records, unparseable);

  console.log(`Shadow filter comparison — ${file}`);
  console.log(`  ${s.records.toLocaleString()} evaluation(s), ${s.unparseable.toLocaleString()} unparseable line(s)`);
  console.log(`  live decisions: ${JSON.stringify(s.liveDecisions)}`);
  if (s.records === 0) {
    console.log("\nNothing to report.");
    return;
  }

  console.log(`\n${"set".padEnd(22)} ${"passed".padStart(8)} ${"of".padStart(8)}  pass rate`);
  for (const set of s.sets) {
    console.log(
      `  ${set.setId.padEnd(20)} ${String(set.passed).padStart(8)} ${String(set.evaluated).padStart(8)}  ${pct(set.passed, set.evaluated)}`
    );
  }

  // The separation that matters.
  console.log(`\n${"=".repeat(74)}`);
  console.log("  THRESHOLDS, OR DATA?");
  console.log("=".repeat(74));
  if (s.setsAgreeOnUnchecked) {
    console.log(
      "  Every set reported the SAME unchecked fields on every record, which is what should\n" +
        "  happen: whether a metric was fetched does not depend on the threshold it would be\n" +
        "  compared against. So \"complete data\" is a property of the token, not of the set."
    );
  } else {
    console.log(
      "  *** SETS DISAGREE ON UNCHECKED FIELDS *** a shadow set appears to be fetching\n" +
        "  something of its own, which breaks the zero-RPC-cost guarantee. Investigate before\n" +
        "  trusting anything below."
    );
  }
  console.log(
    `\n  Tokens with NOTHING unchecked: ` +
      `${s.completeDataTokens.toLocaleString()} of ${s.records.toLocaleString()} (${pct(s.completeDataTokens, s.records)})`
  );
  if (s.completeDataTokens === 0) {
    console.log("  No token in this log had complete data, so no threshold question can be answered from it.");
  } else {
    console.log(`\n  Among ONLY those complete-data tokens:`);
    for (const set of s.sets) {
      console.log(
        `    ${set.setId.padEnd(20)} ${String(set.passedWithCompleteData).padStart(6)} / ${s.completeDataTokens}  (${pct(set.passedWithCompleteData, s.completeDataTokens)})`
      );
    }
    console.log(
      `\n  Read it this way: the left-hand pass rates are dominated by tokens whose metrics were\n` +
        `  never fetched, and the engine fails closed on unknown no matter what a threshold says.\n` +
        `  The complete-data rates above are the only ones that answer a question about thresholds.`
    );
  }

  for (const set of s.sets) {
    console.log(`\n--- ${set.setId}: what blocked it (by rule) ---`);
    const rows = Object.entries(set.blockers).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (rows.length === 0) console.log("    (nothing)");
    for (const [rule, n] of rows) {
      console.log(`    ${String(n).padStart(7)} (${pct(n, set.evaluated).padStart(7)})  ${rule}`);
    }
  }

  console.log(
    `\nShadow sets cost ZERO extra RPC calls by construction: each is a second synchronous\n` +
      `call to evaluateFilters on the SAME already-fetched metrics. A field the live path did\n` +
      `not fetch stays null and is recorded as unchecked - it is never fetched to fill the gap.`
  );
}

main();
