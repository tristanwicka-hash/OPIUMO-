import { loadConfig } from "../config";
import { JsonlLog } from "../util/logger";
import { PerpDirection } from "./types";

/**
 * Trade log for perps, parallel to the spot bot's planned trade log: entry
 * price, exit price, reason, P&L, one JSON line per event, rotated the same
 * way (logging.maxLogFileSizeMB). "Reason" matters here more than for spot -
 * distinguishing a stop-loss hit from a take-profit hit from a manual close
 * is how you'll tell whether your risk limits are actually doing their job.
 */
export class PerpsTradeLog {
  private jsonl: JsonlLog;

  constructor() {
    const config = loadConfig();
    this.jsonl = new JsonlLog(config.logging.perpsTradesFile, config.logging.maxLogFileSizeMB);
  }

  recordOpen(params: {
    market: string;
    direction: PerpDirection;
    notionalUsd: number;
    leverage: number;
    entryPrice: number;
    stopLossPercent?: number;
    takeProfitPercent?: number;
    txSignature: string;
  }) {
    this.jsonl.append({ event: "open", ...params });
  }

  recordClose(params: {
    market: string;
    direction: PerpDirection;
    entryPrice: number;
    exitPrice: number;
    notionalUsd: number;
    pnlUsd: number;
    reason: string;
    txSignature: string;
  }) {
    this.jsonl.append({ event: "close", ...params });
  }

  recordRejected(params: { market: string; direction: PerpDirection; reasons: string[] }) {
    this.jsonl.append({ event: "rejected", ...params });
  }

  readAll() {
    return this.jsonl.readAll();
  }
}
