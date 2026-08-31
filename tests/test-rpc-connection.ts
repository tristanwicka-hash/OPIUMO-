/**
 * Part 1 test: connect to the configured Solana RPC and confirm it responds.
 *
 * Run with: npm run test:rpc
 *
 * NOTE: this needs real outbound network access to your RPC_URL. In a
 * sandboxed CI/dev-container environment without internet egress to Solana
 * RPC hosts, this test will fail with a network error - that is expected
 * there. Run it on your own machine (or wherever the bot will actually run)
 * before trusting Part 1.
 */
import { confirmConnection } from "../src/rpc/connection";

async function main() {
  console.log("=== Part 1 test: RPC connection ===");
  const status = await confirmConnection();

  if (status.ok) {
    console.log("PASS: connected to", status.rpcUrl);
    console.log(`  solana-core version: ${status.version}`);
    console.log(`  current slot:        ${status.slot}`);
    console.log(`  latency:             ${status.latencyMs}ms`);
    process.exit(0);
  } else {
    console.error("FAIL: could not connect to", status.rpcUrl);
    console.error(`  error: ${status.error}`);
    console.error(
      "  If this is a network/DNS/timeout error and you are running inside a " +
        "restricted sandbox, this is expected here - re-run on a machine with " +
        "real internet access to your RPC provider."
    );
    process.exit(1);
  }
}

main();
