import { ParsedTransactionWithMeta, PartiallyDecodedInstruction } from "@solana/web3.js";
import { NewPoolEvent } from "./types";
import { RAYDIUM_AMM_V4_PROGRAM_ID, RAYDIUM_INITIALIZE2_LOG_MARKER } from "./programs";

/**
 * Account order for Raydium AMM V4's `initialize2` instruction.
 *
 * Verified 2026-09-01 against the official Raydium program source
 * (raydium-io/raydium-amm, program/src/instruction.rs, the `initialize2`
 * account list) - every index below (amm/authority/lpMint/coinMint/pcMint/
 * vaults/userWallet) matches the account order the real on-chain program
 * expects. If Raydium ships a new pool-creation instruction version in the
 * future, re-check this list against the then-current source before
 * trusting it - these indices are pinned to the account layout as of the
 * verification date above, not guaranteed forever.
 */
export const RAYDIUM_INITIALIZE2_ACCOUNT_INDEX = {
  ammId: 4,
  ammAuthority: 5,
  lpMint: 7,
  coinMint: 8,
  pcMint: 9,
  poolCoinTokenAccount: 10,
  poolPcTokenAccount: 11,
  userWallet: 17,
};

export function isRaydiumInitialize2Log(logs: string[]): boolean {
  return logs.some((l) => l.includes(RAYDIUM_INITIALIZE2_LOG_MARKER));
}

/**
 * Pulls the new pool address + mints out of a Raydium `initialize2`
 * transaction. Returns null if not a recognizable initialize2 for
 * RAYDIUM_AMM_V4_PROGRAM_ID.
 *
 * We report `coinMint` as the "new token" - if SOL/USDC is the coin side
 * instead of the pc side (or vice versa), the caller should sanity-check
 * against known mints (WSOL, USDC) and swap which one it treats as "the
 * token" vs "the quote asset". See src/data - liquidity size math depends
 * on getting this right.
 */
export function extractRaydiumNewPool(
  signature: string,
  slot: number,
  tx: ParsedTransactionWithMeta
): NewPoolEvent | null {
  const instructions = tx.transaction.message.instructions;

  for (const ix of instructions) {
    const programId = "programId" in ix ? ix.programId.toBase58() : undefined;
    if (programId !== RAYDIUM_AMM_V4_PROGRAM_ID.toBase58()) continue;

    const partial = ix as PartiallyDecodedInstruction;
    if (!("accounts" in partial) || !partial.accounts) continue;

    const accounts = partial.accounts;
    const idx = RAYDIUM_INITIALIZE2_ACCOUNT_INDEX;
    const ammIdPk = accounts[idx.ammId];
    const coinMintPk = accounts[idx.coinMint];
    const pcMintPk = accounts[idx.pcMint];
    const lpMintPk = accounts[idx.lpMint];
    const userWalletPk = accounts[idx.userWallet];
    const coinVaultPk = accounts[idx.poolCoinTokenAccount];
    const pcVaultPk = accounts[idx.poolPcTokenAccount];
    if (!ammIdPk || !coinMintPk) continue;

    return {
      source: "raydium",
      signature,
      slot,
      mint: coinMintPk.toBase58(),
      poolAddress: ammIdPk.toBase58(),
      creator: userWalletPk?.toBase58(),
      raydiumCoinVault: coinVaultPk?.toBase58(),
      raydiumPcVault: pcVaultPk?.toBase58(),
      raydiumPcMint: pcMintPk?.toBase58(),
      raydiumLpMint: lpMintPk?.toBase58(),
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}
