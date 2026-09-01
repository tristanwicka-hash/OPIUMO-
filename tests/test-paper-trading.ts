/**
 * Part 10 test: paper-trading mode - the "run the real pipeline, fake the
 * fill" safety net that sits UNDER trading.enabled (see config/default.json
 * and the TradingConfig.paperTrading doc comment in src/config.ts).
 *
 * Fully offline: global.fetch is mocked to stand in for Jupiter's quote API
 * (same idea as a real Jupiter response, just canned) so simulateFill() and
 * checkPosition() can be exercised without live network access, the same
 * way tests/test-trading-reconciliation.ts mocks Connection instead of
 * hitting real Solana RPC. simulateFill()/reconcilePosition() are private -
 * accessed via an `as any` cast, the established pattern from
 * test-watcher.ts and test-trading-reconciliation.ts.
 *
 * NOT covered here (needs live network, or would require mutating the real
 * config/default.json in place - a risk not worth taking for a config file
 * that gates real trading, see test-trading-engine-gating.ts's identical
 * scoping call for the enabled=true case): the full onFilterPass() paper-buy
 * path end-to-end. What IS covered - simulateFill()'s shape/behavior, and
 * checkPosition() correctly skipping reconciliation in paper mode - is the
 * part that's actually new here; onFilterPass() otherwise reuses the same
 * buy logic already covered by test-trading-signals.ts and
 * test-trading-engine-gating.ts.
 *
 * Run with: npm run test:paper-trading
 */
import { Connection, Keypair } from "@solana/web3.js";
import { SpotTradingEngine } from "../src/trading/engine";
import { PriceHistoryStore } from "../src/trading/priceHistory";
import { PositionStore, SpotPosition } from "../src/trading/positionStore";
import { SpotTradeLog } from "../src/trading/tradeLog";
import { SOL_MINT } from "../src/trading/jupiter";
import { loadConfig } from "../src/config";

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
    decimals: 6,
    entryPriceSol: 0.001,
    entrySizeTokens: 100_000,
    remainingSizeTokens: 100_000,
    entryAt: Date.now() - 60_000,
    highestPriceSol: 0.001,
    executedLadderTiers: [],
    stopLossPriceSol: 0.0008,
    sellFailureCount: 0,
    lastSellFailureAt: null,
    abandoned: false,
    ...overrides,
  };
}

/** Stands in for Jupiter's quote API - always reports "no price movement" so callers can control exactly what triggers. */
function mockFetchReturningFlatQuote(inAmount: string, outAmount: string) {
  return async (_url: any, _init: any) => {
    return {
      ok: true,
      json: async () => ({ inputMint: "in", outputMint: "out", inAmount, outAmount, priceImpactPct: "0" }),
      text: async () => "",
    } as any;
  };
}

async function main() {
  console.log("=== Part 10 test: paper trading (offline) ===");
  const testDir = "logs/test-paper-trading";
  const config = loadConfig();

  console.log("\n-- config defaults --");
  check("trading.paperTrading defaults to true (safe by default, same as trading.enabled)", config.trading.paperTrading === true);
  check("logging.paperTradesFile is configured and distinct from tradesFile", !!config.logging.paperTradesFile && config.logging.paperTradesFile !== config.logging.tradesFile);

  console.log("\n-- SpotTradingEngine accepts a null wallet (paper mode needs no real wallet) --");
  {
    const priceHistory = new PriceHistoryStore(`${testDir}/prices-a.json`);
    const positions = new PositionStore(`${testDir}/positions-a.json`);
    const tradeLog = new SpotTradeLog(`${testDir}/trades-a.jsonl`, true);
    let threw = false;
    try {
      new SpotTradingEngine({} as Connection, null, priceHistory, positions, tradeLog);
    } catch {
      threw = true;
    }
    check("constructing with wallet=null does not throw", !threw);
  }

  console.log("\n-- SpotTradeLog tags every record with isPaper --");
  {
    const tradeLog = new SpotTradeLog(`${testDir}/trades-b.jsonl`, true);
    tradeLog.recordRejectedBuy({ mint: "Mint1", reasons: ["test"] });
    const all = tradeLog.readAll() as any[];
    check("recorded event carries isPaper: true", all[all.length - 1]?.isPaper === true);

    const liveLog = new SpotTradeLog(`${testDir}/trades-c.jsonl`, false);
    liveLog.recordRejectedBuy({ mint: "Mint1", reasons: ["test"] });
    const allLive = liveLog.readAll() as any[];
    check("a live-mode log (isPaper=false) tags records isPaper: false, not omitted", allLive[allLive.length - 1]?.isPaper === false);
  }

  console.log("\n-- simulateFill(): real quote shape, fake (PAPER-) signature, no wallet/tx involved --");
  {
    const priceHistory = new PriceHistoryStore(`${testDir}/prices-d.json`);
    const positions = new PositionStore(`${testDir}/positions-d.json`);
    const tradeLog = new SpotTradeLog(`${testDir}/trades-d.jsonl`, true);
    const engine = new SpotTradingEngine({} as Connection, null, priceHistory, positions, tradeLog);

    const originalFetch = global.fetch;
    global.fetch = mockFetchReturningFlatQuote("1000000", "500000000000") as any;
    try {
      const swap = await (engine as any).simulateFill(SOL_MINT, "SomeMint111111111111111111111111111111111", "1000000", 300);
      check("signature is clearly marked as simulated (starts with PAPER-)", typeof swap.signature === "string" && swap.signature.startsWith("PAPER-"));
      check("inAmountRaw passes through the real quote's inAmount unchanged", swap.inAmountRaw === "1000000");
      check("outAmountRaw passes through the real quote's outAmount unchanged", swap.outAmountRaw === "500000000000");
      check("priceImpactPct parsed from the quote", swap.priceImpactPct === 0);
    } finally {
      global.fetch = originalFetch;
    }
  }

  console.log("\n-- checkPosition() skips wallet reconciliation entirely in paper mode --");
  {
    check("precondition: trading.paperTrading is true by default (this test relies on that)", config.trading.paperTrading === true);

    let reconcileCallCount = 0;
    const mockConnection = {
      getParsedTokenAccountsByOwner: async () => {
        reconcileCallCount++;
        throw new Error("reconcilePosition should never run in paper-trading mode - if this fires, the paperTrading skip broke");
      },
    } as unknown as Connection;

    const priceHistory = new PriceHistoryStore(`${testDir}/prices-e.json`);
    const positions = new PositionStore(`${testDir}/positions-e.json`);
    const tradeLog = new SpotTradeLog(`${testDir}/trades-e.jsonl`, true);
    // wallet=null on purpose: proves this code path never dereferences it either.
    const engine = new SpotTradingEngine(mockConnection, null, priceHistory, positions, tradeLog);

    const pos = goodPosition();
    positions.save(pos);

    // "No price movement" quote so nothing in the exit ladder/stop/trailing logic triggers -
    // this test is only about whether reconciliation ran, not about exit-trigger correctness
    // (already covered by test-trading-signals.ts).
    const originalFetch = global.fetch;
    global.fetch = mockFetchReturningFlatQuote("100000", "100000000000") as any; // 100_000 tokens @ 0.001 SOL = flat vs entry
    let threw = false;
    try {
      await engine.checkPosition(pos);
    } catch (err: any) {
      threw = true;
      console.error(`  (unexpected throw: ${err?.message || err})`);
    } finally {
      global.fetch = originalFetch;
    }

    check("checkPosition() completes without throwing", !threw);
    check("getParsedTokenAccountsByOwner (reconciliation) was never called", reconcileCallCount === 0);
    check("position is still tracked (nothing incorrectly removed it)", positions.get(pos.mint) !== null);
  }

  const fs = require("fs");
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
