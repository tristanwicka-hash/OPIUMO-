/**
 * Did the schedule actually cut credits, or only cut evaluation?
 *
 * ## The flaw this exists to test
 *
 * APPROVALS 13's projection assumed an OFF hour costs zero. It does not. During
 * an OFF hour the bot still holds its WebSocket subscription and still DETECTS
 * tokens - the window test produced 17 NOT_EVALUATED records - and two other
 * things run on their own timers, entirely outside the schedule gate:
 *
 *   - the watchlist polls liquidity every tickIntervalMs, up to maxChecksPerTick
 *   - the outcome tracker fires checkpoints scheduled BEFORE the window closed
 *
 * So the saving is (ON rate - OFF rate) x hours, not (ON rate x hours). This
 * module measures the difference instead of assuming it.
 *
 * Config-free, like the rest of src/analysis/.
 */

export interface MeterRecord {
  at?: string;
  windowCalls?: number;
  windowMs?: number;
}

export interface HourBucket {
  hour: number;
  calls: number;
  meteredHours: number;
  /** Null when this hour has no meter coverage at all - never 0. */
  callsPerHour: number | null;
}

export interface SavingsReport {
  buckets: HourBucket[];
  offHours: number[];
  /** Measured mean across OFF hours that have coverage. Null when none do. */
  offRate: number | null;
  offHoursCovered: number[];
  offHoursUncovered: number[];
  /** Measured mean across ON hours that have coverage. */
  onRate: number | null;
  onHoursCovered: number[];
  /** The two ON hours flanking the OFF block, which are the fairest comparison. */
  adjacentOnRate: number | null;
  adjacentHours: number[];
  /** offRate / onRate. Null when either is unmeasured. 0 would mean OFF is free. */
  offAsFractionOfOn: number | null;
  ready: boolean;
  notReadyReason: string | null;
}

/** Buckets meter windows by the hour-of-day of each window's midpoint. */
export function bucketByHour(records: MeterRecord[]): HourBucket[] {
  const calls = new Array(24).fill(0);
  const ms = new Array(24).fill(0);
  for (const r of records) {
    if (typeof r.windowCalls !== "number" || !r.windowMs || !r.at) continue;
    const end = Date.parse(r.at);
    if (Number.isNaN(end)) continue;
    const mid = new Date(end - r.windowMs / 2);
    calls[mid.getUTCHours()] += r.windowCalls;
    ms[mid.getUTCHours()] += r.windowMs;
  }
  return calls.map((c, hour) => ({
    hour,
    calls: c,
    meteredHours: ms[hour] / 3_600_000,
    // Null, never 0: an hour the meter never covered has no rate, and calling
    // it 0 would make an unmeasured hour look free - the exact error this
    // module exists to catch.
    callsPerHour: ms[hour] > 0 ? c / (ms[hour] / 3_600_000) : null,
  }));
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * `offHours` are the hours the schedule switches off. `minCoverageHours` is how
 * much metered time an hour needs before its rate is trusted.
 */
export function analyseSavings(
  records: MeterRecord[],
  offHours: number[],
  minCoverageHours = 0.5
): SavingsReport {
  const buckets = bucketByHour(records);
  const covered = (h: number) => {
    const b = buckets[h];
    return b.callsPerHour !== null && b.meteredHours >= minCoverageHours;
  };

  const offCovered = offHours.filter(covered);
  const offUncovered = offHours.filter((h) => !covered(h));
  const onHours = [...Array(24).keys()].filter((h) => !offHours.includes(h));
  const onCovered = onHours.filter(covered);

  // The hours immediately before and after the OFF block: the fairest
  // comparison, because they are nearest in time and market conditions.
  const sorted = [...offHours].sort((a, b) => a - b);
  const before = (sorted[0] + 23) % 24;
  const after = (sorted[sorted.length - 1] + 1) % 24;
  const adjacent = [before, after].filter(covered);

  const offRate = mean(offCovered.map((h) => buckets[h].callsPerHour as number));
  const onRate = mean(onCovered.map((h) => buckets[h].callsPerHour as number));
  const adjacentOnRate = mean(adjacent.map((h) => buckets[h].callsPerHour as number));

  const ready = offCovered.length > 0;
  return {
    buckets,
    offHours,
    offRate,
    offHoursCovered: offCovered,
    offHoursUncovered: offUncovered,
    onRate,
    onHoursCovered: onCovered,
    adjacentOnRate,
    adjacentHours: adjacent,
    offAsFractionOfOn:
      offRate !== null && onRate !== null && onRate > 0 ? offRate / onRate : null,
    ready,
    notReadyReason: ready
      ? null
      : `no OFF hour has ${minCoverageHours}h of meter coverage yet - the schedule has not run through ` +
        `${offHours.map((h) => String(h).padStart(2, "0") + ":00").join(", ")} with the meter recording. ` +
        `Nothing is concluded from that; re-run once it has.`,
  };
}

export function formatSavings(r: SavingsReport, planCalls = 10_000_000): string {
  const lines: string[] = [];
  lines.push("Schedule savings — is an OFF hour actually cheaper?");
  lines.push("=".repeat(84));
  lines.push(
    `OFF hours: ${r.offHours.map((h) => String(h).padStart(2, "0")).join(", ")}   ` +
      `(the projection in APPROVALS 13 assumed these cost ZERO)`
  );
  lines.push("");
  lines.push("  hour   calls   metered   calls/h   state");
  lines.push("  " + "-".repeat(56));
  for (const b of r.buckets) {
    const off = r.offHours.includes(b.hour);
    const rate = b.callsPerHour === null ? "unmetered" : `${Math.round(b.callsPerHour).toLocaleString()}`;
    lines.push(
      `  ${String(b.hour).padStart(2, "0")}:00 ${String(b.calls).padStart(7)} ` +
        `${b.meteredHours.toFixed(2).padStart(8)}h ${rate.padStart(9)}   ${off ? "OFF" : "on"}`
    );
  }
  lines.push("");

  if (!r.ready) {
    lines.push(`NOT READY. ${r.notReadyReason}`);
    return lines.join("\n");
  }

  lines.push(`OFF hours measured: ${r.offHoursCovered.map((h) => String(h).padStart(2, "0")).join(", ")}` +
    (r.offHoursUncovered.length ? `   (still unmetered: ${r.offHoursUncovered.map((h) => String(h).padStart(2, "0")).join(", ")})` : ""));
  lines.push(`  OFF rate:            ${Math.round(r.offRate as number).toLocaleString()}/h`);
  if (r.onRate !== null) lines.push(`  ON rate (all on):    ${Math.round(r.onRate).toLocaleString()}/h`);
  if (r.adjacentOnRate !== null) {
    lines.push(`  ON rate (adjacent ${r.adjacentHours.map((h) => String(h).padStart(2, "0")).join(" & ")}):  ${Math.round(r.adjacentOnRate).toLocaleString()}/h   <- fairest comparison`);
  }
  if (r.offAsFractionOfOn !== null) {
    const pct = r.offAsFractionOfOn * 100;
    lines.push("");
    lines.push(`  AN OFF HOUR COSTS ${pct.toFixed(0)}% OF AN ON HOUR.`);
    lines.push(
      pct < 15
        ? "  The schedule is genuinely cutting credits, not just evaluation."
        : pct < 50
        ? "  The schedule cuts real credits, but an OFF hour is NOT free - the projection was optimistic."
        : "  The schedule is mostly cutting EVALUATION, not credits. The projection is wrong and APPROVALS 13 needs correcting."
    );
    const base = r.adjacentOnRate ?? (r.onRate as number);
    const savedPerOffHour = base - (r.offRate as number);
    const savedMonth = savedPerOffHour * r.offHours.length * 30;
    lines.push("");
    lines.push(`  Real saving: ${Math.round(savedPerOffHour).toLocaleString()}/h x ${r.offHours.length} OFF hours x 30 days = ${(savedMonth / 1e6).toFixed(2)}M/month`);
    lines.push(`  (the projection credited ${(base * r.offHours.length * 30 / 1e6).toFixed(2)}M by assuming OFF hours were free)`);
  }
  return lines.join("\n");
}
