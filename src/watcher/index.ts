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

export interface PoolWatcherOptions {
  /** If no new slot is observed for this long, assume the websocket died silently and resubscribe. Default 30s. */
  staleConnectionThresholdMs?: number;
  /** How often to check for a stale connection. Default 10s. */
  healthCheckIntervalMs?: number;
  /** How many recent signatures to remember for dedup, so a redelivered/replayed log doesn't emit twice. Default 2000. */
  maxSeenSignatures?: number;
  /**
   * Cap on each unsubscribe during stop(). Default 10s.
   *
   * On 2026-09-12 at 00:02 UTC the websocket died. checkHealth() called
   * restart(), stop() awaited removeOnLogsListener on the dead socket, and
   * that promise never settled - so start() never ran, and because stop()
   * had already cleared the health timer, nothing ever tried again. The bot
   * stayed up and blind for seven hours. An unsubscribe that does not answer
   * inside this cap is abandoned and the restart proceeds.
   */
  unsubscribeTimeoutMs?: number;
}

/**
 * Subscribes to Pump.fun / Raydium program logs over the RPC websocket and
 * emits a normalized "newPool" event whenever it recognizes a create/
 * initialize2 instruction. Step 2 of the bot - detection only, no data
 * enrichment or filtering yet (that's Part 3/4).
 *
 * Self-heals a dead websocket: @solana/web3.js's Connection does not
 * reliably notice or recover from a silently-dropped subscription, so this
 * watcher tracks a lightweight onSlotChange heartbeat and, if it goes quiet
 * for longer than staleConnectionThresholdMs, tears down and re-establishes
 * every subscription automatically.
 *
 * Emits "wsMessage" (no payload) on EVERY websocket delivery - slot change or
 * program log, whether or not it turns into a newPool. The liveness heartbeat
 * (src/util/heartbeat.ts) listens to it; a supervisor in another process reads
 * the heartbeat and restarts the bot if the socket goes quiet during ON hours.
 */
export class PoolWatcher extends EventEmitter {
  private connection: Connection;
  private subscriptionIds: number[] = [];
  private slotSubscriptionId: number | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastSlotSeenAt = 0;
  private seenSignatures = new Map<string, true>();

  private readonly staleConnectionThresholdMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly maxSeenSignatures: number;
  private readonly unsubscribeTimeoutMs: number;

  constructor(connection: Connection = getConnection(), options: PoolWatcherOptions = {}) {
    super();
    this.connection = connection;
    this.staleConnectionThresholdMs = options.staleConnectionThresholdMs ?? 30_000;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 10_000;
    this.maxSeenSignatures = options.maxSeenSignatures ?? 2000;
    this.unsubscribeTimeoutMs = options.unsubscribeTimeoutMs ?? 10_000;
  }

  /** An unsubscribe on a dead socket never answers. Wait at most the cap, then move on and say so. */
  private async unsubscribeCapped(label: string, p: Promise<unknown>): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    const capped = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.unsubscribeTimeoutMs); });
    try {
      const winner = await Promise.race([p.then(() => "done" as const, (err: any) => { logger.warn(`${label}: unsubscribe failed (${err?.message || err}) - continuing`); return "done" as const; }), capped]);
      if (winner === "timeout") logger.warn(`${label}: unsubscribe did not answer within ${this.unsubscribeTimeoutMs}ms - abandoning it (the socket is probably dead) and continuing`);
    } finally {
      if (timer) clearTimeout(timer);
    }
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

    this.lastSlotSeenAt = Date.now();
    this.slotSubscriptionId = this.connection.onSlotChange(() => {
      this.lastSlotSeenAt = Date.now();
      this.emit("wsMessage");
    });
    this.healthCheckTimer = setInterval(() => this.checkHealth(), this.healthCheckIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    for (const id of this.subscriptionIds) {
      await this.unsubscribeCapped(`logs subscription ${id}`, this.connection.removeOnLogsListener(id));
    }
    this.subscriptionIds = [];
    if (this.slotSubscriptionId !== null) {
      await this.unsubscribeCapped("slot subscription", this.connection.removeSlotChangeListener(this.slotSubscriptionId));
      this.slotSubscriptionId = null;
    }
    this.running = false;
    logger.info("Watcher stopped, all subscriptions removed");
  }

  /** Exposed for tests; not part of the public API contract. */
  checkHealth(): void {
    const silentForMs = Date.now() - this.lastSlotSeenAt;
    if (silentForMs > this.staleConnectionThresholdMs) {
      logger.error(
        `No slot updates for ${silentForMs}ms (threshold ${this.staleConnectionThresholdMs}ms) - ` +
          `websocket subscription is likely dead. Restarting.`
      );
      this.restart();
    }
  }

  private restarting = false;

  /** stop() then start(); a failing stop() no longer prevents the start(). One restart at a time. */
  private restart(): void {
    if (this.restarting) return;
    this.restarting = true;
    this.stop()
      .catch((err) => logger.error(`Watcher stop() failed during restart (${err?.message || err}) - starting anyway`))
      .then(() => this.start())
      .catch((err) => logger.error(`Failed to restart watcher: ${err?.message || err}`))
      .finally(() => { this.restarting = false; });
  }

  private markSeen(signature: string): boolean {
    if (this.seenSignatures.has(signature)) return false;
    this.seenSignatures.set(signature, true);
    if (this.seenSignatures.size > this.maxSeenSignatures) {
      const oldest = this.seenSignatures.keys().next().value;
      if (oldest !== undefined) this.seenSignatures.delete(oldest);
    }
    return true;
  }

  private async handlePumpFunLogs(logsResult: Logs) {
    this.emit("wsMessage");
    if (logsResult.err) return;
    if (!isPumpFunCreateLog(logsResult.logs)) return;
    await this.resolveAndEmit("pumpfun", logsResult.signature);
  }

  private async handleRaydiumLogs(logsResult: Logs) {
    this.emit("wsMessage");
    if (logsResult.err) return;
    if (!isRaydiumInitialize2Log(logsResult.logs)) return;
    await this.resolveAndEmit("raydium", logsResult.signature);
  }

  private async resolveAndEmit(source: "pumpfun" | "raydium", signature: string) {
    if (!this.markSeen(signature)) {
      logger.debug(`${source}: already processed ${signature}, skipping duplicate delivery`);
      return;
    }

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
