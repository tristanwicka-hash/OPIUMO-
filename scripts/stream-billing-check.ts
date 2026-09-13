/**
 * npm run check:stream-billing -- --start     (opens a window)
 * npm run check:stream-billing -- --finish    (closes it, prints the two predictions)
 *
 * SETTLES A QUESTION NO NUMBER WE PRODUCE CAN SEE.
 *
 * Helius documents websocket streaming at "2 credits per 0.1 MB (uncompressed)"
 * (helius.dev/docs/billing/credits). Their FAQ says standard subscriptions and
 * LaserStream share an endpoint and does not say whether both are metered that
 * way. Our own meter counts HTTP calls and structurally cannot see a stream, so
 * every credit figure this project has ever reported is a floor, not a total.
 *
 * The test: over one window, our meter's RPC calls are known exactly. If
 * streams are billed, the account is also being charged for ~28-30 MB/minute of
 * Pump.fun and Raydium logs the bot subscribes to. Those two predictions differ
 * by roughly 5x per hour, so ONE glance at the dashboard usage graph separates
 * them - no precision required, no dashboard API needed.
 *
 * This opens NO websocket of its own. Measuring with a second subscription
 * would add its own streamed bytes to the very number under test.
 *
 * Reads local files and spends nothing.
 */
import fs from "fs";
import path from "path";

const WINDOW = path.join("reports", "stream-billing-window.json");
const METER = path.join("logs", "rpc-meter.jsonl");

/** Helius's published rate, kept in one place. */
export const CREDITS_PER_MB = 20;   // 2 credits per 0.1 MB

/** Helius: "2 credits per 0.1 MB (uncompressed)". */
export function streamCreditsFor(mb: number): number { return mb * CREDITS_PER_MB; }

/** Measured 2026-09-13 over two independent 60s windows: 29.6 and 28.06 MB/min. */
export const MEASURED_MB_PER_MIN = 28.8;

export interface MeterPoint { at: string; rpcCalls: number; startedAt: string }

/**
 * The meter's rpcCalls is cumulative PER PROCESS and resets to zero on restart,
 * so a delta across a restart is meaningless. Summing per-process maxima is the
 * only correct way to count calls over a window that may contain one.
 */
export function callsBetween(points: MeterPoint[], startIso: string, endIso: string): { calls: number; restarts: number; complete: boolean } {
  const inWindow = points.filter((p) => p.at >= startIso && p.at <= endIso);
  if (inWindow.length === 0) return { calls: 0, restarts: 0, complete: false };
  const byProcess = new Map<string, { first: number; last: number }>();
  for (const p of inWindow) {
    const cur = byProcess.get(p.startedAt);
    if (!cur) byProcess.set(p.startedAt, { first: p.rpcCalls, last: p.rpcCalls });
    else cur.last = Math.max(cur.last, p.rpcCalls);
  }
  // For the process already running when the window opened, count only the
  // growth inside it. For one that started inside, count everything it did.
  let calls = 0;
  for (const [startedAt, v] of byProcess) calls += startedAt < startIso ? v.last - v.first : v.last;
  return { calls, restarts: byProcess.size - 1, complete: true };
}

export function readMeter(file = METER): MeterPoint[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").trim().split("\n").flatMap((l) => {
    try { const r = JSON.parse(l); return r?.at && typeof r.rpcCalls === "number" ? [{ at: r.at, rpcCalls: r.rpcCalls, startedAt: r.startedAt }] : []; }
    catch { return []; }
  });
}

function fmt(n: number) { return Math.round(n).toLocaleString(); }

function start() {
  const points = readMeter();
  if (points.length === 0) { console.log("\n  logs/rpc-meter.jsonl is empty or missing - the bot must be running.\n"); return; }
  const at = new Date().toISOString();
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(WINDOW, JSON.stringify({ startedAt: at, meterAtStart: points[points.length - 1] }, null, 2));
  console.log(`\n  window OPEN at ${at}`);
  console.log(`  Leave the bot exactly as it is. Come back in an hour or more and run:`);
  console.log(`      npm run check:stream-billing -- --finish\n`);
}

function finish() {
  if (!fs.existsSync(WINDOW)) { console.log(`\n  no open window - run --start first.\n`); return; }
  const w = JSON.parse(fs.readFileSync(WINDOW, "utf-8"));
  const endedAt = new Date().toISOString();
  const points = readMeter();
  const { calls, restarts, complete } = callsBetween(points, w.startedAt, endedAt);
  const minutes = (Date.parse(endedAt) - Date.parse(w.startedAt)) / 60000;

  if (!complete) { console.log(`\n  the meter logged nothing in this window - is the bot running?\n`); return; }

  const streamCredits = streamCreditsFor(minutes * MEASURED_MB_PER_MIN);
  const ifNotBilled = calls;
  const ifBilled = calls + streamCredits;

  console.log(`\n=== is websocket streaming billed? — the window is closed ===\n`);
  console.log(`  window        ${w.startedAt}`);
  console.log(`             -> ${endedAt}`);
  console.log(`  duration      ${minutes.toFixed(0)} minutes${restarts ? `  (${restarts} bot restart(s) inside it, accounted for)` : ""}`);
  console.log(`  our meter     ${fmt(calls)} RPC calls = ${fmt(calls)} credits (every method in use costs 1)`);
  console.log(`  streamed      ~${fmt(minutes * MEASURED_MB_PER_MIN)} MB at the measured ${MEASURED_MB_PER_MIN} MB/min\n`);
  console.log(`  NOW OPEN THE HELIUS DASHBOARD USAGE GRAPH FOR THAT WINDOW.\n`);
  console.log(`      if it reads about ${fmt(ifNotBilled)}  -> streams are NOT billed. Our meter has been right.`);
  console.log(`      if it reads about ${fmt(ifBilled)}  -> streams ARE billed, and every credit`);
  console.log(`                                     figure this project has produced is a floor.\n`);
  console.log(`  They differ by ${(ifBilled / Math.max(ifNotBilled, 1)).toFixed(1)}x, so the graph does not need to be precise.\n`);

  const out = { ...w, endedAt, minutes, meterCalls: calls, restarts, measuredMbPerMin: MEASURED_MB_PER_MIN, streamedMb: minutes * MEASURED_MB_PER_MIN, predictionIfNotBilled: ifNotBilled, predictionIfBilled: ifBilled, dashboardReading: null, verdict: "UNKNOWN - awaiting the dashboard reading" };
  fs.writeFileSync(WINDOW, JSON.stringify(out, null, 2));
  console.log(`  -> ${WINDOW}  (verdict recorded as UNKNOWN until the dashboard is read)\n`);
}

if (require.main === module) {
  if (process.argv.includes("--finish")) finish();
  else if (process.argv.includes("--start")) start();
  else console.log("\n  usage: --start | --finish\n");
}
