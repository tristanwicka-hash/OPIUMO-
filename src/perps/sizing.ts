import { BN, BASE_PRECISION, PRICE_PRECISION, QUOTE_PRECISION } from "@drift-labs/sdk";

/**
 * Unit conversions between plain JS numbers (USD, price) and the fixed-point
 * BN values Drift's on-chain program expects. Pure, deterministic, offline-
 * testable - the precision constants are static SDK exports, not live data.
 */

/** How many base-asset units (e.g. SOL) a given USD notional buys at a given price. */
export function usdNotionalToBaseAssetAmount(notionalUsd: number, oraclePrice: number): BN {
  if (oraclePrice <= 0) throw new Error("oraclePrice must be > 0");
  const baseSize = notionalUsd / oraclePrice;
  return numberToBN(baseSize, BASE_PRECISION);
}

export function priceToBN(price: number): BN {
  return numberToBN(price, PRICE_PRECISION);
}

export function usdToBN(amountUsd: number): BN {
  return numberToBN(amountUsd, QUOTE_PRECISION);
}

/** Converts a BN-scaled oracle price back to a plain number, e.g. for logging/display. */
export function bnPriceToNumber(price: BN): number {
  return bnToNumber(price, PRICE_PRECISION);
}

function numberToBN(value: number, precision: BN): BN {
  // Avoid floating point garbage in the scaled integer by rounding at a fixed number of
  // decimal places before scaling, rather than multiplying a raw float straight into a BN.
  const precisionNumber = precision.toNumber();
  return new BN(Math.round(value * precisionNumber));
}

function bnToNumber(value: BN, precision: BN): number {
  return value.toNumber() / precision.toNumber();
}
