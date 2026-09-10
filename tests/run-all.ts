/**
 * Runs every test suite in one shot: npm test
 *
 * Each suite still exits with its own process code when run individually
 * (npm run test:rpc / test:watcher / test:metrics / test:filters) - this
 * just chains them via child processes so `npm test` gives you one combined
 * result without hunting down each script name.
 *
 * ## PASS / FAIL / SKIP are three outcomes, not two
 *
 * This runner used to have one boolean, `anyFailed`. Two suites (Perps Drift
 * and Funding-arb live) exit early when WALLET_PRIVATE_KEY is unset - they are
 * skipping, not failing - but they exited 1, so the runner counted them as
 * failures and the closing banner explained them away as needing network. It
 * did not. The result was a suite that could not fail: a real regression in
 * either one would have produced byte-identical output to a healthy run.
 *
 * A skip now exits 2 (see tests/exit-codes.ts), is listed by name with its
 * reason, and is NOT counted as a failure. Anything else non-zero is a failure,
 * so an unexpected outcome still defaults to "failed".
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { EXIT_PASS, EXIT_SKIP, SKIP_REPORT_ENV } from "./exit-codes";
import { parseTotals, aggregate, formatSummary, SuiteRecord, SuiteTotals } from "./summary";

/**
 * Runs one suite, streaming its output live AND capturing it.
 *
 * The runner needs the captured text to read each suite's `Total:` line for the
 * final summary, but streaming must not be given up to get it - a live-network
 * suite can sit for a timeout, and a runner that shows nothing while that
 * happens looks hung. So each chunk is written straight through and kept.
 */
function runSuite(
  script: string,
  env: NodeJS.ProcessEnv
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["ts-node", script], {
      stdio: ["inherit", "pipe", "pipe"],
      env,
    });
    let output = "";
    child.stdout.on("data", (c: Buffer) => {
      process.stdout.write(c);
      output += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      process.stderr.write(c);
      output += c.toString();
    });
    child.on("close", (status) => resolve({ status, output }));
  });
}

const suites = [
  { name: "RPC connection (Part 1)", script: "tests/test-rpc-connection.ts", needsNetwork: true },
  { name: "Pool watcher (Part 2)", script: "tests/test-watcher.ts" },
  { name: "Token metrics (Part 3)", script: "tests/test-token-metrics.ts" },
  { name: "Filter engine (Part 4)", script: "tests/test-filters.ts" },
  { name: "Log rotation (util)", script: "tests/test-logger.ts" },
  { name: "Perps risk engine (offline)", script: "tests/test-perps-risk.ts" },
  { name: "Perps Drift connection (live)", script: "tests/test-perps-connection.ts", needsNetwork: true },
  { name: "Funding-arb signals (offline)", script: "tests/test-funding-arb-signals.ts" },
  { name: "Funding-arb live cycle", script: "tests/test-funding-arb-live.ts", needsNetwork: true },
  { name: "Spot sniper sizing/ATR/exit logic (offline)", script: "tests/test-trading-signals.ts" },
  { name: "Spot sniper engine gates (offline)", script: "tests/test-trading-engine-gating.ts" },
  { name: "Spot sniper sell-failure retry/backoff (offline)", script: "tests/test-trading-retry.ts" },
  { name: "Spot sniper position reconciliation (offline)", script: "tests/test-trading-reconciliation.ts" },
  { name: "Spot sniper human-unit conversions (offline)", script: "tests/test-trading-human-units.ts" },
  { name: "Spot sniper Jupiter quote (live)", script: "tests/test-trading-live.ts", needsNetwork: true },
  { name: "Paper trading mode (Part 10, offline)", script: "tests/test-paper-trading.ts" },
  { name: "Paper-trading performance analyzer (offline)", script: "tests/test-paper-performance.ts" },
  { name: "Two-stage metrics + work queue (offline)", script: "tests/test-two-stage-metrics.ts" },
  { name: "Delay-probe scheduling (offline)", script: "tests/test-delay-probe.ts" },
  { name: "Delay-probe report analysis (offline)", script: "tests/test-delay-probe-report.ts" },
  { name: "Swap priority fee (offline)", script: "tests/test-priority-fee.ts" },
  { name: "Outcome analysis (offline)", script: "tests/test-outcome-analysis.ts" },
  { name: "Outcome tracker state (offline)", script: "tests/test-outcome-tracker.ts" },
  { name: "Watchlist policy (offline)", script: "tests/test-watchlist-policy.ts" },
  { name: "Watchlist runtime (offline)", script: "tests/test-watchlist-runtime.ts" },
  { name: "RPC burn-rate meter (offline)", script: "tests/test-rpc-meter.ts" },
  { name: "Run-summary arithmetic (offline)", script: "tests/test-summary.ts" },
];

/**
 * Only these four reach out to the network (Solana RPC, Jupiter, Drift). The
 * old banner claimed "Parts 1-2" without naming anything, which covered for
 * two suites that were not network-related at all. The caveat now names the
 * suites it applies to, and applies to nothing else.
 */
const NETWORK_SUITES = suites.filter((s) => s.needsNetwork).map((s) => s.name);

type Outcome = "pass" | "fail" | "skip";
interface SuiteResult {
  name: string;
  outcome: Outcome;
  status: number | null;
  /** Only set for a skip: the precondition the suite reported as missing. */
  reason?: string;
  needsNetwork: boolean;
  /** Assertion counts scraped from this suite's own `Total:` line, if it prints one. */
  totals: SuiteTotals;
}

const results: SuiteResult[] = [];
const skipReportFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "opiumo-test-")),
  "skip-reason.txt"
);

async function main() {
  for (const suite of suites) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`Running: ${suite.name}`);
    console.log("=".repeat(70));

    // Cleared before every suite so a stale reason can never be attributed to
    // the wrong suite.
    if (fs.existsSync(skipReportFile)) fs.unlinkSync(skipReportFile);

    const { status, output } = await runSuite(suite.script, {
      ...process.env,
      [SKIP_REPORT_ENV]: skipReportFile,
    });

    let outcome: Outcome;
    let reason: string | undefined;

    if (status === EXIT_PASS) {
      outcome = "pass";
    } else if (status === EXIT_SKIP) {
      outcome = "skip";
      reason = fs.existsSync(skipReportFile)
        ? fs.readFileSync(skipReportFile, "utf-8").trim()
        : "(the suite exited 2 but recorded no reason - see its output above)";
      console.log(`\n>>> ${suite.name} SKIPPED: ${reason}`);
    } else {
      // Includes crashes, signals (status null), and any code this runner does
      // not recognise. Unknown outcomes fail; they are never assumed to be skips.
      outcome = "fail";
      console.error(`\n>>> ${suite.name} FAILED (exit status ${status})`);
    }

    results.push({
      name: suite.name,
      outcome,
      status,
      reason,
      needsNetwork: !!suite.needsNetwork,
      totals: parseTotals(output),
    });
  }

  const passed = results.filter((r) => r.outcome === "pass");
  const failed = results.filter((r) => r.outcome === "fail");
  const skipped = results.filter((r) => r.outcome === "skip");

  console.log(`\n${"=".repeat(70)}`);
  console.log(
    `Suites: ${results.length} run - ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`
  );

  if (skipped.length > 0) {
    console.log("\nSkipped (a precondition was absent - NOT counted as failures):");
    for (const r of skipped) console.log(`  - ${r.name}: ${r.reason}`);
  }

  if (failed.length > 0) {
    console.error("\nFailed:");
    for (const r of failed) console.error(`  - ${r.name} (exit status ${r.status})`);

    const networkFailures = failed.filter((r) => r.needsNetwork);
    if (networkFailures.length > 0) {
      // Deliberately NOT phrased as "these failed because of the network". The
      // exit code cannot tell a blocked host from a real bug, and a mutation test
      // proved the point: a deliberate regression in Perps Drift was correctly
      // reported as FAIL, then filed under this heading as if the sandbox
      // explained it. So the caveat states what is actually known - that these
      // suites need egress - and explicitly refuses to conclude anything else.
      console.error(
        "\nOf those, these suites need live network access to Solana/Jupiter/Drift, so a " +
          "failure is expected in a sandbox with no egress:"
      );
      for (const r of networkFailures) console.error(`  - ${r.name}`);
      console.error(
        "  That is NOT proof the network caused it - a real bug in one of these looks " +
          "identical from the exit code. Read each suite's output above before dismissing it."
      );
    }
    const otherFailures = failed.filter((r) => !r.needsNetwork);
    if (otherFailures.length > 0) {
      console.error(
        `\n${otherFailures.length} failure(s) are NOT network-related and are real: ` +
          otherFailures.map((r) => r.name).join(", ")
      );
    }
  } else if (skipped.length > 0) {
    console.log("\nNo failures. Every suite that ran, passed.");
  } else {
    console.log("\nAll suites passed.");
  }
  console.log(`(Suites needing network: ${NETWORK_SUITES.join(", ")})`);

  // The last line of the run, and the only one starting with SUMMARY. Reading
  // the final `Total:` instead of this is what produced two wrong repo counts.
  const agg = aggregate(results as SuiteRecord[]);
  console.log(formatSummary("OPIUMO", agg));
  console.log("=".repeat(70));

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("test runner crashed:", err);
  process.exit(1);
});
