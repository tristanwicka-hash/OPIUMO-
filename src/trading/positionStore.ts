import fs from "fs";
import path from "path";

export interface SpotPosition {
  mint: string;
  entryPriceSol: number;
  entrySizeTokens: number;
  /** Decreases as ladder tiers sell off portions of the position. Position is closed once this hits 0. */
  remainingSizeTokens: number;
  entryAt: number;
  /** Highest price observed since entry - what the trailing stop trails below, once activated. */
  highestPriceSol: number;
  /** Which takeProfitLadder tiers (by atMultipleOfEntry) have already fired, so we never sell the same tier twice. */
  executedLadderTiers: number[];
  /** ATR-based, computed once at entry from that moment's ATR reading - fixed, NOT itself trailing (the trailing stop is a separate, later-activating mechanism). */
  stopLossPriceSol: number;
}

/**
 * Tracks open spot positions - unlike the funding-arb strategy (which can
 * derive "flat vs open" straight from Drift's live account state), there's
 * no equivalent single source of truth for "which ladder tiers have I
 * already sold" for a spot SPL token - that's purely this bot's own
 * decision history, so it has to be the one to remember it. Persisted to
 * JSON so a restart doesn't forget an open position and double-sell (or
 * never notice) a tier.
 */
export class PositionStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "{}");
  }

  private readAll(): Record<string, SpotPosition> {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch {
      return {};
    }
  }

  private writeAll(data: Record<string, SpotPosition>) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  get(mint: string): SpotPosition | null {
    return this.readAll()[mint] ?? null;
  }

  getAllOpen(): SpotPosition[] {
    return Object.values(this.readAll());
  }

  save(position: SpotPosition) {
    const all = this.readAll();
    all[position.mint] = position;
    this.writeAll(all);
  }

  /** Call once a position is fully closed (remainingSizeTokens reaches 0) so it stops being tracked. */
  remove(mint: string) {
    const all = this.readAll();
    delete all[mint];
    this.writeAll(all);
  }
}
