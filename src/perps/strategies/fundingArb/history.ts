import fs from "fs";
import path from "path";
import { FundingSample } from "./types";

/**
 * Persists a rolling window of funding-rate settlements to a JSON file, one
 * per market (keyed by marketIndex), so "N consecutive settlements" survives
 * a bot restart instead of resetting the streak every time. Unlike the JSONL
 * decision/trade logs (append-only), this needs random access to "the last
 * N samples," so it's a small whole-file read/write instead.
 */
export class FundingHistoryStore {
  private filePath: string;
  private maxSamplesPerMarket: number;

  constructor(filePath: string, maxSamplesPerMarket = 500) {
    this.filePath = filePath;
    this.maxSamplesPerMarket = maxSamplesPerMarket;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "{}");
  }

  private readAll(): Record<string, FundingSample[]> {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch {
      return {};
    }
  }

  private writeAll(data: Record<string, FundingSample[]>) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  getSamples(marketIndex: number): FundingSample[] {
    return this.readAll()[String(marketIndex)] ?? [];
  }

  /**
   * Appends a sample IF its settlementTs is newer than the last recorded one
   * for this market (dedupes repeated polls between settlements). Returns
   * true if a new sample was actually recorded.
   */
  appendIfNewSettlement(marketIndex: number, sample: FundingSample): boolean {
    const all = this.readAll();
    const key = String(marketIndex);
    const existing = all[key] ?? [];
    const last = existing[existing.length - 1];

    if (last && last.settlementTs >= sample.settlementTs) {
      return false; // already have this settlement (or a newer one) - not a new poll result
    }

    const updated = [...existing, sample].slice(-this.maxSamplesPerMarket);
    all[key] = updated;
    this.writeAll(all);
    return true;
  }

  clear(marketIndex: number) {
    const all = this.readAll();
    delete all[String(marketIndex)];
    this.writeAll(all);
  }
}
