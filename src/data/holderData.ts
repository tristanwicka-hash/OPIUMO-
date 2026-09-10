/**
 * Holder concentration: top-holder % and dev-wallet %, for tokens seconds old.
 *
 * ## The bug this fixes, diagnosed from evidence rather than assumption
 *
 * Both metrics were null on ~98% of tokens, which made the filters fail closed
 * and produced a 0% pass rate no threshold change could move.
 *
 * The stated cause was that `getTokenLargestAccounts` does not support
 * Token-2022. **That is not what is happening.** Measured 2026-09-10:
 *
 *   - The mints ARE Token-2022 (owner TokenzQdBNbLqP...), confirmed.
 *   - But `getTokenLargestAccounts` SUCCEEDS on those same Token-2022 mints
 *     once they are a minute or two old - 9 accounts returned. It supports
 *     Token-2022 fine.
 *   - It fails at DETECTION time. In the decision log, the metric succeeded
 *     where detection->decision latency was a median of 161,508ms and failed
 *     where it was 204ms - an 800x split.
 *   - `getAccountInfo` on the same mint succeeds 98% of the time at detection,
 *     so the mint account EXISTS. It is the largest-accounts INDEX that has
 *     not been built yet.
 *   - Raced head to head on 6 fresh mints at 30ms-2.5s old:
 *     getTokenLargestAccounts failed 6/6, DAS getTokenAccounts succeeded 6/6.
 *
 * So the fix is DAS - but because the index lags, NOT because of Token-2022.
 * The distinction matters: routing by token program would not have helped,
 * since a legacy mint at 200ms would hit the same unbuilt index. **Routing is
 * therefore by AGE, which is the thing that actually predicts failure.**
 *
 * ## Cost
 *
 * DAS costs 10 credits per call against 1 for standard JSON-RPC, confirmed on
 * Helius's own pricing page ("DAS calls are 10 credits"). So DAS is used ONLY
 * for tokens young enough that the cheap call would fail, and ONLY after every
 * cheap filter has already passed - see collectHolderData's callers. One DAS
 * call serves BOTH metrics, because the response carries `owner` and `amount`
 * per account, so this is 10 credits per surviving token rather than 20.
 */
import { Connection, PublicKey } from "@solana/web3.js";

/** Below this age the largest-accounts index is unlikely to exist yet. */
export const DEFAULT_DAS_AGE_THRESHOLD_MS = 120_000;

export interface HolderData {
  topHolderPercent: number | null;
  devWalletPercent: number | null;
  /** Which path produced this, so the cost is auditable from the logs. */
  source: "largest-accounts" | "das" | "none";
  /** Credits this cost: 1 for the standard call, 10 for DAS, 0 if skipped. */
  creditsSpent: number;
  error: string | null;
}

interface DasTokenAccount {
  address: string;
  owner: string;
  amount: number | string;
}

/**
 * One DAS `getTokenAccounts` call, which returns every token account for the
 * mint with its owner and amount - enough for both metrics.
 *
 * Issued through the Connection's own transport (`_rpcRequest`) rather than a
 * bare fetch, so the RPC meter counts it. A raw fetch would make this call
 * invisible to the very instrument measuring whether it is affordable. The
 * `as any` cast is the established pattern in this repo for reaching a
 * non-public method.
 */
export async function fetchHolderDataViaDas(
  connection: Connection,
  mint: PublicKey,
  supplyRaw: bigint,
  creator: PublicKey | null,
  excludeAddresses: Set<string>
): Promise<HolderData> {
  if (supplyRaw === 0n) {
    return { topHolderPercent: null, devWalletPercent: null, source: "none", creditsSpent: 0, error: "supply is zero" };
  }
  const res: any = await (connection as any)._rpcRequest("getTokenAccounts", {
    mint: mint.toBase58(),
    limit: 1000,
  });
  if (res?.error) {
    return {
      topHolderPercent: null, devWalletPercent: null, source: "das", creditsSpent: 10,
      error: `DAS getTokenAccounts failed: ${res.error.message ?? JSON.stringify(res.error)}`,
    };
  }
  const accounts: DasTokenAccount[] = res?.result?.token_accounts ?? [];

  let topRaw = 0n;
  let devRaw = 0n;
  const creatorKey = creator?.toBase58() ?? null;
  for (const a of accounts) {
    let amt: bigint;
    try {
      amt = BigInt(a.amount);
    } catch {
      continue;
    }
    // The pool / bonding curve legitimately holds most of the supply
    // pre-migration; counting it would make every token look concentrated.
    if (!excludeAddresses.has(a.address) && !excludeAddresses.has(a.owner)) {
      if (amt > topRaw) topRaw = amt;
    }
    if (creatorKey && a.owner === creatorKey) devRaw += amt;
  }

  const pct = (raw: bigint) => Number((raw * 10000n) / supplyRaw) / 100;
  return {
    topHolderPercent: pct(topRaw),
    // Null when there is no creator to attribute to - not 0, which would read
    // as "the creator holds nothing" rather than "we do not know who they are".
    devWalletPercent: creatorKey === null ? null : pct(devRaw),
    source: "das",
    creditsSpent: 10,
    error: null,
  };
}

/**
 * Age-routed holder fetch.
 *
 * Young tokens go straight to DAS: the cheap call is known to fail for them, so
 * trying it first would spend 1 credit to learn nothing and then 10 anyway.
 * Older tokens use the 1-credit path, with DAS as a fallback if the index still
 * is not there.
 */
export async function collectHolderData(
  connection: Connection,
  params: {
    mint: PublicKey;
    supplyRaw: bigint;
    creator: PublicKey | null;
    excludeAddresses: Set<string>;
    /** Milliseconds since the launch was detected. */
    tokenAgeMs: number;
    dasAgeThresholdMs?: number;
    /** Set false to forbid DAS entirely - the metric then reports null rather than costing 10. */
    allowDas?: boolean;
  }
): Promise<HolderData> {
  const threshold = params.dasAgeThresholdMs ?? DEFAULT_DAS_AGE_THRESHOLD_MS;
  const allowDas = params.allowDas !== false;

  // Young AND allowed to pay: DAS is the only thing that works this early.
  if (params.tokenAgeMs < threshold && allowDas) {
    return fetchHolderDataViaDas(connection, params.mint, params.supplyRaw, params.creator, params.excludeAddresses);
  }

  /**
   * Otherwise fall through to the 1-credit path - INCLUDING when the token is
   * young and DAS is off.
   *
   * Giving up without trying was a real bug, found on the first live run of
   * option (d): the watchlist re-evaluates at a median of 66s, below the 120s
   * threshold, so every re-evaluation returned "none" at 0 credits and produced
   * no data at all. The threshold is a guess about when the index appears; the
   * call itself is the actual test, and it costs 1 credit to ask. If the index
   * is not there yet it fails, which is reported as unchecked - no worse than
   * not asking, and it succeeds whenever the index has arrived.
   */

  // Old enough that the index should exist. Try the 1-credit path.
  try {
    const largest = await connection.getTokenLargestAccounts(params.mint);
    const candidates = largest.value.filter((a) => !params.excludeAddresses.has(a.address.toBase58()));
    const topRaw = candidates.length === 0 ? 0n : BigInt(candidates[0].amount);
    const top = params.supplyRaw === 0n ? null : Number((topRaw * 10000n) / params.supplyRaw) / 100;

    let dev: number | null = null;
    if (params.creator) {
      const owned = await connection.getParsedTokenAccountsByOwner(params.creator, { mint: params.mint });
      let raw = 0n;
      for (const { account } of owned.value) {
        const amount = account.data.parsed?.info?.tokenAmount?.amount;
        if (amount) raw += BigInt(amount);
      }
      dev = params.supplyRaw === 0n ? null : Number((raw * 10000n) / params.supplyRaw) / 100;
    }
    return { topHolderPercent: top, devWalletPercent: dev, source: "largest-accounts", creditsSpent: 2, error: null };
  } catch (err: any) {
    if (!allowDas) {
      return {
        topHolderPercent: null, devWalletPercent: null, source: "none", creditsSpent: 1,
        error: `largest-accounts failed (${err?.message ?? err}) and DAS is disabled`,
      };
    }
    const das = await fetchHolderDataViaDas(connection, params.mint, params.supplyRaw, params.creator, params.excludeAddresses);
    return { ...das, creditsSpent: das.creditsSpent + 1, error: das.error };
  }
}
