/**
 * OPIUMO test: log integrity invariants (offline).
 *
 * The invariants are only worth having if they fire on a bad log and stay quiet
 * on a good one. Both halves are tested here against fixtures written on
 * purpose to be broken, because a checker that reports "clean" on everything is
 * indistinguishable from one that has been switched off - the same problem the
 * fixture-leak guard had.
 *
 * The ORDERED invariant is the interesting one. A strict-monotonic version
 * flagged 6,224 real, correct records on the first run: these logs have
 * concurrent appenders, so small reversals are normal and a checker that calls
 * them violations is the kind that gets deleted. It is a BOUND, and both sides
 * of that bound are asserted.
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  checkFile,
  productionLogs,
  quarantinePlan,
  timestampOf,
  DEFAULT_ORDER_TOLERANCE_MS,
} from "../src/analysis/logIntegrity";
import { assertNoProductionWrites } from "./no-production-writes";

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

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opiumo-logint-"));
}
function write(dir: string, name: string, rows: (string | object)[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return file;
}
const has = (r: ReturnType<typeof checkFile>, id: string) => r.violations.some((v) => v.invariant === id);
/**
 * The detail text of the first violation of a kind, or "" when there is none.
 *
 * Written this way because indexing violations[0] directly CRASHED this suite
 * under a mutation that removed all violations - and a crashed suite prints no
 * Total line, which is indistinguishable from a passing one. Every assertion
 * here has to be able to go red rather than die.
 */
const detailOf = (r: ReturnType<typeof checkFile>, id?: string) =>
  (id === undefined ? r.violations[0] : r.violations.find((v) => v.invariant === id))?.detail ?? "";
const excerptOf = (r: ReturnType<typeof checkFile>, id?: string) =>
  (id === undefined ? r.violations[0] : r.violations.find((v) => v.invariant === id))?.excerpt ?? "";
const count = (r: ReturnType<typeof checkFile>, id: string) => r.violations.filter((v) => v.invariant === id).length;

console.log("=== OPIUMO test: log integrity invariants (offline) ===");

console.log("\n-- a clean log passes every invariant --");
{
  const d = tmp();
  const f = write(d, "decisions.jsonl", [
    { ts: "2026-09-11T00:00:00Z", decision: "SKIP", mint: "A", reasons: ["x"], metrics: {} },
    { ts: "2026-09-11T00:00:01Z", decision: "SKIP", mint: "B", reasons: ["y"], metrics: {} },
  ]);
  const r = checkFile(f);
  check("no violations", r.violations.length === 0, JSON.stringify(r.violations));
  check("both records counted", r.records === 2);
  check("no reversals seen", r.reversals === 0 && r.maxReversalMs === 0);
}

console.log("\n-- unparseable lines are violations, and do not stop the file --");
{
  const d = tmp();
  const f = write(d, "x.jsonl", [
    { ts: "2026-09-11T00:00:00Z", mint: "A" },
    "{not json",
    { ts: "2026-09-11T00:00:02Z", mint: "B" },
  ]);
  const r = checkFile(f);
  check("the bad line is reported", count(r, "parseable") === 1);
  check("it names the line number", r.violations.find((v) => v.invariant === "parseable")?.line === 2);
  check("the records after it are still read", r.records === 2, String(r.records));
  check("the raw line is quoted so it can be found", excerptOf(r, "parseable").includes("{not json"));
}

console.log("\n-- a record with no timestamp cannot be reconciled, and says so --");
{
  const d = tmp();
  const f = write(d, "x.jsonl", [{ mint: "A", decision: "SKIP", reasons: [], metrics: {} }]);
  const r = checkFile(f);
  check("missing timestamp is a violation", has(r, "timestamped"));

  // Any of the accepted fields will do - several logs predate `ts`.
  check("ts is accepted", timestampOf({ ts: "2026-09-11T00:00:00Z" }) !== null);
  check("at is accepted", timestampOf({ at: "2026-09-11T00:00:00Z" }) !== null);
  check("detectedAt is accepted", timestampOf({ detectedAt: "2026-09-11T00:00:00Z" }) !== null);
  check("an unparseable date is not a timestamp", timestampOf({ ts: "last tuesday" }) === null);
  check("a number is not a timestamp", timestampOf({ ts: 1757568000 }) === null);
}

console.log("\n-- ORDERED is a bound, not strict monotonicity --");
{
  const d = tmp();
  // A 5-second reversal: exactly what concurrent appenders produce. Measured
  // p95 on the real watchlist log is 5.5s.
  const small = write(d, "small.jsonl", [
    { ts: "2026-09-11T00:00:10Z", mint: "A" },
    { ts: "2026-09-11T00:00:05Z", mint: "B" },
  ]);
  const rs = checkFile(small);
  check("a small reversal is NOT a violation", !has(rs, "ordered"), JSON.stringify(rs.violations));
  check("  ...but it IS counted", rs.reversals === 1);
  check("  ...and its size is reported", rs.maxReversalMs === 5000, String(rs.maxReversalMs));

  // An hour backwards is a clock change or a stale replay, not concurrency.
  const big = write(d, "big.jsonl", [
    { ts: "2026-09-11T02:00:00Z", mint: "A" },
    { ts: "2026-09-11T01:00:00Z", mint: "B" },
  ]);
  const rb = checkFile(big);
  check("a one-hour reversal IS a violation", has(rb, "ordered"));
  check("the detail says how far back it went", detailOf(rb, "ordered").includes("3600.0s"));
  check("  ...and names the tolerance it exceeded", detailOf(rb, "ordered").includes("120s"));

  // The boundary itself, both sides.
  const at = write(d, "at.jsonl", [
    { ts: "2026-09-11T00:02:00Z", mint: "A" },
    { ts: "2026-09-11T00:00:00Z", mint: "B" }, // exactly 120s
  ]);
  check("exactly at the tolerance is allowed", !has(checkFile(at), "ordered"));
  const over = write(d, "over.jsonl", [
    { ts: "2026-09-11T00:02:01Z", mint: "A" },
    { ts: "2026-09-11T00:00:00Z", mint: "B" }, // 121s
  ]);
  check("one second past it is not", has(checkFile(over), "ordered"));
  check("the default tolerance is 120s", DEFAULT_ORDER_TOLERANCE_MS === 120_000);

  // The bound is measured against the HIGH-WATER MARK, not the previous line -
  // otherwise one early record resets the baseline and every record after it
  // is compared against the wrong thing.
  //
  // This fixture is built so the two disagree: C is one second AFTER B, so a
  // previous-line comparison calls it fine, while against the high-water mark
  // of 02:00 it is two hours adrift. Asserting the COUNT rather than just
  // "some violation" is what makes the difference visible - the first version
  // of this check asserted presence only, and a mutation to previous-line
  // comparison escaped it.
  const hw = write(d, "hw.jsonl", [
    { ts: "2026-09-11T02:00:00Z", mint: "A" },
    { ts: "2026-09-11T00:00:00Z", mint: "B" },
    { ts: "2026-09-11T00:00:01Z", mint: "C" },
  ]);
  const rhw = checkFile(hw);
  check("both records after the high-water mark are violations", count(rhw, "ordered") === 2, String(count(rhw, "ordered")));
  check("  ...including the one that moved FORWARD from its predecessor",
    rhw.violations.some((v) => v.invariant === "ordered" && v.line === 3));
}

console.log("\n-- a fixture identifier in a production log is a violation --");
{
  const d = tmp();
  const f = write(d, "trades.jsonl", [
    { ts: "2026-09-11T00:00:00Z", mint: "RealMint1111", event: "rejected-buy", reasons: [] },
    { ts: "2026-09-11T00:00:01Z", mint: "Mint111111111111111111111111111111111111111", event: "rejected-buy", reasons: [] },
  ]);
  const r = checkFile(f, { fixtureMarkers: ["Mint111111111111111111111111111111111111111"] });
  check("the fixture record is found", count(r, "no-fixtures") === 1);
  check("the real one is not", r.violations.find((v) => v.invariant === "no-fixtures")?.line === 2);

  // A marker too short to be an identifier would match nearly every line.
  check("a short marker is ignored", count(checkFile(f, { fixtureMarkers: ["Mint"] }), "no-fixtures") === 0);
  check("no markers means no fixture violations", count(checkFile(f), "no-fixtures") === 0);
}

console.log("\n-- a record missing a field its readers assume is a violation --");
{
  const d = tmp();
  const f = write(d, "x.jsonl", [
    { ts: "2026-09-11T00:00:00Z", event: "credit-halt", mint: "A", decision: "NOT_EVALUATED", budgetReason: "daily-limit-reached", dayCredits: 1, monthCredits: 2 },
    { ts: "2026-09-11T00:00:01Z", event: "credit-halt", mint: "B", decision: "NOT_EVALUATED" },
  ]);
  const r = checkFile(f);
  check("the complete record passes", count(r, "schema") === 1);
  check("the incomplete one is named with its missing fields",
    r.violations.some((v) => v.invariant === "schema" && v.detail.includes("budgetReason")));

  // A field present but null is NOT missing: null is a value, and "could not
  // compute" is exactly what several of these fields are for.
  const withNull = write(d, "n.jsonl", [
    { ts: "2026-09-11T00:00:00Z", event: "paper-close", mint: "A", openedAt: "x", outcome: null },
  ]);
  check("a null field counts as present", count(checkFile(withNull), "schema") === 0);

  // An unknown event is not a violation - a new event type should not fail the
  // check the day it is added.
  const unknown = write(d, "u.jsonl", [{ ts: "2026-09-11T00:00:00Z", event: "brand-new-thing" }]);
  check("an unknown event type is not a schema violation", count(checkFile(unknown), "schema") === 0);
}

console.log("\n-- a close with no open refers to a state that never existed --");
{
  const d = tmp();
  const ok = write(d, "p.jsonl", [
    { ts: "2026-09-11T00:00:00Z", event: "paper-open", mint: "A", openedAt: "t", entryProceedsSol: 1 },
    { ts: "2026-09-11T00:00:01Z", event: "paper-close", mint: "A", openedAt: "t", outcome: "closed" },
  ]);
  check("an open then a close is fine", !has(checkFile(ok), "referential"));

  const orphan = write(d, "o.jsonl", [
    { ts: "2026-09-11T00:00:01Z", event: "paper-close", mint: "GHOST", openedAt: "t", outcome: "closed" },
  ]);
  const r = checkFile(orphan);
  check("a close with no open is a violation", has(r, "referential"));
  check("it names the mint", r.violations.some((v) => v.detail.includes("GHOST")));

  // Order matters: a close BEFORE its open is also unpaired at that point.
  const reversed = write(d, "r.jsonl", [
    { ts: "2026-09-11T00:00:00Z", event: "paper-close", mint: "A", openedAt: "t", outcome: "closed" },
    { ts: "2026-09-11T00:00:01Z", event: "paper-open", mint: "A", openedAt: "t", entryProceedsSol: 1 },
  ]);
  check("a close before its open is caught", has(checkFile(reversed), "referential"));
}

console.log("\n-- rotated files are included, scratch dirs are not --");
{
  const d = tmp();
  write(d, "decisions.jsonl", [{ ts: "2026-09-11T00:00:00Z", mint: "A" }]);
  write(d, "decisions.2026-09-09T23-22-31-356Z.jsonl", [{ ts: "2026-09-09T00:00:00Z", mint: "B" }]);
  fs.mkdirSync(path.join(d, "test-scratch"));
  write(path.join(d, "test-scratch"), "decisions.jsonl", [{ ts: "2026-09-11T00:00:00Z", mint: "C" }]);
  fs.writeFileSync(path.join(d, "notes.md"), "not a log");

  const files = productionLogs(d).map((f) => path.basename(f));
  check("the live log is included", files.includes("decisions.jsonl"));
  check("the ROTATED log is included", files.some((f) => f.includes("2026-09-09")), files.join(", "));
  check("a nested scratch directory is not", files.length === 2, files.join(", "));
  check("a non-jsonl file is not", !files.some((f) => f.endsWith(".md")));
  check("a missing directory yields nothing", productionLogs(path.join(d, "nope")).length === 0);
}

console.log("\n-- an unreadable file is a violation, not an empty pass --");
{
  const r = checkFile(path.join(tmp(), "does-not-exist.jsonl"));
  check("it is reported", r.violations.length === 1);
  check("  ...as unreadable rather than as zero clean records", detailOf(r).includes("could not read"));
  check("and no records are claimed", r.records === 0);
}

console.log("\n-- the quarantine plan moves nothing --");
{
  const d = tmp();
  const f = write(d, "trades.jsonl", [
    "{bad",
    { ts: "2026-09-11T00:00:00Z", mint: "Mint111111111111111111111111111111111111111" },
  ]);
  const before = fs.readFileSync(f, "utf-8");
  const r = checkFile(f, { fixtureMarkers: ["Mint111111111111111111111111111111111111111"] });
  // Guarded: the planner must not throw either. A mutation that made it delete
  // the file threw ENOENT on its second pass and killed the suite outright,
  // which prints no Total line and reads exactly like a clean run.
  let plan: ReturnType<typeof quarantinePlan> = [];
  let plannerThrew = false;
  try {
    plan = quarantinePlan([r], path.join(d, "quarantine"));
  } catch (e) {
    plannerThrew = true;
    console.log(`    planner threw: ${e instanceof Error ? e.message : e}`);
  }
  check("the planner does not throw", !plannerThrew);
  check("a plan is produced", plan.length >= 1);
  check("it groups by invariant", plan.every((a) => a.destination.includes(".jsonl")));
  check("it names the lines", plan.every((a) => a.lines.length > 0));
  // Read defensively: a mutation that made the planner DELETE the file crashed
  // this suite instead of failing it, and a crashed suite prints no Total line,
  // which reads the same as "no problem".
  const after = fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : "<THE PLANNER DELETED THE FILE>";
  check("THE SOURCE FILE STILL EXISTS", fs.existsSync(f));
  check("THE SOURCE FILE IS UNTOUCHED", after === before, after.slice(0, 60));
  check("nothing was written to the destination", !fs.existsSync(path.join(d, "quarantine")));
}

assertNoProductionWrites(check, ["opiumo-logint-", "GHOST"]);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
