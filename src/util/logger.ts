import fs from "fs";
import path from "path";

/**
 * Minimal dependency-free logger:
 *  - always prints to the console with a timestamp + level, so you can watch
 *    the bot live in a terminal
 *  - also appends structured JSON lines to logs/<name>.jsonl for anything
 *    you want to grep/replay later (decisions, trades)
 */

export type LogLevel = "minimal" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = { minimal: 0, info: 1, debug: 2 };

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export class Logger {
  private level: LogLevel;
  private scope: string;

  constructor(scope: string, level: LogLevel = "info") {
    this.scope = scope;
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.level];
  }

  private stamp(): string {
    return new Date().toISOString();
  }

  private write(level: "INFO" | "DEBUG" | "WARN" | "ERROR", msg: string) {
    const line = `[${this.stamp()}] [${level}] [${this.scope}] ${msg}`;
    if (level === "ERROR") console.error(line);
    else if (level === "WARN") console.warn(line);
    else console.log(line);
  }

  info(msg: string) {
    if (this.shouldLog("info")) this.write("INFO", msg);
  }

  debug(msg: string) {
    if (this.shouldLog("debug")) this.write("DEBUG", msg);
  }

  warn(msg: string) {
    this.write("WARN", msg);
  }

  error(msg: string) {
    this.write("ERROR", msg);
  }
}

/** Appends one JSON object per line to a log file (decisions, trades, ...). */
export class JsonlLog {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    ensureDir(path.dirname(filePath));
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "");
  }

  append(record: Record<string, unknown>) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
    fs.appendFileSync(this.filePath, line + "\n");
  }

  readAll(): Record<string, unknown>[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs
      .readFileSync(this.filePath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
}
