import fs from "fs";
import path from "path";

export interface PriceSample {
  observedAt: number;
  priceSol: number;
}

/**
 * Rolling window of price samples per mint, persisted to JSON so ATR/
 * trailing-stop history survives a bot restart. Same shape/behavior as
 * FundingHistoryStore (src/perps/strategies/fundingArb/history.ts) - kept
 * as its own small class rather than a shared generic, since the two
 * stores' record shapes and append semantics differ (this one just caps by
 * count, funding history dedupes by settlement).
 */
export class PriceHistoryStore {
  private filePath: string;
  private maxSamplesPerMint: number;

  constructor(filePath: string, maxSamplesPerMint = 500) {
    this.filePath = filePath;
    this.maxSamplesPerMint = maxSamplesPerMint;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "{}");
  }

  private readAll(): Record<string, PriceSample[]> {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch {
      return {};
    }
  }

  private writeAll(data: Record<string, PriceSample[]>) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  getSamples(mint: string): PriceSample[] {
    return this.readAll()[mint] ?? [];
  }

  append(mint: string, sample: PriceSample) {
    const all = this.readAll();
    const updated = [...(all[mint] ?? []), sample].slice(-this.maxSamplesPerMint);
    all[mint] = updated;
    this.writeAll(all);
  }

  clear(mint: string) {
    const all = this.readAll();
    delete all[mint];
    this.writeAll(all);
  }
}
