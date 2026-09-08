import { ParsedTransactionWithMeta, PartiallyDecodedInstruction } from "@solana/web3.js";
import { NewPoolEvent } from "./types";
import { PUMPFUN_PROGRAM_ID, PUMPFUN_CREATE_LOG_MARKER, identifyKnownProgram } from "./programs";
import { Logger } from "../util/logger";
import { loadConfig } from "../config";

const logger = new Logger("watcher", loadConfig().logging.level);

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
  /**
   * NO LONGER USED to identify the creator - kept for reference only.
   *
   * Index 7 is `user` in the classic create layout, and it works for the
   * majority of launches. But a Token-2022 mint carries its metadata as a mint
   * EXTENSION, so the two Metaplex accounts drop out of the account list and
   * every later index shifts down by two - putting the Token-2022 PROGRAM at
   * index 7. In a 3-hour run that produced 139 records where the "creator"
   * was TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.
   *
   * Changing it to 5 would just invert the bug and break the ~77% that work.
   * The fee payer is used instead - see extractPumpFunNewPool().
   */
  user: 7,
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
    if (!mintPk) continue;

    const bondingCurvePk = accounts[PUMPFUN_CREATE_ACCOUNT_INDEX.bondingCurve];

    // The creator is the transaction's FEE PAYER, not a fixed account index.
    //
    // accountKeys[0] is always the fee payer and first signer - that is
    // guaranteed by Solana's transaction format, not by Pump.fun's IDL, so it
    // survives the account-layout shift that broke the old index-7 approach and
    // works for both the classic and Token-2022 create variants. Whoever creates
    // a Pump.fun token signs and pays for that transaction. The same pattern is
    // already used by getWalletActivity() in src/data/tokenMetrics.ts.
    const feePayer = tx?.transaction.message.accountKeys?.[0]?.pubkey?.toBase58();

    // Never hand a program ID onward as if it were a wallet. This is the guard
    // that was missing: the old bug queried a program's token accounts and got
    // a confusing RPC error instead of an honest "that is not a wallet".
    const programName = identifyKnownProgram(feePayer);
    let creator: string | undefined = feePayer;
    if (programName) {
      logger.error(
        `Pump.fun create ${signature}: fee payer resolved to the ${programName} PROGRAM (${feePayer}), not a wallet. ` +
          `Refusing to use it as the creator - devWalletPercent will be reported as unknown. ` +
          `This should not happen; if it recurs, the transaction shape has changed.`
      );
      creator = undefined;
    }

    return {
      source: "pumpfun",
      signature,
      slot,
      mint: mintPk.toBase58(),
      // The bonding curve PDA holds the pool's native SOL balance directly -
      // that IS the liquidity for a pre-migration Pump.fun token.
      poolAddress: bondingCurvePk?.toBase58(),
      creator,
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}
