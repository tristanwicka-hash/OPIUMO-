/**
 * Pure retry/backoff/abandonment decisions for sell execution failures.
 * Extracted from src/trading/engine.ts so the logic (which used to just
 * retry every monitoring cycle forever, hammering Jupiter indefinitely on
 * a genuinely dead token - a rug, zero liquidity, whatever) is testable in
 * isolation, same as every other decision function in this repo.
 */

export interface SellFailureState {
  sellFailureCount: number;
  lastSellFailureAt: number | null;
}

/**
 * Exponential backoff: base * 2^(failureCount - 1), capped at maxMs.
 * failureCount=0 (no failures yet, or reset by a success) always returns
 * true immediately - only a PRIOR failure imposes a wait.
 */
export function shouldAttemptSell(state: SellFailureState, nowMs: number, baseMs: number, maxMs: number): boolean {
  if (state.sellFailureCount <= 0 || state.lastSellFailureAt === null) return true;
  const backoffMs = Math.min(baseMs * Math.pow(2, state.sellFailureCount - 1), maxMs);
  return nowMs - state.lastSellFailureAt >= backoffMs;
}

/** How long (ms) until the next attempt is allowed - for logging/visibility, not a decision itself. */
export function nextAttemptInMs(state: SellFailureState, nowMs: number, baseMs: number, maxMs: number): number {
  if (state.sellFailureCount <= 0 || state.lastSellFailureAt === null) return 0;
  const backoffMs = Math.min(baseMs * Math.pow(2, state.sellFailureCount - 1), maxMs);
  return Math.max(0, backoffMs - (nowMs - state.lastSellFailureAt));
}

/** Give up entirely once consecutive failures cross the configured limit. */
export function shouldAbandonPosition(sellFailureCount: number, maxConsecutiveSellFailures: number): boolean {
  return sellFailureCount >= maxConsecutiveSellFailures;
}
