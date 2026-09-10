/**
 * Shared guard: no test may write into a production log.
 *
 * ## Why this is a rule and not another per-file check
 *
 * test-watchlist-runtime.ts already asserted "no fixture mint reached
 * logs/watchlist.jsonl". It was correct, and it was written for one file - so
 * logs/trades.jsonl had no equivalent and quietly accumulated 156 fixture-mint
 * records between 2026-09-08 and 2026-09-10: 39 rejected-buy and 117
 * reconciliation-mismatch. The gating test even carried a comment saying the
 * real trade log was "cleaned up like other tests". It was not.
 *
 * A guard written per file only ever covers the file someone thought of. This
 * one scans EVERY production log in logs/, so a new log is covered the day it
 * is created rather than the day someone remembers to add an assertion.
 *
 * ## What counts as a production log
 *
 * Everything directly inside logs/ - `*.jsonl` and `*.json`. Test scratch
 * directories are nested (logs/test-engine-gating/...) and are skipped, which
 * is what lets a test write freely as long as it writes inside its own folder.
 */
import fs from "fs";
import path from "path";

export const LOGS_DIR = "logs";

/** Every production log file, excluding nested test scratch directories. */
export function productionLogFiles(dir = LOGS_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith(".jsonl") || e.name.endsWith(".json")))
    .map((e) => path.join(dir, e.name));
}

export interface LeakHit {
  file: string;
  marker: string;
  line: number;
  excerpt: string;
}

/**
 * Finds any fixture marker that reached a production log.
 *
 * Markers are the identifiers a test invents - fixture mints, fake signatures,
 * sentinel names. If one appears in a production log, a test wrote there.
 */
export function findLeaks(markers: string[], dir = LOGS_DIR): LeakHit[] {
  const hits: LeakHit[] = [];
  const real = markers.map((m) => m.trim()).filter((m) => m.length >= 6);
  if (real.length === 0) return hits;

  for (const file of productionLogFiles(dir)) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const marker of real) {
        if (lines[i].includes(marker)) {
          hits.push({ file, marker, line: i + 1, excerpt: lines[i].slice(0, 120) });
        }
      }
    }
  }
  return hits;
}

/**
 * Asserts no marker reached any production log. Call at the END of any suite
 * that constructs something capable of logging.
 *
 * `check` is the suite's own assertion function, so a leak fails that suite
 * rather than throwing out of a shared helper.
 */
export function assertNoProductionWrites(
  check: (name: string, cond: boolean, detail?: string) => void,
  markers: string[],
  dir = LOGS_DIR
): void {
  const hits = findLeaks(markers, dir);
  const files = [...new Set(hits.map((h) => h.file))];
  check(
    `no fixture marker reached any production log in ${dir}/ (${productionLogFiles(dir).length} file(s) scanned)`,
    hits.length === 0,
    hits.length === 0
      ? undefined
      : `${hits.length} leak(s) in ${files.join(", ")} - first: ${hits[0].file}:${hits[0].line} contains "${hits[0].marker}"`
  );
}
