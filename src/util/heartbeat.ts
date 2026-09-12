import fs from "fs";
import path from "path";

/**
 * Liveness heartbeat (NIGHT-PROMPT-V5 Project 1).
 *
 * The bot records two timestamps: the last time the websocket delivered
 * ANYTHING (a slot change or a program log - either proves the socket is
 * alive) and the last time a new pool was actually detected. They are
 * written to a small JSON file, atomically (temp file + rename), at most
 * once per `writeIntervalMs`, so a reader in another process - the
 * supervisor, the Dashboard - can tell a quiet night from a dead socket.
 *
 * On 2026-09-12 the websocket died at 00:02 UTC and the process stayed up
 * and blind for seven hours. Nothing outside the event loop could see it,
 * because nothing outside the event loop had a number to look at.
 *
 * Failure policy: a heartbeat write that fails must never take the bot down.
 * The failure is logged once per minute (not per attempt) and the file is
 * simply not updated - which is exactly the signal the readers treat as
 * "unknown", never as "fine".
 */
export interface HeartbeatFile {
  pid: number;
  startedAt: string;
  /** ISO time of the last websocket delivery (slot change or program log), or null if none yet. */
  lastWsMessageAt: string | null;
  /** ISO time of the last newPool detection, or null if none since start. */
  lastDetectionAt: string | null;
  /** When this file was last written. A stale updatedAt means the writer itself is not running. */
  updatedAt: string;
  wsMessages: number;
  detections: number;
  /** Number of write failures since start, so a reader can tell a flaky disk from a healthy one. */
  writeFailures: number;
}

export interface HeartbeatWriterOptions {
  file: string;
  writeIntervalMs?: number;
  now?: () => number;
  warn?: (msg: string) => void;
}

export class HeartbeatWriter {
  private readonly file: string;
  private readonly writeIntervalMs: number;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;
  private startedAt: number;
  private lastWsMessageAt: number | null = null;
  private lastDetectionAt: number | null = null;
  private wsMessages = 0;
  private detections = 0;
  private writeFailures = 0;
  private lastWarnAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: HeartbeatWriterOptions) {
    this.file = options.file;
    this.writeIntervalMs = options.writeIntervalMs ?? 5_000;
    this.now = options.now ?? (() => Date.now());
    this.warn = options.warn ?? (() => {});
    this.startedAt = this.now();
  }

  /** Called on every websocket delivery. Cheap: one clock read and an increment. */
  wsMessage(): void {
    this.lastWsMessageAt = this.now();
    this.wsMessages++;
  }

  /** Called on every newPool detection. */
  detection(): void {
    this.lastDetectionAt = this.now();
    this.detections++;
  }

  snapshot(): HeartbeatFile {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return {
      pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      lastWsMessageAt: iso(this.lastWsMessageAt),
      lastDetectionAt: iso(this.lastDetectionAt),
      updatedAt: new Date(this.now()).toISOString(),
      wsMessages: this.wsMessages,
      detections: this.detections,
      writeFailures: this.writeFailures,
    };
  }

  /** Write now. Returns true on success. Never throws. */
  write(): boolean {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err: any) {
      this.writeFailures++;
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      const t = this.now();
      if (t - this.lastWarnAt >= 60_000) {
        this.lastWarnAt = t;
        this.warn(`heartbeat write to ${this.file} failed (${err?.message || err}); failures so far: ${this.writeFailures}. Readers will show "unknown" until it recovers.`);
      }
      return false;
    }
  }

  /** Start the periodic write. Writes once immediately so the file exists as soon as the bot is up. */
  start(): void {
    if (this.timer) return;
    this.write();
    this.timer = setInterval(() => this.write(), this.writeIntervalMs);
    this.timer.unref?.();
  }

  /** Stop the periodic write and write a final snapshot. */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.write();
  }
}

/** Parse a heartbeat file. Returns null - "unknown" - for anything that is not a well-formed heartbeat. */
export function readHeartbeat(file: string): HeartbeatFile | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.pid !== "number" || typeof parsed.updatedAt !== "string") return null;
    if (Number.isNaN(Date.parse(parsed.updatedAt))) return null;
    for (const k of ["lastWsMessageAt", "lastDetectionAt"]) {
      const v = parsed[k];
      if (v !== null && (typeof v !== "string" || Number.isNaN(Date.parse(v)))) return null;
    }
    return parsed as HeartbeatFile;
  } catch {
    return null;
  }
}
