/**
 * Perps test 2/2: connect to Drift and confirm it's alive. Mirrors
 * tests/test-rpc-connection.ts - needs real network access to your RPC
 * endpoint, so this is EXPECTED to fail in this sandbox (confirmed: every
 * Solana-related host is blocked here, not a code bug). Run it yourself
 * once you have .env filled in and (ideally) some devnet SOL.
 *
 * Run with: npm run test:perps-connection
 */
import { getConnection } from "../src/rpc/connection";
import { getDriftClient, confirmDriftConnection, unsubscribeDriftClient } from "../src/perps/driftClient";
import { getAccountSnapshot } from "../src/perps/positions";
import { loadConfig } from "../src/config";

async function main() {
  console.log("=== Perps test: Drift connection ===");
  const config = loadConfig();

  if (!config.walletPrivateKey) {
    console.error(
      "SKIPPED: WALLET_PRIVATE_KEY is not set in .env. Perps needs a signer even just to " +
        "read account state - fill it in (a fresh devnet-only keypair is fine for testing) and re-run."
    );
    process.exit(1);
  }

  console.log(`env=${config.perps.env} subAccountId=${config.perps.subAccountId}`);
  if (config.perps.env === "devnet") {
    console.log("(devnet: no real funds at risk, this is the right place to test first)");
  }

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

  console.log("PASS: Drift connection confirmed.");
  try {
    const snapshot = getAccountSnapshot(driftClient, config.perps.subAccountId);
    console.log("Account snapshot:", JSON.stringify(snapshot, null, 2));
  } catch (err: any) {
    console.error(
      "Connected, but could not read account snapshot (this is normal for a brand-new wallet " +
        `with no Drift account yet - deposit collateral via Drift's UI first): ${err?.message || err}`
    );
  }

  await unsubscribeDriftClient(driftClient);
  process.exit(0);
}

main();
