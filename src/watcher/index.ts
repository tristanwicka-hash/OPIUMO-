import { EventEmitter } from "events";
import { Connection, Logs, PublicKey } from "@solana/web3.js";
import { getConnection } from "../rpc/connection";
import { loadConfig } from "../config";
import { Logger } from "../util/logger";
import { NewPoolEvent } from "./types";
import {
  PUMPFUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
} from "./programs";
import { isPumpFunCreateLog, extractPumpFunNewPool } from "./pumpfunWatcher";
import { isRaydiumInitialize2Log, extractRaydiumNewPool } from "./raydiumWatcher";

export * from "./types";
export * from "./programs";
export * from "./pumpfunWatcher";
export * from "./raydiumWatcher";

const logger = new Logger("watcher", loadConfig().logging.level);

/**
 * Subscribes to Pump.fun / Raydium program logs over the RPC websocket and
 * emits a normalized "newPool" event whenever it recognizes a create/
 * initialize2 instruction. Step 2 of the bot - detection only, no data
 * enrichment or filtering yet (that's Part 3/4).
 */
export class PoolWatcher extends EventEmitter {
  private connection: Connection;
  private subscriptionIds: number[] = [];
  private running = false;

  constructor(connection: Connection = getConnection()) {
    super();
    this.connection = connection;
  }

  start(): void {
    const config = loadConfig();
    if (this.running) {
      logger.warn("start() called but watcher is already running");
      return;
    }
    this.running = true;

    if (config.sources.watchPumpFun) {
      const id = this.connection.onLogs(
        PUMPFUN_PROGRAM_ID,
        (logsResult) => this.handlePumpFunLogs(logsResult),
        "confirmed"
      );
      this.subscriptionIds.push(id);
      logger.info(`Subscribed to Pump.fun program logs (${PUMPFUN_PROGRAM_ID.toBase58()})`);
    }

    if (config.sources.watchRaydium) {
      const id = this.connection.onLogs(
        RAYDIUM_AMM_V4_PROGRAM_ID,
        (logsResult) => this.handleRaydiumLogs(logsResult),
        "confirmed"
      );
      this.subscriptionIds.push(id);
      logger.info(`Subscribed to Raydium AMM V4 program logs (${RAYDIUM_AMM_V4_PROGRAM_ID.toBase58()})`);
    }
  }

  async stop(): Promise<void> {
    for (const id of this.subscriptionIds) {
      await this.connection.removeOnLogsListener(id);
    }
    this.subscriptionIds = [];
    this.running = false;
    logger.info("Watcher stopped, all subscriptions removed");
  }

  private async handlePumpFunLogs(logsResult: Logs) {
    if (logsResult.err) return;
    if (!isPumpFunCreateLog(logsResult.logs)) return;
    await this.resolveAndEmit("pumpfun", logsResult.signature);
  }

  private async handleRaydiumLogs(logsResult: Logs) {
    if (logsResult.err) return;
    if (!isRaydiumInitialize2Log(logsResult.logs)) return;
    await this.resolveAndEmit("raydium", logsResult.signature);
  }

  private async resolveAndEmit(source: "pumpfun" | "raydium", signature: string) {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx) {
        logger.debug(`${source}: signature ${signature} not yet available, skipping`);
        return;
      }

      const event: NewPoolEvent | null =
        source === "pumpfun"
          ? extractPumpFunNewPool(signature, tx.slot, tx)
          : extractRaydiumNewPool(signature, tx.slot, tx);

      if (!event) {
        logger.debug(`${source}: log matched but could not extract a new pool from ${signature}`);
        return;
      }

      logger.info(`New ${source} token detected: mint=${event.mint} sig=${event.signature}`);
      this.emit("newPool", event);
    } catch (err: any) {
      logger.error(`${source}: failed to resolve tx ${signature}: ${err?.message || err}`);
    }
  }
}
