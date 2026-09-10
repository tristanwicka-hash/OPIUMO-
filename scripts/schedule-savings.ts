/**
 * npm run schedule:savings
 *
 * Reads logs/rpc-meter.jsonl and asks whether an OFF hour is actually cheaper
 * than an ON hour, or whether the schedule only stopped evaluation while the
 * watchlist, outcome tracker and WebSocket detection carried on costing calls.
 *
 * Read-only. Run it after the OFF window has elapsed with the schedule active.
 */
import fs from "fs";
import path from "path";
import { loadConfig } from "../src/config";
import { parseHhMm } from "../src/schedule/scheduler";
import { MeterRecord, analyseSavings, formatSavings } from "../src/analysis/scheduleSavings";

function offHoursFromConfig(): number[] {
  const sch = loadConfig().schedule;
  if (!sch.enabled || sch.activeWindows.length === 0) return [];
  const on = new Set<number>();
  for (const w of sch.activeWindows) {
    const s = Math.floor(parseHhMm(w.start, "start") / 60);
    const e = Math.floor(parseHhMm(w.end, "end") / 60);
    // Walk forward from start to end, wrapping past midnight.
    for (let h = s; h !== e; h = (h + 1) % 24) on.add(h);
  }
  return [...Array(24).keys()].filter((h) => !on.has(h));
}

function main(): void {
  const file = path.resolve(process.cwd(), "logs", "rpc-meter.jsonl");
  if (!fs.existsSync(file)) {
    console.error("No logs/rpc-meter.jsonl. Nothing to measure.");
    process.exit(1);
  }
  const records: MeterRecord[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t));
    } catch {
      continue; // a live file can end mid-write
    }
  }

  const off = offHoursFromConfig();
  if (off.length === 0) {
    console.error("The schedule is disabled or has no windows, so no hour is OFF. Nothing to compare.");
    process.exit(1);
  }

  console.log(`Read ${records.length} meter record(s).`);
  console.log("");
  console.log(formatSavings(analyseSavings(records, off)));
}

main();
