/**
 * Tier-1 verification helper: decodes ONE real Raydium `initialize2`
 * transaction and prints its account list side-by-side with what this bot
 * currently assumes each index means (RAYDIUM_INITIALIZE2_ACCOUNT_INDEX in
 * src/watcher/raydiumWatcher.ts) - the one thing this whole project could
 * never verify from this sandbox (no live RPC access here, confirmed
 * repeatedly). This makes that check a single command instead of writing
 * your own decode script.
 *
 * Usage:
 *   npm run verify:raydium-tx -- <transaction signature>
 *
 * How to use it:
 *   1. Find a recent Raydium pool-creation tx: on Solscan, open the
 *      Raydium AMM V4 program (675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8),
 *      its "Transactions" tab, and look for one Solscan itself labels as
 *      "initialize2" (or just grab a few recent ones and try each).
 *   2. Run this script with that signature.
 *   3. Compare what it prints for "our guess: coinMint / ammId / userWallet"
 *      against what Solscan's own transaction page shows for the new
 *      token/pool/creator. If they match, the indices are still correct.
 *      If not, paste both outputs back and the indices in
 *      RAYDIUM_INITIALIZE2_ACCOUNT_INDEX need updating.
 */
import { getConnection } from "../src/rpc/connection";
import { RAYDIUM_AMM_V4_PROGRAM_ID } from "../src/watcher/programs";
import { RAYDIUM_INITIALIZE2_ACCOUNT_INDEX, extractRaydiumNewPool } from "../src/watcher/raydiumWatcher";
import { PartiallyDecodedInstruction } from "@solana/web3.js";

async function main() {
  const signature = process.argv[2];
  if (!signature) {
    console.error("Usage: npm run verify:raydium-tx -- <transaction signature>");
    process.exit(1);
  }

  console.log(`=== Decoding ${signature} ===\n`);
  const connection = getConnection();
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });

  if (!tx) {
    console.error("Transaction not found (wrong signature, wrong network, or not yet confirmed).");
    process.exit(1);
  }

  const raydiumIx = tx.transaction.message.instructions.find(
    (ix) => "programId" in ix && ix.programId.toBase58() === RAYDIUM_AMM_V4_PROGRAM_ID.toBase58()
  ) as PartiallyDecodedInstruction | undefined;

  if (!raydiumIx || !("accounts" in raydiumIx)) {
    console.error("No Raydium AMM V4 instruction found in this transaction - wrong signature? (this doesn't have to be initialize2 specifically, but it does have to call the Raydium AMM V4 program)");
    process.exit(1);
  }

  console.log("Full account list for this instruction (index: pubkey):\n");
  raydiumIx.accounts.forEach((pk, i) => console.log(`  [${i}] ${pk.toBase58()}`));

  console.log("\nWhat this bot's RAYDIUM_INITIALIZE2_ACCOUNT_INDEX currently assumes:\n");
  for (const [field, idx] of Object.entries(RAYDIUM_INITIALIZE2_ACCOUNT_INDEX)) {
    const pk = raydiumIx.accounts[idx];
    console.log(`  ${field.padEnd(20)} (index ${idx}) = ${pk ? pk.toBase58() : "(out of range!)"}`);
  }

  const extracted = extractRaydiumNewPool(signature, tx.slot, tx);
  console.log("\nWhat extractRaydiumNewPool() derives from this:\n");
  console.log(JSON.stringify(extracted, null, 2));

  console.log(
    "\n=== Now compare the mint/poolAddress/creator above against what Solscan's own page ===\n" +
      "=== for this signature shows as the new token, the pool, and the creator wallet.   ===\n" +
      "If they match: the indices are correct. If not: paste this output + what Solscan   ===\n" +
      "shows, and RAYDIUM_INITIALIZE2_ACCOUNT_INDEX needs updating.                        ===\n"
  );
}

main().catch((err) => {
  console.error("Failed:", err?.message || err);
  process.exit(1);
});
