/**
 * npm run outcome:backlog
 *
 * Reports the outcome tracker's pending queue: current count, composition,
 * overdue count, and - once it has been run more than once - the trend.
 *
 * Read-only over the bot's state. It appends one snapshot per run to
 * logs/outcome-backlog.jsonl so a later run can answer "growing or stable?"
 * with data rather than a single reading. That file is a measurement record,
 * not test output.
 *
 * Run it alongside `npm run schedule:savings`.
 */
import fs from "fs";
import path from "path";
import { loadConfig } from "../src/config";
import { parseHhMm } from "../src/schedule/scheduler";
import {
  PendingEntry, BacklogSnapshot, snapshot, trend, formatBacklog,
} from "../src/analysis/outcomeBacklog";

const HISTORY = path.resolve(process.cwd(), "logs", "outcome-backlog.jsonl");

/** Detections/h and completions/h, measured from the bot's own logs. */
function measuredRates(): { detections: number | null; completions: number | null } {
  const byHour = (file: string, pred: (r: any) => boolean): number | null => {
    const p = path.resolve(process.cwd(), "logs", file);
    if (!fs.existsSync(p)) return null;
    const counts = new Map<string, number>();
    for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let r: any;
      try { r = JSON.parse(t); } catch { continue; }
      if (!r.ts || !pred(r)) continue;
      const k = r.ts.slice(0, 13);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    // Drop the newest bucket: it is a partial hour and would read low.
    const keys = [...counts.keys()].sort();
    const full = keys.slice(0, -1).slice(-4);
    if (full.length === 0) return null;
    return full.reduce((a, k) => a + (counts.get(k) ?? 0), 0) / full.length;
  };
  return {
    detections: byHour("decisions.jsonl", (r) => ["PASS", "SKIP", "DROPPED", "NOT_EVALUATED"].includes(r.decision)),
    completions: byHour("outcomes.jsonl", () => true),
  };
}

function onHoursPerDay(): number {
  const sch = loadConfig().schedule;
  if (!sch.enabled || sch.activeWindows.length === 0) return 24;
  const on = new Set<number>();
  for (const w of sch.activeWindows) {
    const s = Math.floor(parseHhMm(w.start, "start") / 60);
    const e = Math.floor(parseHhMm(w.end, "end") / 60);
    for (let h = s; h !== e; h = (h + 1) % 24) on.add(h);
  }
  return on.size;
}

function main(): void {
  const file = path.resolve(process.cwd(), "logs", "outcome-pending.json");
  if (!fs.existsSync(file)) {
    console.error("No logs/outcome-pending.json - the outcome tracker has never persisted state.");
    process.exit(1);
  }
  let entries: PendingEntry[];
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err: any) {
    // Refused rather than treated as empty: an unreadable state file is not an
    // empty queue, and reporting 0 would look like the backlog had cleared.
    console.error(`logs/outcome-pending.json does not parse (${err?.message}). Refusing to report 0 pending - that would look like the queue had cleared.`);
    process.exit(1);
  }
  if (!Array.isArray(entries)) {
    console.error("logs/outcome-pending.json is not an array. Refusing to guess at its shape.");
    process.exit(1);
  }

  const snap = snapshot(entries, Date.now());

  const history: BacklogSnapshot[] = [];
  if (fs.existsSync(HISTORY)) {
    for (const line of fs.readFileSync(HISTORY, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { history.push(JSON.parse(t)); } catch { continue; }
    }
  }
  history.push(snap);

  const rates = measuredRates();
  const t = trend(history, rates.detections, onHoursPerDay());

  console.log(formatBacklog(snap, t, rates.completions, rates.detections));

  fs.appendFileSync(HISTORY, JSON.stringify(snap) + "\n");
  console.log("");
  console.log(`Snapshot appended to ${path.relative(process.cwd(), HISTORY)} (${history.length} total) so the next run can compute a trend.`);
}

main();
