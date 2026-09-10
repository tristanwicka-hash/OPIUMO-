/**
 * Hourly-histogram tests. Offline, pure, deterministic - synthetic records with
 * explicit timestamps, no log files and no clock.
 *
 * The load-bearing assertions are the ones that stop the table from lying:
 *   - an hour that was never observed reports null, NEVER 0/h
 *   - a dropped or not-evaluated token still counts as a detection
 *   - the rotated-log case (handled in the script) and the derived-time case
 *     are both visible in the output rather than absorbed
 */
import {
  DecisionRecord,
  buildHistogram,
  detectionTime,
  isDetectionRecord,
  observedIntervals,
  observedMinutesByHour,
  rankByRate,
  formatHistogram,
} from "../src/analysis/hourlyHistogram";

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

const iso = (day: number, hh: number, mm = 0, ss = 0) =>
  new Date(Date.UTC(2026, 8, day, hh, mm, ss)).toISOString();

section("which records count as a detection");

check("a SKIP counts", isDetectionRecord({ decision: "SKIP" }));
check("a PASS counts", isDetectionRecord({ decision: "PASS" }));
check(
  "a DROPPED token counts - it was detected, just never evaluated",
  isDetectionRecord({ decision: "DROPPED", event: "dropped" })
);
check(
  "a NOT_EVALUATED token counts - the scheduler refused to look, but a launch happened",
  isDetectionRecord({ decision: "NOT_EVALUATED", event: "outside-schedule" })
);
check("queue-stats bookkeeping does NOT count", !isDetectionRecord({ event: "queue-stats" }));
check("a record with no decision does not count", !isDetectionRecord({ ts: iso(8, 10) }));

section("establishing the detection time, and reporting how");

const direct = detectionTime({ ts: iso(8, 12), detectedAt: iso(8, 11, 30) });
check("a recorded detectedAt wins", direct?.precision === "detectedAt");
check("and is the value used", direct?.ms === Date.parse(iso(8, 11, 30)));

const derived = detectionTime({ ts: iso(8, 12, 0, 30), detectionToDecisionMs: 30_000 });
check("otherwise it is derived from write time minus latency", derived?.precision === "derived");
check("subtracting the latency lands on the detection", derived?.ms === Date.parse(iso(8, 12)));

const fallback = detectionTime({ ts: iso(8, 12) });
check("with neither, the write time is used", fallback?.precision === "record-ts");
check(
  "and that fallback is labelled, so the caveat survives into the report",
  fallback?.precision !== "derived"
);
check("a record with no timestamp at all yields null", detectionTime({ decision: "SKIP" }) === null);
check("an unparseable timestamp yields null", detectionTime({ ts: "not a date" }) === null);
check(
  "a negative latency is ignored rather than added",
  detectionTime({ ts: iso(8, 12), detectionToDecisionMs: -5000 })?.precision === "record-ts"
);

section("reconstructing when the bot was actually running");

const t = (h: number, m: number) => Date.UTC(2026, 8, 8, h, m, 0);
const runs = observedIntervals([t(10, 0), t(10, 1), t(10, 2), t(14, 0), t(14, 1)], 10);
check("a 4-hour gap splits the stream into two runs", runs.length === 2, `got ${runs.length}`);
check("first run starts at 10:00", runs[0].startMs === t(10, 0));
check("first run ends at 10:02", runs[0].endMs === t(10, 2));
check("second run starts at 14:00", runs[1].startMs === t(14, 0));
check(
  "a gap under the threshold does NOT split",
  observedIntervals([t(10, 0), t(10, 9)], 10).length === 1
);
check(
  "raising the threshold merges runs - the answer's sensitivity is checkable",
  observedIntervals([t(10, 0), t(14, 0)], 600).length === 1
);
check("an empty stream yields no intervals", observedIntervals([], 10).length === 0);
check("a single record yields one zero-length interval", observedIntervals([t(10, 0)], 10).length === 1);

section("spreading observation across hour-of-day buckets");

const mins = observedMinutesByHour([{ startMs: t(10, 0), endMs: t(11, 30) }]);
check("the 10:00 bucket gets 60 minutes", mins[10] === 60, `got ${mins[10]}`);
check("the 11:00 bucket gets 31 minutes (inclusive of the end minute)", mins[11] === 31, `got ${mins[11]}`);
check("an untouched hour gets nothing", mins[3] === 0);

const across = observedMinutesByHour([
  { startMs: Date.UTC(2026, 8, 8, 23, 30), endMs: Date.UTC(2026, 8, 9, 0, 29) },
]);
check("a run crossing midnight fills 23:00", across[23] === 30, `got ${across[23]}`);
check("and 00:00 the next day", across[0] === 30, `got ${across[0]}`);

section("NEVER-OBSERVED IS NULL, NOT ZERO - the mistake that would cut the wrong hours");

const sparse: DecisionRecord[] = [
  { decision: "SKIP", ts: iso(8, 10, 0), detectionToDecisionMs: 0 },
  { decision: "SKIP", ts: iso(8, 10, 30), detectionToDecisionMs: 0 },
  { decision: "SKIP", ts: iso(8, 10, 59), detectionToDecisionMs: 0 },
];
const h = buildHistogram(sparse, { gapMinutes: 60 });
check("the observed hour has a rate", h.rows[10].perHour !== null);
check(
  "an hour with no observation reports null",
  h.rows[3].perHour === null,
  `got ${h.rows[3].perHour}`
);
check(
  "it is NOT reported as 0/h, which would rank it as the quietest hour",
  h.rows[3].perHour !== 0
);
check("its detection count is still 0", h.rows[3].detections === 0);
check("and its observed time is 0", h.rows[3].hoursObserved === 0);

section("totals and the sample description");

const many: DecisionRecord[] = [];
for (let m = 0; m < 60; m++) many.push({ decision: "SKIP", ts: iso(8, 12, m), detectionToDecisionMs: 0 });
for (let m = 0; m < 30; m++) many.push({ decision: "SKIP", ts: iso(8, 13, m), detectionToDecisionMs: 0 });
many.push({ event: "queue-stats", ts: iso(8, 13, 59) });
const hh = buildHistogram(many, { gapMinutes: 10 });

check("total counts detections only, not bookkeeping", hh.totalDetections === 90, `got ${hh.totalDetections}`);
check("12:00 has 60", hh.rows[12].detections === 60);
check("13:00 has 30", hh.rows[13].detections === 30);
check("shares sum to 1", Math.abs(hh.rows.reduce((a, r) => a + r.share, 0) - 1) < 1e-9);
check("first seen is the earliest detection", hh.firstSeen === iso(8, 12, 0));
check("last seen is the latest", hh.lastSeen === iso(8, 13, 29));
check("days spanned is 1", hh.daysSpanned === 1);
check("all rows are present even when empty", hh.rows.length === 24);
check("rows are in hour order", hh.rows.every((r, i) => r.hour === i));
check(
  "the precision breakdown accounts for every counted record",
  hh.precisionCounts.detectedAt + hh.precisionCounts.derived + hh.precisionCounts["record-ts"] ===
    hh.totalDetections
);

section("ranking refuses to rank hours it barely saw");

const ranked = rankByRate(hh, 0.9);
check("only hours with enough observation are ranked", ranked.length === 1, `got ${ranked.length}`);
check("and it is the hour with a full hour of data", ranked[0].hour === 12);
check(
  "lowering the bar admits the thin hour",
  rankByRate(hh, 0.4).length === 2
);
check(
  "an impossible bar ranks nothing rather than guessing",
  rankByRate(hh, 99).length === 0
);

section("the report states its own limits");

const text = formatHistogram(hh, 0.9);
check("names the sample size", text.includes("90 detections"));
check("names the date range", text.includes("2026-09-08"));
check("reports observed running time", text.includes("Observed:"));
check("reports how detection times were established", text.includes("derived (write - latency)"));
check(
  "says explicitly when hours could not be ranked",
  text.includes("unmeasured") || text.includes("too little observation")
);

const empty = formatHistogram(buildHistogram([], {}), 1);
check(
  "an empty sample says so rather than printing a table of zeroes",
  empty.includes("Nothing can be said about timing from an empty sample")
);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
