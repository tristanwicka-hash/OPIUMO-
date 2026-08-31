import { ParsedTransactionWithMeta, PartiallyDecodedInstruction } from "@solana/web3.js";
import { NewPoolEvent } from "./types";
import { PUMPFUN_PROGRAM_ID, PUMPFUN_CREATE_LOG_MARKER } from "./programs";

/**
 * Account order for Pump.fun's `create` instruction, per the program's
 * publicly published Anchor IDL. Pump.fun has not changed this layout since
 * launch, but programs CAN be upgraded - if extraction starts returning
 * wrong mints, re-check this against a live `create` transaction (e.g. in
 * Solscan's "Instruction" view) and update the indices below. That is the
 * one thing about this file that could not be verified from this sandbox
 * (no live RPC access here - see README).
 */
export const PUMPFUN_CREATE_ACCOUNT_INDEX = {
  mint: 0,
  mintAuthority: 1,
  bondingCurve: 2,
  associatedBondingCurve: 3,
  user: 7, // the wallet that created the token ("dev wallet")
};

export function isPumpFunCreateLog(logs: string[]): boolean {
  return logs.some((l) => l.includes(PUMPFUN_CREATE_LOG_MARKER));
}

/**
 * Pulls the new mint + creator wallet out of a Pump.fun `create` transaction.
 * Returns null if the transaction doesn't contain a recognizable create
 * instruction for PUMPFUN_PROGRAM_ID.
 */
export function extractPumpFunNewPool(
  signature: string,
  slot: number,
  tx: ParsedTransactionWithMeta
): NewPoolEvent | null {
  const instructions = tx.transaction.message.instructions;

  for (const ix of instructions) {
    const programId = "programId" in ix ? ix.programId.toBase58() : undefined;
    if (programId !== PUMPFUN_PROGRAM_ID.toBase58()) continue;

    // Pump.fun's program is not a "known" program to web3.js's parser, so it
    // shows up partially decoded: a flat list of account pubkeys + raw data.
    const partial = ix as PartiallyDecodedInstruction;
    if (!("accounts" in partial) || !partial.accounts) continue;

    const accounts = partial.accounts;
    const mintPk = accounts[PUMPFUN_CREATE_ACCOUNT_INDEX.mint];
    const userPk = accounts[PUMPFUN_CREATE_ACCOUNT_INDEX.user];
    if (!mintPk) continue;

    const bondingCurvePk = accounts[PUMPFUN_CREATE_ACCOUNT_INDEX.bondingCurve];

    return {
      source: "pumpfun",
      signature,
      slot,
      mint: mintPk.toBase58(),
      // The bonding curve PDA holds the pool's native SOL balance directly -
      // that IS the liquidity for a pre-migration Pump.fun token.
      poolAddress: bondingCurvePk?.toBase58(),
      creator: userPk?.toBase58(),
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}
