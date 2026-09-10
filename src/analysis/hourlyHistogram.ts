/**
 * Detections per hour of day, in UTC, from OPIUMO's own decision logs.
 *
 * ## Why this is the measurement that decides the window
 *
 * The trading-hours research found that nobody publishes a credible hourly
 * volume distribution for Solana memecoins - what exists is either anecdote
 * with confident numbers attached, or real studies that measure something else.
 * The one source with specific hours derives them from "200+ personal trades".
 * Those are hypotheses.
 *
 * This is not. It measures when THIS bot, on THESE filters, actually saw
 * candidates. Any window should come from this table, not from a blog.
 *
 * ## Coverage, and why raw counts alone would mislead
 *
 * The bot has not been running continuously. An hour it spent switched off
 * produces zero detections, which is indistinguishable from an hour with no
 * launches if you only count records - and picking a schedule off that would
 * cut exactly the hours nobody happened to be measuring.
 *
 * So observation time is reconstructed from the record stream: a gap longer
 * than `gapMinutes` is treated as downtime, everything else as observed. Every
 * hour then reports detections, hours observed, and the RATE - and the rate is
 * the column to read. Hours with thin coverage are flagged rather than ranked.
 *
 * This is config-free on purpose, like the rest of src/analysis/ - it runs with
 * no .env and touches no thresholds.
 */

export const DEFAULT_GAP_MINUTES = 10;

/** How a record's detection time was established. Reported, never hidden. */
export type TimePrecision =
  | "detectedAt" // the record carried the detection time directly
  | "derived" // record timestamp minus detectionToDecisionMs
  | "record-ts"; // neither available: the time the record was written

export interface DetectionTime {
  ms: number;
  precision: TimePrecision;
}

/** One line from decisions.jsonl. Only the fields this analysis reads are typed. */
export interface DecisionRecord {
  ts?: string;
  event?: string;
  decision?: string;
  detectedAt?: string;
  detectionToDecisionMs?: number;
  signature?: string;
  mint?: string;
}

/**
 * Records that represent a token being SEEN.
 *
 * A dropped token was detected and never evaluated; so was one refused by the
 * scheduler. Both cost a detection and both belong in a histogram of when
 * launches happen. Bookkeeping records (queue-stats) do not.
 */
export function isDetectionRecord(r: DecisionRecord): boolean {
  if (r.event === "queue-stats") return false;
  return (
    r.decision === "PASS" ||
    r.decision === "SKIP" ||
    r.decision === "DROPPED" ||
    r.decision === "NOT_EVALUATED"
  );
}

/**
 * When the token was detected.
 *
 * Prefers the recorded detection time, then reconstructs it from the write time
 * minus the measured detection-to-decision latency, and only falls back to the
 * write time itself. The fallback can sit up to a queue-wait later than the
 * real detection, so its use is counted and reported rather than absorbed.
 */
export function detectionTime(r: DecisionRecord): DetectionTime | null {
  if (r.detectedAt) {
    const ms = Date.parse(r.detectedAt);
    if (!Number.isNaN(ms)) return { ms, precision: "detectedAt" };
  }
  if (r.ts) {
    const written = Date.parse(r.ts);
    if (!Number.isNaN(written)) {
      if (typeof r.detectionToDecisionMs === "number" && r.detectionToDecisionMs >= 0) {
        return { ms: written - r.detectionToDecisionMs, precision: "derived" };
      }
      return { ms: written, precision: "record-ts" };
    }
  }
  return null;
}

export interface HourRow {
  /** 0-23, UTC. */
  hour: number;
  detections: number;
  /** Hours of observation that landed in this hour-of-day bucket. */
  hoursObserved: number;
  /** detections / hoursObserved. Null when this hour was never observed. */
  perHour: number | null;
  /** Share of all detections, 0-1. */
  share: number;
}

export interface Histogram {
  rows: HourRow[];
  totalDetections: number;
  /** ISO range of the observations, or null when there are none. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** Distinct UTC calendar days touched. */
  daysSpanned: number;
  totalHoursObserved: number;
  /** Contiguous run intervals reconstructed from the record stream. */
  observedIntervals: { startMs: number; endMs: number }[];
  precisionCounts: Record<TimePrecision, number>;
  /** Records that carried no usable timestamp at all. */
  unusableRecords: number;
  gapMinutes: number;
}

/**
 * Reconstructs when the bot was actually running.
 *
 * Consecutive detections closer together than `gapMinutes` are treated as one
 * continuous run. This is an inference, not a fact - a genuinely quiet stretch
 * longer than the threshold is indistinguishable from downtime, and that shows
 * up as an hour looking better than it was. The threshold is a parameter so the
 * answer's sensitivity to it can be checked rather than assumed.
 */
export function observedIntervals(
  sortedMs: number[],
  gapMinutes: number
): { startMs: number; endMs: number }[] {
  if (sortedMs.length === 0) return [];
  const gapMs = gapMinutes * 60_000;
  const out: { startMs: number; endMs: number }[] = [];
  let start = sortedMs[0];
  let prev = sortedMs[0];
  for (const t of sortedMs.slice(1)) {
    if (t - prev > gapMs) {
      out.push({ startMs: start, endMs: prev });
      start = t;
    }
    prev = t;
  }
  out.push({ startMs: start, endMs: prev });
  return out;
}

/** Spreads observed intervals across the 24 hour-of-day buckets, in minutes. */
export function observedMinutesByHour(
  intervals: { startMs: number; endMs: number }[]
): number[] {
  const minutes = new Array(24).fill(0);
  for (const { startMs, endMs } of intervals) {
    // Walk minute by minute. The spans here are days, not years, so this stays
    // cheap and avoids the boundary arithmetic that a closed-form version would
    // need to get exactly right.
    const cursor = new Date(startMs);
    cursor.setUTCSeconds(0, 0);
    const end = endMs;
    while (cursor.getTime() <= end) {
      minutes[cursor.getUTCHours()]++;
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    }
  }
  return minutes;
}

export function buildHistogram(
  records: DecisionRecord[],
  opts: { gapMinutes?: number } = {}
): Histogram {
  const gapMinutes = opts.gapMinutes ?? DEFAULT_GAP_MINUTES;

  const precisionCounts: Record<TimePrecision, number> = {
    detectedAt: 0,
    derived: 0,
    "record-ts": 0,
  };
  let unusableRecords = 0;
  const times: number[] = [];

  for (const r of records) {
    if (!isDetectionRecord(r)) continue;
    const t = detectionTime(r);
    if (t === null) {
      unusableRecords++;
      continue;
    }
    precisionCounts[t.precision]++;
    times.push(t.ms);
  }

  times.sort((a, b) => a - b);

  const counts = new Array(24).fill(0);
  const days = new Set<string>();
  for (const ms of times) {
    const d = new Date(ms);
    counts[d.getUTCHours()]++;
    days.add(d.toISOString().slice(0, 10));
  }

  const intervals = observedIntervals(times, gapMinutes);
  const minutes = observedMinutesByHour(intervals);
  const total = times.length;

  const rows: HourRow[] = counts.map((detections, hour) => {
    const hoursObserved = minutes[hour] / 60;
    return {
      hour,
      detections,
      hoursObserved,
      // Null, not zero: an hour never observed has no rate, and calling it 0
      // would rank it as the worst hour rather than as an unmeasured one.
      perHour: hoursObserved > 0 ? detections / hoursObserved : null,
      share: total === 0 ? 0 : detections / total,
    };
  });

  return {
    rows,
    totalDetections: total,
    firstSeen: times.length > 0 ? new Date(times[0]).toISOString() : null,
    lastSeen: times.length > 0 ? new Date(times[times.length - 1]).toISOString() : null,
    daysSpanned: days.size,
    totalHoursObserved: minutes.reduce((a, b) => a + b, 0) / 60,
    observedIntervals: intervals,
    precisionCounts,
    unusableRecords,
    gapMinutes,
  };
}

/** Hours ranked by rate, ignoring any hour with less than `minHours` of observation. */
export function rankByRate(h: Histogram, minHours: number): HourRow[] {
  return h.rows
    .filter((r) => r.hoursObserved >= minHours && r.perHour !== null)
    .sort((a, b) => (b.perHour as number) - (a.perHour as number));
}

function bar(value: number, max: number, width = 40): string {
  if (max <= 0) return "";
  return "#".repeat(Math.max(0, Math.round((value / max) * width)));
}

export function formatHistogram(h: Histogram, minHoursForRanking: number): string {
  const lines: string[] = [];

  lines.push("OPIUMO detections per hour of day (UTC)");
  lines.push("=".repeat(78));

  if (h.totalDetections === 0) {
    lines.push("No detection records found. Nothing can be said about timing from an empty sample.");
    return lines.join("\n");
  }

  lines.push(`Sample:    ${h.totalDetections} detections`);
  lines.push(`Range:     ${h.firstSeen} -> ${h.lastSeen}  (${h.daysSpanned} distinct UTC days)`);
  lines.push(
    `Observed:  ${h.totalHoursObserved.toFixed(1)}h of running time, in ${h.observedIntervals.length} ` +
      `run(s), inferred from gaps > ${h.gapMinutes}m`
  );
  lines.push("");

  const maxRate = Math.max(...h.rows.map((r) => r.perHour ?? 0));
  lines.push("hour   detections   observed   per hour   ");
  lines.push("-".repeat(78));
  for (const r of h.rows) {
    const rate = r.perHour === null ? "  never seen" : r.perHour.toFixed(1).padStart(9);
    const flag = r.hoursObserved > 0 && r.hoursObserved < minHoursForRanking ? " (thin)" : "";
    lines.push(
      `${String(r.hour).padStart(2, "0")}:00  ` +
        `${String(r.detections).padStart(10)}   ` +
        `${r.hoursObserved.toFixed(1).padStart(7)}h   ` +
        `${rate}   ${bar(r.perHour ?? 0, maxRate, 30)}${flag}`
    );
  }
  lines.push("");

  const ranked = rankByRate(h, minHoursForRanking);
  if (ranked.length === 0) {
    lines.push(
      `No hour has at least ${minHoursForRanking}h of observation, so no hour can be ranked. ` +
        `Collect more data before setting a window.`
    );
  } else {
    const best = ranked.slice(0, 5);
    const worst = ranked.slice(-5).reverse();
    lines.push(`Busiest hours (>= ${minHoursForRanking}h observed):`);
    for (const r of best) {
      lines.push(`  ${String(r.hour).padStart(2, "0")}:00 UTC  ${(r.perHour as number).toFixed(1)}/h`);
    }
    lines.push(`Quietest hours (>= ${minHoursForRanking}h observed):`);
    for (const r of worst) {
      lines.push(`  ${String(r.hour).padStart(2, "0")}:00 UTC  ${(r.perHour as number).toFixed(1)}/h`);
    }
    const unranked = 24 - ranked.length;
    if (unranked > 0) {
      lines.push(
        `  (${unranked} of 24 hours had too little observation to rank - they are not "quiet", they are unmeasured)`
      );
    }
  }

  lines.push("");
  lines.push("How the detection time was established:");
  lines.push(`  recorded directly:            ${h.precisionCounts.detectedAt}`);
  lines.push(`  derived (write - latency):    ${h.precisionCounts.derived}`);
  lines.push(`  fell back to the write time:  ${h.precisionCounts["record-ts"]}`);
  if (h.unusableRecords > 0) lines.push(`  no usable timestamp:          ${h.unusableRecords}`);

  return lines.join("\n");
}
