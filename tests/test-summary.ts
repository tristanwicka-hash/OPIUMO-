/**
 * Tests for the multi-suite summary line.
 *
 * The bug being guarded against: a multi-suite run prints one `Total:` per
 * suite, and reading the LAST one as the repo's figure has twice produced a
 * wrong report. Every assertion here exists to make that arithmetic checkable
 * rather than trusted.
 *
 * NOTE: this suite never prints its fixture strings. The runner scrapes
 * `Total:` lines out of a suite's stdout, so echoing a fixture containing one
 * would inflate the very number under test. That is a real hazard, and the
 * last section asserts the runner's regex only matches at the start of a line.
 */
import { parseTotals, aggregate, formatSummary, SuiteRecord } from "./summary";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? " -- " + detail : ""}`);
    console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`);
  }
}

function section(t: string): void {
  console.log(`\n=== ${t} ===\n`);
}

const rec = (name: string, output: string, outcome: SuiteRecord["outcome"] = "pass"): SuiteRecord => ({
  name,
  outcome,
  totals: parseTotals(output),
});

section("a suite's own Total: line is read correctly");

const t1 = parseTotals("  PASS: something\nTotal: 12 passed, 3 failed\n");
check("passed is read", t1.pass === 12, `got ${t1.pass}`);
check("failed is read", t1.fail === 3, `got ${t1.fail}`);
check("reported is true when a Total: line exists", t1.reported === true);
check("skipped defaults to 0, not undefined", t1.skip === 0, `got ${t1.skip}`);

const t2 = parseTotals("Total: 58 passed, 0 failed, 1 skipped\n");
check("an assertion-level skip count is read when present", t2.skip === 1, `got ${t2.skip}`);

section("a suite that prints no Total: is unknown, never zero");

const t3 = parseTotals("PASS: connected\nPASS: slot advanced\n");
check("reported is false", t3.reported === false);
check("counts stay at 0 but are not claimed as a result", t3.pass === 0 && t3.fail === 0);

const aggNoCount = aggregate([rec("live-suite", "PASS: connected\n")]);
check(
  "a suite with no count is named, not silently counted as zero",
  aggNoCount.suitesWithoutCounts.length === 1 && aggNoCount.suitesWithoutCounts[0] === "live-suite"
);
check(
  "and it is excluded from the reporting-suite count",
  aggNoCount.suitesReportingCounts === 0,
  `got ${aggNoCount.suitesReportingCounts}`
);

section("THE LOAD-BEARING PROPERTY: the summary equals the sum of its suites");

const suiteFixtures: { name: string; p: number; f: number }[] = [
  { name: "suite-a", p: 73, f: 0 },
  { name: "suite-b", p: 58, f: 2 },
  { name: "suite-c", p: 39, f: 0 },
  { name: "suite-d", p: 410, f: 1 },
];
const records = suiteFixtures.map((s) =>
  rec(s.name, `Total: ${s.p} passed, ${s.f} failed\n`, s.f === 0 ? "pass" : "fail")
);
const agg = aggregate(records);

const expectedPass = suiteFixtures.reduce((a, s) => a + s.p, 0);
const expectedFail = suiteFixtures.reduce((a, s) => a + s.f, 0);

check(
  `assertionsPassed equals the sum of every suite (${expectedPass})`,
  agg.assertionsPassed === expectedPass,
  `got ${agg.assertionsPassed}`
);
check(
  `assertionsFailed equals the sum of every suite (${expectedFail})`,
  agg.assertionsFailed === expectedFail,
  `got ${agg.assertionsFailed}`
);
check("suite count equals the number of suites run", agg.suites === 4, `got ${agg.suites}`);
check(
  "suite outcomes partition exactly: passed + failed + skipped === suites",
  agg.suitesPassed + agg.suitesFailed + agg.suitesSkipped === agg.suites,
  `${agg.suitesPassed}+${agg.suitesFailed}+${agg.suitesSkipped} vs ${agg.suites}`
);

// This is the defect itself, as an assertion.
const lastSuite = suiteFixtures[suiteFixtures.length - 1];
check(
  "the summary is NOT the last suite's total (the exact bug this replaces)",
  agg.assertionsPassed !== lastSuite.p,
  `summary ${agg.assertionsPassed} vs last suite ${lastSuite.p}`
);
check(
  "the summary is strictly greater than every individual suite's total",
  suiteFixtures.every((s) => agg.assertionsPassed > s.p)
);

section("mixed: some suites report counts, some do not");

const mixed = aggregate([
  rec("counted-1", "Total: 10 passed, 0 failed\n"),
  rec("uncounted", "PASS: reached the host\n"),
  rec("counted-2", "Total: 5 passed, 1 failed\n", "fail"),
]);
check("only counted suites contribute assertions", mixed.assertionsPassed === 15, `got ${mixed.assertionsPassed}`);
check("reporting count reflects only suites with a Total:", mixed.suitesReportingCounts === 2);
check("the uncounted suite is still counted as a suite", mixed.suites === 3);
check("and is named in the summary", mixed.suitesWithoutCounts.includes("uncounted"));

section("a suite printing more than one Total: is summed, not overwritten");

const doubled = parseTotals("Total: 4 passed, 0 failed\nmore output\nTotal: 6 passed, 1 failed\n");
check("both lines counted", doubled.pass === 10 && doubled.fail === 1, `got ${doubled.pass}/${doubled.fail}`);
check("and the line count is visible", doubled.lines === 2, `got ${doubled.lines}`);

section("the formatted line is unambiguous");

const line = formatSummary("TestRepo", agg);
check("is a single line", !line.trimEnd().includes("\n"));
check("starts with SUMMARY so it cannot be confused with a suite's Total:", line.startsWith("SUMMARY "));
check("names the repo", line.includes("TestRepo"));
check("states the suite count", line.includes("4 suites"));
check("states the assertion total", line.includes(`${expectedPass} passed`));
check("does not contain the string 'Total:'", !line.includes("Total:"));

const lineWithGaps = formatSummary("TestRepo", mixed);
check(
  "names the suites that reported no count, rather than hiding them",
  lineWithGaps.includes("uncounted")
);

section("the runner's scraper only matches a Total: at the start of a line");

// Prose mentioning a total mid-sentence must not be scraped as a result. This
// is what lets a suite talk about its own output without corrupting the count.
const prose = parseTotals("the report said Total: 999 passed, 999 failed in the old format\n");
check("mid-line mention is ignored", prose.reported === false, `parsed ${prose.pass}/${prose.fail}`);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
