/**
 * Backtests the trailing stop against recorded pool histories.
 *
 * Config-free by convention (see CLAUDE.md): this module reads no .env and no
 * config file, so it runs anywhere and every number in a report traces to a
 * parameter set the caller passed in.
 *
 * ## What it refuses to do
 *
 * **Exit-failed runs are counted separately and excluded from every P&L
 * figure.** A honeypot folded in with clean stop-outs is how a backtest
 * overstates itself, and it is the exact failure mode this vault keeps finding.
 * `exitFailed` is reported next to the returns, not inside them.
 *
 * **Tokens whose peak never exceeded entry produce a null capture ratio, not
 * zero.** There was no run to capture, so "captured 0% of it" is a claim about
 * nothing. Those tokens are counted under `noRunToCapture`.
 */
import {
  Position,
  PoolObservation,
  TrailingStopConfig,
  ProceedsFn,
  runSeries,
  RunOutcome,
} from "../trading/trailingStop";

export interface TokenSeries {
  mint: string;
  observations: PoolObservation[];
}

export interface TokenResult {
  mint: string;
  outcome: RunOutcome;
  /**
   * Fraction of the available run captured:
   *   (exit - entry) / (peak - entry)
   * Null when the token never rose above entry - there was no run to capture,
   * and 0 would read as a failure rather than as "not applicable".
   */
  captureRatio: number | null;
  /** Proceeds if you simply held to the last observation. */
  doNothingProceedsSol: number | null;
  /** Proceeds from a fixed take-profit at the configured percentage, if it ever triggered. */
  fixedTakeProfitProceedsSol: number | null;
  /**
   * True when the stop exited and the token later traded ABOVE the exit
   * proceeds - the "sold too early" case, which a P&L-only report hides.
   */
  firedEarlyThenRecovered: boolean;
  /** How much higher it went after the exit, as a percentage of exit proceeds. */
  recoveryAbovePct: number | null;
  peakMultiple: number;
}

export interface BacktestSummary {
  label: string;
  config: TrailingStopConfig;
  fixedTakeProfitPercent: number;
  tokens: number;
  exited: number;
  exitFailed: number;
  heldToEnd: number;
  /** Tokens that at least doubled from entry at some point. */
  runners: number;
  runnersCaught: number;
  /** Median capture ratio across tokens that HAD a run. Null when none did. */
  medianCaptureRatio: number | null;
  noRunToCapture: number;
  firedEarlyThenRecovered: number;
  /** Totals in SOL, EXCLUDING exit-failed runs, which realised nothing. */
  totalTrailingProceedsSol: number;
  totalDoNothingProceedsSol: number;
  totalFixedTakeProfitProceedsSol: number;
  totalEntryProceedsSol: number;
  /** Sum of the best each token ever offered - the ceiling nothing can beat. */
  totalPeakProceedsSol: number;
}

export interface BacktestReport {
  summary: BacktestSummary;
  perToken: TokenResult[];
}

/** First observation at or above the take-profit threshold, or null. */
function fixedTakeProfit(
  position: Position,
  series: PoolObservation[],
  proceeds: ProceedsFn,
  percent: number
): number | null {
  const target = position.entryProceedsSol * (1 + percent / 100);
  for (const o of series) {
    const p = proceeds(o.liquiditySol, position.poolFraction);
    if (p !== null && p >= target) return p;
  }
  return null;
}

export function backtestToken(
  series: TokenSeries,
  poolFraction: number,
  config: TrailingStopConfig,
  proceeds: ProceedsFn,
  fixedTakeProfitPercent: number
): TokenResult | null {
  const obsList = series.observations;
  if (obsList.length < 2) return null;

  const entryProceeds = proceeds(obsList[0].liquiditySol, poolFraction);
  // A token that could not be sold at the moment of entry was never a position.
  if (entryProceeds === null || !(entryProceeds > 0)) return null;

  const position: Position = {
    mint: series.mint,
    entryTs: obsList[0].ts,
    poolFraction,
    entryProceedsSol: entryProceeds,
  };

  const outcome = runSeries(position, obsList.slice(1), config, proceeds);

  const gainAvailable = outcome.peakProceedsSol - entryProceeds;
  const gainCaptured = (outcome.exitProceedsSol ?? outcome.finalProceedsSol ?? entryProceeds) - entryProceeds;
  const captureRatio = gainAvailable > 1e-12 ? gainCaptured / gainAvailable : null;

  // Did it recover above the exit after we left?
  let firedEarly = false;
  let recoveryAbovePct: number | null = null;
  if (outcome.result === "exited" && outcome.exitIndex !== null && outcome.exitProceedsSol !== null) {
    const after = obsList.slice(1).slice(outcome.exitIndex + 1);
    let best = outcome.exitProceedsSol;
    for (const o of after) {
      const p = proceeds(o.liquiditySol, poolFraction);
      if (p !== null && p > best) best = p;
    }
    if (best > outcome.exitProceedsSol * 1.0001) {
      firedEarly = true;
      recoveryAbovePct = ((best - outcome.exitProceedsSol) / outcome.exitProceedsSol) * 100;
    }
  }

  return {
    mint: series.mint,
    outcome,
    captureRatio,
    doNothingProceedsSol: outcome.finalProceedsSol,
    fixedTakeProfitProceedsSol: fixedTakeProfit(position, obsList.slice(1), proceeds, fixedTakeProfitPercent),
    firedEarlyThenRecovered: firedEarly,
    recoveryAbovePct,
    peakMultiple: outcome.peakProceedsSol / entryProceeds,
  };
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function backtest(
  seriesList: TokenSeries[],
  poolFraction: number,
  config: TrailingStopConfig,
  proceeds: ProceedsFn,
  fixedTakeProfitPercent: number,
  label: string
): BacktestReport {
  const perToken: TokenResult[] = [];
  for (const s of seriesList) {
    const r = backtestToken(s, poolFraction, config, proceeds, fixedTakeProfitPercent);
    if (r) perToken.push(r);
  }

  const exited = perToken.filter((t) => t.outcome.result === "exited");
  const exitFailed = perToken.filter((t) => t.outcome.result === "exit-failed");
  const heldToEnd = perToken.filter((t) => t.outcome.result === "held-to-end");
  const runners = perToken.filter((t) => t.peakMultiple >= 2);
  const withRun = perToken.filter((t) => t.captureRatio !== null);

  // Exit-failed runs realised nothing and are excluded from every P&L total.
  const realised = perToken.filter((t) => t.outcome.result !== "exit-failed");

  return {
    summary: {
      label,
      config,
      fixedTakeProfitPercent,
      tokens: perToken.length,
      exited: exited.length,
      exitFailed: exitFailed.length,
      heldToEnd: heldToEnd.length,
      runners: runners.length,
      runnersCaught: runners.filter((t) => t.outcome.result === "exited").length,
      medianCaptureRatio: median(withRun.map((t) => t.captureRatio as number)),
      noRunToCapture: perToken.length - withRun.length,
      firedEarlyThenRecovered: perToken.filter((t) => t.firedEarlyThenRecovered).length,
      totalTrailingProceedsSol: realised.reduce(
        (a, t) => a + (t.outcome.exitProceedsSol ?? t.doNothingProceedsSol ?? t.outcome.entryProceedsSol), 0),
      totalDoNothingProceedsSol: realised.reduce((a, t) => a + (t.doNothingProceedsSol ?? t.outcome.entryProceedsSol), 0),
      totalFixedTakeProfitProceedsSol: realised.reduce(
        (a, t) => a + (t.fixedTakeProfitProceedsSol ?? t.doNothingProceedsSol ?? t.outcome.entryProceedsSol), 0),
      totalEntryProceedsSol: realised.reduce((a, t) => a + t.outcome.entryProceedsSol, 0),
      totalPeakProceedsSol: realised.reduce((a, t) => a + t.outcome.peakProceedsSol, 0),
    },
    perToken,
  };
}

const sol = (v: number) => `${v.toFixed(4)} SOL`;

export function formatReport(reports: BacktestReport[], sampleNote: string): string {
  const lines: string[] = [];
  lines.push("Trailing-stop backtest — OPIUMO recorded pool histories");
  lines.push("=".repeat(100));
  lines.push(sampleNote);
  lines.push("");

  lines.push(
    `  ${"parameter set".padEnd(30)} ${"tok".padStart(4)} ${"exit".padStart(5)} ${"FAIL".padStart(5)} ` +
    `${"run".padStart(4)} ${"caught".padStart(7)} ${"capture".padStart(8)} ${"early".padStart(6)} ` +
    `${"trailing".padStart(11)} ${"donothing".padStart(11)} ${"fixedTP".padStart(11)}`
  );
  lines.push("-".repeat(100));
  for (const r of reports) {
    const s = r.summary;
    lines.push(
      `  ${s.label.padEnd(30)} ${String(s.tokens).padStart(4)} ${String(s.exited).padStart(5)} ` +
      `${String(s.exitFailed).padStart(5)} ${String(s.runners).padStart(4)} ${String(s.runnersCaught).padStart(7)} ` +
      `${(s.medianCaptureRatio === null ? "n/a" : (s.medianCaptureRatio * 100).toFixed(0) + "%").padStart(8)} ` +
      `${String(s.firedEarlyThenRecovered).padStart(6)} ` +
      `${s.totalTrailingProceedsSol.toFixed(3).padStart(11)} ${s.totalDoNothingProceedsSol.toFixed(3).padStart(11)} ` +
      `${s.totalFixedTakeProfitProceedsSol.toFixed(3).padStart(11)}`
    );
  }
  lines.push("");
  lines.push("  tok=tokens tested  exit=clean exits  FAIL=could not be sold (excluded from every total)");
  lines.push("  run=peaked at 2x+  caught=runners the stop exited  capture=median share of the available run");
  lines.push("  early=exited then recovered above the exit price");
  lines.push("");

  for (const r of reports) {
    const s = r.summary;
    lines.push(`## ${s.label}`);
    lines.push(
      `   hard ${s.config.hardStopPercent}% · arms +${s.config.activationPercent}% · trail ${s.config.trailPercent}% · ` +
      `persist ${s.config.persistenceObservations} obs · floor ${Math.round(s.config.minHoldMs / 1000)}s · ` +
      `fixed TP +${s.fixedTakeProfitPercent}%`
    );
    lines.push(
      `   entry basis ${sol(s.totalEntryProceedsSol)} · peak available ${sol(s.totalPeakProceedsSol)} · ` +
      `${s.noRunToCapture} token(s) never rose above entry (capture n/a, not 0)`
    );
    if (s.exitFailed > 0) {
      lines.push(
        `   ${s.exitFailed} token(s) COULD NOT BE SOLD. Counted here and excluded from every SOL total above - ` +
        `folding them in would overstate the result.`
      );
    } else {
      // Zero here is NOT reassurance, and saying so is the difference between a
      // limitation and a false clean bill of health.
      lines.push(
        `   0 exit-failed - but this source CANNOT SEE honeypots. The series are liquidity readings, and ` +
        `a frozen mint authority or a sell-blocking token looks identical to a healthy one in them. Read ` +
        `this as "not observable here", never as "none happened". Real unsellability would need a sell ` +
        `simulation the backtest does not have.`
      );
    }
    // Per-token, never aggregate-only.
    const interesting = [...r.perToken]
      .sort((a, b) => b.peakMultiple - a.peakMultiple)
      .slice(0, 10);
    lines.push(`   top ${interesting.length} by peak multiple:`);
    lines.push(
      `     ${"mint".padEnd(16)} ${"peak x".padStart(7)} ${"result".padStart(12)} ${"capture".padStart(8)} ` +
      `${"exit".padStart(9)} ${"donothing".padStart(10)} ${"recovered".padStart(10)}`
    );
    for (const t of interesting) {
      lines.push(
        `     ${t.mint.slice(0, 14).padEnd(16)} ${t.peakMultiple.toFixed(2).padStart(7)} ` +
        `${t.outcome.result.padStart(12)} ` +
        `${(t.captureRatio === null ? "n/a" : (t.captureRatio * 100).toFixed(0) + "%").padStart(8)} ` +
        `${(t.outcome.exitProceedsSol === null ? "-" : t.outcome.exitProceedsSol.toFixed(4)).padStart(9)} ` +
        `${(t.doNothingProceedsSol === null ? "-" : t.doNothingProceedsSol.toFixed(4)).padStart(10)} ` +
        `${(t.recoveryAbovePct === null ? "-" : "+" + t.recoveryAbovePct.toFixed(0) + "%").padStart(10)}`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
