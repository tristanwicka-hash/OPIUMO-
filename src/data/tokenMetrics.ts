import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { DEFAULT_MAX_LAUNCH_SLOT_SIGNATURES, LpBurnStatus } from "./rugChecks";
import { unpackMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getExtensionTypes, ExtensionType } from "@solana/spl-token";
import { loadConfig, PollingConfig, FiltersConfig } from "../config";
import { Logger } from "../util/logger";
import { NewPoolEvent } from "../watcher/types";

const logger = new Logger("metrics", loadConfig().logging.level);

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface TokenMetrics {
  mint: string;
  fetchedAt: string;

  /** Raw decimals from the mint account - null if we couldn't fetch it. Lets downstream code (e.g. src/trading/engine.ts) convert raw token amounts to human-readable ones for display. */
  decimals: number | null;

  /** null when we could not determine it (e.g. no known pool/vault, or the RPC call failed). */
  liquiditySol: number | null;

  /** % of circulating supply held by the single largest non-pool holder. */
  topHolderPercent: number | null;

  /** % of circulating supply held by the wallet that created the token. */
  devWalletPercent: number | null;

  /** null means "couldn't verify" - NOT the same as false ("confirmed not renounced"). */
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;

  uniqueWallets: number | null;
  transactionCount: number | null;

  /**
   * "Honeypot" isn't a meaningful concept for a classic SPL Token transfer (the program logic
   * is fixed and identical for every token - freezeAuthority above is the one real way a token
   * can be made unsellable, and that's already checked). Token-2022 adds extensions that COULD
   * implement honeypot-like behavior though: a transfer hook can arbitrarily block/tax
   * transfers, and a permanent delegate can move or burn any holder's tokens without consent.
   * Empty array = none of those found (or a classic SPL Token, which can't have them at all).
   * null = couldn't verify (RPC failure) - fails closed, same as the renounce checks.
   */
  riskyTokenExtensions: string[] | null;

  /**
   * How the holder metrics were obtained, and what they cost.
   *
   * "skipped-cheap-fail" means the token already failed a cheaper check and no
   * holder call was made at all - the nulls above are unpaid-for, not failures.
   * "largest-accounts" is the 1-credit path, available once the token is old
   * enough for the index to exist. "das" is the 10-credit path. Recorded so a
   * reader can tell an unaffordable metric from an unavailable one.
   */
  holderSource?: string;
  holderCreditsSpent?: number;

  /**
   * % of the Raydium LP token supply the pool creator personally holds (i.e. NOT locked/burned -
   * withdrawable by them at will). Only meaningful for Raydium pools - a Pump.fun bonding curve
   * has no separate LP token, and the program's own logic makes the liquidity structurally
   * un-rug-pullable pre-migration, so lpCheckApplicable is false there and this stays null
   * (that null does NOT mean "unknown/fail" here - see lpCheckApplicable).
   */
  creatorLpPercent: number | null;
  /** True only for Raydium pools - tells the filter engine whether creatorLpPercent should be evaluated at all. */
  lpCheckApplicable: boolean;
  /**
   * Rug checks 3 and 4 (src/data/rugChecks.ts). Every field is null when not
   * read; `lpBurnStatus` / `bundleSource` say WHY. "not-applicable" and
   * "skipped-cheap-fail" are recorded as such - never as safe.
   */
  lpBurnStatus?: LpBurnStatus;
  lpBurned?: boolean | null;
  launchSlotBuyers?: number | null;
  launchSlotTxs?: number | null;
  bundleSource?: "fetched" | "unknown" | "not-fetched" | "skipped-cheap-fail" | "disabled";
  bundleCreditsSpent?: number;

  /** True if collecting these metrics took longer than polling.metricsMaxAgeMs - treat with suspicion, the token's on-chain state may have moved since. */
  stale: boolean;

  /**
   * True when the expensive activity metrics (uniqueWallets/transactionCount)
   * were DELIBERATELY not collected because stage-1 data already guaranteed a
   * SKIP. This is not the same as "we tried and the RPC failed" - the filter
   * engine words the two differently, and conflating them would claim a
   * network failure that never happened.
   */
  activitySkippedEarly: boolean;

  /** ms spent on the cheap stage-1 metric calls. */
  stage1ElapsedMs: number;
  /** ms spent on the expensive activity call. Null when stage 2 was skipped. */
  stage2ElapsedMs: number | null;
  /** ms for the whole collection, stage 1 + stage 2. */
  totalElapsedMs: number;

  /** Any partial failures, so the filter engine can decide how to treat them - always check this before trusting a PASS. */
  warnings: string[];
}

/** Races a promise against a timeout so one slow RPC call can't hang metrics collection forever. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  // Deliberately NOT unref()'d: an unref'd timer can be skipped entirely by Node's event
  // loop if it ends up the only pending handle (e.g. a standalone script, or a test),
  // which would make a hung RPC call hang forever instead of timing out - defeating the
  // whole point of this wrapper. A few seconds of delayed process exit is a much smaller
  // cost than a timeout that can silently never fire.
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Mint authority / freeze authority state - this is what "renounced" means for an SPL token.
 * Detects whether the mint belongs to the classic Token Program or Token-2022 and decodes
 * accordingly (a plain getMint() call defaults to the classic program and throws on Token-2022
 * mints, which would otherwise look identical to a fetch failure).
 */
/** Token-2022 extensions that can implement honeypot-like behavior (see TokenMetrics.riskyTokenExtensions). */
const RISKY_EXTENSION_NAMES: Partial<Record<number, string>> = {
  [ExtensionType.TransferHook]: "TransferHook (can arbitrarily block/tax transfers)",
  [ExtensionType.PermanentDelegate]: "PermanentDelegate (can move/burn any holder's tokens without consent)",
};

export async function getRenounceStatus(connection: Connection, mint: PublicKey) {
  const accountInfo = await connection.getAccountInfo(mint);
  if (!accountInfo) {
    throw new Error("mint account not found");
  }
  const programId = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const info = unpackMint(mint, accountInfo, programId);

  const riskyTokenExtensions =
    programId.equals(TOKEN_2022_PROGRAM_ID) && info.tlvData.length > 0
      ? getExtensionTypes(info.tlvData)
          .map((t) => RISKY_EXTENSION_NAMES[t])
          .filter((name): name is string => !!name)
      : [];

  return {
    mintAuthorityRenounced: info.mintAuthority === null,
    freezeAuthorityRenounced: info.freezeAuthority === null,
    supplyRaw: info.supply, // bigint, smallest units
    decimals: info.decimals,
    riskyTokenExtensions,
  };
}

/**
 * % of a Raydium pool's LP token supply the creator wallet still holds - i.e. the % that is
 * NOT locked or burned and could be withdrawn (rug-pulled) at will. Reuses getWalletMintPercent
 * against the LP mint instead of the token mint - same math, different target.
 */
export async function getCreatorLpPercent(
  connection: Connection,
  lpMint: PublicKey,
  creator: PublicKey
): Promise<number | null> {
  // Reusing getRenounceStatus purely for its supplyRaw return - LP mints' own renounce status
  // isn't meaningful here, we just need the total LP supply to compute a %.
  const lpRenounce = await getRenounceStatus(connection, lpMint).catch(() => null);
  if (!lpRenounce) return null;
  return getWalletMintPercent(connection, lpMint, creator, lpRenounce.supplyRaw);
}

/**
 * % of supply held by the largest holder, excluding addresses you pass in
 * `excludeAddresses` (always pass the pool/bonding-curve/vault addresses -
 * otherwise the pool itself, which legitimately holds most of the supply
 * pre-migration, will dominate and make every token look concentrated).
 * Uses getTokenLargestAccounts, which the RPC caps at the top 20 accounts -
 * fine for a "is one wallet suspiciously large" check, not a full holder audit.
 */
export async function getTopHolderPercent(
  connection: Connection,
  mint: PublicKey,
  supplyRaw: bigint,
  excludeAddresses: Set<string>
): Promise<number | null> {
  if (supplyRaw === 0n) return null;

  const largest = await connection.getTokenLargestAccounts(mint);
  const candidates = largest.value.filter((a) => !excludeAddresses.has(a.address.toBase58()));
  if (candidates.length === 0) return 0;

  const topRaw = BigInt(candidates[0].amount);
  return Number((topRaw * 10000n) / supplyRaw) / 100; // 2 decimal places, no float division of bigints
}

/** % of supply held by a specific wallet (typically the token's creator / "dev wallet"). */
export async function getWalletMintPercent(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
  supplyRaw: bigint
): Promise<number | null> {
  if (supplyRaw === 0n) return null;

  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  let ownedRaw = 0n;
  for (const { account } of accounts.value) {
    const amount = account.data.parsed?.info?.tokenAmount?.amount;
    if (amount) ownedRaw += BigInt(amount);
  }
  return Number((ownedRaw * 10000n) / supplyRaw) / 100;
}

/** Pump.fun pre-migration liquidity: the bonding curve PDA's native SOL balance.
 *  NOTE: this is the *real* SOL actually deposited by buyers so far - Pump.fun's bonding
 *  curve math also uses a fixed *virtual* SOL reserve (never held in this account) as part
 *  of its price curve, so this number will read lower than the "liquidity"/market-cap figure
 *  shown in Pump.fun's own UI. Treat minLiquiditySol as "real SOL raised", not "displayed mcap". */
export async function getPumpFunLiquiditySol(
  connection: Connection,
  bondingCurve: PublicKey
): Promise<number> {
  const lamports = await connection.getBalance(bondingCurve);
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Raydium liquidity: the SOL sitting in whichever of the pool's two vaults
 * is the WSOL side. Returns null for a pool that isn't SOL-paired (rare for
 * fresh Pump.fun migrations, but possible) - the filter engine should treat
 * null liquidity as "can't verify" rather than silently passing/failing it.
 */
export async function getRaydiumLiquiditySol(
  connection: Connection,
  coinMint: string,
  pcMint: string,
  coinVault: PublicKey | undefined,
  pcVault: PublicKey | undefined
): Promise<number | null> {
  let solVault: PublicKey | undefined;
  if (coinMint === WSOL_MINT) solVault = coinVault;
  else if (pcMint === WSOL_MINT) solVault = pcVault;

  if (!solVault) {
    logger.warn("Raydium pool is not SOL-paired (or vault address missing) - cannot compute liquiditySol");
    return null;
  }

  const balance = await connection.getTokenAccountBalance(solVault);
  return balance.value.uiAmount ?? 0;
}

/**
 * Samples recent activity on `address` (bonding curve or pool address) to
 * approximate unique-wallet count vs transaction volume. This fetches up to
 * `sampleSize` full transactions, so it's the most RPC-expensive metric in
 * the bot - keep sampleSize modest (config.polling.walletActivitySampleSize)
 * and use a paid RPC provider with decent rate limits.
 */
export async function getWalletActivity(
  connection: Connection,
  address: PublicKey,
  sampleSize: number
): Promise<{ uniqueWallets: number; transactionCount: number }> {
  const signatures = await connection.getSignaturesForAddress(address, { limit: sampleSize });
  const transactionCount = signatures.length;

  if (transactionCount === 0) return { uniqueWallets: 0, transactionCount: 0 };

  const wallets = new Set<string>();

  // getParsedTransactions() sends ONE batched JSON-RPC request per chunk rather
  // than one HTTP request per signature. Previously this issued 100 separate
  // requests (10 rounds of 10), which is what made a single observation cost
  // ~101 round trips and pushed the probe into 429s. Same signatures, same fee
  // payers, same numbers - only the transport changes, so uniqueWallets and
  // transactionCount are unaffected.
  // 10, not 25: a batched request spends one credit PER SIGNATURE the instant it
  // lands, so a large batch can blow a per-second credit budget in one shot and
  // trigger 429s that the client then retries - turning a cheap call into a slow
  // one. 10 keeps the round-trip saving without the burst.
  const batchSize = 10;
  for (let i = 0; i < signatures.length; i += batchSize) {
    const batch = signatures.slice(i, i + batchSize);
    let txs: (Awaited<ReturnType<typeof connection.getParsedTransaction>>)[] = [];
    try {
      txs = await connection.getParsedTransactions(
        batch.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 }
      );
    } catch {
      // A failed chunk costs us those wallets but must not discard the rest -
      // the count is then a floor, which the caller can see via transactionCount.
      txs = [];
    }
    for (const tx of txs) {
      const feePayer = tx?.transaction.message.accountKeys?.[0]?.pubkey?.toBase58();
      if (feePayer) wallets.add(feePayer);
    }
  }

  return { uniqueWallets: wallets.size, transactionCount };
}

/**
 * Part 3 entry point: given a newly detected pool (from Part 2), gather
 * every metric Part 4's filters need. Individual metric failures are
 * captured as warnings rather than throwing, so one flaky RPC call doesn't
 * discard an otherwise-complete picture - the filter engine decides how to
 * treat a missing metric (see Part 4). Every RPC call is bounded by
 * polling.metricsFetchTimeoutMs, and the whole collection is timed against
 * polling.metricsMaxAgeMs to flag results that took so long they might be
 * stale by the time you act on them.
 *
 * `pollingOverrides` lets callers (mainly tests) override the timeout/
 * staleness thresholds without touching global config.
 */
export async function collectTokenMetrics(
  connection: Connection,
  event: NewPoolEvent,
  pollingOverrides?: Partial<PollingConfig>,
  filtersOverride?: FiltersConfig,
  options?: {
    /**
     * Collect the activity metrics even when stage-1 data already guarantees a
     * SKIP. The live pipeline never sets this - skipping that work is the whole
     * point of the two-stage split. The delay probe DOES, because
     * uniqueWallets/transactionCount are precisely what it exists to measure,
     * and a token that fails stage 1 at t+0 is exactly the case worth watching
     * as it ages.
     */
    forceActivityMetrics?: boolean;
  }
): Promise<TokenMetrics> {
  const config = loadConfig();
  const polling = { ...config.polling, ...pollingOverrides };
  const filters = filtersOverride ?? config.filters;
  // Holder-fetch policy. Optional in config so an older config file still runs;
  // the defaults are the ones measured on 2026-09-10.
  const holderRaw = (config as unknown as Record<string, any>).holderData ?? {};
  const holderCfg = {
    allowDas: holderRaw.allowDas !== false,
    dasAgeThresholdMs: typeof holderRaw.dasAgeThresholdMs === "number" ? holderRaw.dasAgeThresholdMs : 120_000,
  };
  // Rug checks (src/data/rugChecks.ts). Optional in config so an older file still runs.
  const rugRaw = (config as unknown as Record<string, any>).rugChecks ?? {};
  const rugCfg = {
    bundleDetection: rugRaw.bundleDetection !== false,
    maxLaunchSlotSignatures: typeof rugRaw.maxLaunchSlotSignatures === "number" ? rugRaw.maxLaunchSlotSignatures : DEFAULT_MAX_LAUNCH_SLOT_SIGNATURES,
  };

  // The control flow lives in src/graph/metricsGraph.ts as named nodes and
  // edges; this function only builds the starting state and runs the graph.
  const { runGraph } = await import("../graph/graph");
  const { METRICS_GRAPH, initialMetricsState } = await import("../graph/metricsGraph");
  const { state } = await runGraph(
    METRICS_GRAPH,
    initialMetricsState({
      connection, event, polling, filters, holderCfg, rugCfg,
      forceActivityMetrics: options?.forceActivityMetrics === true,
      log: { debug: (m) => logger.debug(m), warn: (m) => logger.warn(m) },
    })
  );
  return state.result!;
}
