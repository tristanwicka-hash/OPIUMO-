/**
 * Part 3 test: token metrics collection (holders, liquidity, dev %, renounce
 * status, wallet activity).
 *
 * Run with: npm run test:metrics
 *
 * Everything here runs against a hand-built mock `Connection` (only the RPC
 * methods this module actually calls are stubbed) with realistic fixture
 * data, so it's fully offline/deterministic - no live RPC needed, unlike
 * Parts 1-2's live smoke tests.
 */
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getRenounceStatus,
  getTopHolderPercent,
  getWalletMintPercent,
  getPumpFunLiquiditySol,
  getRaydiumLiquiditySol,
  getWalletActivity,
  collectTokenMetrics,
  WSOL_MINT,
} from "../src/data/tokenMetrics";
import { NewPoolEvent } from "../src/watcher/types";

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

function encodeMint(opts: {
  mintAuthority: PublicKey | null;
  freezeAuthority: PublicKey | null;
  supply: bigint;
  decimals: number;
}): Buffer {
  const buf = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: opts.mintAuthority ? 1 : 0,
      mintAuthority: opts.mintAuthority ?? new PublicKey(new Uint8Array(32)),
      supply: opts.supply,
      decimals: opts.decimals,
      isInitialized: true,
      freezeAuthorityOption: opts.freezeAuthority ? 1 : 0,
      freezeAuthority: opts.freezeAuthority ?? new PublicKey(new Uint8Array(32)),
    },
    buf
  );
  return buf;
}

/** Builds a mock Connection exposing only the methods tokenMetrics.ts calls. */
function mockConnection(overrides: Partial<Record<string, (...args: any[]) => any>>): Connection {
  const base: Record<string, (...args: any[]) => any> = {
    getAccountInfo: async () => {
      throw new Error("getAccountInfo not stubbed");
    },
    getTokenLargestAccounts: async () => ({ value: [] }),
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getBalance: async () => 0,
    getTokenAccountBalance: async () => ({ value: { uiAmount: 0 } }),
    getSignaturesForAddress: async () => [],
    getParsedTransaction: async () => null,
  };
  return { ...base, ...overrides } as unknown as Connection;
}

async function main() {
  console.log("=== Part 3 test: token metrics ===");

  console.log("\n-- renounce status --");
  {
    const conn = mockConnection({
      getAccountInfo: async () => ({
        data: encodeMint({ mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000n, decimals: 6 }),
        owner: TOKEN_PROGRAM_ID,
        executable: false,
        lamports: 1,
      }),
    });
    const status = await getRenounceStatus(conn, Keypair.generate().publicKey);
    check("mint with null authorities reports fully renounced", status.mintAuthorityRenounced && status.freezeAuthorityRenounced);
    check("supply decoded correctly", status.supplyRaw === 1_000_000_000n);
  }
  {
    const devWallet = Keypair.generate().publicKey;
    const conn = mockConnection({
      getAccountInfo: async () => ({
        data: encodeMint({ mintAuthority: devWallet, freezeAuthority: devWallet, supply: 1_000_000_000n, decimals: 6 }),
        owner: TOKEN_PROGRAM_ID,
        executable: false,
        lamports: 1,
      }),
    });
    const status = await getRenounceStatus(conn, Keypair.generate().publicKey);
    check("mint with live authorities reports NOT renounced", !status.mintAuthorityRenounced && !status.freezeAuthorityRenounced);
  }

  console.log("\n-- top holder % (excluding pool) --");
  {
    const pool = Keypair.generate().publicKey;
    const whale = Keypair.generate().publicKey;
    const conn = mockConnection({
      getTokenLargestAccounts: async () => ({
        value: [
          { address: pool, amount: "800000000", decimals: 6, uiAmount: 800 }, // 80% - should be excluded
          { address: whale, amount: "150000000", decimals: 6, uiAmount: 150 }, // 15% - real top holder
        ],
      }),
    });
    const pct = await getTopHolderPercent(conn, Keypair.generate().publicKey, 1_000_000_000n, new Set([pool.toBase58()]));
    check("pool excluded, real top holder used (~15%)", pct !== null && Math.abs(pct - 15) < 0.01);
  }

  console.log("\n-- dev wallet % --");
  {
    const dev = Keypair.generate().publicKey;
    const conn = mockConnection({
      getParsedTokenAccountsByOwner: async () => ({
        value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "50000000" } } } } } }],
      }),
    });
    const pct = await getWalletMintPercent(conn, Keypair.generate().publicKey, dev, 1_000_000_000n);
    check("dev wallet % computed correctly (5%)", pct !== null && Math.abs(pct - 5) < 0.01);
  }

  console.log("\n-- liquidity --");
  {
    const conn = mockConnection({ getBalance: async () => 12_500_000_000 }); // 12.5 SOL in lamports
    const sol = await getPumpFunLiquiditySol(conn, Keypair.generate().publicKey);
    check("Pump.fun liquidity converts lamports -> SOL", sol === 12.5);
  }
  {
    const conn = mockConnection({ getTokenAccountBalance: async () => ({ value: { uiAmount: 40 } }) });
    const sol = await getRaydiumLiquiditySol(
      conn,
      "SomeCoinMint",
      WSOL_MINT,
      Keypair.generate().publicKey,
      Keypair.generate().publicKey
    );
    check("Raydium liquidity reads the WSOL-side vault when pcMint is WSOL", sol === 40);
  }
  {
    const conn = mockConnection({});
    const sol = await getRaydiumLiquiditySol(conn, "CoinMint", "SomeOtherQuoteMint", Keypair.generate().publicKey, Keypair.generate().publicKey);
    check("Raydium liquidity returns null for a non-SOL-paired pool", sol === null);
  }

  console.log("\n-- wallet activity (unique wallets vs tx volume) --");
  {
    const wallets = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
    // 8 signatures, only 5 distinct fee payers (some wallets transact twice) - a "wash trading-ish" ratio.
    const sigs = Array.from({ length: 8 }, (_, i) => ({ signature: `sig${i}` }));
    const conn = mockConnection({
      getSignaturesForAddress: async () => sigs,
      getParsedTransaction: async (sig: string) => {
        const i = parseInt(sig.replace("sig", ""), 10);
        const wallet = wallets[i % wallets.length];
        return { transaction: { message: { accountKeys: [{ pubkey: wallet }] } } };
      },
    });
    const activity = await getWalletActivity(conn, Keypair.generate().publicKey, 100);
    check("transactionCount matches signature count", activity.transactionCount === 8);
    check("uniqueWallets deduplicates fee payers", activity.uniqueWallets === 5);
  }

  console.log(`\nOffline checks: ${pass} passed, ${fail} failed`);

  console.log("\n-- collectTokenMetrics: partial-failure handling --");
  {
    // Every underlying call throws - collectTokenMetrics must not throw itself,
    // it should return metrics with nulls + warnings so Part 4 can decide.
    const conn = mockConnection({
      getAccountInfo: async () => {
        throw new Error("boom");
      },
      getTokenLargestAccounts: async () => {
        throw new Error("boom");
      },
      getParsedTokenAccountsByOwner: async () => {
        throw new Error("boom");
      },
      getBalance: async () => {
        throw new Error("boom");
      },
      getSignaturesForAddress: async () => {
        throw new Error("boom");
      },
    });
    const event: NewPoolEvent = {
      source: "pumpfun",
      signature: "sig",
      slot: 1,
      mint: Keypair.generate().publicKey.toBase58(),
      poolAddress: Keypair.generate().publicKey.toBase58(),
      creator: Keypair.generate().publicKey.toBase58(),
      detectedAt: new Date().toISOString(),
    };
    let threw = false;
    let metrics;
    try {
      metrics = await collectTokenMetrics(conn, event);
    } catch {
      threw = true;
    }
    check("collectTokenMetrics does not throw even when every RPC call fails", !threw);
    check("collectTokenMetrics reports warnings instead of crashing", !!metrics && metrics.warnings.length > 0);
    check("collectTokenMetrics defaults renounce flags to false (fail closed) on error", !!metrics && metrics.mintAuthorityRenounced === false);
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
