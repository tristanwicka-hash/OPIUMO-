/**
 * The meter's rpcCalls is cumulative PER PROCESS and resets on restart. A naive
 * last-minus-first delta across a restart undercounts, and this bot restarts
 * often (the supervisor exists precisely because it does). If that arithmetic is
 * wrong the whole billing comparison is wrong, so it is tested rather than
 * eyeballed. Pure functions, no network, no clock.
 */
import { callsBetween, streamCreditsFor, MeterPoint } from "../scripts/stream-billing-check";

let pass = 0, fail = 0;
function eq(actual: unknown, expected: unknown, what: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; }
  else { fail++; console.log(`  FAIL ${what}\n       expected ${JSON.stringify(expected)}\n       got      ${JSON.stringify(actual)}`); }
}

const P = (at: string, rpcCalls: number, startedAt: string): MeterPoint => ({ at, rpcCalls, startedAt });

// Real process-start timestamps. startedAt is an ISO string in the meter and
// callsBetween compares it against the window start to tell "was already
// running" from "started inside", so a fixture using opaque ids like "A" would
// not exercise the real code path.
const A = "2026-09-13T08:00:00Z";   // running before the window opened
const B = "2026-09-13T10:35:00Z";   // restarted inside the window
const C = "2026-09-13T10:38:00Z";   // restarted again inside the window

console.log("\n=== stream-billing window arithmetic ===\n");

// One process running throughout: count only the growth inside the window.
{
  const pts = [
    P("2026-09-13T09:50:00Z", 1000, A),   // before the window
    P("2026-09-13T10:00:00Z", 1200, A),
    P("2026-09-13T10:30:00Z", 1800, A),
    P("2026-09-13T11:00:00Z", 2400, A),
    P("2026-09-13T11:10:00Z", 2600, A),   // after the window
  ];
  const r = callsBetween(pts, "2026-09-13T10:00:00Z", "2026-09-13T11:00:00Z");
  eq(r.calls, 1200, "single process: 2400 - 1200, ignoring points outside the window");
  eq(r.restarts, 0, "single process: no restarts");
  eq(r.complete, true, "single process: window is complete");
}

// A restart inside the window. The naive delta would be 400 - 1200 = -800.
{
  const pts = [
    P("2026-09-13T10:00:00Z", 1200, A),
    P("2026-09-13T10:20:00Z", 1900, A),   // A did 700 more, then died
    P("2026-09-13T10:40:00Z", 300, B),    // B started fresh inside the window
    P("2026-09-13T11:00:00Z", 400, B),
  ];
  const r = callsBetween(pts, "2026-09-13T10:00:00Z", "2026-09-13T11:00:00Z");
  eq(r.calls, 700 + 400, "restart inside the window: A's growth plus ALL of B's calls");
  eq(r.restarts, 1, "restart inside the window is reported, not hidden");
}

// Two restarts, so three processes.
{
  const pts = [
    P("2026-09-13T10:00:00Z", 500, A), P("2026-09-13T10:10:00Z", 800, A),
    P("2026-09-13T10:20:00Z", 100, B), P("2026-09-13T10:30:00Z", 250, B),
    P("2026-09-13T10:40:00Z", 90, C),
  ];
  const r = callsBetween(pts, "2026-09-13T10:00:00Z", "2026-09-13T11:00:00Z");
  eq(r.calls, 300 + 250 + 90, "two restarts: growth of the first, everything from the other two");
  eq(r.restarts, 2, "two restarts counted");
}

// An empty window must read UNKNOWN, never a confident zero. A bot that was
// down looks exactly like a bot that made no calls, and they are different.
{
  const r = callsBetween([P("2026-09-13T09:00:00Z", 100, A)], "2026-09-13T10:00:00Z", "2026-09-13T11:00:00Z");
  eq(r.complete, false, "no meter points in the window reads as incomplete, not as zero calls");
}

// The published rate, pinned to literals so changing the constant fails here.
eq(streamCreditsFor(0.1), 2, "0.1 MB costs 2 credits - Helius's published rate");
eq(streamCreditsFor(1), 20, "1 MB costs 20 credits");
eq(streamCreditsFor(0), 0, "no data streamed costs nothing");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
