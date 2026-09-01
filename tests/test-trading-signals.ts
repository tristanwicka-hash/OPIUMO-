/**
 * Spot sniper test: position sizing, ATR, and exit-ladder/trailing-stop/
 * time-stop logic. Fully offline/deterministic, same philosophy as every
 * other signals test in this repo - read this alongside
 * config/default.json's trading block before flipping trading.enabled.
 *
 * Run with: npm run test:trading-signals
 */
import { computeSpotPositionSizeSol } from "../src/trading/sizing";
import { computeATR, candlesFromPrices } from "../src/trading/atr";
import {
  computeMultiple,
  computeAtrStopPrice,
  checkAtrStopLoss,
  checkTimeStop,
  checkTrailingStop,
  checkLadderTier,
} from "../src/trading/exitLogic";
import { SpotPosition } from "../src/trading/positionStore";
import { loadConfig, TradingConfig } from "../src/config";

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

function goodPosition(overrides: Partial<SpotPosition> = {}): SpotPosition {
  return {
    mint: "Mint111111111111111111111111111111111111111",
    entryPriceSol: 0.001,
    entrySizeTokens: 100_000,
    remainingSizeTokens: 100_000,
    entryAt: Date.now() - 60_000,
    highestPriceSol: 0.001,
    executedLadderTiers: [],
    stopLossPriceSol: 0.0008,
    ...overrides,
  };
}

async function main() {
  console.log("=== Spot sniper test: sizing, ATR, exit logic (all offline) ===");
  const config = loadConfig();
  const trading: TradingConfig = config.trading;
  console.log("Using config.trading:", JSON.stringify(trading));

  console.log("\n-- position sizing --");
  {
    // A realistic ATR-style stop (10% away) against the default 0.75% risk dial: the risk-based
    // formula alone would want ~7.5% of capital - the 1% hard cap is what actually binds here,
    // and that's correct/expected (see the comment in sizing.ts), not a bug.
    const r = computeSpotPositionSizeSol(trading.totalCapitalSol, 0.001, 0.0009, trading);
    check("a realistic stop distance is sized AT the hard cap, not the (much larger) raw risk-based number", r.cappedByHardLimit === true);
    check("capped size is exactly 1% of capital", Math.abs(r.positionSizeSol - trading.totalCapitalSol * 0.01) < 1e-9);
  }
  {
    // Only a very wide stop makes the risk-based number the smaller (binding) one.
    const wideStop = 0.001 * (1 - 0.9); // 90% away from entry
    const r = computeSpotPositionSizeSol(trading.totalCapitalSol, 0.001, wideStop, trading);
    check("a sufficiently wide stop is NOT capped - risk-based sizing wins because it's already smaller", r.cappedByHardLimit === false);
    check("that uncapped size is still below the hard cap (consistent, not a contradiction)", r.positionSizeSol < trading.totalCapitalSol * 0.01);
  }
  {
    // Even if riskPercentPerTrade were misconfigured to something reckless, the position must
    // still never exceed the hard-coded 1% ceiling - that's what "non-overridable" means.
    const recklessConfig: TradingConfig = { ...trading, riskPercentPerTrade: 50 };
    const r = computeSpotPositionSizeSol(10, 0.001, 0.0009999, recklessConfig);
    check(
      "a badly-misconfigured riskPercentPerTrade still can't exceed the non-overridable 1% hard cap",
      r.positionSizeSol <= 10 * 0.01 + 1e-9
    );
  }
  {
    let threw = false;
    try {
      computeSpotPositionSizeSol(0, 0.001, 0.0009, trading);
    } catch {
      threw = true;
    }
    check("zero capital throws rather than silently sizing to 0/NaN", threw);
  }

  console.log("\n-- ATR --");
  {
    const flat = candlesFromPrices(Array(20).fill(0.001));
    const atr = computeATR(flat, 14);
    check("perfectly flat prices -> ATR is ~0", atr !== null && atr < 1e-9);
  }
  {
    const volatile = candlesFromPrices([
      0.001, 0.0015, 0.0009, 0.0016, 0.0008, 0.0017, 0.0007, 0.0018, 0.0006, 0.0019, 0.0005, 0.002, 0.0004, 0.0021, 0.0003,
    ]);
    const atr = computeATR(volatile, 14);
    check("volatile prices -> ATR is meaningfully positive", atr !== null && atr > 0.0003);
  }
  {
    check("too few candles for the period -> null, not a crash or a garbage number", computeATR(candlesFromPrices([0.001, 0.0011]), 14) === null);
  }
  {
    let threw = false;
    try {
      computeATR([], 0);
    } catch {
      threw = true;
    }
    check("period <= 0 throws", threw);
  }

  console.log("\n-- exit logic: ATR stop-loss --");
  {
    const pos = goodPosition({ stopLossPriceSol: 0.0008 });
    check("price above stop -> no trigger", checkAtrStopLoss(0.0009, pos).triggered === false);
    check("price AT stop -> triggers (inclusive)", checkAtrStopLoss(0.0008, pos).triggered === true);
    const r = checkAtrStopLoss(0.0007, pos);
    check("price below stop -> triggers, full exit", r.triggered === true && r.sellPercentOfRemaining === 100);
  }
  {
    check("computeAtrStopPrice: entry - multiplier*ATR", Math.abs(computeAtrStopPrice(0.001, 0.00005, 2) - 0.0009) < 1e-12);
  }

  console.log("\n-- exit logic: time-stop --");
  {
    const stagnant = goodPosition({
      entryAt: Date.now() - 50 * 60 * 60 * 1000, // 50h ago
      highestPriceSol: 0.001, // never moved from entry
      entryPriceSol: 0.001,
    });
    const r = checkTimeStop(Date.now(), stagnant, trading.takeProfitLadder, trading.timeStopHours);
    check("stagnant position past the time-stop window -> triggers", r.triggered === true);
  }
  {
    const tooEarly = goodPosition({ entryAt: Date.now() - 1 * 60 * 60 * 1000 }); // 1h ago
    check("position still within the time window -> no trigger yet", checkTimeStop(Date.now(), tooEarly, trading.takeProfitLadder, trading.timeStopHours).triggered === false);
  }
  {
    const firstTier = Math.min(...trading.takeProfitLadder.map((t) => t.atMultipleOfEntry));
    const pumpedThenDumped = goodPosition({
      entryAt: Date.now() - 50 * 60 * 60 * 1000,
      entryPriceSol: 0.001,
      highestPriceSol: 0.001 * firstTier * 1.5, // it DID move, well past the first tier
    });
    check(
      "a position that reached the first ladder tier at some point does NOT time-stop even if it later fell back",
      checkTimeStop(Date.now(), pumpedThenDumped, trading.takeProfitLadder, trading.timeStopHours).triggered === false
    );
  }

  console.log("\n-- exit logic: trailing stop --");
  {
    const notActivatedYet = goodPosition({ entryPriceSol: 0.001, highestPriceSol: 0.0015 }); // only 1.5x, below trailingStopActivateMultiple (2x default)
    check("trailing stop not yet activated below the activation multiple -> no trigger even on a big drop", checkTrailingStop(0.0005, notActivatedYet, trading).triggered === false);
  }
  {
    const activated = goodPosition({ entryPriceSol: 0.001, highestPriceSol: 0.003 }); // 3x, above the 2x activation default
    const trailPrice = 0.003 * (1 - trading.trailingStopPercent / 100);
    check("just above the trail price -> no trigger", checkTrailingStop(trailPrice + 0.00001, activated, trading).triggered === false);
    const r = checkTrailingStop(trailPrice - 0.00001, activated, trading);
    check("below the trail price once activated -> triggers, full exit", r.triggered === true && r.sellPercentOfRemaining === 100);
  }

  console.log("\n-- exit logic: take-profit ladder --");
  {
    const fresh = goodPosition({ entryPriceSol: 0.001, executedLadderTiers: [] });
    const belowFirstTier = checkLadderTier(0.0015, fresh, trading.takeProfitLadder); // 1.5x, below the 2x first tier
    check("below the first tier -> no trigger", belowFirstTier.triggered === false);

    const atFirstTier = checkLadderTier(0.002, fresh, trading.takeProfitLadder); // exactly 2x
    check("at the first tier -> triggers", atFirstTier.triggered === true);
    check("sells the configured % for that tier", atFirstTier.sellPercentOfRemaining === trading.takeProfitLadder.find((t) => t.atMultipleOfEntry === 2)?.sellPercentOfRemaining);
  }
  {
    const alreadySoldFirstTier = goodPosition({ entryPriceSol: 0.001, executedLadderTiers: [2] });
    const r = checkLadderTier(0.0025, alreadySoldFirstTier, trading.takeProfitLadder); // 2.5x - still below the next tier (5x)
    check("an already-executed tier is never re-triggered, and price hasn't reached the next one yet", r.triggered === false);
  }
  {
    const allExecuted = goodPosition({ executedLadderTiers: trading.takeProfitLadder.map((t) => t.atMultipleOfEntry) });
    const r = checkLadderTier(0.02, allExecuted, trading.takeProfitLadder); // way past every tier
    check("every tier already executed -> no more ladder triggers, even at a huge multiple", r.triggered === false);
  }
  {
    check("computeMultiple basic math", computeMultiple(0.002, 0.001) === 2);
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
