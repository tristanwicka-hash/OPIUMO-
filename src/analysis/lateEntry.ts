/**
 * Late-entry replay: what if the paper book had entered at 60/90/120 s instead
 * of t=0?
 *
 * 107 of 459 closed paper positions drained to <=5% of entry within 10
 * minutes. Entering at t=0 buys into every one of them. This replays each
 * position from the watchlist's own liquidity readings (the same readings the
 * paper book's trailing stop was fed), with the entry moved to the first
 * reading at or after the delay, the same trailing-stop config, the same
 * constant-product realizable-proceeds pricing, and a flat 0.2 SOL stake.
 *
 * ## Reproduction first
 *
 * Replaying at delay 0 with the paper book's own 5%-of-pool fraction must
 * reproduce the recorded exit proceeds; `reproductionCheck` reports how many
 * positions it does and does not, and why. If the replay cannot reproduce the
 * book on the same data, its late-entry numbers are not worth reading.
 *
 * ## What "avoided" means
 *
 * A drained pool at 60 s holds a few thousandths of a SOL. A flat 0.2 SOL
 * would be far more than half of it, and the same share cap the sizing
 * backtest uses (DEFAULT_MAX_POOL_SHARE) refuses the entry. So a drain is
 * AVOIDED when the position is not entered at the delay because the pool had
 * already collapsed. It is counted, never silently dropped.
 *
 * ## Unknown is unknown
 *
 * A position with no reading at or after the delay is `noReading`; one whose
 * replayed series ends without the stop firing is `heldToEnd`, valued at its
 * last reading and reported separately - it is not an exit.
 */
import { runSeries, constantProductProceeds, TrailingStopConfig, Position } from "../trading/trailingStop";
import { DEFAULT_MAX_POOL_SHARE } from "./sizingBacktest";

export interface ClosedPosition {
  mint: string;
  openedAt: string;
  closedAt: string | null;
  entryLiquiditySol: number;
  entryProceedsSol: number;
  exitProceedsSol: number | null;
  poolFraction: number;
  outcome: string;
}
export interface Reading { tMs: number; sol: number }

export const DRAIN_RATIO = 0.05;
export const DRAIN_MINUTES = 10;

export function isDrained(c: ClosedPosition): boolean {
  if (c.exitProceedsSol === null || !c.closedAt || !(c.entryProceedsSol > 0)) return false;
  const minutes = (Date.parse(c.closedAt) - Date.parse(c.openedAt)) / 60_000;
  return c.exitProceedsSol / c.entryProceedsSol <= DRAIN_RATIO && minutes <= DRAIN_MINUTES;
}

export type EntryStatus = "entered" | "not-entered-pool-collapsed" | "no-reading";

export interface Replayed {
  mint: string;
  delaySec: number;
  status: EntryStatus;
  /** Seconds after t=0 the entry reading was actually taken (>= delay). */
  entryAtSec: number | null;
  entryLiquiditySol: number | null;
  stakedSol: number;
  /** Proceeds at exit, or at the last reading when the stop never fired. */
  realisedSol: number | null;
  netSol: number | null;
  result: "exited" | "held-to-end" | "exit-failed" | null;
  wasDrain: boolean;
}

/** Entry reading: at delay 0 the recorded t=0 entry; otherwise the first reading at or after the delay. */
export function entryReading(c: ClosedPosition, readings: Reading[], delaySec: number): { tMs: number; sol: number } | null {
  const t0 = Date.parse(c.openedAt);
  if (delaySec === 0) return { tMs: t0, sol: c.entryLiquiditySol };
  const sorted = [...readings].sort((a, b) => a.tMs - b.tMs);
  return sorted.find((r) => r.tMs - t0 >= delaySec * 1000) ?? null;
}

export function replayPosition(
  c: ClosedPosition, readings: Reading[], delaySec: number,
  opts: { stakeSol: number; trailing: TrailingStopConfig; maxPoolShare?: number; fraction?: number }
): Replayed {
  const wasDrain = isDrained(c);
  const base: Replayed = { mint: c.mint, delaySec, status: "no-reading", entryAtSec: null, entryLiquiditySol: null, stakedSol: 0, realisedSol: null, netSol: null, result: null, wasDrain };
  const entry = entryReading(c, readings, delaySec);
  if (!entry || !(entry.sol > 0)) return base;
  const t0 = Date.parse(c.openedAt);
  const entryAtSec = (entry.tMs - t0) / 1000;
  // Fixed fraction (the book's own 5%) reproduces the book; a flat stake takes S / L_entry of the pool.
  const f = opts.fraction ?? opts.stakeSol / entry.sol;
  const staked = opts.fraction !== undefined ? opts.fraction * entry.sol : opts.stakeSol;
  if (opts.fraction === undefined && f > (opts.maxPoolShare ?? DEFAULT_MAX_POOL_SHARE)) {
    return { ...base, status: "not-entered-pool-collapsed", entryAtSec, entryLiquiditySol: entry.sol };
  }
  const entryProceeds = constantProductProceeds(entry.sol, f);
  if (entryProceeds === null) return base;
  const series = [...readings].filter((r) => r.tMs > entry.tMs).sort((a, b) => a.tMs - b.tMs).map((r) => ({ ts: new Date(r.tMs).toISOString(), liquiditySol: r.sol }));
  const position: Position = { mint: c.mint, entryTs: new Date(entry.tMs).toISOString(), poolFraction: f, entryProceedsSol: entryProceeds };
  const out = runSeries(position, series, opts.trailing, constantProductProceeds);
  const realised = out.result === "exited" ? out.exitProceedsSol : out.result === "held-to-end" ? out.finalProceedsSol : null;
  return {
    ...base, status: "entered", entryAtSec, entryLiquiditySol: entry.sol, stakedSol: staked,
    realisedSol: realised, netSol: realised === null ? null : realised - staked, result: out.result,
  };
}

export interface DelayReport {
  delaySec: number;
  positions: number;
  entered: number;
  notEnteredPoolCollapsed: number;
  noReading: number;
  heldToEnd: number;
  exitFailed: number;
  stakedSol: number;
  realisedSol: number;
  netSol: number;
  netPercent: number | null;
  wins: number;
  /** Null below MIN_FOR_RATE entered positions. */
  winRate: number | null;
  largestLoss: Replayed | null;
  largestWin: Replayed | null;
  /** Of the recorded instant drains: not entered because the pool had already collapsed. */
  drainsAvoided: number;
  /** Of the recorded instant drains: entered anyway and lost more than half the stake. */
  drainsStillHit: number;
  drainsTotal: number;
}

export const MIN_FOR_RATE = 30;

export function summariseDelay(rows: Replayed[]): DelayReport {
  const entered = rows.filter((r) => r.status === "entered" && r.netSol !== null);
  const staked = entered.reduce((a, r) => a + r.stakedSol, 0);
  const realised = entered.reduce((a, r) => a + (r.realisedSol ?? 0), 0);
  const wins = entered.filter((r) => (r.netSol ?? 0) > 0);
  const sorted = [...entered].sort((a, b) => (a.netSol ?? 0) - (b.netSol ?? 0));
  const drains = rows.filter((r) => r.wasDrain);
  return {
    delaySec: rows[0]?.delaySec ?? 0,
    positions: rows.length,
    entered: entered.length,
    notEnteredPoolCollapsed: rows.filter((r) => r.status === "not-entered-pool-collapsed").length,
    noReading: rows.filter((r) => r.status === "no-reading").length,
    heldToEnd: entered.filter((r) => r.result === "held-to-end").length,
    exitFailed: rows.filter((r) => r.result === "exit-failed").length,
    stakedSol: staked, realisedSol: realised, netSol: realised - staked,
    netPercent: staked > 0 ? ((realised - staked) / staked) * 100 : null,
    wins: wins.length,
    winRate: entered.length >= MIN_FOR_RATE ? wins.length / entered.length : null,
    largestLoss: sorted[0] ?? null,
    largestWin: sorted[sorted.length - 1] ?? null,
    drainsAvoided: drains.filter((r) => r.status === "not-entered-pool-collapsed").length,
    drainsStillHit: drains.filter((r) => r.status === "entered" && (r.netSol ?? 0) < -0.5 * r.stakedSol).length,
    drainsTotal: drains.length,
  };
}

export interface Reproduction {
  compared: number;
  exact: number;
  /** |replayed - recorded| <= 1% of recorded. */
  close: number;
  off: number;
  heldToEndInReplay: number;
  noSeries: number;
  examplesOff: { mint: string; recorded: number; replayed: number | null; result: string | null }[];
}

/** Delay 0 with the book's own fraction must give the book's own exits. */
export function reproductionCheck(closes: ClosedPosition[], readingsByMint: Map<string, Reading[]>, trailing: TrailingStopConfig): Reproduction {
  const rep: Reproduction = { compared: 0, exact: 0, close: 0, off: 0, heldToEndInReplay: 0, noSeries: 0, examplesOff: [] };
  for (const c of closes) {
    if (c.exitProceedsSol === null) continue;
    const readings = readingsByMint.get(c.mint) ?? [];
    if (readings.length === 0) { rep.noSeries++; continue; }
    const r = replayPosition(c, readings, 0, { stakeSol: 0, trailing, fraction: c.poolFraction });
    rep.compared++;
    if (r.result === "held-to-end") { rep.heldToEndInReplay++; }
    if (r.realisedSol !== null && Math.abs(r.realisedSol - c.exitProceedsSol) < 1e-9) rep.exact++;
    else if (r.realisedSol !== null && Math.abs(r.realisedSol - c.exitProceedsSol) <= 0.01 * Math.max(c.exitProceedsSol, 1e-9)) rep.close++;
    else { rep.off++; if (rep.examplesOff.length < 5) rep.examplesOff.push({ mint: c.mint, recorded: c.exitProceedsSol, replayed: r.realisedSol, result: r.result }); }
  }
  return rep;
}

const sol = (x: number | null, d = 2) => (x === null ? "n/a" : x.toFixed(d));

export function formatReport(reports: DelayReport[], rep: Reproduction, sample: { positions: number; drained: number; firstOpened: string | null; lastClosed: string | null; readingGapMedianSec: number | null; allRejected: boolean; stakeSol: number }): string {
  const L: string[] = [];
  L.push("Late-entry replay - the paper book re-entered at 60/90/120 s from the watchlist's own readings");
  L.push("=".repeat(112));
  L.push(`  REPRODUCTION at delay 0 with the book's 5% fraction: ${rep.compared} compared, ${rep.exact} exact, ${rep.close} within 1%, ${rep.off} off, ${rep.heldToEndInReplay} held-to-end in replay, ${rep.noSeries} with no readings.`);
  if (rep.examplesOff.length) for (const e of rep.examplesOff) L.push(`      off: ${e.mint.slice(0, 8)}… recorded ${e.recorded.toFixed(5)} replayed ${e.replayed === null ? "null" : e.replayed.toFixed(5)} (${e.result})`);
  L.push("");
  L.push(`  ${"delay".padStart(6)} ${"entered".padStart(8)} ${"not entered*".padStart(13)} ${"no reading".padStart(11)} ${"staked".padStart(8)} ${"returned".padStart(9)} ${"net".padStart(8)} ${"net%".padStart(7)} ${"win rate".padStart(9)} ${"largest loss".padStart(13)} ${"largest win".padStart(12)} ${"held-to-end".padStart(12)}  drains avoided / still hit / of`);
  for (const r of reports) {
    const wr = r.winRate === null ? `n/a(${r.wins}/${r.entered})` : `${(r.winRate * 100).toFixed(1)}%`;
    L.push(`  ${`${r.delaySec}s`.padStart(6)} ${String(r.entered).padStart(8)} ${String(r.notEnteredPoolCollapsed).padStart(13)} ${String(r.noReading).padStart(11)} ${sol(r.stakedSol).padStart(8)} ${sol(r.realisedSol).padStart(9)} ${sol(r.netSol).padStart(8)} ${(r.netPercent === null ? "n/a" : `${r.netPercent.toFixed(1)}%`).padStart(7)} ${wr.padStart(9)} ${sol(r.largestLoss?.netSol ?? null, 3).padStart(13)} ${sol(r.largestWin?.netSol ?? null, 3).padStart(12)} ${String(r.heldToEnd).padStart(12)}  ${r.drainsAvoided} / ${r.drainsStillHit} / ${r.drainsTotal}`);
  }
  L.push(`  * not entered: at the delay the pool held less than 2x the ${sample.stakeSol} SOL stake (share cap ${DEFAULT_MAX_POOL_SHARE * 100}%) - the pool had already collapsed.`);
  L.push("");
  L.push("  SAMPLE LIMITS");
  L.push(`    ${sample.positions} closed paper positions, ${sample.drained} of them instant drains (<= ${DRAIN_RATIO * 100}% of entry within ${DRAIN_MINUTES} min), ${sample.firstOpened ?? "?"} -> ${sample.lastClosed ?? "?"}.`);
  L.push(`    ${sample.allRejected ? "EVERY position is a token the live filters rejected - the reject pile, not a random sample." : "mixed live verdicts."}`);
  L.push(`    Entry is the first watchlist reading AT OR AFTER the delay (median gap between readings ${sample.readingGapMedianSec === null ? "?" : sample.readingGapMedianSec.toFixed(0)} s), priced at that reading - not the exact second.`);
  L.push(`    Exits are the SAME trailing-stop config replayed on the readings after entry; the paper book's own exits were produced from these same readings (see REPRODUCTION).`);
  L.push(`    Held-to-end positions never triggered the stop within the recorded readings and are valued at their last reading - a valuation, not an exit.`);
  L.push(`    Win rates are null below ${MIN_FOR_RATE} entered positions. Nothing here changes live config.`);
  return L.join("\n");
}
