import { loadConfig } from "../config";
import { JsonlLog } from "../util/logger";

/**
 * "Log every trade (entry price, exit price, reason, P&L) to a local file."
 * One JSON line per buy/sell/rejection event, rotated the same way as every
 * other log in this repo (logging.maxLogFileSizeMB).
 */
export class SpotTradeLog {
  private jsonl: JsonlLog;

  constructor() {
    const config = loadConfig();
    this.jsonl = new JsonlLog(config.logging.tradesFile, config.logging.maxLogFileSizeMB);
  }

  recordBuy(params: {
    mint: string;
    entryPriceSol: number;
    /** Human-readable SOL-per-whole-token price, or null if decimals couldn't be determined at buy time. */
    entryPriceSolPerToken: number | null;
    sizeSol: number;
    sizeTokens: number;
    /** Human-readable whole-token count, or null if decimals is unknown. */
    sizeTokensHuman: number | null;
    stopLossPriceSol: number;
    txSignature: string;
  }) {
    this.jsonl.append({ event: "buy", ...params });
  }

  recordSell(params: {
    mint: string;
    entryPriceSol: number;
    entryPriceSolPerToken: number | null;
    exitPriceSol: number;
    exitPriceSolPerToken: number | null;
    sizeSolReceived: number;
    sizeTokensSold: number;
    sizeTokensSoldHuman: number | null;
    pnlSol: number;
    pnlPercent: number;
    reason: string;
    txSignature: string;
  }) {
    this.jsonl.append({ event: "sell", ...params });
  }

  recordRejectedBuy(params: { mint: string; reasons: string[] }) {
    this.jsonl.append({ event: "rejected-buy", ...params });
  }

  recordFailedExecution(params: { mint: string; action: "buy" | "sell"; error: string; sellFailureCount?: number }) {
    this.jsonl.append({ event: "failed-execution", ...params });
  }

  /** A position that hit maxConsecutiveSellFailures - no further automatic sell attempts, needs manual review. */
  recordAbandoned(params: { mint: string; sellFailureCount: number; lastError: string }) {
    this.jsonl.append({ event: "abandoned", ...params });
  }

  /**
   * The position store's remainingSizeTokens didn't match the wallet's actual on-chain balance -
   * e.g. the process died between a sell landing on-chain and this bot recording it, or tokens
   * moved for some other reason. Exit price/P&L are unknown here (this ISN'T a sell we made),
   * so it's logged as its own event, not folded into recordSell().
   */
  recordReconciliationMismatch(params: { mint: string; trackedRaw: number; actualRaw: number; action: "corrected" | "removed" }) {
    this.jsonl.append({ event: "reconciliation-mismatch", ...params });
  }

  readAll() {
    return this.jsonl.readAll();
  }
}
