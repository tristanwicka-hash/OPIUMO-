/**
 * Builds multi-hour price series for the trailing-stop v2 comparison.
 *
 * ## Why this module exists
 *
 * The v1 backtest ran on logs/watchlist.jsonl, whose median series is about 14
 * minutes long, and concluded that a fixed +100% take-profit beat every
 * trailing configuration. That tested the wrong regime: trailing stops exist to
 * capture multi-hour runners, and a 14-minute window cannot contain one. The
 * conclusion was correct about the data and says nothing about the question.
 *
 * The outcome tracker records checkpoints at 1h, 6h and 24h after detection,
 * each carrying the pool's liquidity. Baseline plus those checkpoints is a
 * series that actually spans a day.
 *
 * ## What this data can and cannot answer
 *
 * It is COARSE: at most four points per token, spaced 1h / 6h / 24h. That is
 * enough to ask "did the token run, and would trailing have kept more of it
 * than holding or than a fixed target?". It is NOT enough to calibrate trail
 * distance or wick persistence, which need intra-hour observations - a 6-hour
 * gap hides every wick inside it. Any caller reporting these results has to say
 * so, and `describeGranularity()` exists to make that hard to skip.
 */
import fs from "fs";
import { PoolObservation } from "../trading/trailingStop";

export const CHECKPOINT_1H = 3600;
export const CHECKPOINT_6H = 21600;
export const CHECKPOINT_24H = 86400;

export interface OutcomeRecord {
  ts: string;
  mint: string;
  detectedAt: string;
  checkpointSeconds: number;
  ok: boolean;
  liquiditySol: number | null;
  baselineLiquiditySol: number | null;
}

export interface TokenSeries {
  mint: string;
  detectedAt: string;
  /** Baseline first, then each successful checkpoint in time order. */
  observations: PoolObservation[];
  /** Which checkpoints were successfully read for this token. */
  checkpointsPresent: number[];
  /** The longest horizon this token has data for, in seconds. */
  horizonSeconds: number;
}

/**
 * Reads outcome checkpoints and groups them into per-token series.
 *
 * A checkpoint with `ok: false` or a null liquidity is DROPPED, not
 * interpolated and not treated as zero. A failed read is an absence of
 * knowledge, and filling it in would manufacture a price move that never
 * happened - which is precisely the kind of thing a backtest cannot detect
 * afterwards.
 */
export function loadTokenSeries(files: string[]): {
  series: TokenSeries[];
  recordsRead: number;
  unparseable: number;
  droppedFailedCheckpoints: number;
  droppedNoBaseline: number;
} {
  const byMint = new Map<string, OutcomeRecord[]>();
  let recordsRead = 0;
  let unparseable = 0;
  let droppedFailedCheckpoints = 0;

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let r: any;
      try {
        r = JSON.parse(line);
      } catch {
        unparseable++;
        continue;
      }
      if (typeof r?.mint !== "string" || typeof r?.checkpointSeconds !== "number") continue;
      recordsRead++;
      if (r.ok !== true || typeof r.liquiditySol !== "number") {
        droppedFailedCheckpoints++;
        continue;
      }
      const list = byMint.get(r.mint) ?? [];
      list.push(r as OutcomeRecord);
      byMint.set(r.mint, list);
    }
  }

  const series: TokenSeries[] = [];
  let droppedNoBaseline = 0;

  for (const [mint, records] of byMint) {
    records.sort((a, b) => a.checkpointSeconds - b.checkpointSeconds);
    const first = records[0];
    const baseline = first.baselineLiquiditySol;
    // Without a baseline there is no entry to measure against. Refused rather
    // than substituting the first checkpoint, which would silently discard
    // whatever move happened in the first hour.
    if (typeof baseline !== "number" || !(baseline > 0)) {
      droppedNoBaseline++;
      continue;
    }
    const detectedAt = first.detectedAt;
    const observations: PoolObservation[] = [{ ts: detectedAt, liquiditySol: baseline }];
    for (const r of records) {
      observations.push({ ts: r.ts, liquiditySol: r.liquiditySol as number });
    }
    const checkpointsPresent = records.map((r) => r.checkpointSeconds);
    series.push({
      mint,
      detectedAt,
      observations,
      checkpointsPresent,
      horizonSeconds: checkpointsPresent.length > 0 ? Math.max(...checkpointsPresent) : 0,
    });
  }

  return { series, recordsRead, unparseable, droppedFailedCheckpoints, droppedNoBaseline };
}

/** Tokens whose data reaches at least this horizon. */
export function cohort(all: TokenSeries[], horizonSeconds: number): TokenSeries[] {
  return all.filter((s) => s.checkpointsPresent.includes(horizonSeconds));
}

/**
 * The sentence every report built on this data has to carry.
 *
 * Written here rather than in the report so it cannot drift from the data it
 * describes, and so a second report cannot quietly omit it.
 */
export function describeGranularity(): string {
  return (
    "GRANULARITY: these series have at most four points - baseline, 1h, 6h, 24h. " +
    "That is enough to ask whether a token ran and whether trailing kept more of the run " +
    "than holding or a fixed target. It is NOT enough to calibrate trail distance or wick " +
    "persistence: a six-hour gap hides every wick inside it, so a trail that would have been " +
    "stopped out intraday looks like it survived. Treat the trail distances below as a " +
    "comparison between coarse strategies, not as a tuned parameter."
  );
}
