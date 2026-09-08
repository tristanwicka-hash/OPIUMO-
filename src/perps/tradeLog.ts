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
    /**
     * Lifetime fees AND funding for the position, USD. Required but nullable
     * ON PURPOSE: a caller must consciously decide, and an optional field
     * would let a call site silently omit it and write `undefined`.
     *
     * pnlUsd on its own cannot answer "did the carry actually pay?" - it
     * blends price movement, fees and funding into one number. This is the
     * field that makes realized-vs-theoretical funding capture computable
     * (see src/analysis/fundingCapture.ts).
     *
     * null means "couldn't read it", never "it was zero".
     */
    feesAndFundingUsd: number | null;
    /** The unsettled slice of the above, so settled-only is derivable. Null when unreadable. */
    unsettledFundingUsd: number | null;
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
