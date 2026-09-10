/**
 * Trailing-stop decision logic. PURE: no network, no clock, no side effects,
 * no order placement. Everything is injected.
 *
 * ## This is not live exit logic, and cannot become it by accident
 *
 * OPIUMO has never bought anything, so there are no positions to manage. This
 * exists to answer a question - "would trailing have helped on the tokens we
 * actually saw?" - against recorded history. It returns decisions. It contains
 * no order path, and tests/test-trailing-stop.ts fails if one appears.
 *
 * ## The three things that break naive trailing stops on memecoins
 *
 * **1. The headline price is not a price you can exit at.** On a thin pool your
 * own sell moves the market. Every threshold here is measured against
 * REALIZABLE PROCEEDS for the actual position size, computed by an injected
 * function, never against the pool's headline value. A stop that triggers at a
 * price you cannot get is a stop that does nothing.
 *
 * **2. Wicks.** One bad tick on an illiquid pool trips any stop watching ticks.
 * A breach must PERSIST - `persistenceObservations` consecutive breaching
 * observations, and `minHoldMs` since entry - before it fires. Both
 * configurable, both tested.
 *
 * **3. Some tokens cannot be sold at all.** Rugs, honeypots and frozen mint
 * authorities mean a decision to exit can fail. The proceeds function returns
 * `null` for "cannot realise anything here", and that produces EXIT_FAILED -
 * a distinct outcome, never folded in with a successful exit. Counting a
 * honeypot as a clean stop-out is precisely how a backtest overstates itself.
 */

/** One recorded observation of a pool. */
export interface PoolObservation {
  ts: string;
  /** SOL in the bonding curve / pool. The headline figure, NOT what you can get out. */
  liquiditySol: number;
}

export interface Position {
  mint: string;
  entryTs: string;
  /** Fraction of the pool this position represents, 0-1. Drives slippage. */
  poolFraction: number;
  /** Realizable proceeds at entry, in SOL. Every percentage below is measured against this. */
  entryProceedsSol: number;
}

export interface TrailingStopConfig {
  /**
   * Hard stop as a NEGATIVE percentage of entry proceeds (-50 = exit if
   * realizable proceeds fall to half what entry realised).
   */
  hardStopPercent: number;
  /** The trail only arms once proceeds exceed entry by this percent. */
  activationPercent: number;
  /** Once armed, exit when proceeds fall this far below the high-water mark. */
  trailPercent: number;
  /** Consecutive breaching observations required before firing. 1 = fire on the first. */
  persistenceObservations: number;
  /** No exit at all before this much time has passed since entry. */
  minHoldMs: number;
}

/**
 * Deliberately no DEFAULT config export.
 *
 * The brief said no hardcoded numbers, and a default set is a hardcoded set
 * that everything silently inherits. The backtest sweeps parameter sets
 * explicitly, so every number in a report traces to a set someone chose.
 */

export type ExitTrigger = "hard-stop" | "trail";

export type Decision =
  | { action: "HOLD"; reason: string }
  | { action: "EXIT"; trigger: ExitTrigger; reason: string; proceedsSol: number }
  | { action: "EXIT_FAILED"; reason: string };

export interface TrailState {
  entryProceedsSol: number;
  entryTsMs: number;
  /** Highest REALIZABLE proceeds seen so far - not the highest headline liquidity. */
  highWaterProceedsSol: number;
  armed: boolean;
  consecutiveBreaches: number;
  /** True once an EXIT or EXIT_FAILED has been returned; further steps are no-ops. */
  closed: boolean;
}

/**
 * How much SOL this position would actually realise if sold into a pool holding
 * `liquiditySol`. Returns null when the position cannot be sold at all.
 */
export type ProceedsFn = (liquiditySol: number, poolFraction: number) => number | null;

/**
 * The naive model: proceeds are the position's share of the pool, with no
 * slippage. This is what a stop watching the headline price implicitly assumes.
 *
 * Provided so the backtest can DEMONSTRATE the gap rather than assert it. It is
 * not the default anywhere.
 */
export const naiveProceeds: ProceedsFn = (liquiditySol, poolFraction) => {
  if (!(liquiditySol > 0) || !(poolFraction > 0)) return null;
  return liquiditySol * poolFraction;
};

/**
 * Constant-product slippage: selling a fraction `f` of the pool's tokens
 * returns `R * f / (1 + f)` rather than `R * f`.
 *
 * A position that is 10% of the pool realises ~9.1% of it (a 9% haircut); one
 * that is half the pool realises ~33% (a 33% haircut). Same shape as any x*y=k
 * curve, which is what a Pump.fun bonding curve is before graduation. This is
 * the model the backtest uses, because it is the one that answers the question.
 */
export const constantProductProceeds: ProceedsFn = (liquiditySol, poolFraction) => {
  if (!(liquiditySol > 0) || !(poolFraction > 0)) return null;
  return (liquiditySol * poolFraction) / (1 + poolFraction);
};

/** A pool that cannot be sold into at all - honeypot, frozen authority, rug. */
export const unsellable: ProceedsFn = () => null;

export function initState(position: Position): TrailState {
  return {
    entryProceedsSol: position.entryProceedsSol,
    entryTsMs: Date.parse(position.entryTs),
    highWaterProceedsSol: position.entryProceedsSol,
    armed: false,
    consecutiveBreaches: 0,
    closed: false,
  };
}

const pct = (from: number, to: number) => ((to - from) / from) * 100;

/**
 * One observation, one decision. Pure: returns the next state alongside it
 * rather than mutating anything.
 */
export function step(
  state: TrailState,
  obs: PoolObservation,
  config: TrailingStopConfig,
  proceeds: ProceedsFn,
  poolFraction: number
): { state: TrailState; decision: Decision } {
  if (state.closed) {
    return { state, decision: { action: "HOLD", reason: "position already closed" } };
  }

  const realizable = proceeds(obs.liquiditySol, poolFraction);
  if (realizable === null) {
    // Cannot get anything out. Distinct outcome - never a clean exit.
    return {
      state: { ...state, closed: true },
      decision: {
        action: "EXIT_FAILED",
        reason:
          `position cannot be sold at ${obs.ts} (pool ${obs.liquiditySol.toFixed(4)} SOL) - ` +
          `honeypot, frozen authority, or no liquidity to sell into`,
      },
    };
  }

  const heldMs = Date.parse(obs.ts) - state.entryTsMs;
  const changePct = pct(state.entryProceedsSol, realizable);
  const high = Math.max(state.highWaterProceedsSol, realizable);
  const armed = state.armed || changePct >= config.activationPercent;
  const drawdownPct = pct(high, realizable);

  const hardStopBreached = changePct <= config.hardStopPercent;
  const trailBreached = armed && drawdownPct <= -config.trailPercent;
  const breached = hardStopBreached || trailBreached;

  const consecutiveBreaches = breached ? state.consecutiveBreaches + 1 : 0;
  const next: TrailState = { ...state, highWaterProceedsSol: high, armed, consecutiveBreaches };

  if (!breached) {
    return {
      state: next,
      decision: {
        action: "HOLD",
        reason: armed
          ? `armed, ${drawdownPct.toFixed(1)}% off the high (trail fires at -${config.trailPercent}%)`
          : `not armed, ${changePct.toFixed(1)}% vs entry (arms at +${config.activationPercent}%)`,
      },
    };
  }

  // A breach that has not persisted is a wick until proven otherwise.
  if (consecutiveBreaches < config.persistenceObservations) {
    return {
      state: next,
      decision: {
        action: "HOLD",
        reason:
          `breach ${consecutiveBreaches}/${config.persistenceObservations} - not yet persistent, ` +
          `treating as a wick`,
      },
    };
  }

  // The time floor applies to BOTH triggers. A hard stop that fires seconds
  // after entry on one bad observation is the wick problem wearing a different
  // hat, and on these pools the first seconds are the noisiest.
  if (heldMs < config.minHoldMs) {
    return {
      state: next,
      decision: {
        action: "HOLD",
        reason: `breach persisted but only ${Math.round(heldMs / 1000)}s held, floor is ${Math.round(config.minHoldMs / 1000)}s`,
      },
    };
  }

  return {
    state: { ...next, closed: true },
    decision: {
      action: "EXIT",
      trigger: hardStopBreached ? "hard-stop" : "trail",
      proceedsSol: realizable,
      reason: hardStopBreached
        ? `hard stop: ${changePct.toFixed(1)}% vs entry, floor ${config.hardStopPercent}%`
        : `trail: ${drawdownPct.toFixed(1)}% off a high of ${high.toFixed(4)} SOL, trail ${config.trailPercent}%`,
    },
  };
}

export interface RunOutcome {
  mint: string;
  /** What happened in the end. */
  result: "exited" | "exit-failed" | "held-to-end";
  trigger: ExitTrigger | null;
  reason: string;
  entryProceedsSol: number;
  /** Proceeds actually realised. Null when the run ended without a sale. */
  exitProceedsSol: number | null;
  /** The best realizable proceeds seen at any point - the ceiling any strategy could have caught. */
  peakProceedsSol: number;
  /** Realizable proceeds at the final observation - what "do nothing" would have ended with. */
  finalProceedsSol: number | null;
  observations: number;
  exitIndex: number | null;
  heldMs: number;
}

/**
 * Walks a whole recorded series. The backtest primitive.
 *
 * `peakProceedsSol` is tracked across the WHOLE series regardless of when the
 * strategy exited, because "how much of the run did this capture?" needs the
 * ceiling the token actually reached, not the ceiling before the exit.
 */
export function runSeries(
  position: Position,
  series: PoolObservation[],
  config: TrailingStopConfig,
  proceeds: ProceedsFn
): RunOutcome {
  let state = initState(position);
  let exitProceeds: number | null = null;
  let exitIndex: number | null = null;
  let trigger: ExitTrigger | null = null;
  let reason = "held to the end of the recorded series";
  let result: RunOutcome["result"] = "held-to-end";
  let peak = position.entryProceedsSol;
  let heldMs = 0;

  for (let i = 0; i < series.length; i++) {
    const obs = series[i];
    const realizable = proceeds(obs.liquiditySol, position.poolFraction);
    if (realizable !== null) peak = Math.max(peak, realizable);

    if (state.closed) continue;

    const out = step(state, obs, config, proceeds, position.poolFraction);
    state = out.state;
    if (out.decision.action === "EXIT") {
      exitProceeds = out.decision.proceedsSol;
      exitIndex = i;
      trigger = out.decision.trigger;
      reason = out.decision.reason;
      result = "exited";
      heldMs = Date.parse(obs.ts) - Date.parse(position.entryTs);
    } else if (out.decision.action === "EXIT_FAILED") {
      exitIndex = i;
      reason = out.decision.reason;
      result = "exit-failed";
      heldMs = Date.parse(obs.ts) - Date.parse(position.entryTs);
    }
  }

  const last = series.length > 0 ? series[series.length - 1] : null;
  const finalProceeds = last ? proceeds(last.liquiditySol, position.poolFraction) : null;
  if (result === "held-to-end" && last) heldMs = Date.parse(last.ts) - Date.parse(position.entryTs);

  return {
    mint: position.mint,
    result,
    trigger,
    reason,
    entryProceedsSol: position.entryProceedsSol,
    exitProceedsSol: exitProceeds,
    peakProceedsSol: peak,
    finalProceedsSol: finalProceeds,
    observations: series.length,
    exitIndex,
    heldMs,
  };
}
