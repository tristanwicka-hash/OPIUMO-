import { loadConfig } from "../config";
import { JsonlLog } from "../util/logger";

/**
 * "Log every trade (entry price, exit price, reason, P&L) to a local file."
 * One JSON line per buy/sell/rejection event, rotated the same way as every
 * other log in this repo (logging.maxLogFileSizeMB).
 */
export class SpotTradeLog {
  private jsonl: JsonlLog;
  private isPaper: boolean;

  /**
   * filePath defaults to config.logging.tradesFile (real trades). Pass
   * logging.paperTradesFile + isPaper=true to get a paper-trading log
   * instead - kept as separate constructor args (not auto-detected) so
   * callers can't accidentally mix the two. Every record this class writes
   * carries an `isPaper` field so a line is self-describing even in
   * isolation, on top of the file-level separation.
   */
  constructor(filePath?: string, isPaper = false) {
    const config = loadConfig();
    this.jsonl = new JsonlLog(filePath ?? config.logging.tradesFile, config.logging.maxLogFileSizeMB);
    this.isPaper = isPaper;
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
    this.jsonl.append({ event: "buy", isPaper: this.isPaper, ...params });
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
    this.jsonl.append({ event: "sell", isPaper: this.isPaper, ...params });
  }

  recordRejectedBuy(params: { mint: string; reasons: string[] }) {
    this.jsonl.append({ event: "rejected-buy", isPaper: this.isPaper, ...params });
  }

  recordFailedExecution(params: { mint: string; action: "buy" | "sell"; error: string; sellFailureCount?: number }) {
    this.jsonl.append({ event: "failed-execution", isPaper: this.isPaper, ...params });
  }

  /** A position that hit maxConsecutiveSellFailures - no further automatic sell attempts, needs manual review. */
  recordAbandoned(params: { mint: string; sellFailureCount: number; lastError: string }) {
    this.jsonl.append({ event: "abandoned", isPaper: this.isPaper, ...params });
  }

  /**
   * The position store's remainingSizeTokens didn't match the wallet's actual on-chain balance -
   * e.g. the process died between a sell landing on-chain and this bot recording it, or tokens
   * moved for some other reason. Exit price/P&L are unknown here (this ISN'T a sell we made),
   * so it's logged as its own event, not folded into recordSell().
   */
  recordReconciliationMismatch(params: { mint: string; trackedRaw: number; actualRaw: number; action: "corrected" | "removed" }) {
    this.jsonl.append({ event: "reconciliation-mismatch", isPaper: this.isPaper, ...params });
  }

  readAll() {
    return this.jsonl.readAll();
  }
}
