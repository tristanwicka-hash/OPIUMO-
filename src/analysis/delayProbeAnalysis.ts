/**
 * Turns raw `logs/delay-probe.jsonl` observations into the one thing the
 * roadmap actually needs: at 30s / 120s / 300s, how many tokens would pass
 * the CURRENT filters (minUniqueWallets, minTransactionCount,
 * maxTopHolderPercent), and how do the underlying numbers move with age.
 *
 * Deliberately pure - no fs, no config, no network - so it can be unit
 * tested with synthetic records and reused by the CLI script under
 * scripts/. This mirrors src/analysis/paperPerformance.ts's split.
 */

/** Mirrors DelayProbeRecord in src/data/delayProbe.ts. Duplicated rather than
 * imported so this module (and its tests) stay import-clean of anything that
 * eventually pulls in loadConfig() - see scripts/analyze-delay-probe.ts. */
export interface DelayProbeRecord {
  mint: string;
  source?: string;
  signature?: string;
  detectedAt?: string;
  delaySeconds: number;
  actualElapsedMs: number;
  queueWaitMs?: number;
  ok: boolean;
  error: string | null;
  uniqueWalletCount: number | null;
  transactionCount: number | null;
  topHolderPercent: number | null;
  liquiditySol: number | null;
  devWalletPercent?: number | null;
  mintAuthorityRenounced?: boolean | null;
  freezeAuthorityRenounced?: boolean | null;
  warnings?: string[];
  collectionMs?: number | null;
  /** Only present on the periodic coverage line DelayProbe.recordStats() writes. */
  event?: string;
}

export interface FilterThresholds {
  minUniqueWallets: number;
  minTransactionCount: number;
  maxTopHolderPercent: number;
}

/** config/default.json's shipped values - the CLI's default, overridable by flag
 * so a re-tune doesn't silently make old reports mean something different. */
export const DEFAULT_THRESHOLDS: FilterThresholds = {
  minUniqueWallets: 20,
  minTransactionCount: 30,
  maxTopHolderPercent: 20,
};

export interface MetricStats {
  /** How many OK observations had a non-null value for this metric. */
  sampleSize: number;
  /** How many OK observations had null instead - a real gap, not a zero. */
  nullCount: number;
  min: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
}

export interface DelayBucketReport {
  delaySeconds: number;
  /** Every job scheduled at this delay, including drops and errors. */
  scheduled: number;
  ok: number;
  /** ok:false with a real fetch error (not a queue drop). */
  errored: number;
  /** ok:false because the probe queue was full - the observation was never attempted. */
  dropped: number;
  uniqueWallets: MetricStats;
  transactionCount: MetricStats;
  topHolderPercent: MetricStats;
  liquiditySol: MetricStats;
  /** Of the OK observations where all three filtered metrics are non-null,
   * the fraction that would PASS the given thresholds today. */
  passRate: {
    /** OK observations with uniqueWalletCount, transactionCount AND topHolderPercent
     * all non-null - the only ones a real pass/fail verdict can be computed for. */
    evaluable: number;
    passed: number;
    passRatePercent: number | null;
  };
}

export interface DelayProbeReport {
  thresholds: FilterThresholds;
  totalRecords: number;
  /** Coverage lines (event: "probe-stats") are informational, not observations - counted separately. */
  coverageLines: number;
  distinctMints: number;
  malformedRecords: number;
  buckets: DelayBucketReport[];
}

function isCoverageLine(r: DelayProbeRecord): boolean {
  return r.event === "probe-stats";
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  // Nearest-rank, clamped - fine for report-grade estimates, not a stats library.
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function statsFor(values: Array<number | null>): MetricStats {
  const present = values.filter((v): v is number => v !== null && !Number.isNaN(v));
  const sorted = [...present].sort((a, b) => a - b);
  return {
    sampleSize: present.length,
    nullCount: values.length - present.length,
    min: sorted.length > 0 ? sorted[0] : null,
    median: median(sorted),
    p90: percentile(sorted, 90),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
  };
}

/**
 * Groups by delaySeconds and computes, per bucket, the metric distributions
 * and the pass rate against `thresholds`. Records with ok:false are counted
 * toward `errored` or `dropped` but excluded from every metric/pass-rate
 * computation - a failed observation has no numbers, not zero numbers.
 */
export function analyzeDelayProbe(
  records: DelayProbeRecord[],
  thresholds: FilterThresholds = DEFAULT_THRESHOLDS,
): DelayProbeReport {
  const coverageLines = records.filter(isCoverageLine);
  const observations = records.filter((r) => !isCoverageLine(r));

  const mints = new Set(observations.map((r) => r.mint).filter(Boolean));

  const byDelay = new Map<number, DelayProbeRecord[]>();
  for (const r of observations) {
    const arr = byDelay.get(r.delaySeconds) ?? [];
    arr.push(r);
    byDelay.set(r.delaySeconds, arr);
  }

  const buckets: DelayBucketReport[] = [...byDelay.keys()]
    .sort((a, b) => a - b)
    .map((delaySeconds) => {
      const group = byDelay.get(delaySeconds)!;
      const dropped = group.filter((r) => !r.ok && r.error?.startsWith("dropped")).length;
      const errored = group.filter((r) => !r.ok && !r.error?.startsWith("dropped")).length;
      const ok = group.filter((r) => r.ok);

      const uniqueWallets = statsFor(ok.map((r) => r.uniqueWalletCount));
      const transactionCount = statsFor(ok.map((r) => r.transactionCount));
      const topHolderPercent = statsFor(ok.map((r) => r.topHolderPercent));
      const liquiditySol = statsFor(ok.map((r) => r.liquiditySol));

      const evaluableRecords = ok.filter(
        (r) => r.uniqueWalletCount !== null && r.transactionCount !== null && r.topHolderPercent !== null,
      );
      const passed = evaluableRecords.filter(
        (r) =>
          r.uniqueWalletCount! >= thresholds.minUniqueWallets &&
          r.transactionCount! >= thresholds.minTransactionCount &&
          r.topHolderPercent! <= thresholds.maxTopHolderPercent,
      ).length;

      return {
        delaySeconds,
        scheduled: group.length,
        ok: ok.length,
        errored,
        dropped,
        uniqueWallets,
        transactionCount,
        topHolderPercent,
        liquiditySol,
        passRate: {
          evaluable: evaluableRecords.length,
          passed,
          passRatePercent: evaluableRecords.length > 0 ? (passed / evaluableRecords.length) * 100 : null,
        },
      };
    });

  // A record with no numeric delaySeconds at all (parse survived JSON.parse
  // but the shape is wrong) would otherwise sort into NaN silently.
  const malformedRecords = observations.filter((r) => typeof r.delaySeconds !== "number" || Number.isNaN(r.delaySeconds)).length;

  return {
    thresholds,
    totalRecords: records.length,
    coverageLines: coverageLines.length,
    distinctMints: mints.size,
    malformedRecords,
    buckets: buckets.filter((b) => !Number.isNaN(b.delaySeconds)),
  };
}
