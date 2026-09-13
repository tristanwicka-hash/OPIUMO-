/**
 * npm run creators:backfill -- --scope paper [--max-calls 800] [--dry-run]
 *
 * Recovers the creator wallet for tokens we already have outcomes for, by
 * reading each launch transaction's fee payer - the same rule the live watcher
 * uses (pumpfunWatcher.extractPumpFunNewPool).
 *
 * ## This one SPENDS, so it is bounded and says so
 *
 * The creator was resolved at detection time and never written down, so it
 * cannot be recovered from the logs for free. It costs exactly **one
 * getTransaction per mint**. Nothing here runs without `--max-calls`, the cap
 * is enforced before each call, and the exact spend is printed and recorded.
 *
 *   --scope paper    the closed paper positions (the set every P&L report uses)
 *   --scope outcomes every mint in the outcome tracker - thousands of calls
 *   --dry-run        count what it WOULD cost and stop
 *
 * Already-known creators are skipped, so re-running is cheap and resumable.
 * Writes logs/creators.jsonl: one {mint, creator, at, source} per line.
 */
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../src/rpc/connection";
import { loadConfig } from "../src/config";
import { identifyKnownProgram } from "../src/watcher/programs";

const CREATORS_LOG = path.join("logs", "creators.jsonl");
const arg = (f: string) => { const i = process.argv.indexOf(f); return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined; };
const has = (f: string) => process.argv.includes(f);

interface Known { mint: string; creator: string | null; at: string; source: string }

function readKnown(): Map<string, Known> {
  const out = new Map<string, Known>();
  if (!fs.existsSync(CREATORS_LOG)) return out;
  for (const l of fs.readFileSync(CREATORS_LOG, "utf-8").split("\n")) {
    if (!l.trim()) continue;
    // A transient failure is NOT "known": retry it next run. A resolved creator,
    // or a fee payer that is genuinely a program, is settled and never re-fetched.
    try { const r = JSON.parse(l); if (r.mint && !String(r.source ?? "").startsWith("error:")) out.set(r.mint, r); } catch { /* partial line */ }
  }
  return out;
}

/** mint -> its launch signature and time, from the decision log (all rotations). */
function launchesFromDecisions(): Map<string, { signature: string; at: string }> {
  const out = new Map<string, { signature: string; at: string }>();
  const files = fs.readdirSync("logs").filter((f) => /^decisions.*\.jsonl$/.test(f)).sort();
  for (const f of files) {
    for (const l of fs.readFileSync(path.join("logs", f), "utf-8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l);
        if (r.mint && r.signature && r.source === "pumpfun" && !out.has(r.mint)) out.set(r.mint, { signature: r.signature, at: r.ts });
      } catch { /* partial line */ }
    }
  }
  return out;
}

function scopeMints(scope: string): Set<string> {
  const out = new Set<string>();
  if (scope === "paper") {
    for (const l of fs.readFileSync(path.join("logs", "paper-positions.jsonl"), "utf-8").split("\n")) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (r.event === "paper-close" && r.mint) out.add(r.mint); } catch { /* partial */ }
    }
  } else if (scope === "outcomes") {
    for (const l of fs.readFileSync(path.join("logs", "outcomes.jsonl"), "utf-8").split("\n")) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (r.mint) out.add(r.mint); } catch { /* partial */ }
    }
  } else throw new Error(`--scope must be "paper" or "outcomes", got "${scope}"`);
  return out;
}

async function main() {
  const scope = arg("--scope") ?? "paper";
  const maxCalls = Number(arg("--max-calls") ?? 0);
  const dryRun = has("--dry-run");

  const known = readKnown();
  const launches = launchesFromDecisions();
  const wanted = scopeMints(scope);
  const todo = [...wanted].filter((m) => !known.has(m) && launches.has(m));
  const noSignature = [...wanted].filter((m) => !launches.has(m));

  console.log(`scope "${scope}": ${wanted.size} mint(s) with outcomes`);
  console.log(`  already known:        ${wanted.size - todo.length - noSignature.length}`);
  console.log(`  no launch signature:  ${noSignature.length} (cannot be recovered at any price - the launch was never in a decision row)`);
  console.log(`  TO FETCH:             ${todo.length}  =  ${todo.length} getTransaction call(s), one per mint`);
  console.log(`  today's ledger before: ${JSON.parse(fs.readFileSync(loadConfig().creditBudget.ledgerFile, "utf-8")).day.credits.toLocaleString()} credits`);

  if (dryRun) { console.log("\nDRY RUN - nothing fetched."); return; }
  if (!maxCalls) { console.error("\nRefusing to spend without --max-calls. Re-run with an explicit cap."); process.exit(2); }
  if (todo.length > maxCalls) console.log(`\ncap: --max-calls ${maxCalls}, so ${todo.length - maxCalls} will be left for a later run (re-running is resumable)`);

  const connection = getConnection();
  fs.mkdirSync("logs", { recursive: true });
  let calls = 0, found = 0, unresolved = 0, failed = 0;
  const started = Date.now();

  for (const mint of todo) {
    if (calls >= maxCalls) break;
    const { signature, at } = launches.get(mint)!;
    calls++;
    let creator: string | null = null;
    let source = "fee-payer";
    try {
      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      // The fee payer is ALWAYS the first *static* account key. Reading it via
      // getAccountKeys() throws on a versioned transaction that uses address
      // lookup tables ("address table lookups were not resolved") - and most
      // Pump.fun launches are versioned. A lookup-table address can never be a
      // signer, so index 0 of staticAccountKeys is the fee payer by definition
      // and needs no resolution. 697 calls were wasted learning this.
      const msg: any = tx?.transaction?.message;
      const feePayer: string | undefined =
        msg?.staticAccountKeys?.[0]?.toBase58?.() ??
        msg?.accountKeys?.[0]?.pubkey?.toBase58?.() ??
        msg?.accountKeys?.[0]?.toBase58?.();
      if (!feePayer) { source = "no-transaction"; failed++; }
      else if (identifyKnownProgram(new PublicKey(feePayer).toBase58())) { source = "fee-payer-is-a-program"; unresolved++; }
      else { creator = feePayer; found++; }
    } catch (e: any) {
      source = `error: ${String(e?.message ?? e).slice(0, 80)}`;
      failed++;
    }
    fs.appendFileSync(CREATORS_LOG, JSON.stringify({ mint, creator, at, source, signature } as Known & { signature: string }) + "\n");
    if (calls % 50 === 0) console.log(`  ${calls}/${Math.min(todo.length, maxCalls)} ... ${found} resolved, ${unresolved} were programs, ${failed} failed`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\nspent ${calls} getTransaction call(s) in ${secs}s: ${found} creator(s) resolved, ${unresolved} fee payer was a program, ${failed} failed`);
  console.log(`written to ${CREATORS_LOG}`);
  console.log(`today's ledger after:  ${JSON.parse(fs.readFileSync(loadConfig().creditBudget.ledgerFile, "utf-8")).day.credits.toLocaleString()} credits`);
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
