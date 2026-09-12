/**
 * "raised-stop OR take-profit": the paper book's exit rule for Pump.fun,
 * adopted for the PAPER book only on 2026-09-12 (APPROVALS 43, decided (a)
 * after the walk-forward in reports/walk-forward-exit-2026-09-12.md).
 *
 * PURE, like trailingStop.ts: no network, no clock, no side effects, no order
 * path. Records only.
 *
 * Why a stop on SOL RAISED and not on value: Pump.fun prices a position on
 * the bonding curve (virtual reserves = real + 30 SOL), which floors the
 * position's VALUE above 50% of stake for any entry under 12.4 SOL raised -
 * 87.5% of the book's entries. A -50% value stop can therefore never fire on
 * a drain there. The pool's real SOL has no floor, so a stop defined on it
 * always can. The take-profit is where the money is: selling into the brief
 * spikes is what moved the number in every re-run.
 *
 * Definition (identical to raisedStopRule / fixedTakeProfitRule / eitherRule
 * in src/analysis/venueRerun.ts, which is what the walk-forward scored):
 *   - take-profit: exit the first observation where realizable proceeds
 *     >= entry proceeds x (1 + takeProfitPercent/100). No hold, no persistence.
 *   - raised-stop: after minHoldMs, count consecutive observations where the
 *     pool's SOL <= entry SOL x (1 - raisedDropPercent/100); exit when the
 *     count reaches persistenceObservations. Observations inside the hold do
 *     not count toward the streak.
 *   - whichever fires first.
 *   - a null realizable (cannot be sold) is EXIT_FAILED, never a clean exit.
 */
import { Decision, PoolObservation, ProceedsFn } from "./trailingStop";

export interface RaisedTakeProfitConfig {
  /** Apply this rule to positions on these venues; every other venue keeps the trailing stop. */
  venues: string[];
  /** Exit when the pool's real SOL has fallen this percent below its level at entry (30 = at 70% of entry). */
  raisedDropPercent: number;
  /** Exit when realizable proceeds reach entry x (1 + this/100). */
  takeProfitPercent: number;
  /** Consecutive breaching observations before the raised stop fires. */
  persistenceObservations: number;
  /** The raised stop cannot fire before this much time has passed since entry. */
  minHoldMs: number;
}

export interface RaisedState {
  entryLiquiditySol: number;
  entryProceedsSol: number;
  entryTsMs: number;
  consecutiveBreaches: number;
  closed: boolean;
}

export function initRaisedState(p: { entryTs: string; entryLiquiditySol: number; entryProceedsSol: number }): RaisedState {
  return { entryLiquiditySol: p.entryLiquiditySol, entryProceedsSol: p.entryProceedsSol, entryTsMs: Date.parse(p.entryTs), consecutiveBreaches: 0, closed: false };
}

export function validateRaisedTakeProfit(c: RaisedTakeProfitConfig): string[] {
  const e: string[] = [];
  if (!Array.isArray(c.venues) || c.venues.some((v) => typeof v !== "string" || !v)) e.push("paperExecution.raisedTakeProfit.venues must be a list of venue names");
  if (!(c.raisedDropPercent > 0 && c.raisedDropPercent < 100)) e.push("paperExecution.raisedTakeProfit.raisedDropPercent must be between 0 and 100 (exclusive)");
  if (!(c.takeProfitPercent > 0)) e.push("paperExecution.raisedTakeProfit.takeProfitPercent must be > 0");
  if (!(Number.isInteger(c.persistenceObservations) && c.persistenceObservations >= 1)) e.push("paperExecution.raisedTakeProfit.persistenceObservations must be an integer >= 1");
  if (!(c.minHoldMs >= 0)) e.push("paperExecution.raisedTakeProfit.minHoldMs must be >= 0");
  return e;
}

/** One observation, one decision. Pure: returns the next state alongside it. */
export function stepRaised(
  state: RaisedState,
  obs: PoolObservation,
  config: RaisedTakeProfitConfig,
  proceeds: ProceedsFn,
  poolFraction: number
): { state: RaisedState; decision: Decision } {
  if (state.closed) return { state, decision: { action: "HOLD", reason: "position already closed" } };

  const realizable = proceeds(obs.liquiditySol, poolFraction);
  if (realizable === null) {
    return {
      state: { ...state, closed: true },
      decision: { action: "EXIT_FAILED", reason: `position cannot be sold at ${obs.ts} (pool ${obs.liquiditySol.toFixed(4)} SOL) - honeypot, frozen authority, or no liquidity to sell into` },
    };
  }

  const target = state.entryProceedsSol * (1 + config.takeProfitPercent / 100);
  if (realizable >= target) {
    return {
      state: { ...state, closed: true },
      decision: { action: "EXIT", trigger: "take-profit", proceedsSol: realizable, reason: `take-profit: value ${realizable.toFixed(4)} SOL >= entry ${state.entryProceedsSol.toFixed(4)} x ${(1 + config.takeProfitPercent / 100).toFixed(2)} (+${config.takeProfitPercent}%)` },
    };
  }

  const heldMs = Date.parse(obs.ts) - state.entryTsMs;
  const floor = state.entryLiquiditySol * (1 - config.raisedDropPercent / 100);
  if (heldMs < config.minHoldMs) {
    return { state, decision: { action: "HOLD", reason: `inside the ${Math.round(config.minHoldMs / 1000)}s hold (${Math.round(heldMs / 1000)}s held); raised ${obs.liquiditySol.toFixed(3)} vs stop ${floor.toFixed(3)}` } };
  }
  const breached = obs.liquiditySol <= floor;
  const consecutiveBreaches = breached ? state.consecutiveBreaches + 1 : 0;
  const next: RaisedState = { ...state, consecutiveBreaches };
  if (!breached) return { state: next, decision: { action: "HOLD", reason: `raised ${obs.liquiditySol.toFixed(3)} SOL above stop ${floor.toFixed(3)} (entry ${state.entryLiquiditySol.toFixed(3)}); take-profit at ${target.toFixed(4)} SOL` } };
  if (consecutiveBreaches < config.persistenceObservations) return { state: next, decision: { action: "HOLD", reason: `raised-stop breach ${consecutiveBreaches}/${config.persistenceObservations} - not yet persistent, treating as a wick` } };
  return {
    state: { ...next, closed: true },
    decision: { action: "EXIT", trigger: "raised-stop", proceedsSol: realizable, reason: `raised-stop: SOL raised ${obs.liquiditySol.toFixed(3)} <= ${floor.toFixed(3)} (entry ${state.entryLiquiditySol.toFixed(3)}, -${config.raisedDropPercent}%) on ${consecutiveBreaches} consecutive readings` },
  };
}
