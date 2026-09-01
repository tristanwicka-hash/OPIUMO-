import { initialize, DriftEnv } from "@drift-labs/sdk";

/**
 * Maps a human-readable market symbol ("SOL-PERP") to Drift's internal
 * numeric marketIndex, and back. Drift's `initialize()` just returns
 * bundled, static market metadata for the given env - no network call - so
 * this whole file is pure and safe to unit test offline.
 */

export function resolveMarketIndex(env: DriftEnv, symbol: string): number | null {
  const config = initialize({ env });
  const market = config.PERP_MARKETS.find((m) => m.symbol.toUpperCase() === symbol.toUpperCase());
  return market ? market.marketIndex : null;
}

export function resolveMarketSymbol(env: DriftEnv, marketIndex: number): string | null {
  const config = initialize({ env });
  const market = config.PERP_MARKETS.find((m) => m.marketIndex === marketIndex);
  return market ? market.symbol : null;
}

export function listAvailableMarkets(env: DriftEnv): string[] {
  const config = initialize({ env });
  return config.PERP_MARKETS.map((m) => m.symbol);
}
