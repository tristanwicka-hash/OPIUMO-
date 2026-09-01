/**
 * Perps test 1/2: the risk engine + market registry + sizing math. All pure
 * functions, fully offline/deterministic - no Drift connection needed,
 * same philosophy as tests/test-filters.ts for the spot bot.
 *
 * Run with: npm run test:perps-risk
 */
import {
  validateOrderAgainstRiskLimits,
  estimateLiquidationPrice,
  computePositionSizeForRisk,
  computeStopLossPrice,
  computeTakeProfitPrice,
} from "../src/perps/risk";
import { resolveMarketIndex, resolveMarketSymbol, listAvailableMarkets } from "../src/perps/marketRegistry";
import { usdNotionalToBaseAssetAmount, priceToBN, bnPriceToNumber } from "../src/perps/sizing";
import { loadConfig, PerpsConfig } from "../src/config";
import { PerpOrderRequest } from "../src/perps/types";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    pass++;
  } else {
    console.error(`  FAIL: ${name}`);
    fail++;
  }
}

function goodOrder(overrides: Partial<PerpOrderRequest> = {}): PerpOrderRequest {
  return {
    market: "SOL-PERP",
    direction: "long",
    notionalUsd: 50,
    leverage: 2,
    stopLossPercent: -10,
    takeProfitPercent: 20,
    ...overrides,
  };
}

async function main() {
  console.log("=== Perps test: risk engine, market registry, sizing (all offline) ===");
  const config = loadConfig();
  const perpsConfig: PerpsConfig = config.perps;
  console.log("Using config.perps:", JSON.stringify(perpsConfig));

  console.log("\n-- market registry (SDK's bundled static config, no network) --");
  {
    const mainnetIndex = resolveMarketIndex("mainnet-beta", "SOL-PERP");
    check("SOL-PERP resolves to a market index on mainnet-beta", mainnetIndex !== null && mainnetIndex >= 0);
    const devnetIndex = resolveMarketIndex("devnet", "SOL-PERP");
    check("SOL-PERP resolves to a market index on devnet", devnetIndex !== null && devnetIndex >= 0);
    check("unknown symbol resolves to null, not a guess", resolveMarketIndex("mainnet-beta", "NOT-A-REAL-MARKET") === null);
    check("round-trips index -> symbol", mainnetIndex !== null && resolveMarketSymbol("mainnet-beta", mainnetIndex) === "SOL-PERP");
    check("lists at least a handful of markets", listAvailableMarkets("mainnet-beta").length > 3);
  }

  console.log("\n-- risk gate: baseline good order passes --");
  {
    const r = validateOrderAgainstRiskLimits(goodOrder(), perpsConfig, 0);
    check("comfortably-good order is allowed", r.allowed === true);
    check("no reasons when allowed", r.reasons.length === 0);
  }

  console.log("\n-- risk gate: each rule fails individually --");
  {
    const r = validateOrderAgainstRiskLimits(goodOrder({ market: "DOGE-PERP" }), perpsConfig, 0);
    check("market not in allowedMarkets -> rejected", !r.allowed);
    check("reason names the market", r.reasons.some((x) => x.includes("DOGE-PERP")));
  }
  {
    const r = validateOrderAgainstRiskLimits(goodOrder({ notionalUsd: perpsConfig.maxPositionSizeUsd + 1 }), perpsConfig, 0);
    check("notional over maxPositionSizeUsd -> rejected", !r.allowed);
    check("reason mentions notional/maxPositionSizeUsd", r.reasons.some((x) => x.includes("maxPositionSizeUsd")));
  }
  {
    const r = validateOrderAgainstRiskLimits(goodOrder({ leverage: perpsConfig.maxLeverage + 1 }), perpsConfig, 0);
    check("leverage over maxLeverage -> rejected", !r.allowed);
    check("reason mentions maxLeverage", r.reasons.some((x) => x.includes("maxLeverage")));
  }
  {
    const r = validateOrderAgainstRiskLimits(goodOrder({ stopLossPercent: undefined }), perpsConfig, 0);
    check("missing stop-loss when requireStopLoss=true -> rejected", perpsConfig.requireStopLoss ? !r.allowed : true);
  }
  {
    const r = validateOrderAgainstRiskLimits(goodOrder({ stopLossPercent: 10 }), perpsConfig, 0);
    check("positive stopLossPercent (wrong sign) -> rejected", !r.allowed);
  }
  {
    const r = validateOrderAgainstRiskLimits(goodOrder({ takeProfitPercent: -5 }), perpsConfig, 0);
    check("negative takeProfitPercent (wrong sign) -> rejected", !r.allowed);
  }
  {
    const r = validateOrderAgainstRiskLimits(goodOrder(), perpsConfig, perpsConfig.maxOpenPositions);
    check("already at maxOpenPositions -> rejected", !r.allowed);
    check("reason mentions maxOpenPositions", r.reasons.some((x) => x.includes("maxOpenPositions")));
  }
  {
    const r = validateOrderAgainstRiskLimits(goodOrder({ notionalUsd: -5, leverage: 0 }), perpsConfig, 0);
    check("multiple simultaneous failures all reported, not just the first", r.reasons.length >= 2);
  }

  console.log("\n-- stop-loss / take-profit price targets --");
  const approxEqual = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  {
    check("long stop-loss sits below entry", approxEqual(computeStopLossPrice(100, -10, "long"), 90));
    check("long take-profit sits above entry", approxEqual(computeTakeProfitPrice(100, 20, "long"), 120));
    check("short stop-loss sits above entry", approxEqual(computeStopLossPrice(100, -10, "short"), 110));
    check("short take-profit sits below entry", approxEqual(computeTakeProfitPrice(100, 20, "short"), 80));
  }
  {
    let threw = false;
    try {
      computeStopLossPrice(100, 10, "long"); // wrong sign
    } catch {
      threw = true;
    }
    check("computeStopLossPrice rejects a positive stopLossPercent", threw);
  }

  console.log("\n-- liquidation price estimate (approximation, sanity-check only) --");
  {
    const liq2x = estimateLiquidationPrice(100, 2, "long");
    const liq10x = estimateLiquidationPrice(100, 10, "long");
    check("higher leverage -> liquidation price closer to entry (long)", liq10x > liq2x);
    check("long liquidation price is below entry", liq2x < 100 && liq10x < 100);

    const shortLiq2x = estimateLiquidationPrice(100, 2, "short");
    const shortLiq10x = estimateLiquidationPrice(100, 10, "short");
    check("higher leverage -> liquidation price closer to entry (short)", shortLiq10x < shortLiq2x);
    check("short liquidation price is above entry", shortLiq2x > 100 && shortLiq10x > 100);
  }

  console.log("\n-- fixed-fractional position sizing --");
  {
    // $1000 account, risking 2% ($20) per trade, entry $100, stop at $90 (10% away)
    // -> size such that a 10% move = $20 loss => notional = $200
    const size = computePositionSizeForRisk(1000, 2, 100, 90);
    check("position sizing matches the fixed-fractional formula ($200 notional)", Math.abs(size - 200) < 0.01);
  }

  console.log("\n-- sizing/precision conversions (BN <-> number) --");
  {
    const base = usdNotionalToBaseAssetAmount(200, 100); // $200 at $100/unit = 2 units
    check("usdNotionalToBaseAssetAmount computes a positive BN", !base.isZero() && !base.isNeg());
    const priceBN = priceToBN(123.45);
    const roundTripped = bnPriceToNumber(priceBN);
    check("price round-trips through BN within float precision", Math.abs(roundTripped - 123.45) < 0.001);
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
