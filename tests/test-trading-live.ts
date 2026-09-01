/**
 * Spot sniper test: one real Jupiter quote (no swap, no funds moved). Mirrors
 * tests/test-perps-connection.ts and test-funding-arb-live.ts - needs real
 * network access, EXPECTED to fail in this sandbox (every Solana-related
 * host is blocked here, confirmed, not a code bug). This is the piece that
 * could NOT be verified live from this session - run it yourself before
 * trusting the Jupiter wiring, well before ever setting trading.enabled=true.
 *
 * Run with: npm run test:trading-live
 */
import { getQuote, SOL_MINT } from "../src/trading/jupiter";
import { loadConfig } from "../src/config";

// A well-known, extremely liquid mint (USDC) so a successful quote here says
// something about the Jupiter API wiring, not about some obscure token's liquidity.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function main() {
  console.log("=== Spot sniper test: Jupiter quote (read-only, no swap) ===");
  const config = loadConfig();
  console.log(`quoteApiUrl=${config.jupiter.quoteApiUrl}`);

  try {
    const oneSolLamports = "1000000000";
    const quote = await getQuote(SOL_MINT, USDC_MINT, oneSolLamports, 50);
    console.log("PASS: got a real quote from Jupiter.");
    console.log(`  1 SOL -> ${quote.outAmount} USDC (raw), price impact ${quote.priceImpactPct}%`);
    process.exit(0);
  } catch (err: any) {
    console.error("FAIL: could not get a Jupiter quote:", err?.message || err);
    console.error(
      "  If this is a network/DNS/timeout/403 error and you are running inside a restricted " +
        "sandbox, this is expected here - re-run on a machine with real internet access. If it's " +
        "a 404 or a clearly-different response shape, config.jupiter.quoteApiUrl may be stale - " +
        "check https://dev.jup.ag for the current endpoint (see the comment in config/default.json)."
    );
    process.exit(1);
  }
}

main();
