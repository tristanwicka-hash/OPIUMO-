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
  /** Raydium-only: the pool's SPL token vault for the base ("coin") mint. */
  raydiumCoinVault?: string;
  /** Raydium-only: the pool's SPL token vault for the quote ("pc") mint. */
  raydiumPcVault?: string;
  /** Raydium-only: the quote-side mint (often WSOL, sometimes USDC). */
  raydiumPcMint?: string;
  detectedAt: string;
}
