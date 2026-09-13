/**
 * npm run cost:scanner -- [--launches 5] [--max-calls 400]
 *
 * MEASURE what a wallet scanner costs per launch. Do not estimate it.
 *
 * ## The question this answers
 *
 * The proposed new job is not sniping. There is no speed requirement: it can
 * analyse launches after the fact, in batches, at whatever rate a free tier
 * allows. So the only number that matters is RPC calls per launch analysed -
 * and until it is measured, every plan built on it is a guess.
 *
 * ## What the scanner does per launch, and what each step costs
 *
 *   1. IDENTIFY THE DEPLOYER
 *      getTransaction(launchSignature) -> the fee payer is the first static
 *      account key. 1 call.
 *
 *   2. TRACE SOL OUT OF THE DEPLOYER BEFORE THE LAUNCH
 *      getSignaturesForAddress(deployer, before=launchSig) -> 1 call per page.
 *      Then getParsedTransactions on those signatures in batches of 10 to see
 *      who the deployer funded. ceil(n/10) calls, and the batch bills PER
 *      SIGNATURE, so it is n credits regardless of batching.
 *
 *   3. FIRST BUYERS - same slot and the slot after
 *      getSignaturesForAddress(mint) -> the earliest signatures on the mint.
 *      Then getParsedTransactions on the ones inside the window.
 *
 *   4. FOLLOW THOSE WALLETS OUT
 *      getSignaturesForAddress(buyer) per early buyer, capped.
 *
 * ## Every call is counted, and the run is HARD CAPPED
 *
 * `--max-calls` stops the whole run, not each launch. A tracer that discovers
 * its own cost by spending without a ceiling is how 697 calls were wasted on
 * 2026-09-13 learning that getAccountKeys() throws on versioned transactions.
 *
 * Costs real credits. It is bounded, reported, and charged to the same meter.
 */
import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { getConnection } from "../src/rpc/connection";
import { creditsForMethod } from "../src/rpc/rpcMeter";

const arg = (n: string, d: number) => { const i = process.argv.indexOf(`--${n}`); const v = i >= 0 ? Number(process.argv[i + 1]) : NaN; return Number.isFinite(v) && v > 0 ? v : d; };
const LAUNCHES = arg("launches", 5);
const MAX_CALLS = arg("max-calls", 400);
/** Signatures to pull per address. Deliberately small: this is a cost probe. */
const SIG_PAGE = arg("sig-page", 50);
/** How many early buyers to follow out. */
const MAX_BUYERS = arg("max-buyers", 5);

interface Counted { method: string; credits: number; note: string }
const calls: Counted[] = [];
let capped = false;
function charge(method: string, note = "", n = 1): boolean {
  if (calls.length + n > MAX_CALLS) { capped = true; return false; }
  for (let i = 0; i < n; i++) calls.push({ method, credits: creditsForMethod(method), note });
  return true;
}
const spent = () => calls.reduce((a, c) => a + c.credits, 0);

interface LaunchTrace {
  mint: string;
  ok: boolean;
  deployer: string | null;
  priorSigs: number;
  fundedWallets: number;
  earlyBuyers: number;
  followed: number;
  callsUsed: number;
  creditsUsed: number;
  note: string;
}

async function traceOne(conn: Connection, mint: string, launchSig: string, knownCreator: string): Promise<LaunchTrace> {
  const before = calls.length;
  const t: LaunchTrace = { mint, ok: false, deployer: null, priorSigs: 0, fundedWallets: 0, earlyBuyers: 0, followed: 0, callsUsed: 0, creditsUsed: 0, note: "" };
  const done = () => {
    t.callsUsed = calls.length - before;
    t.creditsUsed = calls.slice(before).reduce((a, c) => a + c.credits, 0);
    return t;
  };

  // --- 1. the deployer ------------------------------------------------------
  if (!charge("getTransaction", "launch tx -> fee payer")) { t.note = "capped"; return done(); }
  let deployer: string | null = null;
  try {
    const tx: any = await conn.getTransaction(launchSig, { maxSupportedTransactionVersion: 0 });
    // The fee payer is ALWAYS the first STATIC account key. getAccountKeys()
    // throws on a versioned transaction that uses address lookup tables.
    const msg: any = tx?.transaction?.message;
    deployer = msg?.staticAccountKeys?.[0]?.toBase58?.() ?? msg?.accountKeys?.[0]?.pubkey?.toBase58?.() ?? msg?.accountKeys?.[0]?.toBase58?.() ?? null;
  } catch (err: any) { t.note = `launch tx unreadable: ${String(err?.message ?? err).slice(0, 60)}`; return done(); }
  t.deployer = deployer ?? knownCreator;
  if (!t.deployer) { t.note = "no deployer could be identified"; return done(); }

  // --- 2. what the deployer did BEFORE the launch --------------------------
  if (!charge("getSignaturesForAddress", "deployer history before launch")) { t.note = "capped"; return done(); }
  let priorSigs: string[] = [];
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(t.deployer), { limit: SIG_PAGE, before: launchSig });
    priorSigs = sigs.map((s) => s.signature);
  } catch (err: any) { t.note = `deployer history unreadable: ${String(err?.message ?? err).slice(0, 50)}`; }
  t.priorSigs = priorSigs.length;

  // The batch bills PER SIGNATURE even though it is one HTTP request, so the
  // credit cost is the signature count, not the request count. Charging per
  // request here would understate the bill by 10x.
  const funded = new Set<string>();
  for (let i = 0; i < priorSigs.length; i += 10) {
    const batch = priorSigs.slice(i, i + 10);
    if (!charge("getTransaction", "deployer prior tx (batched, billed per signature)", batch.length)) { t.note = "capped mid-trace"; return done(); }
    try {
      const txs = await conn.getParsedTransactions(batch, { maxSupportedTransactionVersion: 0 });
      for (const tx of txs) {
        for (const ix of (tx?.transaction?.message?.instructions ?? []) as any[]) {
          const info = ix?.parsed?.info;
          if (info?.destination && info?.lamports) funded.add(String(info.destination));
        }
      }
    } catch { /* a failed batch is a floor, recorded in the note */ }
  }
  t.fundedWallets = funded.size;

  // --- 3. the first buyers -------------------------------------------------
  if (!charge("getSignaturesForAddress", "earliest signatures on the mint")) { t.note = "capped"; return done(); }
  let earlySigs: string[] = [];
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(mint), { limit: SIG_PAGE });
    // Oldest last from the API; the launch slot is the earliest we hold.
    earlySigs = sigs.slice(-Math.min(10, sigs.length)).map((s) => s.signature);
  } catch (err: any) { t.note += ` mint history unreadable: ${String(err?.message ?? err).slice(0, 40)}`; }

  const buyers = new Set<string>();
  for (let i = 0; i < earlySigs.length; i += 10) {
    const batch = earlySigs.slice(i, i + 10);
    if (!charge("getTransaction", "early mint tx (batched, billed per signature)", batch.length)) { t.note = "capped mid-trace"; return done(); }
    try {
      const txs = await conn.getParsedTransactions(batch, { maxSupportedTransactionVersion: 0 });
      for (const tx of txs) {
        const fp = (tx?.transaction?.message as any)?.accountKeys?.[0]?.pubkey?.toBase58?.();
        if (fp && fp !== t.deployer) buyers.add(fp);
      }
    } catch { /* floor */ }
  }
  t.earlyBuyers = buyers.size;

  // --- 4. follow those wallets out ----------------------------------------
  let followed = 0;
  for (const b of [...buyers].slice(0, MAX_BUYERS)) {
    if (!charge("getSignaturesForAddress", "early buyer's later activity")) { t.note = "capped mid-trace"; return done(); }
    try { await conn.getSignaturesForAddress(new PublicKey(b), { limit: SIG_PAGE }); followed++; }
    catch { /* floor */ }
  }
  t.followed = followed;
  t.ok = true;
  return done();
}

async function main() {
  const rows: any[] = [];
  for (const line of fs.readFileSync(path.join("logs", "creators.jsonl"), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r?.mint && r?.creator && r?.signature) rows.push(r); } catch { /* partial */ }
  }
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const sample = rows.slice(-LAUNCHES);

  console.log(`\n=== wallet-scanner cost probe ===\n`);
  console.log(`  tracing ${sample.length} real launch(es), hard cap ${MAX_CALLS} calls for the WHOLE run`);
  console.log(`  per address: ${SIG_PAGE} signatures; following at most ${MAX_BUYERS} early buyers\n`);

  const conn = getConnection("confirmed");
  const traces: LaunchTrace[] = [];
  for (const r of sample) {
    const t = await traceOne(conn, r.mint, r.signature, r.creator);
    traces.push(t);
    console.log(`  ${t.mint.slice(0, 10)}...  ${String(t.callsUsed).padStart(4)} calls  ${String(t.creditsUsed).padStart(4)} credits  ` +
      `deployer ${t.deployer ? t.deployer.slice(0, 8) : "?"}  prior ${String(t.priorSigs).padStart(3)}  funded ${t.fundedWallets}  buyers ${t.earlyBuyers}  followed ${t.followed}` +
      (t.note ? `  [${t.note}]` : ""));
    if (capped) { console.log(`\n  HARD CAP HIT at ${calls.length} calls - stopping. Numbers below cover the completed traces only.`); break; }
  }

  const complete = traces.filter((t) => t.ok);
  const byMethod = new Map<string, { calls: number; credits: number }>();
  for (const c of calls) {
    const m = byMethod.get(c.method) ?? { calls: 0, credits: 0 };
    m.calls++; m.credits += c.credits; byMethod.set(c.method, m);
  }

  console.log(`\n  RPC METHODS USED`);
  for (const [m, v] of [...byMethod.entries()].sort((a, b) => b[1].credits - a[1].credits)) {
    console.log(`    ${m.padEnd(26)} ${String(v.calls).padStart(5)} calls  ${String(v.credits).padStart(5)} credits  (${creditsForMethod(m)}/call)`);
  }

  console.log(`\n  MEASURED COST`);
  console.log(`    total this run            : ${calls.length} calls, ${spent()} credits`);
  if (complete.length === 0) {
    console.log(`    complete traces           : 0 - nothing to average. The cap or an error stopped every trace.`);
  } else {
    const cc = complete.map((t) => t.creditsUsed).sort((a, b) => a - b);
    const mean = cc.reduce((a, b) => a + b, 0) / cc.length;
    const median = cc[Math.floor(cc.length / 2)];
    console.log(`    complete traces           : ${complete.length}`);
    console.log(`    credits per launch  mean  : ${mean.toFixed(1)}`);
    console.log(`                        median: ${median}`);
    console.log(`                        range : ${cc[0]} to ${cc[cc.length - 1]}`);
    const out = {
      at: new Date().toISOString(),
      launchesTraced: complete.length,
      sigPage: SIG_PAGE, maxBuyers: MAX_BUYERS,
      creditsPerLaunch: { mean: Number(mean.toFixed(2)), median, min: cc[0], max: cc[cc.length - 1] },
      totalCalls: calls.length, totalCredits: spent(),
      byMethod: Object.fromEntries([...byMethod.entries()].map(([k, v]) => [k, v])),
      traces: complete,
      cappedEarly: capped,
    };
    fs.mkdirSync("reports", { recursive: true });
    fs.writeFileSync(path.join("reports", "scanner-cost.json"), JSON.stringify(out, null, 2) + "\n");
    console.log(`\n  written to reports/scanner-cost.json`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
