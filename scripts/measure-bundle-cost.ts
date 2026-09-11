/**
 * npm run measure:bundle -- [--n 5]
 *
 * Runs bundle detection LIVE on the most recent Pump.fun launches in
 * logs/decisions.jsonl and prints buyers, transactions and credits spent per
 * token. This is the one live call the check gets before it is trusted, and
 * the measurement the brief asked for.
 *
 * Uses a plain Connection (not getConnection()) so the RPC meter does not
 * record this script as a bot process. Costs roughly (2 + launch-slot txs)
 * credits per token. Read-only.
 */
import fs from "fs";
import dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";
import { detectBundle } from "../src/data/rugChecks";
import { NewPoolEvent } from "../src/watcher/types";

dotenv.config();

async function main(): Promise<void> {
  const url = process.env.RPC_URL;
  if (!url) { console.error("RPC_URL is not set - cannot measure live"); process.exit(1); }
  const nArg = process.argv.indexOf("--n");
  const n = nArg !== -1 ? Number(process.argv[nArg + 1]) : 5;
  const lines = fs.readFileSync("logs/decisions.jsonl", "utf-8").split("\n").filter((l) => l.trim());
  const recent: { mint: string; signature: string; ts: string }[] = [];
  for (let i = lines.length - 1; i >= 0 && recent.length < n; i--) {
    try { const d = JSON.parse(lines[i]); if (d.source === "pumpfun" && d.mint && d.signature && !recent.some((r) => r.mint === d.mint)) recent.push({ mint: d.mint, signature: d.signature, ts: d.ts }); } catch { /* skip */ }
  }
  const connection = new Connection(url, "confirmed");
  console.log(`Bundle detection, live, on ${recent.length} recent Pump.fun launches\n`);
  console.log(`  ${"mint".padEnd(46)} ${"slot".padStart(10)} ${"launch txs".padStart(10)} ${"buyers".padStart(7)} ${"credits".padStart(8)}  note`);
  let total = 0;
  for (const r of recent) {
    // The create transaction gives the launch slot and the creator (fee payer). 1 credit.
    let slot = 0, creator: string | undefined, poolAddress: string | undefined;
    try {
      const tx = await connection.getParsedTransaction(r.signature, { maxSupportedTransactionVersion: 0 });
      slot = tx?.slot ?? 0;
      creator = tx?.transaction.message.accountKeys?.[0]?.pubkey?.toBase58();
      // Bonding curve = account index 2 of the create instruction (pumpfunWatcher.ts); fall back to the mint address.
      const ix = tx?.transaction.message.instructions.find((i: any) => i.accounts && i.accounts.length >= 4) as any;
      poolAddress = ix?.accounts?.[2]?.toBase58?.() ?? r.mint;
    } catch (err: any) {
      console.log(`  ${r.mint.padEnd(46)} create tx unreadable: ${err?.message ?? err}`); continue;
    }
    const event: NewPoolEvent = { source: "pumpfun", signature: r.signature, slot, mint: r.mint, poolAddress, creator, detectedAt: r.ts };
    const res = await detectBundle(connection, event);
    const credits = res.creditsSpent + 1;
    total += credits;
    console.log(`  ${r.mint.padEnd(46)} ${String(slot).padStart(10)} ${String(res.launchSlotTxs ?? "-").padStart(10)} ${String(res.launchSlotBuyers ?? "-").padStart(7)} ${String(credits).padStart(8)}  ${res.source}: ${res.note}`);
  }
  console.log(`\n  total credits spent: ${total} for ${recent.length} tokens (${recent.length ? (total / recent.length).toFixed(1) : "-"} per token, including the 1-credit create-tx read this script needs and the pipeline does not)`);
}
main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
