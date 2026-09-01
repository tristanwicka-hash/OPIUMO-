import { TakeProfitStep, TradingConfig } from "../config";
import { SpotPosition } from "./positionStore";

export interface ExitSignal {
  /** true if any exit action should happen this cycle. */
  triggered: boolean;
  reason: string;
  /** % of the CURRENT remaining position to sell (0-100). 100 = full exit. */
  sellPercentOfRemaining: number;
}

/** currentPrice / entryPrice - how many multiples of entry the position is currently worth. */
export function computeMultiple(currentPriceSol: number, entryPriceSol: number): number {
  if (entryPriceSol <= 0) throw new Error("entryPriceSol must be > 0");
  return currentPriceSol / entryPriceSol;
}

/** ATR-based stop: entryPrice - (atrStopMultiplier * ATR). A full exit, not a partial one. */
export function computeAtrStopPrice(entryPriceSol: number, atr: number, atrStopMultiplier: number): number {
  return entryPriceSol - atrStopMultiplier * atr;
}

export function checkAtrStopLoss(currentPriceSol: number, position: SpotPosition): ExitSignal {
  if (currentPriceSol <= position.stopLossPriceSol) {
    return {
      triggered: true,
      reason: `ATR stop-loss hit: price ${currentPriceSol} <= stop ${position.stopLossPriceSol.toFixed(9)}`,
      sellPercentOfRemaining: 100,
    };
  }
  return { triggered: false, reason: "", sellPercentOfRemaining: 0 };
}

/**
 * "Exit if position hasn't moved [24-72hrs] since entry." "Moved" is defined as ever having
 * reached the ladder's first tier (the smallest atMultipleOfEntry) - a token that's just sat
 * flat near entry price for the whole window is going nowhere; one that pumped and dumped back
 * to entry HAS moved (and other exits would have handled the dump) so this only fires for true
 * stagnation, not "gave back its gains."
 */
export function checkTimeStop(
  nowMs: number,
  position: SpotPosition,
  ladder: TakeProfitStep[],
  timeStopHours: number
): ExitSignal {
  const elapsedHours = (nowMs - position.entryAt) / (1000 * 60 * 60);
  if (elapsedHours < timeStopHours) return { triggered: false, reason: "", sellPercentOfRemaining: 0 };

  const firstTierMultiple = Math.min(...ladder.map((t) => t.atMultipleOfEntry));
  const everReachedFirstTier = position.highestPriceSol / position.entryPriceSol >= firstTierMultiple;
  if (everReachedFirstTier) return { triggered: false, reason: "", sellPercentOfRemaining: 0 };

  return {
    triggered: true,
    reason: `time-stop: ${elapsedHours.toFixed(1)}h since entry (>= ${timeStopHours}h) and price never reached the first ladder tier (${firstTierMultiple}x)`,
    sellPercentOfRemaining: 100,
  };
}

/**
 * "After 2x gain, trail stop at -30% from highest price reached." Only active once the
 * position has ever reached trailingStopActivateMultiple - before that, the ATR stop is the
 * only downside protection (a trailing stop from day one would just be a worse stop-loss).
 */
export function checkTrailingStop(currentPriceSol: number, position: SpotPosition, trading: TradingConfig): ExitSignal {
  const activated = position.highestPriceSol / position.entryPriceSol >= trading.trailingStopActivateMultiple;
  if (!activated) return { triggered: false, reason: "", sellPercentOfRemaining: 0 };

  const trailStopPrice = position.highestPriceSol * (1 - trading.trailingStopPercent / 100);
  if (currentPriceSol <= trailStopPrice) {
    return {
      triggered: true,
      reason:
        `trailing stop hit: price ${currentPriceSol} <= ${trading.trailingStopPercent}% below highest ` +
        `(${position.highestPriceSol.toFixed(9)}) = ${trailStopPrice.toFixed(9)}`,
      sellPercentOfRemaining: 100,
    };
  }
  return { triggered: false, reason: "", sellPercentOfRemaining: 0 };
}

/**
 * The tiered take-profit ladder: "At 2x sell 50%, at 5x sell 25% of remainder, at 10x sell 25%
 * of remainder." Returns the single NEXT untriggered tier that the current price has reached
 * (ladder tiers are checked in ascending order and only one fires per cycle - if price gapped
 * past multiple tiers between checks, the remaining ones still fire on later cycles rather than
 * all at once, which is a reasonable, conservative default worth knowing about).
 */
export function checkLadderTier(currentPriceSol: number, position: SpotPosition, ladder: TakeProfitStep[]): ExitSignal {
  const multiple = computeMultiple(currentPriceSol, position.entryPriceSol);
  const sorted = [...ladder].sort((a, b) => a.atMultipleOfEntry - b.atMultipleOfEntry);

  for (const tier of sorted) {
    if (position.executedLadderTiers.includes(tier.atMultipleOfEntry)) continue;
    if (multiple >= tier.atMultipleOfEntry) {
      return {
        triggered: true,
        reason: `ladder tier hit: ${multiple.toFixed(2)}x >= ${tier.atMultipleOfEntry}x - selling ${tier.sellPercentOfRemaining}% of remainder`,
        sellPercentOfRemaining: tier.sellPercentOfRemaining,
      };
    }
  }
  return { triggered: false, reason: "", sellPercentOfRemaining: 0 };
}
