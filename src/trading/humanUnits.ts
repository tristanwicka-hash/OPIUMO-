/**
 * Display-only conversions between raw on-chain token units (what the exit
 * logic and position store use internally throughout - see the UNIT
 * CONVENTION note in src/trading/engine.ts) and human-readable amounts/
 * prices. Never used in the actual trading math, only in what gets logged -
 * a wrong decimals value here could only ever produce a misleading log
 * line, never a wrong trade.
 */

/** Raw token units -> whole/human token count. Returns null if decimals is unknown. */
export function toHumanTokenAmount(rawAmount: number, decimals: number | null): number | null {
  if (decimals === null) return null;
  return rawAmount / Math.pow(10, decimals);
}

/** SOL-per-raw-unit price -> SOL-per-whole-token price. Returns null if decimals is unknown. */
export function toHumanPricePerToken(rawPriceSol: number, decimals: number | null): number | null {
  if (decimals === null) return null;
  return rawPriceSol * Math.pow(10, decimals);
}

/** Formats a value for a log line, falling back to a clear placeholder when decimals is unknown rather than a silently wrong number. */
export function formatHuman(value: number | null, suffix = ""): string {
  return value === null ? `?${suffix}` : `${value.toFixed(6)}${suffix}`;
}
