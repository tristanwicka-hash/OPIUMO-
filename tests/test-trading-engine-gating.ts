/**
 * Spot sniper test: the two most important gates on SpotTradingEngine.onFilterPass()
 * - the ones that directly enforce the "no auto-execution until trading.enabled"
 * non-negotiable. Both are checked BEFORE any network call, so they're testable
 * fully offline against the real (default, enabled=false) config.
 *
 * NOT covered here: the duplicate-position and maxOpenPositions gates (simple
 * boolean/count checks, lower risk than the numeric logic already covered by
 * test-trading-signals.ts) and the actual Jupiter execution path (needs live
 * network - see npm run test:trading-live). Testing those gates independently
 * would need config.trading.enabled=true, which the shared config singleton
 * doesn't support overriding per-test without editing config/default.json -
 * a reasonable scoping call given everything else already covered this session.
 *
 * Run with: npm run test:trading-engine-gating
 */
import fs from "fs";
import { assertNoProductionWrites } from "./no-production-writes";
import { Connection, Keypair } from "@solana/web3.js";
import { SpotTradingEngine } from "../src/trading/engine";
import { PriceHistoryStore } from "../src/trading/priceHistory";
import { PositionStore } from "../src/trading/positionStore";
import { SpotTradeLog } from "../src/trading/tradeLog";
import { FilterResult } from "../src/filters/engine";
import { NewPoolEvent } from "../src/watcher/types";
import { loadConfig } from "../src/config";

let pass = 0;
let fail = 0;
/**
 * Reads the suite's own trade log back as parsed records. Parsed, never
 * grepped: a substring search over the raw file would match the reason text
 * inside an unrelated event and report a gate that never fired.
 */
function readTradeLog(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    pass++;
  } else {
    console.error(`  FAIL: ${name}`);
    fail++;
  }
}

const event: NewPoolEvent = {
  source: "pumpfun",
  signature: "sig",
  slot: 1,
  mint: "Mint111111111111111111111111111111111111111",
  poolAddress: "Pool111111111111111111111111111111111111111",
  creator: "Creator1111111111111111111111111111111111111",
  detectedAt: new Date().toISOString(),
};

async function main() {
  console.log("=== Spot sniper test: trading engine gates (offline) ===");
  const config = loadConfig();
  check("precondition: trading.enabled is false by default (this test relies on that)", config.trading.enabled === false);

  const testDir = "logs/test-engine-gating";
  fs.rmSync(testDir, { recursive: true, force: true });
  const priceHistory = new PriceHistoryStore(`${testDir}/prices.json`);
  const positions = new PositionStore(`${testDir}/positions.json`);
  // Routed into testDir like priceHistory and positions above. This previously
  // defaulted to the REAL logs/trades.jsonl and the comment claimed it was
  // cleaned up; it was not. 39 rejected-buy records with the fixture mint
  // accumulated in the production trade log between 2026-09-08 and 09-10.
  const tradeLog = new SpotTradeLog(`${testDir}/trades.jsonl`, false);

  // Never actually used - every case here is refused before either would be touched.
  const fakeConnection = {} as Connection;
  const fakeWallet = Keypair.generate();
  const engine = new SpotTradingEngine(fakeConnection, fakeWallet, priceHistory, positions, tradeLog);

  console.log("\n-- trading.enabled=false blocks every buy --");
  {
    const passResult: FilterResult = { mint: event.mint, source: event.source, signature: event.signature, decision: "PASS", reasons: [], metrics: {} as any, evaluatedAt: new Date().toISOString() };
    await engine.onFilterPass(event, passResult);
    check("no position was opened while trading.enabled is false", positions.get(event.mint) === null);

    // The assertion above is necessary but NOT sufficient, and on its own it
    // passed for the wrong reason. A mutation test proved it: with the gate
    // changed to `if (false)`, control fell through into the buy path, the
    // Jupiter quote threw against the `{} as Connection` above, the throw was
    // caught, and no position opened - so the check stayed green while the
    // single most important safety gate in this repo was disabled.
    //
    // "Nothing happened" is the same observation whether the gate refused the
    // buy or the buy merely failed. Only the rejected-buy record distinguishes
    // them, so the gate is now asserted by its own evidence: the reason it
    // logs. That string cannot be produced by any other path.
    const rejected = readTradeLog(`${testDir}/trades.jsonl`).filter(
      (r) => r.event === "rejected-buy" && r.mint === event.mint
    );
    check(
      "the gate logged a rejected-buy for this mint (not merely: nothing happened)",
      rejected.length === 1
    );
    check(
      "the rejection reason names trading.enabled, so the gate is what refused it",
      rejected.length === 1 &&
        rejected[0].reasons.some((r: string) => r.includes("trading.enabled is false"))
    );
  }

  console.log("\n-- a non-PASS filter result is refused, even if trading were enabled --");
  {
    const skipResult: FilterResult = { mint: event.mint, source: event.source, signature: event.signature, decision: "SKIP", reasons: ["liquidity too low"], metrics: {} as any, evaluatedAt: new Date().toISOString() };
    await engine.onFilterPass(event, skipResult);
    check("no position was opened for a SKIP result", positions.get(event.mint) === null);
  }

  fs.rmSync(testDir, { recursive: true, force: true });

  // RULE, not a per-file check: scans EVERY production log in logs/, so a

  // log added later is covered without anyone remembering to add an assertion.

  assertNoProductionWrites(check, ["Mint111111111111111111111111111111111111111"]);


  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
