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

  recordBuy(params: { mint: string; entryPriceSol: number; sizeSol: number; sizeTokens: number; stopLossPriceSol: number; txSignature: string }) {
    this.jsonl.append({ event: "buy", ...params });
  }

  recordSell(params: {
    mint: string;
    entryPriceSol: number;
    exitPriceSol: number;
    sizeSolReceived: number;
    sizeTokensSold: number;
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

  recordFailedExecution(params: { mint: string; action: "buy" | "sell"; error: string }) {
    this.jsonl.append({ event: "failed-execution", ...params });
  }

  readAll() {
    return this.jsonl.readAll();
  }
}
