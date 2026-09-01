/**
 * Funding-arb test 2/2: run one real evaluation cycle against live Drift
 * data. Mirrors tests/test-perps-connection.ts - needs your own RPC + a
 * wallet in .env, EXPECTED to fail in this sandbox (every Solana-related
 * host is blocked here, confirmed, not a code bug).
 *
 * This does NOT place any order regardless of config - fundingArb.enabled
 * defaults false, and even if you flip it, checkOnce() only calls into
 * openPerpPosition()/closePerpPosition() when its own signals say to, and
 * those are still gated by perps.enabled underneath. Safe to run against a
 * real wallet on devnet to see what the strategy is actually thinking.
 *
 * Run with: npm run test:funding-arb-live
 */
import { getConnection } from "../src/rpc/connection";
import { getDriftClient, confirmDriftConnection, unsubscribeDriftClient } from "../src/perps/driftClient";
import { FundingArbStrategy } from "../src/perps/strategies/fundingArb/engine";
import { loadConfig } from "../src/config";

async function main() {
  console.log("=== Funding-arb test: one live evaluation cycle ===");
  const config = loadConfig();

  if (!config.walletPrivateKey) {
    console.error("SKIPPED: WALLET_PRIVATE_KEY is not set in .env - needed even just to read account/market state.");
    process.exit(1);
  }

  console.log(`market=${config.fundingArb.market} env=${config.perps.env} fundingArb.enabled=${config.fundingArb.enabled}`);

  const driftClient = getDriftClient(getConnection());
  const status = await confirmDriftConnection(driftClient);
  if (!status.ok) {
    console.error("FAIL: could not confirm Drift connection:", status.error);
    console.error(
      "  If this is a network/DNS/timeout error and you are running inside a restricted sandbox, " +
        "this is expected here - re-run on a machine with real internet access to your RPC provider."
    );
    process.exit(1);
  }

  const strategy = new FundingArbStrategy(driftClient);
  try {
    const result = await strategy.checkOnce();
    console.log("PASS: ran one full evaluation cycle without crashing.");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error("FAIL: checkOnce() threw:", err?.message || err);
    process.exitCode = 1;
  } finally {
    await unsubscribeDriftClient(driftClient);
  }
}

main();
