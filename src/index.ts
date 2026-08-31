import { loadConfig } from "./config";
import { Logger } from "./util/logger";
import { getConnection, confirmConnection } from "./rpc/connection";
import { PoolWatcher, NewPoolEvent } from "./watcher";
import { collectTokenMetrics } from "./data/tokenMetrics";
import { evaluateFilters } from "./filters/engine";
import { DecisionLog } from "./filters/decisionLog";

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

  // Part 2 -> Part 3 -> Part 4: on every new pool, fetch metrics, filter, log.
  watcher.on("newPool", async (event: NewPoolEvent) => {
    try {
      const metrics = await collectTokenMetrics(connection, event);
      const result = evaluateFilters(event, metrics, config.filters);
      decisionLog.record(result);

      if (result.decision === "PASS" && config.trading.enabled) {
        // Parts 5/6 (auto-buy / auto-sell) plug in here once built and enabled.
        logger.warn(
          `${event.mint} PASSed and trading.enabled=true, but auto-buy is not wired up in this build yet.`
        );
      }
    } catch (err: any) {
      logger.error(`Failed to process ${event.source} event ${event.signature}: ${err?.message || err}`);
    }
  });

  watcher.start();
  logger.info("Watcher running. Waiting for new pools... (Ctrl+C to stop)");

  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    await watcher.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(`Fatal error: ${err?.message || err}`);
  process.exit(1);
});
