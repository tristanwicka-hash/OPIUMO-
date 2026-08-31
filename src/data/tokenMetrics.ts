import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { loadConfig } from "../config";
import { Logger } from "../util/logger";
import { NewPoolEvent } from "../watcher/types";

const logger = new Logger("metrics", loadConfig().logging.level);

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface TokenMetrics {
  mint: string;
  fetchedAt: string;

  /** null when we could not determine it (e.g. no known pool/vault). */
  liquiditySol: number | null;

  /** % of circulating supply held by the single largest non-pool holder. */
  topHolderPercent: number | null;

  /** % of circulating supply held by the wallet that created the token. */
  devWalletPercent: number | null;

  mintAuthorityRenounced: boolean;
  freezeAuthorityRenounced: boolean;

  uniqueWallets: number | null;
  transactionCount: number | null;

  /** Any partial failures, so the filter engine can decide how to treat them. */
  warnings: string[];
}

/** Mint authority / freeze authority state - this is what "renounced" means for an SPL token. */
export async function getRenounceStatus(connection: Connection, mint: PublicKey) {
  const info = await getMint(connection, mint);
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

/** Pump.fun pre-migration liquidity: the bonding curve PDA's native SOL balance. */
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
 * treat a missing metric (see Part 4).
 */
export async function collectTokenMetrics(
  connection: Connection,
  event: NewPoolEvent
): Promise<TokenMetrics> {
  const config = loadConfig();
  const warnings: string[] = [];
  const mint = new PublicKey(event.mint);

  let mintAuthorityRenounced = false;
  let freezeAuthorityRenounced = false;
  let supplyRaw = 0n;
  try {
    const renounce = await getRenounceStatus(connection, mint);
    mintAuthorityRenounced = renounce.mintAuthorityRenounced;
    freezeAuthorityRenounced = renounce.freezeAuthorityRenounced;
    supplyRaw = renounce.supplyRaw;
  } catch (err: any) {
    warnings.push(`renounce status: ${err?.message || err}`);
  }

  let liquiditySol: number | null = null;
  try {
    if (event.source === "pumpfun" && event.poolAddress) {
      liquiditySol = await getPumpFunLiquiditySol(connection, new PublicKey(event.poolAddress));
    } else if (event.source === "raydium") {
      if (!event.raydiumPcMint) {
        warnings.push("no pcMint captured - cannot determine which vault is the SOL side");
      } else {
        liquiditySol = await getRaydiumLiquiditySol(
          connection,
          event.mint,
          event.raydiumPcMint,
          event.raydiumCoinVault ? new PublicKey(event.raydiumCoinVault) : undefined,
          event.raydiumPcVault ? new PublicKey(event.raydiumPcVault) : undefined
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
    topHolderPercent = await getTopHolderPercent(connection, mint, supplyRaw, exclude);
  } catch (err: any) {
    warnings.push(`topHolderPercent: ${err?.message || err}`);
  }

  let devWalletPercent: number | null = null;
  try {
    if (event.creator) {
      devWalletPercent = await getWalletMintPercent(connection, mint, new PublicKey(event.creator), supplyRaw);
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
    const activity = await getWalletActivity(connection, activityAddress, config.polling.walletActivitySampleSize);
    uniqueWallets = activity.uniqueWallets;
    transactionCount = activity.transactionCount;
  } catch (err: any) {
    warnings.push(`walletActivity: ${err?.message || err}`);
  }

  if (warnings.length > 0) {
    logger.warn(`Partial metrics for ${event.mint}: ${warnings.join("; ")}`);
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
    warnings,
  };
}
