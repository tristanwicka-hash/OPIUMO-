/**
 * Funding-arb test 1/2: the pure signal logic + history store. Fully
 * offline/deterministic, same philosophy as tests/test-filters.ts and
 * tests/test-perps-risk.ts - this is the strategy's actual decision-making,
 * read this alongside config/default.json's fundingArb block before you
 * ever flip fundingArb.enabled.
 *
 * Run with: npm run test:funding-arb-signals
 */
import fs from "fs";
import {
  shouldEnter,
  shouldExitOnFundingFlip,
  shouldExitOnBasis,
  computePositionLegs,
  shouldRebalance,
  passesCostGate,
  hasSufficientMarginBuffer,
} from "../src/perps/strategies/fundingArb/signals";
import { FundingHistoryStore } from "../src/perps/strategies/fundingArb/history";
import { FundingSample } from "../src/perps/strategies/fundingArb/types";
import { loadConfig, FundingArbConfig } from "../src/config";

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

function sample(rate: number, tsOffsetSeconds: number): FundingSample {
  return { observedAt: Date.now(), settlementTs: 1_700_000_000 + tsOffsetSeconds, shortRateHourlyPercent: rate };
}

function samplesAt(rates: number[]): FundingSample[] {
  return rates.map((r, i) => sample(r, i * 3600));
}

async function main() {
  console.log("=== Funding-arb test: signals + history (all offline) ===");
  const config = loadConfig();
  const fa: FundingArbConfig = config.fundingArb;
  console.log("Using config.fundingArb:", JSON.stringify(fa));

  console.log("\n-- shouldEnter: N consecutive settlements, not a single spike --");
  {
    const good = samplesAt(Array(fa.minConsecutiveSettlementsToEnter).fill(fa.minFundingRateHourlyPercent + 0.01));
    check("N consecutive good settlements -> enter", shouldEnter(good, fa).decision === true);
  }
  {
    const tooFew = samplesAt(Array(fa.minConsecutiveSettlementsToEnter - 1).fill(1));
    const r = shouldEnter(tooFew, fa);
    check("fewer than N settlements recorded -> do not enter", r.decision === false);
    check("reason explains why", r.reasons[0].includes("settlement"));
  }
  {
    // One spike buried among otherwise-good settlements is NOT enough - one bad one in the window fails it.
    const rates = Array(fa.minConsecutiveSettlementsToEnter).fill(fa.minFundingRateHourlyPercent + 0.01);
    rates[0] = fa.minFundingRateHourlyPercent - 0.5; // one settlement below threshold
    const r = shouldEnter(samplesAt(rates), fa);
    check("a single below-threshold settlement in the window blocks entry (not just a spike)", r.decision === false);
  }
  {
    // Only the LAST N settlements matter - stale good data further back shouldn't count.
    const rates = [10, 10, 10, ...Array(fa.minConsecutiveSettlementsToEnter).fill(-1)];
    const r = shouldEnter(samplesAt(rates), fa);
    check("only the most recent N settlements are considered, not the whole history", r.decision === false);
  }

  console.log("\n-- shouldExitOnFundingFlip --");
  {
    const flipped = samplesAt(Array(fa.minConsecutiveSettlementsToExit).fill(-0.5));
    const r = shouldExitOnFundingFlip(flipped, fa);
    check("N consecutive settlements below threshold -> exit", r.decision === true);
  }
  {
    const stillMostlyGood = samplesAt([
      ...Array(fa.minConsecutiveSettlementsToExit - 1).fill(-0.5),
      fa.minFundingRateHourlyPercent + 1, // one good one breaks the streak
    ]);
    check("one good settlement in the exit window prevents exit", shouldExitOnFundingFlip(stillMostlyGood, fa).decision === false);
  }
  {
    check("not enough history yet -> no exit signal (nothing to compare)", shouldExitOnFundingFlip([], fa).decision === false);
  }

  console.log("\n-- shouldExitOnBasis --");
  {
    check("basis within range -> no exit", shouldExitOnBasis(fa.maxBasisPercent - 0.1, fa).decision === false);
    check("basis over range (positive) -> exit", shouldExitOnBasis(fa.maxBasisPercent + 0.1, fa).decision === true);
    check("basis over range (negative) -> exit (symmetric)", shouldExitOnBasis(-(fa.maxBasisPercent + 0.1), fa).decision === true);
  }

  console.log("\n-- position legs + rebalance --");
  {
    const legs = computePositionLegs(100, 100);
    check("balanced legs -> zero drift", legs.driftUsd === 0 && legs.driftPercentOfSpot === 0);
    check("balanced legs -> no rebalance", shouldRebalance(legs, fa).decision === false);
  }
  {
    const driftedLegs = computePositionLegs(100, 100 * (1 + (fa.rebalanceDriftPercent + 1) / 100));
    const r = shouldRebalance(driftedLegs, fa);
    check("legs drifted beyond rebalanceDriftPercent -> rebalance", r.decision === true);
    check("reason names both leg sizes", r.reasons[0].includes("spot") && r.reasons[0].includes("perp"));
  }
  {
    // spot leg near zero shouldn't divide-by-zero/crash
    const legs = computePositionLegs(0, 50);
    check("zero spot notional doesn't throw or produce NaN/Infinity", Number.isFinite(legs.driftPercentOfSpot));
  }

  console.log("\n-- passesCostGate: funding must clear round-trip costs --");
  {
    const r = passesCostGate(fa.minFundingRateHourlyPercent * 10, fa); // comfortably above threshold
    check("healthy funding rate clears costs", r.decision === true);
  }
  {
    const r = passesCostGate(0.0001, fa); // barely positive, tiny
    check("funding rate too small to clear round-trip costs -> rejected", r.decision === false);
  }
  {
    const r = passesCostGate(-0.5, fa);
    check("negative funding rate always rejected (short would be paying)", r.decision === false);
    check("reason explains a short would be paying", r.reasons[0].includes("paying"));
  }

  console.log("\n-- hasSufficientMarginBuffer --");
  {
    check("health comfortably above threshold -> ok", hasSufficientMarginBuffer(fa.minMarginBufferPercent + 20, fa).decision === true);
    check("health right at threshold -> ok (inclusive is NOT required here, boundary can go either way, just must not crash)", typeof hasSufficientMarginBuffer(fa.minMarginBufferPercent, fa).decision === "boolean");
    const r = hasSufficientMarginBuffer(fa.minMarginBufferPercent - 5, fa);
    check("health below threshold -> not ok", r.decision === false);
    check("reason mentions liquidation risk", r.reasons[0].includes("liquidation"));
  }

  console.log(`\nOffline checks: ${pass} passed, ${fail} failed`);

  console.log("\n-- FundingHistoryStore --");
  {
    const testPath = "logs/test-funding-history.json";
    if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
    const store = new FundingHistoryStore(testPath, 5);

    const added1 = store.appendIfNewSettlement(0, sample(1, 0));
    check("first sample for a market is recorded", added1 === true);
    check("getSamples returns it back", store.getSamples(0).length === 1);

    const addedDupe = store.appendIfNewSettlement(0, sample(2, 0)); // same settlementTs as before
    check("re-polling the SAME settlement is deduped, not appended again", addedDupe === false);
    check("still only 1 sample after a duplicate poll", store.getSamples(0).length === 1);

    const addedNew = store.appendIfNewSettlement(0, sample(2, 3600)); // a genuinely new settlement
    check("a genuinely new settlement is recorded", addedNew === true);
    check("history now has 2 samples", store.getSamples(0).length === 2);

    for (let i = 0; i < 10; i++) store.appendIfNewSettlement(0, sample(i, (i + 2) * 3600));
    check("history is capped at maxSamplesPerMarket, oldest dropped first", store.getSamples(0).length === 5);
    check("the cap keeps the MOST RECENT samples", store.getSamples(0)[store.getSamples(0).length - 1].shortRateHourlyPercent === 9);

    check("different markets are tracked independently", store.getSamples(1).length === 0);
    store.appendIfNewSettlement(1, sample(99, 0));
    check("market 1's history doesn't affect market 0's", store.getSamples(0).length === 5 && store.getSamples(1).length === 1);

    store.clear(0);
    check("clear() empties a market's history", store.getSamples(0).length === 0);

    fs.unlinkSync(testPath);
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
