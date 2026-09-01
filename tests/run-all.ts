/**
 * Runs every test suite in one shot: npm test
 *
 * Each suite still exits with its own process code when run individually
 * (npm run test:rpc / test:watcher / test:metrics / test:filters) - this
 * just chains them via child processes so `npm test` gives you one combined
 * pass/fail without hunting down each script name.
 */
import { spawnSync } from "child_process";

const suites = [
  { name: "RPC connection (Part 1)", script: "tests/test-rpc-connection.ts" },
  { name: "Pool watcher (Part 2)", script: "tests/test-watcher.ts" },
  { name: "Token metrics (Part 3)", script: "tests/test-token-metrics.ts" },
  { name: "Filter engine (Part 4)", script: "tests/test-filters.ts" },
  { name: "Log rotation (util)", script: "tests/test-logger.ts" },
];

let anyFailed = false;

for (const suite of suites) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Running: ${suite.name}`);
  console.log("=".repeat(70));

  const result = spawnSync("npx", ["ts-node", suite.script], { stdio: "inherit" });

  if (result.status !== 0) {
    anyFailed = true;
    console.error(`\n>>> ${suite.name} exited with a non-zero status (${result.status})`);
  }
}

console.log(`\n${"=".repeat(70)}`);
if (anyFailed) {
  console.error("One or more suites failed or need live network access to fully verify (see output above).");
  console.error("Parts 1-2's live checks are EXPECTED to fail in a sandboxed environment with no Solana RPC egress.");
} else {
  console.log("All suites passed.");
}
console.log("=".repeat(70));

process.exit(anyFailed ? 1 : 0);
