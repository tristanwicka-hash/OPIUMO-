export type PoolSource = "pumpfun" | "raydium";

/** Normalized "a new token/pool just appeared" event, regardless of source. */
export interface NewPoolEvent {
  source: PoolSource;
  signature: string;
  slot: number;
  /** The new token's mint address. */
  mint: string;
  /** AMM pool / bonding-curve address, when the source exposes one directly. */
  poolAddress?: string;
  /** Wallet that created the token/pool, when we can identify it from the tx. */
  creator?: string;
  detectedAt: string;
}
