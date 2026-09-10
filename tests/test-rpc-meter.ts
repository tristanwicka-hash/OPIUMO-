/**
 * RPC burn-rate meter tests. Offline, deterministic, injected clock - no
 * network and no wall clock, so an hourly rate can be asserted exactly.
 *
 * The load-bearing assertions here are the two that decide whether a measured
 * burn rate can be trusted at all:
 *   - a batch of N calls counts as N, not as 1
 *   - a rate over too little uptime is null, never a number
 */
import {
  RpcMeter,
  parseRpcMethods,
  perHour,
  formatMeterLine,
  MIN_UPTIME_FOR_RATE_MS,
} from "../src/rpc/rpcMeter";

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

const T0 = Date.parse("2026-09-10T00:00:00.000Z");
const HOUR = 3_600_000;
const body = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] });

section("parsing a JSON-RPC body");

check("a single call yields its method", JSON.stringify(parseRpcMethods(body("getSlot"))) === '["getSlot"]');
check(
  "an already-parsed object works too",
  JSON.stringify(parseRpcMethods({ jsonrpc: "2.0", method: "getBalance" })) === '["getBalance"]'
);
check(
  "a batch yields every method in order",
  JSON.stringify(
    parseRpcMethods(JSON.stringify([{ method: "getAccountInfo" }, { method: "getBalance" }]))
  ) === '["getAccountInfo","getBalance"]'
);
check("malformed JSON is null, not an empty list", parseRpcMethods("{not json") === null);
check("an object with no method is null", parseRpcMethods({ jsonrpc: "2.0" }) === null);
check("an empty batch is null", parseRpcMethods("[]") === null);
check("undefined is null", parseRpcMethods(undefined) === null);

section("A BATCH OF N COUNTS AS N - the figure a provider actually bills");

const batchMeter = new RpcMeter(T0);
const batch = JSON.stringify(
  Array.from({ length: 40 }, (_, i) => ({ id: i, method: "getAccountInfo" }))
);
const counted = batchMeter.record(batch);
const batchSnap = batchMeter.snapshot(T0 + HOUR);

check("record() reports 40 calls for a 40-call batch", counted === 40, `got ${counted}`);
check("rpcCalls counts all 40", batchSnap.rpcCalls === 40, `got ${batchSnap.rpcCalls}`);
check("httpRequests counts the single POST", batchSnap.httpRequests === 1, `got ${batchSnap.httpRequests}`);
check(
  "the two are reported separately, so batching cannot hide the real call count",
  batchSnap.rpcCalls !== batchSnap.httpRequests
);

section("counting and per-method attribution");

const m = new RpcMeter(T0);
for (let i = 0; i < 100; i++) m.record(body("getAccountInfo"));
for (let i = 0; i < 25; i++) m.record(body("getBalance"));
for (let i = 0; i < 5; i++) m.record(body("getSlot"));
const snap = m.snapshot(T0 + HOUR);

check("total calls", snap.rpcCalls === 130, `got ${snap.rpcCalls}`);
check("methods are sorted busiest first", snap.methods[0].method === "getAccountInfo");
check("busiest method's count", snap.methods[0].calls === 100, `got ${snap.methods[0].calls}`);
check("shares sum to 1", Math.abs(snap.methods.reduce((a, x) => a + x.share, 0) - 1) < 1e-9);
check(
  "share is calls/total, not calls/httpRequests",
  Math.abs(snap.methods[0].share - 100 / 130) < 1e-9
);
check("every method seen is listed", snap.methods.length === 3, `got ${snap.methods.length}`);

section("the hourly rate is arithmetic, not a guess");

check("130 calls over exactly one hour is 130/h", snap.callsPerHourSinceStart === 130);
const half = m.snapshot(T0 + HOUR / 2);
check("the same calls over half an hour is 260/h", half.callsPerHourSinceStart === 260);
check("perHour is exact for a clean case", perHour(50, HOUR) === 50);

section("NULL IS NOT ZERO: too little uptime is not a rate");

const fresh = new RpcMeter(T0);
fresh.record(body("getSlot"));
const tooSoon = fresh.snapshot(T0 + 1_000);
check(
  "a rate from 1 second of uptime is null, not an extrapolated number",
  tooSoon.callsPerHourSinceStart === null,
  `got ${tooSoon.callsPerHourSinceStart}`
);
check("the raw count is still reported", tooSoon.rpcCalls === 1);
check(
  "the threshold is the documented one",
  perHour(1, MIN_UPTIME_FOR_RATE_MS - 1) === null && perHour(1, MIN_UPTIME_FOR_RATE_MS) !== null
);
check("a zero-elapsed snapshot does not divide by zero", fresh.snapshot(T0).callsPerHourSinceStart === null);

section("the window measures CURRENT burn, not the lifetime average");

const w = new RpcMeter(T0);
for (let i = 0; i < 600; i++) w.record(body("getAccountInfo")); // busy first hour
const first = w.snapshotAndRollWindow(T0 + HOUR);
check("first window rate equals the lifetime rate", first.callsPerHourInWindow === 600);

for (let i = 0; i < 60; i++) w.record(body("getAccountInfo")); // quiet second hour
const second = w.snapshot(T0 + 2 * HOUR);
check("lifetime average is dragged up by the busy hour", second.callsPerHourSinceStart === 330);
check(
  "the window shows the CURRENT rate instead",
  second.callsPerHourInWindow === 60,
  `got ${second.callsPerHourInWindow}`
);
check("window calls exclude the previous window", second.windowCalls === 60, `got ${second.windowCalls}`);
check("cumulative total still counts everything", second.rpcCalls === 660);

section("an unrecognised body is counted, and the gap is visible");

const u = new RpcMeter(T0);
u.record("{not json");
const us = u.snapshot(T0 + HOUR);
check("it still counts as a call, so the total is never understated", us.rpcCalls === 1);
check("it is tallied separately", us.unparsedBodies === 1);
check("and attributed to an explicit bucket, not to a real method", us.methods[0].method === "<unparsed>");

section("the printed line cannot be mistaken for a credit figure");

const line = formatMeterLine(snap);
check("is a single line", !line.includes("\n"));
check("carries the hourly rate", line.includes("130/h"));
check(
  "says plainly that these are requests, not credits",
  line.includes("requests, not credits")
);
check("names the busiest method", line.includes("getAccountInfo"));
check(
  "says 'not enough uptime yet' rather than printing a made-up rate",
  formatMeterLine(tooSoon).includes("not enough uptime yet")
);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
