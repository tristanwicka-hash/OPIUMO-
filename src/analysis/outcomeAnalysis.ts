/**
 * The question this file exists to answer: **of the tokens the filters
 * rejected, how many were worth buying?**
 *
 * A 0% pass rate is not evidence of anything on its own. If none of the
 * rejected tokens went anywhere, the filters are doing their job perfectly.
 * If some of them ran, the filters are burning money. Same number, opposite
 * conclusions - and only outcome data separates them.
 *
 * Pure functions over already-parsed records. No file I/O, no network, no
 * config: the loader lives in the CLI script so the maths is testable in
 * isolation and gives the same answer for the same input every time.
 */

import { OutcomeRecord } from "../data/outcomeTracker";

/** The decision-log shape this analysis needs. Deliberately a subset - decisions.jsonl carries far more. */
export interface DecisionLike {
  mint: string;
  decision: string;
  metrics?: {
    uniqueWallets?: number | null;
    transactionCount?: number | null;
    topHolderPercent?: number | null;
    liquiditySol?: number | null;
  } | null;
}

/**
 * What counts as a token worth having bought.
 *
 * ## Why BOTH a multiple and an absolute floor
 *
 * Either one alone produces nonsense on real Pump.fun data:
 *
 *  - Multiple alone: the median token sits at 0.002 SOL. A move to 0.006 SOL
 *    is a "3x" that represents four thousandths of a SOL of real buying - noise
 *    rounded up into a headline. The first pass over real data had exactly this
 *    case (0.002 -> 0.005 SOL, 3.47x) sitting two rows above a genuine 15x.
 *  - Absolute alone: a token that was already at 25 SOL when detected and
 *    crawled to 32 SOL is above any sensible floor, but nobody made money on
 *    it - there was no move to catch.
 *
 * Requiring both means a winner is a token that went from small to genuinely
 * bought-into, which is the only thing an early-entry strategy could have
 * profited from.
 */
export interface WinnerDefinition {
  /** Liquidity must reach at least this many SOL at some checkpoint. */
  minAbsoluteLiquiditySol: number;
  /** AND liquidity must have grown by at least this multiple from its baseline. */
  minLiquidityMultiple: number;
}

export const DEFAULT_WINNER: WinnerDefinition = {
  minAbsoluteLiquiditySol: 5,
  minLiquidityMultiple: 3,
};

export interface TokenOutcome {
  mint: string;
  baselineLiquiditySol: number | null;
  /** Best liquidity seen across all checkpoints. */
  peakLiquiditySol: number | null;
  peakMultiple: number | null;
  checkpointsObserved: number;
  /** False when baseline or peak is missing - such a token is counted as unknown, never as a loser. */
  evaluable: boolean;
  isWinner: boolean;
}

/** Collapses many checkpoint records per mint into one outcome per mint. */
export function summarizeOutcomes(
  records: OutcomeRecord[],
  winner: WinnerDefinition = DEFAULT_WINNER
): Map<string, TokenOutcome> {
  const byMint = new Map<string, OutcomeRecord[]>();
  for (const r of records) {
    const list = byMint.get(r.mint);
    if (list) list.push(r);
    else byMint.set(r.mint, [r]);
  }

  const out = new Map<string, TokenOutcome>();
  for (const [mint, rows] of byMint) {
    const readings = rows.filter((r) => r.ok && r.liquiditySol !== null).map((r) => r.liquiditySol as number);
    const peak = readings.length > 0 ? Math.max(...readings) : null;

    // Any row carries the baseline; prefer a non-null one. A null baseline is
    // "we could not measure it", never zero - dividing by an assumed zero would
    // manufacture an infinite multiple out of a failed read.
    const baselineRow = rows.find((r) => r.baselineLiquiditySol !== null);
    const baseline = baselineRow ? (baselineRow.baselineLiquiditySol as number) : null;

    const evaluable = peak !== null && baseline !== null && baseline > 0;
    const peakMultiple = evaluable ? (peak as number) / (baseline as number) : null;
    const isWinner =
      evaluable &&
      (peak as number) >= winner.minAbsoluteLiquiditySol &&
      (peakMultiple as number) >= winner.minLiquidityMultiple;

    out.set(mint, {
      mint,
      baselineLiquiditySol: baseline,
      peakLiquiditySol: peak,
      peakMultiple,
      checkpointsObserved: readings.length,
      evaluable,
      isWinner,
    });
  }
  return out;
}

export interface SkippedWinnerReport {
  /** Tokens present in BOTH logs with a usable outcome. Everything below is out of this. */
  evaluableTokens: number;
  /** Tokens joined but whose outcome could not be computed - reported, never silently dropped. */
  unevaluableTokens: number;
  skipped: number;
  passed: number;
  winners: number;
  /** Winners the filters rejected. This is the number the whole exercise is for. */
  skippedWinners: number;
  /** Winners the filters caught. */
  passedWinners: number;
  /** Of everything skipped, the fraction that turned out to be winners. */
  skippedWinnerRate: number | null;
  /** Of all winners, the fraction the filters missed. */
  missRate: number | null;
  winnerDefinition: WinnerDefinition;
  /** The rejected winners themselves, worst miss first, so they can be inspected individually. */
  missedWinners: TokenOutcome[];
}

export function analyzeSkippedWinners(
  decisions: DecisionLike[],
  outcomes: Map<string, TokenOutcome>,
  winner: WinnerDefinition = DEFAULT_WINNER
): SkippedWinnerReport {
  // One decision per mint: the first is the live t+0 decision, which is the one
  // the filters actually made.
  const firstDecision = new Map<string, DecisionLike>();
  for (const d of decisions) {
    if (!firstDecision.has(d.mint)) firstDecision.set(d.mint, d);
  }

  let evaluableTokens = 0;
  let unevaluableTokens = 0;
  let skipped = 0;
  let passed = 0;
  let winners = 0;
  let skippedWinners = 0;
  let passedWinners = 0;
  const missedWinners: TokenOutcome[] = [];

  for (const [mint, decision] of firstDecision) {
    const outcome = outcomes.get(mint);
    if (!outcome) continue;
    if (!outcome.evaluable) {
      unevaluableTokens++;
      continue;
    }
    evaluableTokens++;

    const isSkip = decision.decision.toUpperCase() === "SKIP";
    if (isSkip) skipped++;
    else passed++;

    if (outcome.isWinner) {
      winners++;
      if (isSkip) {
        skippedWinners++;
        missedWinners.push(outcome);
      } else {
        passedWinners++;
      }
    }
  }

  missedWinners.sort((a, b) => (b.peakMultiple ?? 0) - (a.peakMultiple ?? 0));

  return {
    evaluableTokens,
    unevaluableTokens,
    skipped,
    passed,
    winners,
    skippedWinners,
    passedWinners,
    skippedWinnerRate: skipped > 0 ? skippedWinners / skipped : null,
    missRate: winners > 0 ? skippedWinners / winners : null,
    winnerDefinition: winner,
    missedWinners,
  };
}

export interface ThresholdSet {
  label: string;
  minUniqueWallets: number;
  minTransactionCount: number;
  maxTopHolderPercent: number;
  minLiquiditySol: number;
}

export interface ThresholdCounterfactual {
  set: ThresholdSet;
  /** Tokens this threshold set would have admitted. */
  wouldPass: number;
  /** Of those, how many were winners. */
  winnersCaught: number;
  winnersMissed: number;
  /** Losers admitted - the cost side, which a capture rate alone hides. */
  losersAdmitted: number;
  /** winnersCaught / wouldPass. Null when nothing would have passed. */
  precision: number | null;
  /** winnersCaught / total winners. Null when there were no winners to catch. */
  recall: number | null;
  /** Tokens whose decision-time metrics were incomplete, so this set could not be applied. */
  notEvaluable: number;
}

/**
 * Replays candidate threshold sets against decision-time metrics joined to real
 * outcomes: how many winners each set would have caught, and how many losers it
 * would have let in.
 *
 * **Fails closed, exactly as the live engine does.** A token with any missing
 * decision-time metric is counted as `notEvaluable` rather than assumed to pass
 * - assuming otherwise would inflate every capture rate here with tokens the
 * real bot would have rejected for unknown data.
 *
 * This is a counterfactual on a fixed sample, not a backtest with execution.
 * It says which tokens a rule would have admitted; it says nothing about the
 * price actually obtainable, slippage, or whether the position could have been
 * exited - all of which make the real result worse, never better.
 */
export function evaluateThresholds(
  decisions: DecisionLike[],
  outcomes: Map<string, TokenOutcome>,
  sets: ThresholdSet[]
): ThresholdCounterfactual[] {
  const firstDecision = new Map<string, DecisionLike>();
  for (const d of decisions) {
    if (!firstDecision.has(d.mint)) firstDecision.set(d.mint, d);
  }

  const totalWinners = [...firstDecision.keys()].filter((m) => outcomes.get(m)?.isWinner).length;

  return sets.map((set) => {
    let wouldPass = 0;
    let winnersCaught = 0;
    let losersAdmitted = 0;
    let notEvaluable = 0;

    for (const [mint, decision] of firstDecision) {
      const outcome = outcomes.get(mint);
      if (!outcome || !outcome.evaluable) continue;

      const m = decision.metrics;
      const complete =
        m != null &&
        m.uniqueWallets != null &&
        m.transactionCount != null &&
        m.topHolderPercent != null &&
        m.liquiditySol != null;

      if (!complete) {
        notEvaluable++;
        continue;
      }

      const passes =
        (m!.uniqueWallets as number) >= set.minUniqueWallets &&
        (m!.transactionCount as number) >= set.minTransactionCount &&
        (m!.topHolderPercent as number) <= set.maxTopHolderPercent &&
        (m!.liquiditySol as number) >= set.minLiquiditySol;

      if (!passes) continue;
      wouldPass++;
      if (outcome.isWinner) winnersCaught++;
      else losersAdmitted++;
    }

    return {
      set,
      wouldPass,
      winnersCaught,
      winnersMissed: totalWinners - winnersCaught,
      losersAdmitted,
      precision: wouldPass > 0 ? winnersCaught / wouldPass : null,
      recall: totalWinners > 0 ? winnersCaught / totalWinners : null,
      notEvaluable,
    };
  });
}

/**
 * How much confidence the sample supports. Rare events need large samples: at a
 * 2% winner rate, 100 tokens contain two winners and one of them landing either
 * side of a threshold swings every rate above by 50%.
 *
 * Returns a warning string, or null when the sample is genuinely adequate.
 * Deliberately returns the warning rather than logging it, so every report that
 * prints a number is forced to print this next to it.
 */
export function sampleAdequacyWarning(evaluableTokens: number, winners: number): string | null {
  if (evaluableTokens < 100) {
    return `Only ${evaluableTokens} evaluable tokens. Winner rates here are indicative at best - a rate this sparse needs several hundred tokens before it means much.`;
  }
  if (winners < 5) {
    return `Only ${winners} winner(s) in ${evaluableTokens} tokens. Every rate below rests on those ${winners} - one more or one fewer moves them substantially. Treat direction as real and magnitude as not yet known.`;
  }
  return null;
}
