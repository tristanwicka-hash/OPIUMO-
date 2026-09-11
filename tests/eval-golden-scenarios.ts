/**
 * Deterministic scenarios for the evaluation pipeline, shared by the golden
 * capture and the golden test.
 *
 * Each scenario is a hand-built mock Connection plus a NewPoolEvent plus the
 * options collectTokenMetrics takes. Run through the pipeline they produce a
 * TokenMetrics object; with the timing fields removed that object is the
 * behaviour the graph refactor must reproduce byte for byte.
 *
 * Nothing here touches the network or the real config file beyond loadConfig()
 * (which the module under test calls itself). RPC_URL must be set to anything.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { NewPoolEvent } from "../src/watcher/types";
import { TokenMetrics, WSOL_MINT } from "../src/data/tokenMetrics";

export const MINT = "So11111111111111111111111111111111111111112";
export const POOL = "11111111111111111111111111111112";
export const CREATOR = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
export const LP_MINT = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
export const PC_VAULT = new PublicKey(new Uint8Array(32).fill(11)).toBase58();
export const COIN_VAULT = new PublicKey(new Uint8Array(32).fill(12)).toBase58();
const W = (n: number) => new PublicKey(new Uint8Array(32).fill(100 + n)).toBase58();

export function encodeMint(opts: { mintAuthority: PublicKey | null; freezeAuthority: PublicKey | null; supply: bigint; decimals: number }): Buffer {
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

const renouncedMint = { owner: TOKEN_PROGRAM_ID, data: encodeMint({ mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000n, decimals: 6 }) };
const liveMint = { owner: TOKEN_PROGRAM_ID, data: encodeMint({ mintAuthority: new PublicKey(CREATOR), freezeAuthority: null, supply: 1_000_000_000n, decimals: 6 }) };
const burnedLp = { owner: TOKEN_PROGRAM_ID, data: encodeMint({ mintAuthority: null, freezeAuthority: null, supply: 0n, decimals: 9 }) };
void TOKEN_2022_PROGRAM_ID;

export function mockConnection(overrides: Partial<Record<string, (...args: any[]) => any>>): Connection {
  const base: Record<string, (...args: any[]) => any> = {
    getAccountInfo: async () => { throw new Error("getAccountInfo not stubbed"); },
    getTokenLargestAccounts: async () => ({ value: [] }),
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getBalance: async () => 0,
    getTokenAccountBalance: async () => ({ value: { uiAmount: 0 } }),
    getSignaturesForAddress: async () => [],
    getParsedTransaction: async () => null,
    getParsedTransactions: async (sigs: string[]) => sigs.map(() => null),
  };
  return { ...base, ...overrides } as unknown as Connection;
}

const sigs = (n: number, slot: number) => Array.from({ length: n }, (_, i) => ({ signature: `sig${i}`, slot }));
const txsByWallet = (wallets: string[]) => async (s: string[]) =>
  s.map((sig, i) => ({ transaction: { message: { accountKeys: [{ pubkey: new PublicKey(wallets[i % wallets.length]) }] } }, meta: { err: null }, slot: 1000 }));

export interface Scenario {
  name: string;
  event: NewPoolEvent;
  connection: Connection;
  options?: { forceActivityMetrics?: boolean };
  polling?: { metricsFetchTimeoutMs?: number };
}

const base = (o: Partial<NewPoolEvent> = {}): NewPoolEvent => ({
  source: "pumpfun", signature: "createSig", slot: 1000, mint: MINT, poolAddress: POOL, creator: CREATOR,
  detectedAt: "2026-09-11T00:00:00.000Z", ...o,
});

export const SCENARIOS: Scenario[] = [
  {
    name: "pumpfun: cheap fail on liquidity, everything downstream skipped",
    event: base(),
    connection: mockConnection({ getAccountInfo: async () => renouncedMint, getBalance: async () => 0.5e9 }),
  },
  {
    name: "pumpfun: cheap pass, holder ok, 3 launch-slot buyers, activity ok",
    event: base(),
    connection: mockConnection({
      getAccountInfo: async () => renouncedMint,
      getBalance: async () => 10e9,
      getTokenLargestAccounts: async () => ({ value: [{ address: new PublicKey(W(1)), amount: "50000000" }, { address: new PublicKey(W(2)), amount: "30000000" }] }),
      getParsedTokenAccountsByOwner: async () => ({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "20000000" } } } } } }] }),
      getSignaturesForAddress: async (_a: any, opts: any) => (opts?.limit === 25 ? [...sigs(3, 1000), { signature: "createSig", slot: 1000 }] : sigs(20, 1005)),
      getParsedTransactions: txsByWallet([W(1), W(2), W(3), W(4), W(5)]),
    }),
  },
  {
    name: "pumpfun: cheap pass but largest-accounts throws (DAS disabled) -> holder none",
    event: base(),
    connection: mockConnection({
      getAccountInfo: async () => renouncedMint,
      getBalance: async () => 10e9,
      getTokenLargestAccounts: async () => { throw new Error("index not built"); },
      getSignaturesForAddress: async () => sigs(5, 1002),
      getParsedTransactions: txsByWallet([W(1)]),
    }),
  },
  {
    name: "pumpfun: mint account unreadable -> renounce unknown, decimals null",
    event: base(),
    connection: mockConnection({ getAccountInfo: async () => null, getBalance: async () => 10e9 }),
  },
  {
    name: "pumpfun: mint authority still live -> cheap fail",
    event: base(),
    connection: mockConnection({ getAccountInfo: async () => liveMint, getBalance: async () => 10e9 }),
  },
  {
    name: "pumpfun: no pool address -> liquidity warning, activity by mint",
    event: base({ poolAddress: undefined }),
    connection: mockConnection({ getAccountInfo: async () => renouncedMint }),
  },
  {
    name: "raydium: SOL-paired pool, LP burned, creator holds no LP",
    event: base({ source: "raydium", raydiumPcMint: WSOL_MINT, raydiumPcVault: PC_VAULT, raydiumCoinVault: COIN_VAULT, raydiumLpMint: LP_MINT }),
    connection: mockConnection({
      getAccountInfo: async (pk: PublicKey) => (pk.toBase58() === LP_MINT ? burnedLp : renouncedMint),
      getTokenAccountBalance: async () => ({ value: { uiAmount: 12.5 } }),
      getTokenLargestAccounts: async () => ({ value: [{ address: new PublicKey(W(1)), amount: "10000000" }] }),
      getSignaturesForAddress: async () => sigs(2, 1000),
      getParsedTransactions: txsByWallet([W(1), W(2)]),
    }),
  },
  {
    name: "raydium: no pcMint captured -> liquidity warning, cheap fail",
    event: base({ source: "raydium", raydiumLpMint: LP_MINT }),
    connection: mockConnection({ getAccountInfo: async (pk: PublicKey) => (pk.toBase58() === LP_MINT ? burnedLp : renouncedMint) }),
  },
  {
    name: "pumpfun: cheap fail but forceActivityMetrics (delay probe / watchlist) -> activity fetched",
    event: base(),
    options: { forceActivityMetrics: true },
    connection: mockConnection({
      getAccountInfo: async () => renouncedMint,
      getBalance: async () => 0.2e9,
      getSignaturesForAddress: async () => sigs(4, 1002),
      getParsedTransactions: txsByWallet([W(1), W(1), W(2), W(3)]),
    }),
  },
  {
    name: "pumpfun: activity fetch throws -> warning, nulls",
    event: base(),
    options: { forceActivityMetrics: true },
    connection: mockConnection({
      getAccountInfo: async () => renouncedMint,
      getBalance: async () => 0.2e9,
      getSignaturesForAddress: async () => { throw new Error("429"); },
    }),
  },
  {
    name: "pumpfun: liquidity read hangs -> per-call timeout, liquidity unknown",
    event: base(),
    polling: { metricsFetchTimeoutMs: 60 },
    connection: mockConnection({ getAccountInfo: async () => renouncedMint, getBalance: () => new Promise(() => undefined) }),
  },
  {
    name: "pumpfun: bundle window does not reach the launch slot -> unknown",
    event: base({ slot: 900 }),
    connection: mockConnection({
      getAccountInfo: async () => renouncedMint,
      getBalance: async () => 10e9,
      getTokenLargestAccounts: async () => ({ value: [{ address: new PublicKey(W(1)), amount: "10000000" }] }),
      getSignaturesForAddress: async (_a: any, opts: any) => (opts?.limit === 25 ? sigs(25, 950) : sigs(20, 1005)),
      getParsedTransactions: txsByWallet([W(1), W(2)]),
    }),
  },
];

/** Fields that vary run to run and carry no decision. */
export function stable(m: TokenMetrics): Record<string, unknown> {
  const { fetchedAt, stage1ElapsedMs, stage2ElapsedMs, totalElapsedMs, ...rest } = m as any;
  void fetchedAt; void stage1ElapsedMs; void stage2ElapsedMs; void totalElapsedMs;
  rest.warnings = (rest.warnings as string[]).filter((w) => !/^metrics took \d+ms/.test(w));
  rest.stale = false; // timing-only
  return rest;
}
