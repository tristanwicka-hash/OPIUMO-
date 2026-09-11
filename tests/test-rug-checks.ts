// top-level await via an async main wrapper below
/**
 * Rug checks 3 and 4. Offline: every RPC call is injected.
 *
 * Load-bearing: unreadable is unknown, never safe; Pump.fun is not-applicable,
 * never burned; a signature window that misses the launch slot gives NO count
 * rather than a floor; the creator's own wallet is not a "buyer"; credits are
 * counted per transaction fetched.
 */
import { PublicKey } from "@solana/web3.js";
import { lpStatusFromSupply, readLpStatus, launchSlotSignatures, countBuyers, detectBundle, DEFAULT_MAX_LAUNCH_SLOT_SIGNATURES } from "../src/data/rugChecks";
import { NewPoolEvent } from "../src/watcher/types";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS: ${name}`); } else { fail++; console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
const section = (t: string) => console.log(`\n=== ${t} ===\n`);
const fakeConn = {} as any;
const CREATOR = "11111111111111111111111111111112"; // a valid base58 key - PublicKey() throws on anything else
const ev = (o: Partial<NewPoolEvent> = {}): NewPoolEvent => ({
  source: "pumpfun", signature: "createSig", slot: 1000, mint: "So11111111111111111111111111111111111111112",
  poolAddress: "So11111111111111111111111111111111111111112", creator: CREATOR, detectedAt: "2026-09-11T00:00:00.000Z", ...o,
});

(async () => {
section("LP burn status");
{
  const pf = lpStatusFromSupply("pumpfun", null, null);
  check("Pump.fun -> not-applicable, lpBurned null (not true)", pf.status === "not-applicable" && pf.lpBurned === null && /not as safe/.test(pf.note));
  check("Raydium, supply 0 -> burned", lpStatusFromSupply("raydium", 0n, null).status === "burned" && lpStatusFromSupply("raydium", 0n, null).lpBurned === true);
  const nb = lpStatusFromSupply("raydium", 12345n, null);
  check("Raydium, supply > 0 -> not-burned, with the locker caveat", nb.status === "not-burned" && nb.lpBurned === false && /locker/.test(nb.note) && nb.lpSupplyRaw === "12345");
  const un = lpStatusFromSupply("raydium", null, "rpc timeout");
  check("read error -> unknown, lpBurned null, reason kept", un.status === "unknown" && un.lpBurned === null && /rpc timeout/.test(un.note));
  check("Raydium with null supply and no error is still unknown", lpStatusFromSupply("raydium", null, null).status === "unknown");
}

section("readLpStatus: credits and failure paths");
{
  const r1 = await readLpStatus(fakeConn, ev(), async () => 0n);
  check("Pump.fun costs 0 credits and does not call the reader", r1.creditsSpent === 0 && r1.status === "not-applicable");
  const r2 = await readLpStatus(fakeConn, ev({ source: "raydium", raydiumLpMint: undefined }), async () => 0n);
  check("Raydium without a captured LP mint -> unknown, 0 credits", r2.status === "unknown" && r2.creditsSpent === 0 && /no LP mint captured/.test(r2.note));
  const r3 = await readLpStatus(fakeConn, ev({ source: "raydium", raydiumLpMint: CREATOR }), async () => 0n);
  check("Raydium burned -> 1 credit", r3.status === "burned" && r3.creditsSpent === 1);
  const r4 = await readLpStatus(fakeConn, ev({ source: "raydium", raydiumLpMint: CREATOR }), async () => { throw new Error("boom"); });
  check("Raydium read failure -> unknown, the credit was still spent", r4.status === "unknown" && r4.creditsSpent === 1 && /boom/.test(r4.note));
}

section("launch-slot signatures");
{
  const sigs = [{ signature: "s3", slot: 1002 }, { signature: "s2", slot: 1000 }, { signature: "createSig", slot: 1000 }, { signature: "s1", slot: 1000 }];
  const r = launchSlotSignatures(sigs, 1000, "createSig");
  check("keeps launch-slot signatures and drops the create itself", r.inSlot.map((s) => s.signature).join(",") === "s2,s1" && !r.windowExceeded);
  const late = launchSlotSignatures([{ signature: "x", slot: 1005 }, { signature: "y", slot: 1003 }], 1000, "createSig");
  check("a window whose oldest signature is newer than the launch slot is EXCEEDED", late.windowExceeded && late.inSlot.length === 0);
  check("an empty window is not exceeded (nothing happened)", !launchSlotSignatures([], 1000, "c").windowExceeded);
}

section("counting buyers");
{
  const txs = [
    { signature: "a", feePayer: "W1", err: null }, { signature: "b", feePayer: "W1", err: null },
    { signature: "c", feePayer: "W2", err: null }, { signature: "d", feePayer: CREATOR, err: null },
    { signature: "e", feePayer: "W3", err: { InstructionError: [0, "Custom"] } }, { signature: "f", feePayer: null, err: null },
  ];
  check("distinct wallets, creator excluded, failed and unreadable txs excluded -> 2", countBuyers(txs, CREATOR) === 2);
  check("without a known creator the creator's wallet counts", countBuyers(txs, undefined) === 3);
}

section("detectBundle end to end with injected RPC");
{
  const io = (sigs: { signature: string; slot: number }[], txs: Record<string, string | null>) => ({
    signatures: async () => sigs,
    transactions: async (s: string[]) => s.map((sig) => ({ signature: sig, feePayer: txs[sig] ?? null, err: null })),
  });
  const bundled = await detectBundle(fakeConn, ev(), {}, io(
    [{ signature: "b3", slot: 1000 }, { signature: "b2", slot: 1000 }, { signature: "b1", slot: 1000 }, { signature: "createSig", slot: 1000 }],
    { b1: "W1", b2: "W2", b3: "W3" }
  ));
  check("three launch-slot buys from three wallets -> 3 buyers, 3 txs", bundled.launchSlotBuyers === 3 && bundled.launchSlotTxs === 3 && bundled.source === "fetched");
  check("credits = 1 signatures call + 1 per transaction fetched = 4", bundled.creditsSpent === 4, String(bundled.creditsSpent));
  const clean = await detectBundle(fakeConn, ev(), {}, io([{ signature: "later", slot: 1001 }, { signature: "createSig", slot: 1000 }], {}));
  check("nothing else in the launch slot -> 0 buyers, 1 credit", clean.launchSlotBuyers === 0 && clean.launchSlotTxs === 0 && clean.creditsSpent === 1);
  const exceeded = await detectBundle(fakeConn, ev(), { maxSignatures: 2 }, io([{ signature: "n2", slot: 1010 }, { signature: "n1", slot: 1009 }], {}));
  check("window exceeded -> buyers NULL (not a floor), unknown, 1 credit", exceeded.launchSlotBuyers === null && exceeded.windowExceeded && exceeded.source === "unknown" && exceeded.creditsSpent === 1);
  const failed = await detectBundle(fakeConn, ev(), {}, { signatures: async () => { throw new Error("429"); } });
  check("RPC failure -> unknown, null, says not safe", failed.launchSlotBuyers === null && failed.source === "unknown" && /not safe/.test(failed.note));
  const noSlot = await detectBundle(fakeConn, ev({ slot: 0 }), {}, io([], {}));
  check("no launch slot -> unknown without spending", noSlot.source === "unknown" && noSlot.creditsSpent === 0);
  const noAddr = await detectBundle(fakeConn, ev({ poolAddress: undefined, mint: "" }), {}, io([], {}));
  check("no address -> unknown without spending", noAddr.source === "unknown" && noAddr.creditsSpent === 0);
  check("the default window is 25 signatures", DEFAULT_MAX_LAUNCH_SLOT_SIGNATURES === 25);
  const creatorOnly = await detectBundle(fakeConn, ev(), {}, io([{ signature: "c1", slot: 1000 }, { signature: "createSig", slot: 1000 }], { c1: CREATOR }));
  check("the creator's own launch-slot buy is 1 tx but 0 buyers", creatorOnly.launchSlotTxs === 1 && creatorOnly.launchSlotBuyers === 0);
  void PublicKey;
}

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
