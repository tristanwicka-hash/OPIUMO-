/**
 * Is the outcome tracker's pending queue growing, stable, or diverging?
 *
 * ## Why this is a credits question, not a bookkeeping one
 *
 * Every pending checkpoint is one future getBalance call. Each detection
 * schedules three, at 1h, 6h and 24h. If schedulings outrun completions the
 * backlog grows, and the FLOOR cost of every hour grows with it - including
 * hours the schedule has switched off, because a checkpoint scheduled during an
 * ON hour still fires 24 hours later whatever the schedule says then.
 *
 * ## Growing is not the same as diverging
 *
 * The queue is bounded by the longest horizon: in steady state, pending settles
 * at roughly `detections/h x (1 + 6 + 24)` running 24/7, or `x (1 + 6 + ON
 * hours)` under a schedule. A queue climbing toward that is FILLING, not
 * diverging, and the two must not be reported the same way. What would indicate
 * real trouble is a rising OVERDUE count - checkpoints past their due time that
 * the worker has not got to.
 *
 * Config-free, like the rest of src/analysis/.
 */

export interface PendingEntry {
  checkpointSeconds: number;
  dueAtMs: number;
}

export interface BacklogSnapshot {
  at: string;
  pending: number;
  byHorizon: Record<string, number>;
  overdue: number;
  /** Worst lateness among overdue entries, in minutes. 0 when none are late. */
  maxLateMinutes: number;
  /** Earliest due time still outstanding, ISO. Null when the queue is empty. */
  earliestDueAt: string | null;
}

export function snapshot(entries: PendingEntry[], nowMs: number): BacklogSnapshot {
  const byHorizon: Record<string, number> = {};
  for (const e of entries) {
    const k = `${e.checkpointSeconds}`;
    byHorizon[k] = (byHorizon[k] ?? 0) + 1;
  }
  const overdue = entries.filter((e) => e.dueAtMs < nowMs);
  const maxLate = overdue.length
    ? Math.max(...overdue.map((e) => (nowMs - e.dueAtMs) / 60000))
    : 0;
  const earliest = entries.length ? Math.min(...entries.map((e) => e.dueAtMs)) : null;
  return {
    at: new Date(nowMs).toISOString(),
    pending: entries.length,
    byHorizon,
    overdue: overdue.length,
    maxLateMinutes: Math.round(maxLate),
    earliestDueAt: earliest === null ? null : new Date(earliest).toISOString(),
  };
}

export type Verdict = "filling" | "stable" | "draining" | "diverging" | "unknown";

export interface TrendResult {
  verdict: Verdict;
  /** Change per hour between the first and last snapshot. Null with under 2 snapshots. */
  perHour: number | null;
  spanHours: number | null;
  snapshots: number;
  /** Steady-state estimate the queue is heading toward. */
  steadyStateEstimate: number | null;
  reason: string;
}

/**
 * Classifies the trend.
 *
 * `diverging` is reserved for the case that actually matters: pending above the
 * steady state AND a meaningful overdue count. Growth on its own is filling,
 * and calling that divergence would raise an alarm about a queue behaving
 * exactly as designed.
 */
export function trend(
  history: BacklogSnapshot[],
  detectionsPerHour: number | null,
  onHoursPerDay: number,
  overdueAlarm = 100
): TrendResult {
  if (history.length < 2) {
    return {
      verdict: "unknown",
      perHour: null,
      spanHours: null,
      snapshots: history.length,
      steadyStateEstimate:
        detectionsPerHour === null ? null : Math.round(detectionsPerHour * (1 + 6 + onHoursPerDay)),
      reason:
        `only ${history.length} snapshot(s) - a trend needs at least 2. Nothing is concluded from ` +
        `one reading; re-run later and the history file will answer it.`,
    };
  }

  const first = history[0];
  const last = history[history.length - 1];
  const spanHours = (Date.parse(last.at) - Date.parse(first.at)) / 3_600_000;
  if (!(spanHours > 0)) {
    return { verdict: "unknown", perHour: null, spanHours, snapshots: history.length,
      steadyStateEstimate: null, reason: "snapshots share a timestamp - cannot compute a rate" };
  }

  const perHour = (last.pending - first.pending) / spanHours;
  const steady =
    detectionsPerHour === null ? null : Math.round(detectionsPerHour * (1 + 6 + onHoursPerDay));

  let verdict: Verdict;
  let reason: string;
  const overdueBad = last.overdue >= overdueAlarm;

  if (steady !== null && last.pending > steady * 1.2 && overdueBad) {
    verdict = "diverging";
    reason =
      `pending ${last.pending.toLocaleString()} is above the ~${steady.toLocaleString()} steady state AND ` +
      `${last.overdue.toLocaleString()} checkpoints are overdue - the worker is not keeping up.`;
  } else if (perHour > 50) {
    verdict = "filling";
    reason =
      `+${Math.round(perHour).toLocaleString()}/h` +
      (steady ? `, heading toward a steady state of ~${steady.toLocaleString()}` : "") +
      `. Overdue: ${last.overdue}. Growth toward the bound is the queue filling, not diverging.`;
  } else if (perHour < -50) {
    verdict = "draining";
    reason = `${Math.round(perHour).toLocaleString()}/h - the queue is shrinking.`;
  } else {
    verdict = "stable";
    reason = `${perHour >= 0 ? "+" : ""}${Math.round(perHour)}/h over ${spanHours.toFixed(1)}h - flat.`;
  }

  return { verdict, perHour, spanHours, snapshots: history.length, steadyStateEstimate: steady, reason };
}

/** Future getBalance calls per hour once every horizon is firing. */
export function steadyStateCallsPerHour(detectionsPerHour: number, checkpointCount = 3): number {
  return detectionsPerHour * checkpointCount;
}

export function formatBacklog(
  snap: BacklogSnapshot,
  t: TrendResult,
  completionRatePerHour: number | null,
  detectionsPerHour: number | null
): string {
  const L: string[] = [];
  L.push("Outcome tracker backlog — every pending checkpoint is one future getBalance call");
  L.push("=".repeat(88));
  L.push(`  measured at:  ${snap.at}`);
  L.push(`  PENDING:      ${snap.pending.toLocaleString()}`);
  L.push(`  by horizon:   ${Object.entries(snap.byHorizon).sort((a,b)=>Number(a[0])-Number(b[0]))
    .map(([k,v]) => `${Number(k)/3600}h: ${v.toLocaleString()}`).join("   ")}`);
  L.push(`  overdue:      ${snap.overdue.toLocaleString()}${snap.overdue ? ` (worst ${snap.maxLateMinutes} min late)` : "  <- the signal that would mean the worker is not keeping up"}`);
  L.push(`  earliest due: ${snap.earliestDueAt ?? "n/a"}`);
  L.push("");
  L.push(`  TREND: ${t.verdict.toUpperCase()} — ${t.reason}`);
  L.push(`  (${t.snapshots} snapshot(s)${t.spanHours ? ` over ${t.spanHours.toFixed(1)}h` : ""})`);
  L.push("");
  if (detectionsPerHour !== null) {
    const steadyCalls = steadyStateCallsPerHour(detectionsPerHour);
    L.push(`  COST: at ${Math.round(detectionsPerHour).toLocaleString()} detections/h, every detection schedules 3 checkpoints,`);
    L.push(`  so in steady state this costs ${Math.round(steadyCalls).toLocaleString()} getBalance calls/h.`);
    if (completionRatePerHour !== null) {
      L.push(`  Observed completions right now: ${Math.round(completionRatePerHour).toLocaleString()}/h.`);
      if (completionRatePerHour < steadyCalls * 0.8) {
        L.push(`  ** The observed rate is BELOW steady state, so the floor cost has not arrived yet. **`);
        L.push(`  ** Expect burn to RISE by roughly ${Math.round(steadyCalls - completionRatePerHour).toLocaleString()}/h as the longer horizons start firing. **`);
      }
    }
  }
  return L.join("\n");
}
