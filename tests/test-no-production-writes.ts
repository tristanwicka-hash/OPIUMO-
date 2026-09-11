/**
 * Meta-test: does the fixture-leak guard actually detect a leak?
 *
 * `no-production-writes.ts` is the guard that found 156 fixture-mint records
 * sitting in the real logs/trades.jsonl. Four suites call it, and it reports
 * clean on every run - which is exactly the problem. A guard whose only
 * observed output is "clean" is indistinguishable from a guard that has been
 * switched off.
 *
 * A mutation proved it: with `for (const marker of real)` changed to iterate
 * an empty array, findLeaks() could no longer detect anything at all, and all
 * four suites stayed green. Nothing in the repo fed it a log it should reject.
 *
 * So this suite is the negative case. Every assertion below runs against a
 * temp directory built on purpose to be contaminated, and asserts the guard
 * reports the leak - with the right file, the right line, and the right
 * marker. The clean case is asserted too, so "detects everything" cannot pass
 * for "detects the right thing".
 *
 * Offline, no network, and it never touches the real logs/ directory.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { findLeaks, productionLogFiles, assertNoProductionWrites } from "./no-production-writes";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`);
  }
}

const FIXTURE_MINT = "Mint111111111111111111111111111111111111111";
const REAL_MINT = "So11111111111111111111111111111111111111112";

/** A throwaway logs/ directory, so the real one is never read or written. */
function makeLogsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opiumo-leakguard-"));
}

console.log("=== OPIUMO test: the fixture-leak guard detects leaks (offline) ===");

console.log("\n-- a contaminated log is reported, with file, line and marker --");
{
  const dir = makeLogsDir();
  fs.writeFileSync(
    path.join(dir, "trades.jsonl"),
    [
      JSON.stringify({ event: "buy", mint: REAL_MINT }),
      JSON.stringify({ event: "rejected-buy", mint: FIXTURE_MINT, reasons: ["trading.enabled is false"] }),
      JSON.stringify({ event: "sell", mint: REAL_MINT }),
    ].join("\n") + "\n"
  );

  const hits = findLeaks([FIXTURE_MINT], dir);
  check("the leak is found at all", hits.length === 1, `${hits.length} hit(s)`);
  check("it names the file that was contaminated", hits[0]?.file === path.join(dir, "trades.jsonl"));
  check("it names the 1-indexed line", hits[0]?.line === 2, `line ${hits[0]?.line}`);
  check("it names which marker matched", hits[0]?.marker === FIXTURE_MINT);
  check("it carries an excerpt a human can read", (hits[0]?.excerpt ?? "").includes("rejected-buy"));

  // The other half: a clean log of the same shape produces nothing. Without
  // this, a guard that flagged every line would pass every check above.
  const clean = makeLogsDir();
  fs.writeFileSync(
    path.join(clean, "trades.jsonl"),
    JSON.stringify({ event: "buy", mint: REAL_MINT }) + "\n"
  );
  check("an uncontaminated log of the same shape reports nothing", findLeaks([FIXTURE_MINT], clean).length === 0);
}

console.log("\n-- every production log is scanned, not just the one someone thought of --");
{
  // This is the whole reason the guard is shared rather than per-file: the
  // 156 leaked records were in a log that had no assertion of its own.
  const dir = makeLogsDir();
  fs.writeFileSync(path.join(dir, "trades.jsonl"), `{"mint":"${FIXTURE_MINT}"}\n`);
  fs.writeFileSync(path.join(dir, "watchlist.jsonl"), `{"mint":"${FIXTURE_MINT}"}\n`);
  fs.writeFileSync(path.join(dir, "positions.json"), `{"mint":"${FIXTURE_MINT}"}\n`);
  // A log nobody has thought to write an assertion for yet.
  fs.writeFileSync(path.join(dir, "brand-new-log.jsonl"), `{"mint":"${FIXTURE_MINT}"}\n`);

  const hits = findLeaks([FIXTURE_MINT], dir);
  const files = new Set(hits.map((h) => path.basename(h.file)));
  check("all four production logs are scanned", hits.length === 4, `${hits.length} hit(s)`);
  check("including a log with no assertion of its own", files.has("brand-new-log.jsonl"));
  check("both .jsonl and .json are covered", files.has("positions.json") && files.has("trades.jsonl"));
}

console.log("\n-- a test's own scratch directory is left alone --");
{
  // Nested directories are how a suite writes freely. If these were scanned,
  // every suite that logs would fail its own guard and the guard would be
  // deleted within a day.
  const dir = makeLogsDir();
  fs.mkdirSync(path.join(dir, "test-engine-gating"));
  fs.writeFileSync(path.join(dir, "test-engine-gating", "trades.jsonl"), `{"mint":"${FIXTURE_MINT}"}\n`);

  check("a nested scratch log is not treated as a production log", productionLogFiles(dir).length === 0);
  check("and produces no leak", findLeaks([FIXTURE_MINT], dir).length === 0);
}

console.log("\n-- a marker too short to be an identifier is refused --");
{
  // Without the length floor, a marker like "1" or "" matches nearly every
  // line of every log and the guard becomes noise that gets switched off.
  const dir = makeLogsDir();
  fs.writeFileSync(path.join(dir, "trades.jsonl"), `{"mint":"${REAL_MINT}","slot":1}\n`);

  check("a 1-character marker is ignored", findLeaks(["1"], dir).length === 0);
  check("an empty marker is ignored", findLeaks([""], dir).length === 0);
  check("a whitespace-only marker is ignored", findLeaks(["   "], dir).length === 0);
  // ...but a plausible identifier of exactly the floor length still counts.
  check("a 6-character marker is still honoured", findLeaks([REAL_MINT.slice(0, 6)], dir).length === 1);
}

console.log("\n-- assertNoProductionWrites fails the calling suite on a leak --");
{
  // findLeaks() returning hits is only useful if the wrapper turns them into a
  // failed assertion. Captured rather than run through `check`, so a real
  // failure here does not read as a passing suite.
  const dir = makeLogsDir();
  fs.writeFileSync(path.join(dir, "trades.jsonl"), `{"mint":"${FIXTURE_MINT}"}\n`);

  const calls: { name: string; cond: boolean; detail?: string }[] = [];
  const capture = (name: string, cond: boolean, detail?: string) => calls.push({ name, cond, detail });

  assertNoProductionWrites(capture, [FIXTURE_MINT], dir);
  check("it made exactly one assertion", calls.length === 1);
  check("and that assertion FAILED", calls[0]?.cond === false);
  check("the detail names the offending file and line", (calls[0]?.detail ?? "").includes("trades.jsonl:1"));
  check("the detail names the marker", (calls[0]?.detail ?? "").includes(FIXTURE_MINT));

  const cleanDir = makeLogsDir();
  fs.writeFileSync(path.join(cleanDir, "trades.jsonl"), `{"mint":"${REAL_MINT}"}\n`);
  const cleanCalls: { name: string; cond: boolean }[] = [];
  assertNoProductionWrites((name, cond) => cleanCalls.push({ name, cond }), [FIXTURE_MINT], cleanDir);
  check("a clean directory passes the same assertion", cleanCalls[0]?.cond === true);
  check("and the message states how many files were scanned", cleanCalls[0]?.name.includes("1 file(s) scanned"));
}

console.log("\n-- a logs directory that does not exist is not a pass --");
{
  // "Nothing to scan" and "scanned, found nothing" are different facts. The
  // guard reports zero files scanned rather than claiming a clean result, so
  // a wrong path cannot read as a clean bill of health.
  const missing = path.join(os.tmpdir(), "opiumo-leakguard-does-not-exist");
  check("no files are reported for a missing directory", productionLogFiles(missing).length === 0);
  const calls: { name: string }[] = [];
  assertNoProductionWrites((name) => calls.push({ name }), [FIXTURE_MINT], missing);
  check("the assertion says 0 file(s) scanned, not that all is well", calls[0]?.name.includes("0 file(s) scanned"));
}

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
