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

/**
 * True only when the Pump.fun program ITSELF emitted "Instruction: Create".
 *
 * The previous implementation was `logs.some(l => l.includes(marker))`, which
 * matched the marker anywhere in the transaction regardless of which program
 * printed it. The Associated Token Account program logs the *same* line when
 * it creates an ATA - which happens on an ordinary Pump.fun BUY by a
 * first-time buyer. That misclassified ~24% of detections as launches: the
 * watcher then read account index 0 of a `buy` instruction, which is the
 * program-wide `global` PDA, not a mint. One such address showed up 18 times
 * in 75 minutes with 18 different signatures, always throwing
 * TokenInvalidAccountOwnerError.
 *
 * Solana brackets each program's output, so the emitting program is
 * recoverable by tracking invocation depth:
 *
 *   Program <pumpfun> invoke [1]
 *   Program log: Instruction: Create      <- pumpfun's, a real launch
 *   Program <ata> invoke [2]
 *   Program log: Instruction: Create      <- the ATA program's, a buy
 *   Program <ata> success
 *   Program <pumpfun> success
 *
 * We keep a stack of invoked programs and only accept the marker when the
 * innermost (currently executing) program is Pump.fun.
 */
export function isPumpFunCreateLog(logs: string[]): boolean {
  const pumpfun = PUMPFUN_PROGRAM_ID.toBase58();
  const stack: string[] = [];
  let sawAnyInvoke = false;
  let markerUnderOtherProgram: string | null = null;

  for (const raw of logs) {
    const line = raw.trim();

    const invoke = line.match(/^Program (\S+) invoke \[\d+\]$/);
    if (invoke) {
      sawAnyInvoke = true;
      stack.push(invoke[1]);
      continue;
    }
    // "success" and "failed: ..." both end an invocation.
    if (/^Program \S+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }

    // `includes`, NOT strict equality. Scoping to the emitting program is what
    // fixes the ATA false positive; requiring the line to equal the marker
    // exactly was a second, unintended tightening that rejected every real
    // launch and took detection to zero. If Pump.fun ever renames the
    // instruction (CreateV2, say) `includes` keeps matching, while the program
    // scope still excludes another program's Create.
    if (line.includes(PUMPFUN_CREATE_LOG_MARKER)) {
      const emitter = stack[stack.length - 1];
      if (emitter === pumpfun) return true;
      markerUnderOtherProgram = emitter ?? "(no invoke context)";
    }
  }

  // Never fail silently to zero detections again. If the logs carried no
  // invoke brackets at all we cannot attribute the marker to anyone - that is a
  // log-format surprise, not a buy, so fall back to the old permissive match
  // and say so loudly rather than going quietly blind.
  if (markerUnderOtherProgram !== null && !sawAnyInvoke) {
    logger.warn(
      "Pump.fun create marker seen but the logs contained no 'Program ... invoke [n]' lines, so the " +
        "emitting program could not be determined. Falling back to a permissive match - if this " +
        "repeats, the RPC provider's log format has changed and isPumpFunCreateLog needs revisiting."
    );
    return true;
  }

  if (markerUnderOtherProgram !== null) {
    logger.debug(
      `ignored an 'Instruction: Create' emitted by ${markerUnderOtherProgram}, not Pump.fun ` +
        `- this is the ordinary-buy false positive the scoping exists to reject`
    );
  }

  return false;
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
    // Index 3. Safe to read even though index 7 was not: indices 0-4 sit BEFORE
    // the two Metaplex metadata accounts, so they do not shift on the
    // Token-2022 variant that broke the old creator lookup.
    const assocBondingCurvePk = accounts[PUMPFUN_CREATE_ACCOUNT_INDEX.associatedBondingCurve];

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
      pumpfunAssociatedBondingCurve: assocBondingCurvePk?.toBase58(),
      creator,
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}
