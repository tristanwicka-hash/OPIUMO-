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

/**
 * Program IDs that must NEVER be treated as a wallet address.
 *
 * This exists because of a real bug: pumpfunWatcher used a hardcoded account
 * index for the creator wallet, and on Token-2022 mints that index landed on
 * the Token-2022 PROGRAM. 139 logged records then asked the chain "what token
 * accounts does the Token-2022 program own?", which failed with a confusing
 * "could not find mint" instead of an honest "that is not a wallet".
 */
export const KNOWN_PROGRAM_IDS: Record<string, string> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  "11111111111111111111111111111111": "System",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Token Metadata",
  SysvarRent111111111111111111111111111111111: "Rent Sysvar",
  [PUMPFUN_PROGRAM_ID.toBase58()]: "Pump.fun",
  [RAYDIUM_AMM_V4_PROGRAM_ID.toBase58()]: "Raydium AMM V4",
};

/** Returns the program's name if `address` is a known program ID, else null. */
export function identifyKnownProgram(address: string | undefined): string | null {
  if (!address) return null;
  return KNOWN_PROGRAM_IDS[address] ?? null;
}
