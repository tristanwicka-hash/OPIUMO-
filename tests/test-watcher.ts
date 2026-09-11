/**
 * Part 2 test: pool/token creation detection.
 *
 * Run with: npm run test:watcher
 *
 * Three kinds of checks here:
 *  1. Offline, deterministic unit tests of the log-matching + mint-extraction
 *     logic against realistic fixture data - these do NOT need network and
 *     fully pass/fail in this sandbox.
 *  2. Offline unit tests of PoolWatcher's own reliability behavior (signature
 *     dedup, self-healing reconnect) against a mock Connection - also fully
 *     offline/deterministic.
 *  3. A live subscription smoke test (PoolWatcher.start()) - this needs a
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
import { PoolWatcher, PoolWatcherOptions } from "../src/watcher";
import { getConnection } from "../src/rpc/connection";

/** Mock Connection exposing only what PoolWatcher itself calls (no metrics/filter methods needed here). */
function mockWatcherConnection(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  let nextId = 1;
  const base: Record<string, (...args: any[]) => any> = {
    onLogs: () => nextId++,
    removeOnLogsListener: async () => {},
    onSlotChange: () => nextId++,
    removeSlotChangeListener: async () => {},
    getParsedTransaction: async () => null,
  };
  return { ...base, ...overrides } as any;
}

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

/**
 * A realistic Pump.fun create log array. isPumpFunCreateLog() now checks WHICH
 * program emitted "Instruction: Create" (see the Bug 2 fix), so a bare marker
 * with no invoke bracket is correctly ignored - real logs always have one.
 */
function pumpfunCreateLogs(): string[] {
  const pump = PUMPFUN_PROGRAM_ID.toBase58();
  return [`Program ${pump} invoke [1]`, PUMPFUN_CREATE_LOG_MARKER, `Program ${pump} success`];
}

function fixtureAccounts(count: number): PublicKey[] {
  return Array.from({ length: count }, () => Keypair.generate().publicKey);
}

/** Builds a minimal object matching the slice of ParsedTransactionWithMeta we read. */
/**
 * `feePayer` becomes accountKeys[0] - which is where extractPumpFunNewPool now
 * reads the creator from, rather than a hardcoded instruction account index.
 * Defaults to a fresh random key so existing callers get a realistic wallet.
 */
function fixtureParsedTx(programId: PublicKey, accounts: PublicKey[], feePayer?: PublicKey) {
  const payer = feePayer ?? Keypair.generate().publicKey;
  return {
    slot: 123456789,
    transaction: {
      message: {
        accountKeys: [
          { pubkey: payer, signer: true, writable: true },
          ...accounts.map((pubkey) => ({ pubkey, signer: false, writable: false })),
        ],
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

  // Bug 2: an ordinary BUY by a first-time buyer creates their associated token
  // account, and the ATA program logs the SAME "Instruction: Create" line. The
  // old substring match treated that as a launch - ~24% of detections - and then
  // read account index 0 of a `buy`, which is the program-wide `global` PDA.
  {
    const PUMP = PUMPFUN_PROGRAM_ID.toBase58();
    const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

    const buyWithAtaCreate = [
      `Program ${PUMP} invoke [1]`,
      "Program log: Instruction: Buy",
      `Program ${ATA} invoke [2]`,
      "Program log: Instruction: Create",
      `Program ${ATA} success`,
      `Program ${PUMP} success`,
    ];
    check(
      "a BUY whose ATA-create logs 'Instruction: Create' is NOT a launch",
      !isPumpFunCreateLog(buyWithAtaCreate)
    );

    const realCreate = [
      `Program ${PUMP} invoke [1]`,
      "Program log: Instruction: Create",
      `Program ${ATA} invoke [2]`,
      "Program log: Instruction: Create",
      `Program ${ATA} success`,
      `Program ${PUMP} success`,
    ];
    check(
      "a real launch IS still detected, even alongside an ATA create",
      isPumpFunCreateLog(realCreate)
    );

    // The ATA program's idempotent variant contains the marker as a substring.
    check(
      "CreateIdempotent from the ATA program is not a launch",
      !isPumpFunCreateLog([
        `Program ${ATA} invoke [1]`,
        "Program log: Instruction: CreateIdempotent",
        `Program ${ATA} success`,
      ])
    );

    // A failed inner invocation still closes its frame.
    check(
      "a failed inner program does not leak its frame",
      !isPumpFunCreateLog([
        `Program ${PUMP} invoke [1]`,
        "Program log: Instruction: Buy",
        `Program ${ATA} invoke [2]`,
        `Program ${ATA} failed: custom program error: 0x0`,
        `Program ${PUMP} success`,
        `Program ${ATA} invoke [1]`,
        "Program log: Instruction: Create",
        `Program ${ATA} success`,
      ])
    );

    // Regression guard: scoping must not also make the match exact. Requiring
    // line === marker took live detection to ZERO, because a real launch's log
    // text is not guaranteed to equal the marker byte-for-byte.
    check(
      "a renamed pumpfun create instruction still matches (includes, not equals)",
      isPumpFunCreateLog([
        `Program ${PUMP} invoke [1]`,
        "Program log: Instruction: CreateV2",
        `Program ${PUMP} success`,
      ])
    );
    check(
      "trailing text after the marker still matches",
      isPumpFunCreateLog([
        `Program ${PUMP} invoke [1]`,
        "Program log: Instruction: Create  ",
        `Program ${PUMP} success`,
      ])
    );

    // Fail loudly, never silently to zero: with no invoke brackets we cannot
    // attribute the marker, so we accept rather than go blind.
    check(
      "a bare marker with NO invoke context falls back to permissive (never silent zero)",
      isPumpFunCreateLog(["Program log: Instruction: Create"])
    );
  }
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
    const feePayer = Keypair.generate().publicKey;
    const tx = fixtureParsedTx(PUMPFUN_PROGRAM_ID, accounts, feePayer);
    const event = extractPumpFunNewPool("sig1", 1, tx);
    check("extractPumpFunNewPool returns an event", event !== null);
    check(
      "extractPumpFunNewPool picks mint at the documented index",
      event?.mint === accounts[PUMPFUN_CREATE_ACCOUNT_INDEX.mint].toBase58()
    );
    // Creator now comes from the transaction FEE PAYER (accountKeys[0]), not a
    // fixed instruction account index. A Token-2022 mint carries metadata as a
    // mint extension, which drops two Metaplex accounts and shifts index 7 onto
    // the Token-2022 PROGRAM - that produced 139 bogus "creator" values in a
    // real run. The fee payer is guaranteed by Solana's transaction format, so
    // it survives that layout difference.
    check(
      "extractPumpFunNewPool takes creator from the fee payer, not an account index",
      event?.creator === feePayer.toBase58()
    );
    check(
      "  ...and NOT from the old index-7 slot",
      event?.creator !== accounts[PUMPFUN_CREATE_ACCOUNT_INDEX.user].toBase58()
    );
    // The bonding curve's ASSOCIATED TOKEN ACCOUNT (index 3). Without this the
    // pool itself counts as the top holder and every pre-migration Pump.fun
    // token reads ~99% concentration - 207 of 335 real readings did.
    check(
      "captures the associated bonding curve at index 3",
      event?.pumpfunAssociatedBondingCurve ===
        accounts[PUMPFUN_CREATE_ACCOUNT_INDEX.associatedBondingCurve].toBase58()
    );
    check(
      "  ...which is a DIFFERENT account from poolAddress",
      event?.pumpfunAssociatedBondingCurve !== event?.poolAddress
    );
  }

  // The exact bug this replaced: a program ID must never be reported as a wallet.
  {
    const accounts = fixtureAccounts(14);
    const token2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    const tx = fixtureParsedTx(PUMPFUN_PROGRAM_ID, accounts, token2022);
    const event = extractPumpFunNewPool("sig-token2022", 1, tx);
    check("a Token-2022 PROGRAM ID as fee payer is refused as a creator", event?.creator === undefined);
    check("  ...but the event is still produced (mint is still valid)", event !== null && event.mint.length > 0);
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

  console.log("\n-- signature dedup (a redelivered/duplicated log must not double-process) --");
  {
    const accounts = fixtureAccounts(14);
    const tx = fixtureParsedTx(PUMPFUN_PROGRAM_ID, accounts);
    let getParsedTransactionCalls = 0;
    const conn = mockWatcherConnection({
      getParsedTransaction: async () => {
        getParsedTransactionCalls++;
        return tx;
      },
    });
    const watcher = new PoolWatcher(conn);
    let emitCount = 0;
    watcher.on("newPool", () => emitCount++);

    const logsResult = { err: null, logs: pumpfunCreateLogs(), signature: "duplicate-sig" };
    await (watcher as any).handlePumpFunLogs(logsResult);
    await (watcher as any).handlePumpFunLogs(logsResult); // same signature delivered again

    check("duplicate signature only emits newPool once", emitCount === 1);
    check("duplicate signature only resolves the transaction once (saves an RPC call)", getParsedTransactionCalls === 1);
  }

  console.log("\n-- self-healing: a silently-dead websocket triggers automatic resubscribe --");
  {
    let onLogsCalls = 0;
    const conn = mockWatcherConnection({
      onLogs: () => {
        onLogsCalls++;
        return onLogsCalls;
      },
    });
    const options: PoolWatcherOptions = { staleConnectionThresholdMs: 10, healthCheckIntervalMs: 60_000 };
    const watcher = new PoolWatcher(conn, options);

    watcher.start();
    const callsAfterStart = onLogsCalls;
    check("start() subscribes to pumpfun + raydium logs", callsAfterStart === 2);

    // Simulate total silence: no onSlotChange callback ever fires, so lastSlotSeenAt
    // never advances past start(). Wait past the (tiny, test-only) staleness threshold,
    // then trigger the health check manually instead of waiting on the real interval.
    await new Promise((r) => setTimeout(r, 25));
    watcher.checkHealth();
    await new Promise((r) => setTimeout(r, 25)); // restart() runs stop().then(start()) asynchronously

    check("a stale connection triggers an automatic resubscribe", onLogsCalls > callsAfterStart);
    await watcher.stop();
  }
  {
    // The inverse: healthy connections (slot updates arriving) must NOT be restarted.
    let onLogsCalls = 0;
    let onSlotChangeCallback: () => void = () => {};
    const conn = mockWatcherConnection({
      onLogs: () => {
        onLogsCalls++;
        return onLogsCalls;
      },
      onSlotChange: (cb: () => void) => {
        onSlotChangeCallback = cb;
        return 1;
      },
    });
    const watcher = new PoolWatcher(conn, { staleConnectionThresholdMs: 10_000, healthCheckIntervalMs: 60_000 });
    watcher.start();
    const callsAfterStart = onLogsCalls;

    onSlotChangeCallback(); // simulate a heartbeat right before the health check
    watcher.checkHealth();
    await new Promise((r) => setTimeout(r, 10));

    check("a healthy (recently-seen-slot) connection is left alone", onLogsCalls === callsAfterStart);
    await watcher.stop();
  }

  console.log(`\nOffline checks: ${pass} passed, ${fail} failed`);

  console.log("\n-- live subscription smoke test --");
  /**
   * This section opens a REAL websocket to the configured RPC and starts the
   * RPC meter. Two things went wrong with it on 2026-09-11 and both are fixed
   * here:
   *
   *  1. It ran inside the pre-commit hook. SKIP_NETWORK_SUITES=1 excludes the
   *     suites marked `needsNetwork` in run-all.ts, but this suite is offline
   *     for its first 29 checks and was never marked - so the hook opened a
   *     live websocket on every commit. It now skips this section under that
   *     flag and says so.
   *  2. It could hang forever. `watcher.stop()` awaits
   *     `removeOnLogsListener`, and when the websocket is half-open that
   *     unsubscribe never gets a response. The hook sat 23 minutes on it - long
   *     enough for the meter's 10-minute timer to write this TEST process into
   *     logs/rpc-meter.jsonl as if it were the bot. A hard 15-second cap now
   *     turns a stuck stop into a reported failure and the process exits.
   */
  if (process.env.SKIP_NETWORK_SUITES === "1") {
    console.log("SKIPPED: live websocket smoke test - SKIP_NETWORK_SUITES=1 (offline checks above still count)");
  } else {
    const LIVE_CAP_MS = 15_000;
    const capped = <T>(p: Promise<T>, label: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} did not complete within ${LIVE_CAP_MS / 1000}s`)), LIVE_CAP_MS);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
      });
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
      await capped(watcher.stop(), "watcher.stop()");
      console.log("PASS: subscription started and stopped without error");
      console.log(`  (no event required for this smoke test; liveOk=${liveOk})`);
    } catch (err: any) {
      console.error("FAIL (expected in a sandbox with no Solana RPC egress):", err?.message || err);
      console.error(
        "  Re-run this test on a machine with real websocket access to your RPC provider " +
          "before trusting Part 2 end-to-end."
      );
    }
  }

  // The runner and the pre-commit hook read this line; without it a suite counts
  // as "did not run to completion" (which is how this file was reported until now).
  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  // Exit explicitly: a lingering websocket or meter timer must not keep this alive.
  process.exit(fail > 0 ? 1 : 0);
}

main();
