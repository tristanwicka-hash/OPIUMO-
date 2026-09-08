/**
 * Funding-rate-arb capture analysis - PURE functions, no I/O, no config.
 *
 * ## What is and is not computable today (checked against the source)
 *
 * THEORETICAL funding capture IS computable. `logs/funding-arb-history.json`
 * persists a `FundingSample[]` per market
 * (src/perps/strategies/fundingArb/history.ts), each carrying
 * `settlementTs` and `shortRateHourlyPercent` - the % per hour a short earns
 * at that settlement. Multiply by notional and the hours held and you get
 * what the strategy *should* have collected.
 *
 * REALIZED funding capture is NOT loggable today. `PerpsTradeLog.recordClose`
 * (src/perps/tradeLog.ts) records `pnlUsd` and nothing else numeric -
 * a single figure that blends price movement, fees, and funding with no way
 * to separate them. There is no funding-collected field anywhere in the perps
 * logs, and Drift's settled-funding figure is never read into a log line.
 *
 * So `computeFundingCapture()` returns `realizedUsd: null` and a plain-language
 * `realizedUnavailableReason`, rather than pretending pnlUsd is funding. Per the
 * repo's fail-closed rule, null means "couldn't check", never 0.
 *
 * Making it real would need ONE additive field on `recordClose` -
 * `fundingCollectedUsd` - populated from Drift's settled-funding number at
 * close time. That is a change to the perps logging path, so it is left as a
 * recommendation rather than done here.
 */

/** Mirrors FundingSample in src/perps/strategies/fundingArb/types.ts, restated so this module stays dependency-free. */
export interface FundingSampleLike {
  observedAt: number;
  /** Unix SECONDS of the on-chain settlement. */
  settlementTs: number;
  /** % per hour a SHORT earns (positive) or pays (negative). */
  shortRateHourlyPercent: number;
}

export interface FundingCaptureResult {
  /** Settlements that fell inside the holding window. */
  settlementsInWindow: number;
  /** Mean shortRateHourlyPercent across those settlements. Null when none. */
  averageHourlyRatePercent: number | null;
  /** Hours the position was held. */
  holdingHours: number;
  /**
   * What the short leg should have earned, in USD:
   *   notional * (avgHourlyRate/100) * holdingHours
   * Null when there were no settlements to average.
   */
  theoreticalUsd: number | null;
  /** Always null today - the data is not logged. See the module comment. */
  realizedUsd: null;
  /** Always null today, for the same reason. */
  captureRatePercent: null;
  /** Plain-language explanation, so a report never shows a bare blank. */
  realizedUnavailableReason: string;
}

export const REALIZED_FUNDING_UNAVAILABLE =
  "not logged: src/perps/tradeLog.ts recordClose() stores only pnlUsd, which blends price move, " +
  "fees and funding. Add a fundingCollectedUsd field at close time to make this computable.";

/**
 * Theoretical funding a short leg should have captured over a holding window.
 *
 * Settlements are matched by `settlementTs` (unix SECONDS) falling within
 * [openedAtUnixSec, closedAtUnixSec]; the boundaries are inclusive so a
 * settlement landing exactly at open or close still counts.
 */
export function computeFundingCapture(
  samples: FundingSampleLike[],
  openedAtUnixSec: number,
  closedAtUnixSec: number,
  notionalUsd: number,
): FundingCaptureResult {
  const holdingSeconds = Math.max(0, closedAtUnixSec - openedAtUnixSec);
  const holdingHours = holdingSeconds / 3600;

  const inWindow = samples.filter((s) => s.settlementTs >= openedAtUnixSec && s.settlementTs <= closedAtUnixSec);

  const averageHourlyRatePercent =
    inWindow.length > 0
      ? inWindow.reduce((a, s) => a + s.shortRateHourlyPercent, 0) / inWindow.length
      : null;

  const theoreticalUsd =
    averageHourlyRatePercent !== null ? notionalUsd * (averageHourlyRatePercent / 100) * holdingHours : null;

  return {
    settlementsInWindow: inWindow.length,
    averageHourlyRatePercent,
    holdingHours,
    theoreticalUsd,
    realizedUsd: null,
    captureRatePercent: null,
    realizedUnavailableReason: REALIZED_FUNDING_UNAVAILABLE,
  };
}
