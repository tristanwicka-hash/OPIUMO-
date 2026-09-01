import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { unpackMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { loadConfig, PollingConfig } from "../config";
import { Logger } from "../util/logger";
import { NewPoolEvent } from "../watcher/types";

const logger = new Logger("metrics", loadConfig().logging.level);

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface TokenMetrics {
  mint: string;
  fetchedAt: string;

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

  /** True if collecting these metrics took longer than polling.metricsMaxAgeMs - treat with suspicion, the token's on-chain state may have moved since. */
  stale: boolean;

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
export async function getRenounceStatus(connection: Connection, mint: PublicKey) {
  const accountInfo = await connection.getAccountInfo(mint);
  if (!accountInfo) {
    throw new Error("mint account not found");
  }
  const programId = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const info = unpackMint(mint, accountInfo, programId);
  return {
    mintAuthorityRenounced: info.mintAuthority === null,
    freezeAuthorityRenounced: info.freezeAuthority === null,
    supplyRaw: info.supply, // bigint, smallest units
    decimals: info.decimals,
  };
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
  // Fetch in small batches so one slow RPC call doesn't serialize everything.
  const batchSize = 10;
  for (let i = 0; i < signatures.length; i += batchSize) {
    const batch = signatures.slice(i, i + batchSize);
    const txs = await Promise.all(
      batch.map((s) =>
        connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
      )
    );
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
  pollingOverrides?: Partial<PollingConfig>
): Promise<TokenMetrics> {
  const config = loadConfig();
  const polling = { ...config.polling, ...pollingOverrides };
  const warnings: string[] = [];
  const mint = new PublicKey(event.mint);
  const startedAt = Date.now();
  const timeout = <T>(p: Promise<T>, label: string) => withTimeout(p, polling.metricsFetchTimeoutMs, label);

  let mintAuthorityRenounced: boolean | null = null;
  let freezeAuthorityRenounced: boolean | null = null;
  let supplyRaw = 0n;
  try {
    const renounce = await timeout(getRenounceStatus(connection, mint), "renounce status");
    mintAuthorityRenounced = renounce.mintAuthorityRenounced;
    freezeAuthorityRenounced = renounce.freezeAuthorityRenounced;
    supplyRaw = renounce.supplyRaw;
  } catch (err: any) {
    warnings.push(`renounce status: ${err?.message || err}`);
    // mintAuthorityRenounced/freezeAuthorityRenounced stay null ("unknown"), NOT false
    // ("confirmed not renounced") - the filter engine tells those two states apart.
  }

  let liquiditySol: number | null = null;
  try {
    if (event.source === "pumpfun" && event.poolAddress) {
      liquiditySol = await timeout(getPumpFunLiquiditySol(connection, new PublicKey(event.poolAddress)), "pumpfun liquidity");
    } else if (event.source === "raydium") {
      if (!event.raydiumPcMint) {
        warnings.push("no pcMint captured - cannot determine which vault is the SOL side");
      } else {
        liquiditySol = await timeout(
          getRaydiumLiquiditySol(
            connection,
            event.mint,
            event.raydiumPcMint,
            event.raydiumCoinVault ? new PublicKey(event.raydiumCoinVault) : undefined,
            event.raydiumPcVault ? new PublicKey(event.raydiumPcVault) : undefined
          ),
          "raydium liquidity"
        );
      }
    } else {
      warnings.push("no pool address available - cannot compute liquiditySol");
    }
  } catch (err: any) {
    warnings.push(`liquiditySol: ${err?.message || err}`);
  }

  let topHolderPercent: number | null = null;
  try {
    const exclude = new Set<string>([event.poolAddress, event.raydiumCoinVault, event.raydiumPcVault].filter(Boolean) as string[]);
    topHolderPercent = await timeout(getTopHolderPercent(connection, mint, supplyRaw, exclude), "top holder %");
  } catch (err: any) {
    warnings.push(`topHolderPercent: ${err?.message || err}`);
  }

  let devWalletPercent: number | null = null;
  try {
    if (event.creator) {
      devWalletPercent = await timeout(getWalletMintPercent(connection, mint, new PublicKey(event.creator), supplyRaw), "dev wallet %");
    } else {
      warnings.push("no creator wallet identified - cannot compute devWalletPercent");
    }
  } catch (err: any) {
    warnings.push(`devWalletPercent: ${err?.message || err}`);
  }

  let uniqueWallets: number | null = null;
  let transactionCount: number | null = null;
  try {
    const activityAddress = event.poolAddress ? new PublicKey(event.poolAddress) : mint;
    const activity = await timeout(
      getWalletActivity(connection, activityAddress, polling.walletActivitySampleSize),
      "wallet activity"
    );
    uniqueWallets = activity.uniqueWallets;
    transactionCount = activity.transactionCount;
  } catch (err: any) {
    warnings.push(`walletActivity: ${err?.message || err}`);
  }

  const elapsedMs = Date.now() - startedAt;
  const stale = elapsedMs > polling.metricsMaxAgeMs;
  if (stale) {
    warnings.push(`metrics took ${elapsedMs}ms to collect (> metricsMaxAgeMs ${polling.metricsMaxAgeMs}ms) - data may be stale`);
  }

  if (warnings.length > 0) {
    logger.warn(`Partial/stale metrics for ${event.mint}: ${warnings.join("; ")}`);
  }

  return {
    mint: event.mint,
    fetchedAt: new Date().toISOString(),
    liquiditySol,
    topHolderPercent,
    devWalletPercent,
    mintAuthorityRenounced,
    freezeAuthorityRenounced,
    uniqueWallets,
    transactionCount,
    stale,
    warnings,
  };
}
