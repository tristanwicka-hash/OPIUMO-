import { HeartbeatFile } from "../util/heartbeat";
import { ScheduleConfig, evaluateSchedule } from "../schedule/scheduler";

/**
 * Supervisor decision logic (NIGHT-PROMPT-V5 Project 1). Pure: no clock, no
 * filesystem, no processes - scripts/supervisor.ts supplies those. Kept pure
 * so the whole decision table is testable offline and so the mutation tests
 * can prove every branch is load-bearing.
 *
 * The supervisor runs in its OWN process. It reads the heartbeat file the bot
 * writes (see src/util/heartbeat.ts) and, during ON hours, restarts the bot
 * when the websocket has been silent for longer than `wsSilenceWindowMs`.
 * It never opens a network connection, so it spends zero RPC credits.
 */
export interface SupervisorConfig {
  enabled: boolean;
  /** Heartbeat file the bot writes; resolved against process.cwd() like every other path in config. */
  heartbeatFile: string;
  /** How often the bot writes the heartbeat file. */
  heartbeatWriteIntervalMs: number;
  /** Restart if no websocket message for this long during ON hours. Default 5 minutes. */
  wsSilenceWindowMs: number;
  /** How often the supervisor looks. */
  checkIntervalMs: number;
  /** After a restart (or a fresh start) leave the bot alone for this long before judging it again. */
  startupGraceMs: number;
  /**
   * SIGINT first; if the process is still there after this long, SIGKILL.
   * 35 s because the bot's graceful stop caps each of its three websocket
   * unsubscribes at 10 s - on a dead socket a clean shutdown takes ~30 s.
   */
  killGraceMs: number;
  /** Command the supervisor spawns to restart the bot. */
  startCommand: string[];
  /** Where the restarted bot's stdout/stderr are appended. */
  botStdoutFile: string;
  /** Supervisor's own structured log. Loud entries (RESTART) go here AND to stderr. */
  logFile: string;
}

export const DEFAULT_SUPERVISOR: SupervisorConfig = {
  enabled: true,
  heartbeatFile: "logs/heartbeat.json",
  heartbeatWriteIntervalMs: 5_000,
  wsSilenceWindowMs: 5 * 60_000,
  checkIntervalMs: 30_000,
  startupGraceMs: 5 * 60_000,
  killGraceMs: 35_000,
  startCommand: ["node", "dist/src/index.js"],
  botStdoutFile: "logs/bot-stdout.log",
  logFile: "logs/supervisor.jsonl",
};

export function validateSupervisor(s: SupervisorConfig): void {
  const pos = (k: keyof SupervisorConfig) => {
    const v = s[k];
    if (typeof v !== "number" || !(v > 0)) throw new Error(`supervisor.${String(k)} must be a positive number, got ${JSON.stringify(v)}`);
  };
  pos("heartbeatWriteIntervalMs"); pos("wsSilenceWindowMs"); pos("checkIntervalMs"); pos("startupGraceMs"); pos("killGraceMs");
  if (s.wsSilenceWindowMs <= s.heartbeatWriteIntervalMs) throw new Error("supervisor.wsSilenceWindowMs must exceed heartbeatWriteIntervalMs, or every tick looks silent");
  if (!Array.isArray(s.startCommand) || s.startCommand.length === 0) throw new Error("supervisor.startCommand must be a non-empty array");
}

export type SupervisorAction = "restart" | "wait" | "off-hours" | "grace" | "ok";

export interface SupervisorInput {
  nowMs: number;
  heartbeat: HeartbeatFile | null;
  /** Whether a bot process is alive (pid from the heartbeat, or found by name). null = could not tell. */
  botAlive: boolean | null;
  /** When the supervisor last restarted/started the bot, or null if never this session. */
  lastRestartAtMs: number | null;
  /** When the supervisor itself started - a missing heartbeat is judged against this, not against epoch. */
  supervisorStartedAtMs: number;
  /**
   * The last time the supervisor READ a well-formed heartbeat, or null if never.
   * A heartbeat that vanishes is judged from the moment it vanished, not from
   * the supervisor's start: on 2026-09-12 the live tick read "unreadable for
   * 211s of 300s" three seconds after the file was broken, because the only
   * reference it had was its own start 3.5 minutes earlier.
   */
  lastReadableAtMs?: number | null;
  schedule: ScheduleConfig;
  ignoreSchedule?: boolean;
  config: Pick<SupervisorConfig, "wsSilenceWindowMs" | "startupGraceMs" | "heartbeatWriteIntervalMs">;
}

export interface SupervisorDecision {
  action: SupervisorAction;
  reason: string;
  /** Milliseconds since the last websocket message (or since the reference point when unknown), for the log. */
  silentForMs: number | null;
  /** Milliseconds since the heartbeat file was last written, or null when unreadable. */
  heartbeatAgeMs: number | null;
}

/**
 * The decision table:
 *  - OFF hours (schedule says outside window): never restart. A quiet OFF hour is expected.
 *  - inside startup grace after our own restart: wait.
 *  - heartbeat unreadable: the bot is either not running or cannot write. Judged
 *    against the latest of (supervisor start, last restart, last time a readable
 *    heartbeat was seen): once THAT is older than the window, restart. Never
 *    restart on the first tick.
 *  - heartbeat readable but its updatedAt is older than the window: the writer
 *    is frozen or dead (the process may still exist). Restart.
 *  - heartbeat fresh but lastWsMessageAt (or, if none yet, startedAt) older
 *    than the window: the socket is dead while the process is alive - the
 *    2026-09-12 outage shape. Restart.
 *  - otherwise: ok.
 */
export function decideSupervisor(input: SupervisorInput): SupervisorDecision {
  const { nowMs, heartbeat, config } = input;
  const window = config.wsSilenceWindowMs;

  if (!input.ignoreSchedule) {
    const sched = evaluateSchedule(input.schedule, new Date(nowMs));
    if (!sched.active) {
      return { action: "off-hours", reason: `schedule OFF: ${sched.detail}`, silentForMs: null, heartbeatAgeMs: heartbeat ? nowMs - Date.parse(heartbeat.updatedAt) : null };
    }
  }

  if (input.lastRestartAtMs !== null && nowMs - input.lastRestartAtMs < config.startupGraceMs) {
    return { action: "grace", reason: `restarted ${Math.round((nowMs - input.lastRestartAtMs) / 1000)}s ago; startup grace is ${Math.round(config.startupGraceMs / 1000)}s`, silentForMs: null, heartbeatAgeMs: heartbeat ? nowMs - Date.parse(heartbeat.updatedAt) : null };
  }

  if (!heartbeat) {
    const ref = Math.max(input.supervisorStartedAtMs, input.lastRestartAtMs ?? 0, input.lastReadableAtMs ?? 0);
    const sinceRef = nowMs - ref;
    if (sinceRef >= window) {
      return {
        action: "restart",
        reason: `heartbeat file unreadable for ${Math.round(sinceRef / 1000)}s (window ${Math.round(window / 1000)}s); bot process ${input.botAlive === null ? "state unknown" : input.botAlive ? "alive but not writing" : "not found"}`,
        silentForMs: sinceRef,
        heartbeatAgeMs: null,
      };
    }
    return { action: "wait", reason: `heartbeat file unreadable; waiting (${Math.round(sinceRef / 1000)}s of ${Math.round(window / 1000)}s)`, silentForMs: sinceRef, heartbeatAgeMs: null };
  }

  const heartbeatAgeMs = nowMs - Date.parse(heartbeat.updatedAt);
  if (heartbeatAgeMs >= window) {
    return {
      action: "restart",
      reason: `heartbeat not written for ${Math.round(heartbeatAgeMs / 1000)}s (window ${Math.round(window / 1000)}s) - the bot process is frozen or gone (pid ${heartbeat.pid}, ${input.botAlive === null ? "state unknown" : input.botAlive ? "still alive" : "not found"})`,
      silentForMs: heartbeatAgeMs,
      heartbeatAgeMs,
    };
  }

  const lastWs = heartbeat.lastWsMessageAt !== null ? Date.parse(heartbeat.lastWsMessageAt) : Date.parse(heartbeat.startedAt);
  const silentForMs = nowMs - lastWs;
  if (silentForMs >= window) {
    return {
      action: "restart",
      reason: heartbeat.lastWsMessageAt === null
        ? `no websocket message since the bot started ${Math.round(silentForMs / 1000)}s ago (window ${Math.round(window / 1000)}s); process alive and writing heartbeats - the socket never came up`
        : `websocket silent for ${Math.round(silentForMs / 1000)}s (window ${Math.round(window / 1000)}s) while the process is alive and writing heartbeats - dead socket (pid ${heartbeat.pid})`,
      silentForMs,
      heartbeatAgeMs,
    };
  }

  return { action: "ok", reason: `last websocket message ${Math.round(silentForMs / 1000)}s ago`, silentForMs, heartbeatAgeMs };
}
