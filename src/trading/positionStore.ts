import fs from "fs";
import path from "path";

export interface SpotPosition {
  mint: string;
  /** Raw decimals from the mint account - null if it couldn't be fetched at buy time. Display-only: used to convert raw token amounts/prices to human-readable ones in logs, never in the exit-logic math itself (which stays in raw units throughout, see the UNIT CONVENTION note in src/trading/engine.ts). */
  decimals: number | null;
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
  /** Consecutive failed sell attempts for this position. Reset to 0 on any successful sell. Drives backoff + eventual abandonment - see src/trading/retry.ts. */
  sellFailureCount: number;
  /** When the most recent sell failure happened, or null if there hasn't been one (or it was reset by a success). */
  lastSellFailureAt: number | null;
  /** True once sellFailureCount has crossed trading.maxConsecutiveSellFailures - no further automatic sell attempts are made; needs manual review. */
  abandoned: boolean;
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

  /** Positions no longer being actively managed (too many consecutive sell failures) - needs your manual review. */
  getAbandoned(): SpotPosition[] {
    return this.getAllOpen().filter((p) => p.abandoned);
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
