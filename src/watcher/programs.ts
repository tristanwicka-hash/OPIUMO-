import { PublicKey } from "@solana/web3.js";

/**
 * Well-known program IDs. These are stable, public constants (not something
 * that needs live-network verification):
 *   - Pump.fun: https://github.com/pump-fun (bonding-curve launch program)
 *   - Raydium AMM V4: https://docs.raydium.io (classic liquidity pool program)
 *
 * NOTE: Raydium has newer pool types (CPMM/CLMM) with different program IDs.
 * This bot watches classic AMM V4 pool creation (`initialize2`), which is
 * still what most Pump.fun tokens migrate into. Add more program IDs here
 * if you want to also catch CPMM/CLMM launches.
 */
export const PUMPFUN_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

export const RAYDIUM_AMM_V4_PROGRAM_ID = new PublicKey(
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);

/** Log substring that appears when Pump.fun's `create` instruction runs. */
export const PUMPFUN_CREATE_LOG_MARKER = "Program log: Instruction: Create";

/** Log substring that appears when Raydium's `initialize2` instruction runs. */
export const RAYDIUM_INITIALIZE2_LOG_MARKER = "init_pc_amount";
