/**
 * The rug checks: LP burn status and launch-block bundle detection.
 *
 * ## What was already here, said plainly
 *
 * The brief listed four checks "OPIUMO checks none of". Two of them it did:
 * mint authority and freeze authority are read in `getRenounceStatus` and
 * enforced by `requireMintAuthorityRenounced` / `requireFreezeAuthorityRenounced`,
 * null-as-unknown, since the first filter commit. On 27,633 Pump.fun launches
 * every one came back renounced - Pump.fun renounces by construction - so
 * those two checks cost 11% of credits and have never fired (APPROVALS 28).
 * This module adds the two that were missing.
 *
 * ## LP burned or locked (check 3)
 *
 * Applies to Raydium pools only. A Pump.fun token before graduation has no LP
 * token - the bonding curve holds the SOL - so the status is
 * `not-applicable`, which is recorded as such and never as "safe". For a
 * Raydium pool the LP mint's supply is read: 0 means every LP token was
 * burned. A non-zero supply is `not-burned`; it MAY be sitting in a locker,
 * and this module does not recognise lockers, so it says `not-burned` and the
 * note says lockers are unchecked rather than claiming the LP is at risk.
 *
 * ## Bundle detection (check 4)
 *
 * A dev who buys with N wallets in the launch block makes holder
 * concentration look healthy when it isn't. Every transaction on the pool in
 * the LAUNCH SLOT other than the create itself is fetched, and its fee payer
 * counted. `launchSlotBuyers` is the number of distinct wallets (creator
 * excluded) that transacted in that slot. This COSTS credits - one
 * getSignaturesForAddress plus one getTransaction per launch-slot signature -
 * so it is gated behind the cheap checks exactly like the holder call, and
 * `bundleCreditsSpent` is recorded on every token so the cost is measured, not
 * assumed. `scripts/measure-bundle-cost.ts` runs it live on recent launches.
 *
 * ## Unreadable is unchecked, never safe
 *
 * Every field here is `null` when it could not be read, with the reason in
 * `note`. A null never satisfies a filter.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { NewPoolEvent } from "../watcher/types";

export type LpBurnStatus = "burned" | "not-burned" | "not-applicable" | "unknown";

export interface LpStatus {
  status: LpBurnStatus;
  /** True only when the LP mint's supply is zero. Null when unknown or not applicable. */
  lpBurned: boolean | null;
  lpSupplyRaw: string | null;
  note: string;
}

/** Pure: decides the status from what was read. */
export function lpStatusFromSupply(source: NewPoolEvent["source"], lpSupplyRaw: bigint | null, readError: string | null): LpStatus {
  if (source !== "raydium") {
    return { status: "not-applicable", lpBurned: null, lpSupplyRaw: null, note: "Pump.fun bonding curve has no LP token before graduation - LP burn does not apply; recorded as not-applicable, not as safe" };
  }
  if (readError !== null || lpSupplyRaw === null) {
    return { status: "unknown", lpBurned: null, lpSupplyRaw: null, note: `LP mint supply could not be read${readError ? `: ${readError}` : ""} - unchecked, not safe` };
  }
  if (lpSupplyRaw === 0n) return { status: "burned", lpBurned: true, lpSupplyRaw: "0", note: "LP mint supply is zero - every LP token was burned" };
  return { status: "not-burned", lpBurned: false, lpSupplyRaw: lpSupplyRaw.toString(), note: "LP tokens still exist; they may be in a locker, which this check does not recognise - treat as unverified, not as pulled" };
}

export async function readLpStatus(
  connection: Connection,
  event: NewPoolEvent,
  readSupply: (lpMint: PublicKey) => Promise<bigint> = async (lpMint) => {
    const { getRenounceStatus } = await import("./tokenMetrics");
    return (await getRenounceStatus(connection, lpMint)).supplyRaw;
  }
): Promise<LpStatus & { creditsSpent: number }> {
  if (event.source !== "raydium") return { ...lpStatusFromSupply(event.source, null, null), creditsSpent: 0 };
  if (!event.raydiumLpMint) return { ...lpStatusFromSupply("raydium", null, "no LP mint captured from the initialize2 transaction"), creditsSpent: 0 };
  try {
    const supply = await readSupply(new PublicKey(event.raydiumLpMint));
    return { ...lpStatusFromSupply("raydium", supply, null), creditsSpent: 1 };
  } catch (err: any) {
    return { ...lpStatusFromSupply("raydium", null, err?.message || String(err)), creditsSpent: 1 };
  }
}

// ---- bundle detection -----------------------------------------------------------

export interface SignatureInfo { signature: string; slot: number }
export interface ParsedTxLite { signature: string; feePayer: string | null; err: unknown }

export interface BundleResult {
  /** Distinct fee payers, creator excluded, that transacted on the pool in the launch slot. Null when unknown. */
  launchSlotBuyers: number | null;
  /** Transactions on the pool in the launch slot other than the create. Null when unknown. */
  launchSlotTxs: number | null;
  /** True when the signature window did not reach back to the launch slot - the count would be a floor, so it is not given. */
  windowExceeded: boolean;
  source: "fetched" | "unknown" | "not-fetched";
  creditsSpent: number;
  note: string;
}

export const DEFAULT_MAX_LAUNCH_SLOT_SIGNATURES = 25;

/** Pure: which signatures belong to the launch slot, minus the create itself. */
export function launchSlotSignatures(sigs: SignatureInfo[], launchSlot: number, createSignature: string): { inSlot: SignatureInfo[]; windowExceeded: boolean } {
  const inSlot = sigs.filter((s) => s.slot === launchSlot && s.signature !== createSignature);
  // getSignaturesForAddress returns newest first. If the OLDEST returned is still
  // newer than the launch slot, the launch slot lies beyond the window.
  const oldest = sigs.reduce<number | null>((m, s) => (m === null || s.slot < m ? s.slot : m), null);
  const windowExceeded = sigs.length > 0 && oldest !== null && oldest > launchSlot;
  return { inSlot, windowExceeded };
}

/** Pure: count distinct fee payers, excluding the creator and failed transactions. */
export function countBuyers(txs: ParsedTxLite[], creator: string | undefined): number {
  const wallets = new Set<string>();
  for (const t of txs) {
    if (t.err) continue;
    if (!t.feePayer) continue;
    if (creator && t.feePayer === creator) continue;
    wallets.add(t.feePayer);
  }
  return wallets.size;
}

export async function detectBundle(
  connection: Connection,
  event: NewPoolEvent,
  opts: { maxSignatures?: number } = {},
  io: {
    signatures?: (address: PublicKey, limit: number) => Promise<SignatureInfo[]>;
    transactions?: (signatures: string[]) => Promise<ParsedTxLite[]>;
  } = {}
): Promise<BundleResult> {
  const max = opts.maxSignatures ?? DEFAULT_MAX_LAUNCH_SLOT_SIGNATURES;
  const address = event.poolAddress ?? event.mint;
  if (!address) return { launchSlotBuyers: null, launchSlotTxs: null, windowExceeded: false, source: "unknown", creditsSpent: 0, note: "no pool or mint address on the event" };
  if (!(event.slot > 0)) return { launchSlotBuyers: null, launchSlotTxs: null, windowExceeded: false, source: "unknown", creditsSpent: 0, note: "launch slot unknown on the event" };
  const getSigs = io.signatures ?? (async (a, limit) => (await connection.getSignaturesForAddress(a, { limit })).map((s) => ({ signature: s.signature, slot: s.slot })));
  const getTxs = io.transactions ?? (async (sigs) => {
    const txs = await connection.getParsedTransactions(sigs, { maxSupportedTransactionVersion: 0 });
    return txs.map((tx, i) => ({ signature: sigs[i], feePayer: tx?.transaction.message.accountKeys?.[0]?.pubkey?.toBase58() ?? null, err: tx?.meta?.err ?? (tx ? null : "not found") }));
  });
  let credits = 0;
  try {
    const sigs = await getSigs(new PublicKey(address), max);
    credits += 1;
    const { inSlot, windowExceeded } = launchSlotSignatures(sigs, event.slot, event.signature);
    if (windowExceeded) {
      return { launchSlotBuyers: null, launchSlotTxs: null, windowExceeded: true, source: "unknown", creditsSpent: credits, note: `the newest ${max} signatures do not reach back to slot ${event.slot} - a count would be a floor, so none is given` };
    }
    if (inSlot.length === 0) {
      return { launchSlotBuyers: 0, launchSlotTxs: 0, windowExceeded: false, source: "fetched", creditsSpent: credits, note: "no transaction other than the create in the launch slot" };
    }
    const txs = await getTxs(inSlot.map((s) => s.signature));
    credits += inSlot.length; // billed per transaction even when batched (measured: rpcCalls > httpRequests)
    const buyers = countBuyers(txs, event.creator);
    return { launchSlotBuyers: buyers, launchSlotTxs: inSlot.length, windowExceeded: false, source: "fetched", creditsSpent: credits, note: `${inSlot.length} launch-slot transaction(s) from ${buyers} wallet(s) other than the creator` };
  } catch (err: any) {
    return { launchSlotBuyers: null, launchSlotTxs: null, windowExceeded: false, source: "unknown", creditsSpent: credits, note: `bundle check failed: ${err?.message || String(err)} - unchecked, not safe` };
  }
}
