/**
 * OPIUMO supervisor - a SEPARATE process that watches the bot's liveness
 * heartbeat and restarts the bot when the websocket goes quiet during ON
 * hours (NIGHT-PROMPT-V5 Project 1).
 *
 *   npm run supervisor                      # default config (5-minute window)
 *   npm run supervisor -- --once            # one tick, print the decision, exit
 *   npm run supervisor -- --dry-run         # decide and log, never kill or spawn
 *   npm run supervisor -- --window-ms 60000 --check-ms 10000 --ignore-schedule
 *
 * Why a separate process: on 2026-09-12 the watcher's own health timer was
 * cleared by the very stop() that then hung, so nothing inside the event loop
 * could ever fire again. A guard that shares the event loop it guards dies
 * with it.
 *
 * Zero credits by construction: this file imports fs, path, child_process and
 * the pure config/schedule/decision modules only. No @solana/web3.js, no
 * Connection, no fetch. The live proof is `lsof -p <supervisor pid> -iTCP`
 * showing no sockets and the meter's process list not containing it.
 */
import fs from "fs";
import path from "path";
import { execFileSync, spawn } from "child_process";
import { loadConfig } from "../config";
import { readHeartbeat } from "../util/heartbeat";
import { decideSupervisor, SupervisorAction, SupervisorConfig, validateSupervisor } from "./supervisor";

interface Args {
  once: boolean;
  dryRun: boolean;
  ignoreSchedule: boolean;
  windowMs?: number;
  checkMs?: number;
  heartbeatFile?: string;
  logFile?: string;
  stateFile?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { once: false, dryRun: false, ignoreSchedule: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === "--once") a.once = true;
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--ignore-schedule") a.ignoreSchedule = true;
    else if (k === "--window-ms") a.windowMs = Number(v());
    else if (k === "--check-ms") a.checkMs = Number(v());
    else if (k === "--heartbeat-file") a.heartbeatFile = v();
    else if (k === "--log-file") a.logFile = v();
    else if (k === "--state-file") a.stateFile = v();
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

export interface SupervisorState {
  pid: number;
  startedAt: string;
  lastTickAt: string;
  lastAction: SupervisorAction | null;
  lastReason: string | null;
  lastRestartAt: string | null;
  restarts: number;
  windowMs: number;
  checkIntervalMs: number;
  dryRun: boolean;
  ignoreSchedule: boolean;
  botPid: number | null;
}

function appendJsonl(file: string, row: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  } catch (err: any) {
    process.stderr.write(`supervisor: could not append to ${file}: ${err?.message || err}\n`);
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (err: any) {
    process.stderr.write(`supervisor: could not write ${file}: ${err?.message || err}\n`);
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === "EPERM"; }
}

/**
 * Every process that IS the bot: executable basename equals startCommand[0]
 * ("node") and the arguments equal the rest ("dist/src/index.js"), exactly.
 * Excludes ourselves.
 *
 * Not `pgrep -f`: on 2026-09-12 the first live tick matched the bash wrapper
 * that had launched the bot, because its command line CONTAINED the string.
 * A supervisor that SIGKILLs every process whose command line mentions the
 * bot would kill shells, editors and greps. Matching the parsed command line
 * exactly cannot.
 */
export function findBotPids(startCommand: string[], psOutput?: string): number[] {
  const wantExe = path.basename(startCommand[0]);
  const wantArgs = startCommand.slice(1).join(" ");
  let out = psOutput;
  if (out === undefined) {
    try { out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }); } catch { return []; }
  }
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    const parts = m[2].trim().split(/\s+/);
    if (parts.length === 0) continue;
    const exe = path.basename(parts[0]);
    const args = parts.slice(1).join(" ");
    if (exe === wantExe && args === wantArgs) pids.push(pid);
  }
  return pids;
}

async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/**
 * SIGINT first - that is the signal the bot's graceful shutdown handler is on
 * (src/index.ts), so pending checkpoints and the final tally are written -
 * then wait up to killGraceMs, then SIGKILL whatever is left (a frozen process
 * never handles a catchable signal). Returns what happened to each pid.
 */
async function stopPids(pids: number[], killGraceMs: number): Promise<Array<{ pid: number; how: "int" | "kill" | "gone" }>> {
  const result: Array<{ pid: number; how: "int" | "kill" | "gone" }> = [];
  for (const pid of pids) {
    if (!pidAlive(pid)) { result.push({ pid, how: "gone" }); continue; }
    try { process.kill(pid, "SIGINT"); } catch { /* fallthrough to the alive check */ }
    const deadline = Date.now() + killGraceMs;
    while (Date.now() < deadline && pidAlive(pid)) await sleep(200);
    if (pidAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* it may have just exited */ }
      await sleep(300);
      result.push({ pid, how: "kill" });
    } else {
      result.push({ pid, how: "int" });
    }
  }
  return result;
}

function startBot(cfg: SupervisorConfig): number | null {
  fs.mkdirSync(path.dirname(cfg.botStdoutFile), { recursive: true });
  const out = fs.openSync(cfg.botStdoutFile, "a");
  const [cmd, ...args] = cfg.startCommand;
  const child = spawn(cmd, args, { cwd: process.cwd(), detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  fs.closeSync(out);
  return child.pid ?? null;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const base = loadConfig().supervisor;
  const cfg: SupervisorConfig = {
    ...base,
    wsSilenceWindowMs: args.windowMs ?? base.wsSilenceWindowMs,
    checkIntervalMs: args.checkMs ?? base.checkIntervalMs,
    heartbeatFile: args.heartbeatFile ?? base.heartbeatFile,
    logFile: args.logFile ?? base.logFile,
  };
  validateSupervisor(cfg);
  const schedule = loadConfig().schedule;
  const stateFile = args.stateFile ?? path.join(path.dirname(cfg.logFile), "supervisor-state.json");

  if (!cfg.enabled && !args.once) {
    process.stderr.write("supervisor.enabled is false in config/default.json - exiting without doing anything\n");
    return;
  }

  const startedAtMs = Date.now();
  let lastRestartAtMs: number | null = null;
  let restarts = 0;
  let lastAction: SupervisorAction | null = null;
  let lastReason: string | null = null;
  let lastReadableAtMs: number | null = null;
  let lastSummaryAtMs = startedAtMs;
  let stopping = false;

  appendJsonl(cfg.logFile, {
    ts: new Date().toISOString(), level: "info", event: "supervisor-start", pid: process.pid,
    windowMs: cfg.wsSilenceWindowMs, checkIntervalMs: cfg.checkIntervalMs, heartbeatFile: cfg.heartbeatFile,
    dryRun: args.dryRun, ignoreSchedule: args.ignoreSchedule, once: args.once,
  });

  const tick = async (): Promise<void> => {
    const nowMs = Date.now();
    const heartbeat = readHeartbeat(cfg.heartbeatFile);
    if (heartbeat) lastReadableAtMs = nowMs;
    const namedPids = findBotPids(cfg.startCommand);
    const hbPidAlive = heartbeat ? pidAlive(heartbeat.pid) : null;
    const botAlive: boolean | null = namedPids.length > 0 ? true : hbPidAlive === true ? true : hbPidAlive === false ? false : namedPids.length === 0 ? false : null;
    const decision = decideSupervisor({
      nowMs, heartbeat, botAlive, lastRestartAtMs, supervisorStartedAtMs: startedAtMs, lastReadableAtMs,
      schedule, ignoreSchedule: args.ignoreSchedule, config: cfg,
    });

    const changed = decision.action !== lastAction;
    const summaryDue = nowMs - lastSummaryAtMs >= 60 * 60_000;
    if (changed || summaryDue || args.once) {
      appendJsonl(cfg.logFile, {
        ts: new Date(nowMs).toISOString(), level: decision.action === "restart" ? "LOUD" : "info",
        event: changed ? "state-change" : "hourly", action: decision.action, reason: decision.reason,
        silentForMs: decision.silentForMs, heartbeatAgeMs: decision.heartbeatAgeMs, botPids: namedPids, heartbeatPid: heartbeat?.pid ?? null,
      });
      if (summaryDue) lastSummaryAtMs = nowMs;
    }

    if (decision.action === "restart") {
      const banner = `\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n` +
        `!!! SUPERVISOR RESTART ${new Date(nowMs).toISOString()}${args.dryRun ? " (DRY RUN - not acting)" : ""}\n` +
        `!!! reason: ${decision.reason}\n` +
        `!!! bot pids: ${namedPids.length ? namedPids.join(", ") : "none found"}${heartbeat ? ` (heartbeat pid ${heartbeat.pid})` : " (no readable heartbeat)"}\n` +
        `!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`;
      process.stderr.write(banner);
      const targets = Array.from(new Set([...namedPids, ...(heartbeat && hbPidAlive ? [heartbeat.pid] : [])]));
      let stopped: Array<{ pid: number; how: string }> = [];
      let newPid: number | null = null;
      if (!args.dryRun) {
        stopped = await stopPids(targets, cfg.killGraceMs);
        newPid = startBot(cfg);
        lastRestartAtMs = Date.now();
        restarts++;
      }
      appendJsonl(cfg.logFile, {
        ts: new Date().toISOString(), level: "LOUD", event: "RESTART", dryRun: args.dryRun, reason: decision.reason,
        silentForMs: decision.silentForMs, heartbeatAgeMs: decision.heartbeatAgeMs, stopped, newPid, restarts,
      });
      process.stderr.write(`!!! ${args.dryRun ? "would have restarted" : `restarted: stopped ${JSON.stringify(stopped)}, new pid ${newPid}`}\n`);
    }

    lastAction = decision.action;
    lastReason = decision.reason;
    const state: SupervisorState = {
      pid: process.pid, startedAt: new Date(startedAtMs).toISOString(), lastTickAt: new Date(nowMs).toISOString(),
      lastAction, lastReason, lastRestartAt: lastRestartAtMs === null ? null : new Date(lastRestartAtMs).toISOString(), restarts,
      windowMs: cfg.wsSilenceWindowMs, checkIntervalMs: cfg.checkIntervalMs, dryRun: args.dryRun, ignoreSchedule: args.ignoreSchedule,
      botPid: namedPids[0] ?? heartbeat?.pid ?? null,
    };
    writeJsonAtomic(stateFile, state);
    if (args.once) {
      process.stdout.write(JSON.stringify({ decision, heartbeat, botPids: namedPids, state }, null, 2) + "\n");
    }
  };

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    appendJsonl(cfg.logFile, { ts: new Date().toISOString(), level: "info", event: "supervisor-stop", pid: process.pid, restarts });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await tick();
  if (args.once) return;
  while (!stopping) {
    await sleep(cfg.checkIntervalMs);
    try { await tick(); } catch (err: any) {
      appendJsonl(cfg.logFile, { ts: new Date().toISOString(), level: "error", event: "tick-failed", error: String(err?.message || err) });
    }
  }
}

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`supervisor failed: ${err?.stack || err}\n`); process.exit(1); });
}
