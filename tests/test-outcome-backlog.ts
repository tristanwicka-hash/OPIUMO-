/**
 * Outcome-backlog analysis tests. Offline, synthetic entries, injected clock.
 *
 * The load-bearing distinction: a queue GROWING toward its bound is filling,
 * and must not be reported as diverging. The queue is bounded by the longest
 * checkpoint horizon, so growth alone is expected. Divergence means pending
 * above steady state AND checkpoints going overdue - the worker not keeping up.
 * Conflating them would raise an alarm about a queue behaving as designed.
 */
import { PendingEntry, BacklogSnapshot, snapshot, trend, steadyStateCallsPerHour, formatBacklog } from "../src/analysis/outcomeBacklog";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " -- " + detail : ""}`); console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
function section(t: string): void { console.log(`\n=== ${t} ===\n`); }

const NOW = Date.UTC(2026, 8, 10, 20, 0, 0);
const e = (cpSec: number, dueOffsetMin: number): PendingEntry => ({
  checkpointSeconds: cpSec, dueAtMs: NOW + dueOffsetMin * 60_000,
});
const snapAt = (pending: number, overdue: number, hoursAgo: number): BacklogSnapshot => ({
  at: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
  pending, byHorizon: {}, overdue, maxLateMinutes: overdue ? 5 : 0, earliestDueAt: null,
});

section("snapshot");

const entries = [e(3600, 30), e(3600, -10), e(21600, 300), e(86400, 1400), e(86400, 1440)];
const s = snapshot(entries, NOW);
check("counts every entry", s.pending === 5);
check("splits by horizon", s.byHorizon["3600"] === 2 && s.byHorizon["21600"] === 1 && s.byHorizon["86400"] === 2);
check("counts overdue", s.overdue === 1);
check("reports worst lateness", s.maxLateMinutes === 10, `got ${s.maxLateMinutes}`);
check("reports the earliest due time", s.earliestDueAt === new Date(NOW - 10 * 60_000).toISOString());
const empty = snapshot([], NOW);
check("an empty queue is 0 pending with a null earliest due", empty.pending === 0 && empty.earliestDueAt === null);
check("and no overdue", empty.overdue === 0 && empty.maxLateMinutes === 0);

section("a single reading is NOT a trend");

const one = trend([snapAt(15000, 0, 0)], 1000, 19);
check("verdict is unknown", one.verdict === "unknown");
check("no rate is claimed", one.perHour === null);
check("the reason says a trend needs 2", one.reason.includes("at least 2"));
check("but a steady-state estimate is still offered", one.steadyStateEstimate === 1000 * 26);
check("with zero snapshots it is still unknown", trend([], 1000, 19).verdict === "unknown");

section("THE LOAD-BEARING CASE: growing toward the bound is FILLING, not diverging");

const growing = trend([snapAt(10000, 0, 4), snapAt(15000, 0, 0)], 1000, 19);
check("a rising queue with no overdue is 'filling'", growing.verdict === "filling", growing.reason);
check("NOT diverging", growing.verdict !== "diverging");
check("the rate is computed", Math.abs((growing.perHour as number) - 1250) < 1);
check("the reason names the steady state it heads toward", growing.reason.includes("steady state"));
check("and says growth toward the bound is not divergence", growing.reason.includes("not diverging"));

// Divergence needs BOTH: above steady state AND overdue piling up.
const diverging = trend([snapAt(30000, 500, 4), snapAt(40000, 900, 0)], 1000, 19);
check("above steady state AND overdue is 'diverging'", diverging.verdict === "diverging", diverging.reason);
check("the reason names the overdue count", diverging.reason.includes("overdue"));
const aboveButHealthy = trend([snapAt(30000, 0, 4), snapAt(40000, 0, 0)], 1000, 19);
check(
  "above steady state but NO overdue is still only filling - the worker is coping",
  aboveButHealthy.verdict === "filling",
  aboveButHealthy.reason
);

check("a flat queue is 'stable'", trend([snapAt(15000, 0, 4), snapAt(15010, 0, 0)], 1000, 19).verdict === "stable");
check("a shrinking queue is 'draining'", trend([snapAt(20000, 0, 4), snapAt(15000, 0, 0)], 1000, 19).verdict === "draining");
check(
  "snapshots sharing a timestamp yield unknown, not a divide-by-zero",
  trend([snapAt(1, 0, 0), snapAt(2, 0, 0)], 1000, 19).verdict === "unknown"
);

section("steady state is bounded by the horizons, and scales with the schedule");

check("24/7 steady state is detections x 31", trend([snapAt(1,0,1), snapAt(2,0,0)], 1000, 24).steadyStateEstimate === 31000);
check("a 19h schedule lowers it to x 26", trend([snapAt(1,0,1), snapAt(2,0,0)], 1000, 19).steadyStateEstimate === 26000);
check("an unknown detection rate gives a null estimate", trend([snapAt(1,0,1), snapAt(2,0,0)], null, 19).steadyStateEstimate === null);
check("3 checkpoints per detection sets the steady-state call rate", steadyStateCallsPerHour(1000) === 3000);
check("and it scales with the checkpoint count", steadyStateCallsPerHour(1000, 2) === 2000);

section("the report warns when the floor cost has NOT arrived yet");

const notArrived = formatBacklog(s, growing, 1081, 1163);
check("it states the steady-state cost", notArrived.includes("3,489"));
check("it flags that the observed rate is below it", notArrived.includes("has not arrived yet"));
check("and quantifies the expected rise", notArrived.includes("Expect burn to RISE"));
const arrived = formatBacklog(s, growing, 3400, 1163);
check(
  "once observed matches steady state, no rise is claimed",
  !arrived.includes("Expect burn to RISE")
);
check("overdue 0 is labelled as the signal to watch", formatBacklog(snapshot([e(3600,30)], NOW), growing, 100, 100).includes("not keeping up"));

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (failures.length) { console.log("\nFailures:"); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail > 0 ? 1 : 0);
