/**
 * Reads the paper-positions log back so the open book survives a restart.
 *
 * `JsonlLog` rotates a full file to `<name>.<ISO stamp><ext>` and starts a new
 * one, so the open of a position can sit in a rotated file while its close (or
 * nothing) sits in the current one. Every rotated sibling is read, oldest first
 * (the stamp sorts lexically), then the current file.
 *
 * Kept out of paperExecution.ts so the book itself stays free of I/O.
 */
import fs from "fs";
import path from "path";

export interface PaperLogRead {
  rows: Record<string, unknown>[];
  files: string[];
  /** Lines that did not parse - most likely a write cut off by a crash. Counted, never guessed at. */
  unparseable: number;
}

export function readPaperLog(logFile: string): PaperLogRead {
  return readRotatedJsonl(logFile);
}

/** Every rotated sibling of `logFile`, oldest first, then the file itself. `keep` skips lines before JSON.parse. */
export function readRotatedJsonl(logFile: string, keep?: (line: string) => boolean): PaperLogRead {
  const { dir, name, ext } = path.parse(logFile);
  const rotated = fs.existsSync(dir || ".")
    ? fs.readdirSync(dir || ".")
        .filter((f) => f.startsWith(`${name}.`) && f.endsWith(ext) && f !== `${name}${ext}`)
        .sort()
        .map((f) => path.join(dir, f))
    : [];
  const files = [...rotated, ...(fs.existsSync(logFile) ? [logFile] : [])];
  const rows: Record<string, unknown>[] = [];
  let unparseable = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, "utf-8").split("\n")) {
      if (!line || (keep && !keep(line))) continue;
      try { rows.push(JSON.parse(line)); } catch { unparseable++; }
    }
  }
  return { rows, files, unparseable };
}

/**
 * The last liquidity reading per mint from the watchlist logs, for the given
 * mints only. A failed read (liquiditySol null) is not a reading and is skipped.
 */
export function lastWatchlistReadings(watchlistFile: string, mints: Set<string>): Map<string, { ts: string; liquiditySol: number }> {
  const out = new Map<string, { ts: string; liquiditySol: number }>();
  const { rows } = readRotatedJsonl(watchlistFile, (l) => l.includes('"checked"'));
  for (const r of rows) {
    if (r.event !== "checked" || typeof r.mint !== "string" || !mints.has(r.mint)) continue;
    if (typeof r.liquiditySol !== "number" || typeof r.ts !== "string") continue;
    const prev = out.get(r.mint);
    if (!prev || Date.parse(r.ts) >= Date.parse(prev.ts)) out.set(r.mint, { ts: r.ts, liquiditySol: r.liquiditySol });
  }
  return out;
}
