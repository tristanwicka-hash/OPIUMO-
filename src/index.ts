import { loadConfig } from "./config";
import { Logger } from "./util/logger";
import { loadWalletFromBase58 } from "./util/wallet";
import { getConnection, confirmConnection } from "./rpc/connection";
import { PoolWatcher, NewPoolEvent } from "./watcher";
import { collectTokenMetrics } from "./data/tokenMetrics";
import { evaluateFilters } from "./filters/engine";
import { DecisionLog } from "./filters/decisionLog";
import { SpotTradingEngine } from "./trading/engine";

const logger = new Logger("main", loadConfig().logging.level);

async function main() {
  const config = loadConfig();

  logger.info("=== OPIUMO Sniper Bot starting ===");
  const tradingMode = !config.trading.enabled
    ? "no (detection/filtering only)"
    : config.trading.paperTrading
    ? "YES - PAPER (simulated fills, no real orders)"
    : "YES - LIVE TRADING (real SOL)";
  logger.info(`Trading enabled: ${tradingMode}`);
  logger.info(`Watching: pumpfun=${config.sources.watchPumpFun} raydium=${config.sources.watchRaydium}`);

  // Part 1: prove the RPC connection is alive before doing anything else.
  const status = await confirmConnection();
  if (!status.ok) {
    logger.error(`Cannot start - RPC connection failed: ${status.error}`);
    process.exit(1);
  }

  const connection = getConnection();
  const decisionLog = new DecisionLog();
  const watcher = new PoolWatcher(connection);

  // Parts 5-7: only built if trading.enabled=true. A real wallet is only required for LIVE
  // trading (paperTrading=false) - config validation already enforces that pairing, so this is
  // a belt-and-suspenders check, not the actual gate (every buy/sell inside SpotTradingEngine
  // re-checks trading.enabled/paperTrading itself).
  let tradingEngine: SpotTradingEngine | null = null;
  if (config.trading.enabled) {
    if (!config.trading.paperTrading && !config.walletPrivateKey) {
      logger.error(
        "trading.enabled is true and paperTrading is false (LIVE mode) but WALLET_PRIVATE_KEY is not set - " +
          "this should have failed config validation already."
      );
      process.exit(1);
    }
    // A wallet is optional in paper mode - only used (if present) so log lines show a real
    // address; SpotTradingEngine never signs or sends anything while paperTrading is true.
    const wallet = config.walletPrivateKey ? loadWalletFromBase58(config.walletPrivateKey) : null;
    tradingEngine = new SpotTradingEngine(connection, wallet);
    tradingEngine.start();
    const walletLabel = wallet ? wallet.publicKey.toBase58() : "(none configured - not needed in paper mode)";
    if (config.trading.paperTrading) {
      logger.warn(
        `*** PAPER TRADING IS ON *** simulated fills only, no real orders will be placed. wallet=${walletLabel} ` +
          `totalCapitalSol=${config.trading.totalCapitalSol} maxOpenPositions=${config.trading.maxOpenPositions}`
      );
    } else {
      logger.warn(
        `*** LIVE TRADING IS ON *** wallet=${walletLabel} totalCapitalSol=${config.trading.totalCapitalSol} ` +
          `maxOpenPositions=${config.trading.maxOpenPositions}`
      );
    }
  }

  // Part 2 -> Part 3 -> Part 4 -> (Part 5, if enabled): on every new pool, fetch metrics, filter, log, maybe buy.
  watcher.on("newPool", async (event: NewPoolEvent) => {
    try {
      const metrics = await collectTokenMetrics(connection, event);
      const result = evaluateFilters(event, metrics, config.filters);
      decisionLog.record(result);

      if (result.decision === "PASS" && tradingEngine) {
        await tradingEngine.onFilterPass(event, result);
      }
    } catch (err: any) {
      logger.error(`Failed to process ${event.source} event ${event.signature}: ${err?.message || err}`);
    }
  });

  watcher.start();
  logger.info("Watcher running. Waiting for new pools... (Ctrl+C to stop)");

  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    tradingEngine?.stop();
    await watcher.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(`Fatal error: ${err?.message || err}`);
  process.exit(1);
});
