/**
 * Part 2 test: pool/token creation detection.
 *
 * Run with: npm run test:watcher
 *
 * Two kinds of checks here:
 *  1. Offline, deterministic unit tests of the log-matching + mint-extraction
 *     logic against realistic fixture data - these do NOT need network and
 *     fully pass/fail in this sandbox.
 *  2. A live subscription smoke test (PoolWatcher.start()) - this needs a
 *     websocket connection to your RPC provider. In this sandbox it will
 *     fail with a network error, same as Part 1's RPC test; expected here,
 *     re-run on a machine with real RPC access before trusting Part 2.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  PUMPFUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  PUMPFUN_CREATE_LOG_MARKER,
  RAYDIUM_INITIALIZE2_LOG_MARKER,
} from "../src/watcher/programs";
import {
  isPumpFunCreateLog,
  extractPumpFunNewPool,
  PUMPFUN_CREATE_ACCOUNT_INDEX,
} from "../src/watcher/pumpfunWatcher";
import {
  isRaydiumInitialize2Log,
  extractRaydiumNewPool,
  RAYDIUM_INITIALIZE2_ACCOUNT_INDEX,
} from "../src/watcher/raydiumWatcher";
import { PoolWatcher } from "../src/watcher";
import { getConnection } from "../src/rpc/connection";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    pass++;
  } else {
    console.error(`  FAIL: ${name}`);
    fail++;
  }
}

function fixtureAccounts(count: number): PublicKey[] {
  return Array.from({ length: count }, () => Keypair.generate().publicKey);
}

/** Builds a minimal object matching the slice of ParsedTransactionWithMeta we read. */
function fixtureParsedTx(programId: PublicKey, accounts: PublicKey[]) {
  return {
    slot: 123456789,
    transaction: {
      message: {
        instructions: [{ programId, accounts }],
      },
    },
  } as any;
}

async function main() {
  console.log("=== Part 2 test: pool/token watcher ===");

  console.log("\n-- log matchers --");
  check(
    "isPumpFunCreateLog matches a real-shaped Create log",
    isPumpFunCreateLog([
      "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
      PUMPFUN_CREATE_LOG_MARKER,
      "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
    ])
  );
  check(
    "isPumpFunCreateLog rejects unrelated logs (e.g. a Buy)",
    !isPumpFunCreateLog(["Program log: Instruction: Buy"])
  );
  check(
    "isRaydiumInitialize2Log matches a real-shaped initialize2 log",
    isRaydiumInitialize2Log([
      "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
      `ray_log: ${RAYDIUM_INITIALIZE2_LOG_MARKER}=1000000000`,
    ])
  );
  check(
    "isRaydiumInitialize2Log rejects unrelated logs (e.g. a Swap)",
    !isRaydiumInitialize2Log(["Program log: ray_log: swap"])
  );

  console.log("\n-- mint extraction (fixture data) --");
  {
    const accounts = fixtureAccounts(14);
    const tx = fixtureParsedTx(PUMPFUN_PROGRAM_ID, accounts);
    const event = extractPumpFunNewPool("sig1", 1, tx);
    check("extractPumpFunNewPool returns an event", event !== null);
    check(
      "extractPumpFunNewPool picks mint at the documented index",
      event?.mint === accounts[PUMPFUN_CREATE_ACCOUNT_INDEX.mint].toBase58()
    );
    check(
      "extractPumpFunNewPool picks creator at the documented index",
      event?.creator === accounts[PUMPFUN_CREATE_ACCOUNT_INDEX.user].toBase58()
    );
  }
  {
    const accounts = fixtureAccounts(18);
    const tx = fixtureParsedTx(RAYDIUM_AMM_V4_PROGRAM_ID, accounts);
    const event = extractRaydiumNewPool("sig2", 2, tx);
    check("extractRaydiumNewPool returns an event", event !== null);
    check(
      "extractRaydiumNewPool picks coinMint at the documented index",
      event?.mint === accounts[RAYDIUM_INITIALIZE2_ACCOUNT_INDEX.coinMint].toBase58()
    );
    check(
      "extractRaydiumNewPool picks poolAddress (ammId) at the documented index",
      event?.poolAddress === accounts[RAYDIUM_INITIALIZE2_ACCOUNT_INDEX.ammId].toBase58()
    );
  }
  {
    // Wrong program ID -> extractors must return null, not guess.
    const accounts = fixtureAccounts(14);
    const tx = fixtureParsedTx(Keypair.generate().publicKey, accounts);
    check("extractPumpFunNewPool returns null for an unrelated program", extractPumpFunNewPool("sig3", 3, tx) === null);
    check("extractRaydiumNewPool returns null for an unrelated program", extractRaydiumNewPool("sig4", 4, tx) === null);
  }

  console.log(`\nOffline checks: ${pass} passed, ${fail} failed`);

  console.log("\n-- live subscription smoke test --");
  try {
    const watcher = new PoolWatcher(getConnection());
    let liveOk = false;
    watcher.on("newPool", () => {
      liveOk = true;
    });
    watcher.start();
    // We don't wait for an actual event (could be minutes) - just prove the
    // websocket subscription itself doesn't immediately blow up.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await watcher.stop();
    console.log("PASS: subscription started and stopped without error");
    console.log(`  (no event required for this smoke test; liveOk=${liveOk})`);
  } catch (err: any) {
    console.error("FAIL (expected in a sandbox with no Solana RPC egress):", err?.message || err);
    console.error(
      "  Re-run this test on a machine with real websocket access to your RPC provider " +
        "before trusting Part 2 end-to-end."
    );
  }

  process.exit(fail > 0 ? 1 : 0);
}

main();
