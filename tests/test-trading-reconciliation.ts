/**
 * Spot sniper test: position-store vs actual-wallet-balance reconciliation.
 * Fully offline against a mocked Connection - reconcilePosition() is called
 * directly (it's private; accessed via a cast, same pattern already used
 * in tests/test-watcher.ts for PoolWatcher's private handlers) so this
 * doesn't need a live Jupiter quote to test, unlike a full checkPosition() run.
 *
 * This covers a real gap found in review: nothing ever checked the position
 * store against the wallet's actual balance, so a missed sell confirmation
 * (e.g. the process dying between broadcast and recording) would leave the
 * store silently wrong forever.
 *
 * Run with: npm run test:trading-reconciliation
 */
import { Connection, Keypair } from "@solana/web3.js";
import { SpotTradingEngine } from "../src/trading/engine";
import { PriceHistoryStore } from "../src/trading/priceHistory";
import { PositionStore, SpotPosition } from "../src/trading/positionStore";
import { SpotTradeLog } from "../src/trading/tradeLog";

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

/** A mock Connection that reports a fixed on-chain token balance for getParsedTokenAccountsByOwner. */
function mockConnectionWithBalance(rawAmount: number | null): Connection {
  return {
    getParsedTokenAccountsByOwner: async () => {
      if (rawAmount === null) throw new Error("simulated RPC failure");
      return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(rawAmount) } } } } } }] };
    },
  } as unknown as Connection;
}

async function main() {
  console.log("=== Spot sniper test: position reconciliation (offline) ===");
  const testDir = "logs/test-reconciliation";

  function freshEngine(connection: Connection) {
    const priceHistory = new PriceHistoryStore(`${testDir}/prices.json`);
    const positions = new PositionStore(`${testDir}/positions.json`);
    const tradeLog = new SpotTradeLog();
    const engine = new SpotTradingEngine(connection, Keypair.generate(), priceHistory, positions, tradeLog);
    return { engine, positions };
  }

  console.log("\n-- balance matches tracked amount --");
  {
    const { engine, positions } = freshEngine(mockConnectionWithBalance(100_000));
    const pos = goodPosition();
    positions.save(pos);
    const reconciled = await (engine as any).reconcilePosition(pos);
    check("returns true (position stays open)", reconciled === true);
    check("remainingSizeTokens is unchanged", positions.get(pos.mint)?.remainingSizeTokens === 100_000);
  }

  console.log("\n-- wallet holds LESS than tracked -> corrected down --");
  {
    const { engine, positions } = freshEngine(mockConnectionWithBalance(40_000));
    const pos = goodPosition({ remainingSizeTokens: 100_000 });
    positions.save(pos);
    const reconciled = await (engine as any).reconcilePosition(pos);
    check("returns true (position stays open, just corrected)", reconciled === true);
    check("remainingSizeTokens corrected DOWN to the real balance", positions.get(pos.mint)?.remainingSizeTokens === 40_000);
  }

  console.log("\n-- wallet holds ZERO -> position removed entirely --");
  {
    const { engine, positions } = freshEngine(mockConnectionWithBalance(0));
    const pos = goodPosition({ remainingSizeTokens: 100_000 });
    positions.save(pos);
    const reconciled = await (engine as any).reconcilePosition(pos);
    check("returns false (position is gone)", reconciled === false);
    check("position removed from the store", positions.get(pos.mint) === null);
  }

  console.log("\n-- wallet holds MORE than tracked -> warned, NOT auto-corrected upward --");
  {
    const { engine, positions } = freshEngine(mockConnectionWithBalance(150_000));
    const pos = goodPosition({ remainingSizeTokens: 100_000 });
    positions.save(pos);
    const reconciled = await (engine as any).reconcilePosition(pos);
    check("returns true (position stays open)", reconciled === true);
    check("remainingSizeTokens is NOT bumped up to match the higher on-chain balance", positions.get(pos.mint)?.remainingSizeTokens === 100_000);
  }

  console.log("\n-- RPC failure during reconciliation doesn't block the position or crash --");
  {
    const { engine, positions } = freshEngine(mockConnectionWithBalance(null));
    const pos = goodPosition();
    positions.save(pos);
    let threw = false;
    let reconciled = false;
    try {
      reconciled = await (engine as any).reconcilePosition(pos);
    } catch {
      threw = true;
    }
    check("does not throw on a transient RPC failure", !threw);
    check("treats it as 'still open, try again later' rather than removing the position", reconciled === true);
    check("position is untouched", positions.get(pos.mint)?.remainingSizeTokens === 100_000);
  }

  const fs = require("fs");
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
