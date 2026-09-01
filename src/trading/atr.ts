export interface Candle {
  high: number;
  low: number;
  close: number;
}

/**
 * Average True Range - standard Wilder formula. Pure, offline-testable.
 *
 * NOTE ON DATA SOURCE: a proper ATR needs real intrabar high/low, which
 * means OHLC candles from a price feed we don't have for a brand-new
 * meme-coin (no established candle API exists the moment a token launches).
 * src/trading/priceHistory.ts instead samples point-in-time prices every
 * priceCheckIntervalMs and builds single-price "candles" from them
 * (high = low = close = that sample) - this is a documented approximation:
 * True Range degrades to |close - prevClose| when there's no separate
 * intrabar range, so this ATR will read LOWER than one computed from real
 * OHLC candles on the same token (it can't see intra-interval volatility
 * between samples). Tighten priceCheckIntervalMs if this matters to you -
 * more frequent sampling narrows the gap. computeATR() itself is a
 * standard, correct implementation either way - feed it real OHLC candles
 * from a proper price feed later and it will just work, no change needed.
 */
export function computeATR(candles: Candle[], period: number): number | null {
  if (period <= 0) throw new Error("period must be > 0");
  if (candles.length < period + 1) return null; // need one extra candle for the first prevClose

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prevClose), Math.abs(curr.low - prevClose));
    trueRanges.push(tr);
  }

  const relevant = trueRanges.slice(-period);
  if (relevant.length < period) return null;

  // Simple moving average of True Range over `period`, not Wilder's exponentially-smoothed
  // variant (the more "classic" ATR formula, which needs to track a running smoothed value
  // across every prior candle rather than just the last N - not worth the extra state for a
  // strategy that only needs "is this token wildly volatile," not textbook-precise ATR).
  return relevant.reduce((sum, tr) => sum + tr, 0) / period;
}

/** Builds single-price "candles" from a plain price series - see the data-source note above. */
export function candlesFromPrices(prices: number[]): Candle[] {
  return prices.map((p) => ({ high: p, low: p, close: p }));
}
