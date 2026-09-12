/**
 * OPIUMO test: liveness heartbeat + supervisor decisions (offline).
 *
 * Covers NIGHT-PROMPT-V5 Project 1:
 *   - the heartbeat writer records ws-message and detection times, writes
 *     atomically, survives a failed write (counts it, warns once a minute,
 *     never throws), and its reader returns null ("unknown") for anything
 *     malformed - never a zero.
 *   - the supervisor decision table, including the exact shape of the
 *     2026-09-12 outage (process alive and writing heartbeats, socket dead).
 *   - the PoolWatcher emits "wsMessage" on slot changes AND program logs.
 *   - the supervisor process, run --once --dry-run against a fixture, decides
 *     "restart" for a dead socket and opens no network socket.
 *
 * Deterministic: injected clock everywhere. RPC_URL is set to an unroutable
 * address so loadConfig() passes without any network.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { HeartbeatWriter, readHeartbeat, HeartbeatFile } from "../src/util/heartbeat";
import { decideSupervisor, DEFAULT_SUPERVISOR, validateSupervisor, SupervisorInput } from "../src/supervisor/supervisor";
import { findBotPids } from "../src/supervisor/run";
import { ScheduleConfig, DEFAULT_SCHEDULE } from "../src/schedule/scheduler";

process.env.RPC_URL = process.env.RPC_URL || "http://127.0.0.1:1";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opiumo-hb-"));
const MIN = 60_000;

// ---- Heartbeat writer -------------------------------------------------------
console.log("\nHeartbeat writer");
{
  let now = Date.parse("2026-09-12T12:00:00Z");
  const warnings: string[] = [];
  const file = path.join(tmp, "hb", "heartbeat.json");
  const hb = new HeartbeatWriter({ file, writeIntervalMs: 5000, now: () => now, warn: (m) => warnings.push(m) });
  check("write() creates the file and its directory", hb.write() && fs.existsSync(file));
  const first = readHeartbeat(file)!;
  check("fresh heartbeat has null timestamps, not zero/epoch", first.lastWsMessageAt === null && first.lastDetectionAt === null);
  check("fresh heartbeat records pid and startedAt", first.pid === process.pid && first.startedAt === new Date(now).toISOString());
  now += 7_000; hb.wsMessage(); hb.wsMessage();
  now += 1_000; hb.detection();
  hb.write();
  const second = readHeartbeat(file)!;
  check("lastWsMessageAt is the time of the last wsMessage()", second.lastWsMessageAt === new Date(Date.parse("2026-09-12T12:00:07Z")).toISOString());
  check("lastDetectionAt is the time of the last detection()", second.lastDetectionAt === new Date(Date.parse("2026-09-12T12:00:08Z")).toISOString());
  check("counts are kept", second.wsMessages === 2 && second.detections === 1);
  check("updatedAt is the write time", second.updatedAt === new Date(now).toISOString());
  check("no tmp file left behind", fs.readdirSync(path.dirname(file)).length === 1);

  // Broken write: the target path is a directory, so rename() fails.
  const blockedDir = path.join(tmp, "blocked", "heartbeat.json");
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(path.join(blockedDir, "occupant"), "x"); // non-empty so rename cannot replace it
  const hb2 = new HeartbeatWriter({ file: blockedDir, now: () => now, warn: (m) => warnings.push(m) });
  const ok1 = hb2.write();
  const ok2 = hb2.write();
  check("a failed write returns false and does not throw", ok1 === false && ok2 === false);
  check("failed writes are counted", hb2.snapshot().writeFailures === 2);
  check("failure warned once, not per attempt, inside a minute", warnings.length === 1 && /heartbeat write .* failed/.test(warnings[0]));
  now += 61_000; hb2.write();
  check("warns again after a minute", warnings.length === 2);
  check("a directory at the heartbeat path reads as unknown (null)", readHeartbeat(blockedDir) === null);
  check("tmp file cleaned after a failed rename", !fs.readdirSync(path.dirname(blockedDir)).some((f) => f.endsWith(".tmp")));
}

// ---- Reader rejects malformed input --------------------------------------
console.log("\nHeartbeat reader");
{
  const f = path.join(tmp, "r.json");
  const cases: Array<[string, string]> = [
    ["missing file", "__missing__"],
    ["garbage", "{garbage"],
    ["empty object", "{}"],
    ["pid as string", JSON.stringify({ pid: "1", updatedAt: "2026-09-12T00:00:00Z", lastWsMessageAt: null, lastDetectionAt: null })],
    ["bad updatedAt", JSON.stringify({ pid: 1, updatedAt: "yesterday", lastWsMessageAt: null, lastDetectionAt: null })],
    ["lastWsMessageAt zero", JSON.stringify({ pid: 1, updatedAt: "2026-09-12T00:00:00Z", lastWsMessageAt: 0, lastDetectionAt: null })],
    ["lastDetectionAt bad string", JSON.stringify({ pid: 1, updatedAt: "2026-09-12T00:00:00Z", lastWsMessageAt: null, lastDetectionAt: "0 min ago" })],
  ];
  for (const [name, body] of cases) {
    if (body === "__missing__") { try { fs.unlinkSync(f); } catch { /* absent */ } } else fs.writeFileSync(f, body);
    check(`reader returns null for ${name}`, readHeartbeat(f) === null);
  }
  fs.writeFileSync(f, JSON.stringify({ pid: 1, startedAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:05Z", lastWsMessageAt: "2026-09-12T00:00:04Z", lastDetectionAt: null, wsMessages: 3, detections: 0, writeFailures: 0 }));
  check("reader accepts a well-formed heartbeat", readHeartbeat(f)?.wsMessages === 3);
}

// ---- Decision table --------------------------------------------------------
console.log("\nSupervisor decisions");
const ON_ALWAYS: ScheduleConfig = { ...DEFAULT_SCHEDULE, enabled: false };
// Enabled schedule: ON 12:00-07:00 UTC (same shape as the live config), so 09:00Z is OFF.
const LIVE_SHAPE: ScheduleConfig = { ...DEFAULT_SCHEDULE, enabled: true, timezone: "UTC", activeWindows: [{ days: "all", start: "12:00", end: "07:00" }] } as ScheduleConfig;
const T0 = Date.parse("2026-09-12T13:00:00Z"); // ON under LIVE_SHAPE
const T_OFF = Date.parse("2026-09-12T09:00:00Z"); // OFF under LIVE_SHAPE

function hbAt(opts: { updatedAgoMs: number; wsAgoMs: number | null; startedAgoMs?: number; now?: number }): HeartbeatFile {
  const now = opts.now ?? T0;
  const startedAgo = opts.startedAgoMs ?? 60 * MIN;
  return {
    pid: 4242, startedAt: new Date(now - startedAgo).toISOString(), updatedAt: new Date(now - opts.updatedAgoMs).toISOString(),
    lastWsMessageAt: opts.wsAgoMs === null ? null : new Date(now - opts.wsAgoMs).toISOString(), lastDetectionAt: null,
    wsMessages: 10, detections: 0, writeFailures: 0,
  };
}
function decide(over: Partial<SupervisorInput>) {
  const base: SupervisorInput = {
    nowMs: T0, heartbeat: hbAt({ updatedAgoMs: 3_000, wsAgoMs: 2_000 }), botAlive: true, lastRestartAtMs: null,
    supervisorStartedAtMs: T0 - 60 * MIN, schedule: ON_ALWAYS, config: DEFAULT_SUPERVISOR,
  };
  return decideSupervisor({ ...base, ...over });
}
{
  check("fresh heartbeat + recent ws message -> ok", decide({}).action === "ok");
  const outage = decide({ heartbeat: hbAt({ updatedAgoMs: 3_000, wsAgoMs: 6 * MIN }) });
  check("OUTAGE SHAPE: process alive, heartbeats fresh, socket silent 6 min -> restart", outage.action === "restart", outage.reason);
  check("  ...reason names the dead socket and the pid", /dead socket/.test(outage.reason) && /4242/.test(outage.reason));
  check("  ...silentForMs is the ws silence, not the heartbeat age", outage.silentForMs === 6 * MIN && outage.heartbeatAgeMs === 3_000);
  check("socket silent 4m59s -> ok (window is 5 min)", decide({ heartbeat: hbAt({ updatedAgoMs: 3_000, wsAgoMs: 5 * MIN - 1000 }) }).action === "ok");
  check("socket silent exactly 5m -> restart", decide({ heartbeat: hbAt({ updatedAgoMs: 3_000, wsAgoMs: 5 * MIN }) }).action === "restart");
  const frozen = decide({ heartbeat: hbAt({ updatedAgoMs: 6 * MIN, wsAgoMs: 6 * MIN }) });
  check("heartbeat itself not written for 6 min -> restart (frozen/dead process)", frozen.action === "restart" && /not written/.test(frozen.reason));
  const neverUp = decide({ heartbeat: hbAt({ updatedAgoMs: 2_000, wsAgoMs: null, startedAgoMs: 6 * MIN }) });
  check("no ws message ever, started 6 min ago -> restart", neverUp.action === "restart" && /never came up/.test(neverUp.reason));
  check("no ws message ever, started 2 min ago -> ok (judged from startedAt)", decide({ heartbeat: hbAt({ updatedAgoMs: 2_000, wsAgoMs: null, startedAgoMs: 2 * MIN }) }).action === "ok");

  check("OFF hours + dead socket -> off-hours, never restart", decide({ nowMs: T_OFF, schedule: LIVE_SHAPE, heartbeat: hbAt({ updatedAgoMs: 3_000, wsAgoMs: 30 * MIN, now: T_OFF }) }).action === "off-hours");
  check("ON hours under the live-shaped schedule + dead socket -> restart", decide({ schedule: LIVE_SHAPE, heartbeat: hbAt({ updatedAgoMs: 3_000, wsAgoMs: 30 * MIN }) }).action === "restart");
  check("--ignore-schedule overrides OFF hours", decide({ nowMs: T_OFF, schedule: LIVE_SHAPE, ignoreSchedule: true, heartbeat: hbAt({ updatedAgoMs: 3_000, wsAgoMs: 30 * MIN, now: T_OFF }) }).action === "restart");

  check("just restarted (2 min ago) + silence -> grace, not a restart loop", decide({ lastRestartAtMs: T0 - 2 * MIN, heartbeat: hbAt({ updatedAgoMs: 3_000, wsAgoMs: 30 * MIN }) }).action === "grace");
  check("restarted 6 min ago + still silent -> restart again", decide({ lastRestartAtMs: T0 - 6 * MIN, heartbeat: hbAt({ updatedAgoMs: 3_000, wsAgoMs: 30 * MIN }) }).action === "restart");

  check("no heartbeat, supervisor just started -> wait (never restart on first sight)", decide({ heartbeat: null, supervisorStartedAtMs: T0 - 10_000 }).action === "wait");
  const noHb = decide({ heartbeat: null, supervisorStartedAtMs: T0 - 6 * MIN, botAlive: false });
  check("no heartbeat for 6 min since supervisor start, no process -> restart", noHb.action === "restart" && /not found/.test(noHb.reason));
  const noHbAlive = decide({ heartbeat: null, supervisorStartedAtMs: T0 - 6 * MIN, botAlive: true });
  check("no heartbeat for 6 min but a process exists -> restart, reason says 'alive but not writing'", noHbAlive.action === "restart" && /alive but not writing/.test(noHbAlive.reason));
  const vanished = decide({ heartbeat: null, supervisorStartedAtMs: T0 - 60 * MIN, lastReadableAtMs: T0 - 40_000, botAlive: true });
  check("heartbeat readable 40 s ago, now unreadable, supervisor up an hour -> wait (judged from when it vanished, live bug 2026-09-12)", vanished.action === "wait" && /40s of 300s/.test(vanished.reason), vanished.reason);
  check("heartbeat last readable 6 min ago, now unreadable -> restart", decide({ heartbeat: null, supervisorStartedAtMs: T0 - 60 * MIN, lastReadableAtMs: T0 - 6 * MIN }).action === "restart");
  check("no heartbeat but we restarted 3 min ago -> grace", decide({ heartbeat: null, supervisorStartedAtMs: T0 - 60 * MIN, lastRestartAtMs: T0 - 3 * MIN }).action === "grace");
  check("no heartbeat, restarted 6 min ago (grace over), still nothing -> restart", decide({ heartbeat: null, supervisorStartedAtMs: T0 - 60 * MIN, lastRestartAtMs: T0 - 6 * MIN }).action === "restart");

  // custom window
  const cfg = { ...DEFAULT_SUPERVISOR, wsSilenceWindowMs: 60_000, startupGraceMs: 60_000 };
  check("configurable window: 90 s silence restarts under a 60 s window", decide({ config: cfg, heartbeat: hbAt({ updatedAgoMs: 3_000, wsAgoMs: 90_000 }) }).action === "restart");
  check("configurable window: 90 s silence is ok under the default 5-min window", decide({ heartbeat: hbAt({ updatedAgoMs: 3_000, wsAgoMs: 90_000 }) }).action === "ok");
}

// ---- Config validation -----------------------------------------------------
console.log("\nSupervisor config validation");
{
  const throws = (f: () => void) => { try { f(); return false; } catch { return true; } };
  check("defaults validate", !throws(() => validateSupervisor(DEFAULT_SUPERVISOR)));
  check("window must exceed write interval", throws(() => validateSupervisor({ ...DEFAULT_SUPERVISOR, wsSilenceWindowMs: 5000 })));
  check("negative check interval rejected", throws(() => validateSupervisor({ ...DEFAULT_SUPERVISOR, checkIntervalMs: -1 })));
  check("empty start command rejected", throws(() => validateSupervisor({ ...DEFAULT_SUPERVISOR, startCommand: [] })));
  check("default window is 5 minutes, default check every 30 s", DEFAULT_SUPERVISOR.wsSilenceWindowMs === 300_000 && DEFAULT_SUPERVISOR.checkIntervalMs === 30_000);
}

// ---- Bot process matching --------------------------------------------------
console.log("\nBot process matching (findBotPids)");
{
  const ps = [
    "  101 /usr/local/bin/node dist/src/index.js",
    "  102 node dist/src/index.js",
    "  103 /bin/bash -c cd ~/x && nohup node dist/src/index.js >> logs/bot-stdout.log 2>&1 &",
    "  104 grep dist/src/index.js logs/x",
    "  105 node dist/src/supervisor/run.js",
    "  106 node dist/src/index.js --extra",
    "  107 /usr/local/bin/node dist/src/perpsIndex.js",
    `  ${process.pid} node dist/src/index.js`,
  ].join("\n");
  const found = findBotPids(["node", "dist/src/index.js"], ps);
  check("matches node processes whose arguments are exactly the start command (absolute or bare node)", JSON.stringify(found) === "[101,102]", JSON.stringify(found));
  check("the bash wrapper that launched the bot is NOT matched (live bug 2026-09-12)", !found.includes(103));
  check("a grep mentioning the file is NOT matched", !found.includes(104));
  check("the supervisor itself is NOT matched", !found.includes(105));
  check("extra arguments do not match", !found.includes(106));
  check("our own pid is excluded", !found.includes(process.pid));
  const live = findBotPids(["node", "dist/src/index.js"]);
  check("against the real process table: returns only numbers (may be empty on a test machine)", live.every((n) => Number.isInteger(n) && n > 0));
}

// ---- Watcher emits wsMessage ----------------------------------------------
console.log("\nPoolWatcher wsMessage emission");
async function watcherEmits() {
  const { PoolWatcher } = await import("../src/watcher");
  let slotCb: (() => void) | null = null;
  const logCbs: Array<(l: any) => void> = [];
  let nextId = 1;
  const conn: any = {
    onLogs: (_p: any, cb: (l: any) => void) => { logCbs.push(cb); return nextId++; },
    onSlotChange: (cb: () => void) => { slotCb = cb; return nextId++; },
    removeOnLogsListener: async () => {}, removeSlotChangeListener: async () => {},
  };
  const w = new PoolWatcher(conn, { healthCheckIntervalMs: 60_000 });
  let n = 0;
  w.on("wsMessage", () => n++);
  w.start();
  slotCb!();
  check("slot change emits wsMessage", n === 1);
  // A program log that is NOT a create still counts as a websocket message.
  logCbs[0]({ err: null, signature: "sig1", logs: ["Program log: something unrelated"] });
  check("an unrelated program log emits wsMessage", n === 2);
  logCbs[0]({ err: { some: "error" }, signature: "sig2", logs: [] });
  check("a failed-tx log still emits wsMessage (the socket is alive)", n === 3);
  await w.stop();
}

// ---- Supervisor process, --once --dry-run ------------------------------------
console.log("\nSupervisor process (--once --dry-run)");
function runOnce(hbFile: string, extra: string[] = []) {
  const logFile = path.join(tmp, `sup-${Math.random().toString(36).slice(2)}.jsonl`);
  const stateFile = logFile.replace(".jsonl", "-state.json");
  const out = execFileSync("npx", ["ts-node", "--transpile-only", "src/supervisor/run.ts", "--once", "--dry-run", "--ignore-schedule", "--heartbeat-file", hbFile, "--log-file", logFile, "--state-file", stateFile, ...extra], {
    encoding: "utf8", cwd: process.cwd(), env: { ...process.env, RPC_URL: "http://127.0.0.1:1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  return { out: JSON.parse(out), log: fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)), state: JSON.parse(fs.readFileSync(stateFile, "utf8")) };
}
function processChecks() {
  const now = Date.now();
  const dead = path.join(tmp, "dead-socket.json");
  fs.writeFileSync(dead, JSON.stringify({ pid: 999999, startedAt: new Date(now - 3600e3).toISOString(), updatedAt: new Date(now - 2000).toISOString(), lastWsMessageAt: new Date(now - 10 * MIN).toISOString(), lastDetectionAt: null, wsMessages: 1, detections: 0, writeFailures: 0 }));
  const r = runOnce(dead);
  check("dead-socket fixture -> process decides restart", r.out.decision.action === "restart", JSON.stringify(r.out.decision));
  check("dry run: RESTART entry logged LOUD with dryRun true and no new pid", r.log.some((e) => e.event === "RESTART" && e.level === "LOUD" && e.dryRun === true && e.newPid === null));
  check("state file records the decision", r.state.lastAction === "restart" && r.state.dryRun === true);

  const fine = path.join(tmp, "fine.json");
  fs.writeFileSync(fine, JSON.stringify({ pid: 999999, startedAt: new Date(now - 3600e3).toISOString(), updatedAt: new Date(now - 2000).toISOString(), lastWsMessageAt: new Date(now - 1000).toISOString(), lastDetectionAt: null, wsMessages: 1, detections: 0, writeFailures: 0 }));
  const r2 = runOnce(fine);
  check("fresh fixture -> ok, no RESTART entry", r2.out.decision.action === "ok" && !r2.log.some((e) => e.event === "RESTART"));
  const eightSec = path.join(tmp, "eight.json");
  fs.writeFileSync(eightSec, JSON.stringify({ pid: 999999, startedAt: new Date(now - 3600e3).toISOString(), updatedAt: new Date(now - 2000).toISOString(), lastWsMessageAt: new Date(now - 8000).toISOString(), lastDetectionAt: null, wsMessages: 1, detections: 0, writeFailures: 0 }));
  const r3 = runOnce(eightSec, ["--window-ms", "6000"]);
  check("--window-ms 6000 turns an 8-second silence into a restart (window is configurable end to end)", r3.out.decision.action === "restart");
  let rejected = false;
  try { runOnce(eightSec, ["--window-ms", "500"]); } catch (err: any) { rejected = /must exceed heartbeatWriteIntervalMs/.test(String(err?.stderr || err)); }
  check("a window shorter than the heartbeat write interval is refused at startup", rejected);

  // Zero network: the run.ts module graph must not reach @solana/web3.js or the Connection.
  const probe = path.join(tmp, "modgraph.js"); // plain JS outside the repo so ts-node uses the repo tsconfig for the src it requires
  fs.writeFileSync(probe, [
    'process.env.RPC_URL = "http://127.0.0.1:1";',
    `require(${JSON.stringify(path.join(process.cwd(), "src/supervisor/run"))});`,
    "const loaded = Object.keys(require.cache);",
    'console.log(JSON.stringify({ web3: loaded.filter((f) => /@solana\\/web3\\.js|rpc\\/connection/.test(f)).length, total: loaded.length }));',
  ].join("\n"));
  const modules = execFileSync("node", ["-r", "ts-node/register/transpile-only", probe], { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const m = JSON.parse(modules.trim().split("\n").pop()!);
  check(`supervisor module graph loads no @solana/web3.js and no rpc/connection (${m.total} modules loaded)`, m.web3 === 0, JSON.stringify(m));
}

(async () => {
  await watcherEmits();
  processChecks();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); console.log(`\nTotal: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
