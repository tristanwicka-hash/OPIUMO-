import { loadConfig } from "./config";
import { Logger } from "./util/logger";
import { getConnection } from "./rpc/connection";
import { getDriftClient, confirmDriftConnection, unsubscribeDriftClient } from "./perps/driftClient";
import { FundingArbStrategy } from "./perps/strategies/fundingArb/engine";

/**
 * Entry point for the PERPS side of this bot - a separate track from
 * src/index.ts (the spot Pump.fun/Raydium sniper). Run this with
 * `npm run perps` (or `npm run start:perps` after building).
 *
 * Found in review: FundingArbStrategy (src/perps/strategies/fundingArb/engine.ts)
 * was fully built and tested but never had anywhere to actually run from -
 * only tests/test-funding-arb-live.ts ever instantiated it, and that runs
 * ONE cycle and exits. This is the real runner: connects once, then calls
 * strategy.start() to run on its own schedule (fundingArb.checkIntervalMinutes)
 * until you stop it.
 *
 * Safe to run even with fundingArb.enabled=false and/or perps.enabled=false -
 * checkOnce() still runs on schedule and logs what it's seeing (funding
 * rates, signals), it just never places an order while either is false.
 * That's the same "watch it decide before you trust it" posture as the
 * spot sniper's Part 4 filter engine.
 */
async function main() {
  const config = loadConfig();
  const logger = new Logger("perps-main", config.logging.level);

  logger.info("=== OPIUMO Perps Runner starting ===");
  logger.info(`perps.enabled=${config.perps.enabled} fundingArb.enabled=${config.fundingArb.enabled} env=${config.perps.env}`);
  if (!config.fundingArb.enabled || !config.perps.enabled) {
    logger.info("Running in watch-only mode (at least one enabled flag is false) - no order will ever be placed until both are true.");
  }
  if (config.perps.enabled && config.perps.env === "mainnet-beta") {
    logger.warn("*** perps.enabled=true AND env=mainnet-beta - this WILL place real leveraged orders with real money. ***");
  }

  if (!config.walletPrivateKey) {
    logger.error("WALLET_PRIVATE_KEY is not set in .env - required even just to read Drift account/market state. See .env.example.");
    process.exit(1);
  }

  const driftClient = getDriftClient(getConnection());
  const status = await confirmDriftConnection(driftClient);
  if (!status.ok) {
    logger.error(`Cannot start - Drift connection failed: ${status.error}`);
    process.exit(1);
  }

  const strategy = new FundingArbStrategy(driftClient);
  strategy.start();
  logger.info(`Funding-arb loop running for ${config.fundingArb.market}, checking every ${config.fundingArb.checkIntervalMinutes}min. (Ctrl+C to stop)`);

  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    strategy.stop();
    await unsubscribeDriftClient(driftClient);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`Fatal error: ${err?.message || err}`);
  process.exit(1);
});
