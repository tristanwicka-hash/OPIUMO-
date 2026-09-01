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
  logger.info(`Trading enabled: ${config.trading.enabled ? "YES - LIVE TRADING" : "no (detection/filtering only)"}`);
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

  // Parts 5-7: only built if trading.enabled=true AND a wallet is configured - config
  // validation already requires both together, so this is a belt-and-suspenders check, not
  // the actual gate (every buy/sell inside SpotTradingEngine re-checks trading.enabled itself).
  let tradingEngine: SpotTradingEngine | null = null;
  if (config.trading.enabled) {
    if (!config.walletPrivateKey) {
      logger.error("trading.enabled is true but WALLET_PRIVATE_KEY is not set - this should have failed config validation already.");
      process.exit(1);
    }
    const wallet = loadWalletFromBase58(config.walletPrivateKey);
    tradingEngine = new SpotTradingEngine(connection, wallet);
    tradingEngine.start();
    logger.warn(
      `*** LIVE TRADING IS ON *** wallet=${wallet.publicKey.toBase58()} totalCapitalSol=${config.trading.totalCapitalSol} ` +
        `maxOpenPositions=${config.trading.maxOpenPositions}`
    );
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
