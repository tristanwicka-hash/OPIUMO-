/**
 * Funding-rate-arb capture analysis - PURE functions, no I/O, no config.
 *
 * ## What the two numbers mean
 *
 * THEORETICAL capture is what the observed funding rates say the short leg
 * *should* have earned. It comes from `logs/funding-arb-history.json`, which
 * persists a `FundingSample[]` per market (src/perps/strategies/fundingArb/history.ts):
 * each sample carries `settlementTs` and `shortRateHourlyPercent`. Multiply the
 * average in-window rate by notional and hours held.
 *
 * REALIZED capture is what actually landed, read from the `feesAndFundingUsd`
 * field on the perps close record (src/perps/tradeLog.ts), which comes from
 * Drift's own `calculateFeesAndFundingPnl()` - settled plus unsettled, over the
 * position's whole life.
 *
 * ## The one caveat that matters
 *
 * The realized figure is fees AND funding, not funding alone. Drift derives it
 * from `quoteBreakEvenAmount - quoteEntryAmount`, which nets trading fees in;
 * there is no separate lifetime funding-only figure on the position. So the
 * capture rate is measured NET of fees while the theoretical figure is GROSS.
 *
 * That is deliberately the more useful comparison for this strategy: the whole
 * point of `estimatedRoundTripCostBps` is to check funding actually beats fees.
 * A capture rate materially below 100% is the strategy telling you fees ate the
 * carry. It is not an error in the measurement, and the report says so.
 *
 * Unknown is null everywhere, never 0 - "couldn't read it" and "it was zero"
 * are different facts, the same rule the filters use.
 */

/** Mirrors FundingSample in src/perps/strategies/fundingArb/types.ts, restated so this module stays dependency-free. */
export interface FundingSampleLike {
  observedAt: number;
  /** Unix SECONDS of the on-chain settlement. */
  settlementTs: number;
  /** % per hour a SHORT earns (positive) or pays (negative). */
  shortRateHourlyPercent: number;
}

/** One `event: "close"` line from logs/perps-trades.jsonl. Only fields we read are typed. */
export interface PerpsCloseRecord {
  ts?: string;
  event?: string;
  market?: string;
  notionalUsd?: number;
  pnlUsd?: number;
  feesAndFundingUsd?: number | null;
  unsettledFundingUsd?: number | null;
  reason?: string;
  [key: string]: unknown;
}

export interface FundingCaptureResult {
  /** Settlements that fell inside the holding window. */
  settlementsInWindow: number;
  /** Mean shortRateHourlyPercent across those settlements. Null when none. */
  averageHourlyRatePercent: number | null;
  /** Hours the position was held. */
  holdingHours: number;
  /**
   * What the short leg should have earned GROSS, in USD:
   *   notional * (avgHourlyRate/100) * holdingHours
   * Null when there were no settlements to average.
   */
  theoreticalUsd: number | null;
  /** What actually landed, NET of fees. Null when the close record didn't carry it. */
  realizedUsd: number | null;
  /**
   * realized / theoretical * 100. Null when either side is unknown, or when
   * theoretical is 0 (a rate of nothing has no meaningful capture rate).
   * Below 100% typically means fees ate part of the carry - see the module note.
   */
  captureRatePercent: number | null;
  /** Set only when a figure could not be produced, so a report never shows a bare blank. */
  unavailableReason: string | null;
}

/**
 * Theoretical vs realized funding capture over one position's holding window.
 *
 * Settlements are matched by `settlementTs` (unix SECONDS) falling within
 * [openedAtUnixSec, closedAtUnixSec], inclusive at both ends so a settlement
 * landing exactly at open or close still counts.
 *
 * `realizedFeesAndFundingUsd` is the `feesAndFundingUsd` field from the close
 * record; pass null when the record predates that field.
 */
export function computeFundingCapture(
  samples: FundingSampleLike[],
  openedAtUnixSec: number,
  closedAtUnixSec: number,
  notionalUsd: number,
  realizedFeesAndFundingUsd: number | null = null,
): FundingCaptureResult {
  const holdingSeconds = Math.max(0, closedAtUnixSec - openedAtUnixSec);
  const holdingHours = holdingSeconds / 3600;

  const inWindow = samples.filter((s) => s.settlementTs >= openedAtUnixSec && s.settlementTs <= closedAtUnixSec);

  const averageHourlyRatePercent =
    inWindow.length > 0 ? inWindow.reduce((a, s) => a + s.shortRateHourlyPercent, 0) / inWindow.length : null;

  const theoreticalUsd =
    averageHourlyRatePercent !== null ? notionalUsd * (averageHourlyRatePercent / 100) * holdingHours : null;

  const realizedUsd = realizedFeesAndFundingUsd;

  let captureRatePercent: number | null = null;
  let unavailableReason: string | null = null;

  if (realizedUsd === null) {
    unavailableReason =
      "realized figure missing: the close record carried no feesAndFundingUsd " +
      "(a position closed before that field existed, or the market account was unreadable at close)";
  } else if (theoreticalUsd === null) {
    unavailableReason =
      "theoretical figure unavailable: no funding settlements were recorded inside the holding window";
  } else if (theoreticalUsd === 0) {
    unavailableReason = "theoretical funding was exactly 0 - a capture rate against zero is undefined";
  } else {
    captureRatePercent = (realizedUsd / theoreticalUsd) * 100;
  }

  return {
    settlementsInWindow: inWindow.length,
    averageHourlyRatePercent,
    holdingHours,
    theoreticalUsd,
    realizedUsd,
    captureRatePercent,
    unavailableReason,
  };
}

export interface FundingCaptureSummary {
  closes: number;
  /** Closes that carried a usable realized figure. */
  closesWithRealized: number;
  totalRealizedUsd: number | null;
  totalTheoreticalUsd: number | null;
  /** Aggregate realized/theoretical across every close that had both. Null when not computable. */
  overallCaptureRatePercent: number | null;
  perClose: Array<{ market: string; closedAt: string | null } & FundingCaptureResult>;
}

/**
 * Aggregate capture across every `close` record in a perps trade log.
 *
 * Each close is paired with the matching `open` for that market to establish
 * the holding window; a close with no preceding open is skipped rather than
 * guessed at. Aggregate totals only include closes where BOTH sides are known,
 * so a partially-populated log cannot quietly drag the headline rate around.
 */
export function summarizeFundingCapture(
  records: PerpsCloseRecord[],
  samplesByMarket: Record<string, FundingSampleLike[]>,
): FundingCaptureSummary {
  const openByMarket = new Map<string, PerpsCloseRecord>();
  const perClose: FundingCaptureSummary["perClose"] = [];

  for (const rec of records) {
    const market = rec.market;
    if (!market) continue;

    if (rec.event === "open") {
      openByMarket.set(market, rec);
      continue;
    }
    if (rec.event !== "close") continue;

    const open = openByMarket.get(market);
    if (!open) continue; // a close with no matching open - window unknowable, skip rather than guess
    openByMarket.delete(market);

    const openedMs = Date.parse(open.ts ?? "");
    const closedMs = Date.parse(rec.ts ?? "");
    if (Number.isNaN(openedMs) || Number.isNaN(closedMs)) continue;

    const realized = typeof rec.feesAndFundingUsd === "number" ? rec.feesAndFundingUsd : null;
    const notional = typeof rec.notionalUsd === "number" ? rec.notionalUsd : (open.notionalUsd ?? 0);

    const result = computeFundingCapture(
      samplesByMarket[market] ?? [],
      Math.floor(openedMs / 1000),
      Math.floor(closedMs / 1000),
      notional,
      realized,
    );
    perClose.push({ market, closedAt: rec.ts ?? null, ...result });
  }

  const withBoth = perClose.filter((c) => c.realizedUsd !== null && c.theoreticalUsd !== null);
  const totalRealizedUsd = withBoth.length > 0 ? withBoth.reduce((a, c) => a + (c.realizedUsd ?? 0), 0) : null;
  const totalTheoreticalUsd = withBoth.length > 0 ? withBoth.reduce((a, c) => a + (c.theoreticalUsd ?? 0), 0) : null;

  const overallCaptureRatePercent =
    totalRealizedUsd !== null && totalTheoreticalUsd !== null && totalTheoreticalUsd !== 0
      ? (totalRealizedUsd / totalTheoreticalUsd) * 100
      : null;

  return {
    closes: perClose.length,
    closesWithRealized: perClose.filter((c) => c.realizedUsd !== null).length,
    totalRealizedUsd,
    totalTheoreticalUsd,
    overallCaptureRatePercent,
    perClose,
  };
}
