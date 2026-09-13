/**
 * npm run cost:depth -- [--launches 40] [--max-credits 60000] [--max-depth 1000]
 *
 * WHERE DOES THE PRE-LAUNCH FUNDING ACTUALLY SIT?
 *
 * The free-tier scanner has to cap how far back it reads a deployer's history,
 * because 43% of deployers have 1000+ prior transactions and each one is a
 * credit. I picked a cap of 50 by affordability. Nobody has ever checked
 * whether the funding the fingerprint looks for is INSIDE that window.
 *
 * That is the difference between "the free scanner is as good as a paid one"
 * and "the free scanner silently misses most of what it is looking for", and it
 * cannot be answered after the plan lapses: reading a deployer's full history
 * costs ~1000 credits, so this calibration is ~33/day on the free tier and
 * affordable exactly once, now.
 *
 * Measured once, deeply, it sets the cap on evidence instead of on my guess.
 *
 * Read-only. Places nothing, trades nothing. Hard credit ceiling for the WHOLE
 * run, checked before every call, so this cannot become the bill it is costing.
 */
import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { getConnection } from "../src/rpc/connection";

const PAGE = 1000;                       // the API's own maximum per call
export const CAPS = [10, 25, 50, 100, 200, 500, 1000] as const;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`--${name} needs a number`);
  return v;
}

export interface FundingEvent { destination: string; depth: number; lamports: number }

/**
 * Recall at each cap: of all the funding events found in the FULL history, what
 * fraction sits within the most recent K signatures.
 *
 * Returns null - never 0 - when there were no events to find. A launch whose
 * deployer never funded anyone is not evidence that a cap of 10 works; it is
 * no evidence at all, and averaging it in as 100% would be a lie about coverage.
 */
export function recallByCap(events: FundingEvent[], caps: readonly number[] = CAPS): Record<number, number | null> {
  const out: Record<number, number | null> = {};
  for (const k of caps) out[k] = events.length === 0 ? null : events.filter((e) => e.depth < k).length / events.length;
  return out;
}

/** Mean of the values that exist, with the count they came from. Absent is skipped, never counted as zero. */
export function meanKnown(values: (number | null)[]): { mean: number | null; n: number } {
  const known = values.filter((v): v is number => v !== null);
  return { mean: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null, n: known.length };
}


/**
 * THE MEAN ACROSS ALL DEPLOYERS IS MISLEADING, AND THIS IS WHY.
 *
 * The first run of this returned "28.3% recall at cap 50" and looked like proof
 * that the free tier cripples the scanner. It is not. Two populations are being
 * averaged that have nothing to do with each other:
 *
 *   - THROWAWAY deployers, with a handful of prior transactions. This is the
 *     shape the insider fingerprint is actually looking for, and a cap of 50
 *     reads their ENTIRE history.
 *   - HIGH-VOLUME deployers, with 1000+ prior transactions and, in the measured
 *     sample, a median of 1044 SOL transfers each. A wallet sending a thousand
 *     transfers is an aggregator or a bot, not somebody quietly funding five
 *     fresh wallets before a launch. Capping it loses most of its history, and
 *     most of that history is noise.
 *
 * Averaging them puts the noise wallets' unreachable depth into the score for
 * the wallets we care about. Segmenting is not slicing until the answer is nice
 * - it is the difference between "the cap breaks the scanner" and "the cap is
 * irrelevant to the wallets the scanner is for", and those need different plans.
 */
export interface Segment { label: string; launches: number; medianEvents: number | null; meanRecallAt: Record<number, number | null> }

export function segment(
  perLaunch: { depthRead: number; events: number; recall: Record<number, number | null> }[],
  shallowMax = 50,
  caps: readonly number[] = CAPS,
): { shallow: Segment; deep: Segment } {
  const build = (label: string, rows: typeof perLaunch): Segment => {
    const ev = rows.map((r) => r.events).sort((a, b) => a - b);
    return {
      label, launches: rows.length,
      medianEvents: ev.length ? ev[Math.floor(ev.length / 2)] : null,
      meanRecallAt: Object.fromEntries(caps.map((k) => [k, meanKnown(rows.map((r) => r.recall[k])).mean])),
    };
  };
  return {
    shallow: build(`throwaway (<=${shallowMax} prior txs)`, perLaunch.filter((r) => r.depthRead <= shallowMax)),
    deep: build(`high-volume (>${shallowMax} prior txs)`, perLaunch.filter((r) => r.depthRead > shallowMax)),
  };
}

async function main() {
  const wantLaunches = arg("launches", 40);
  const maxCredits = arg("max-credits", 60_000);
  const maxDepth = arg("max-depth", 1000);
  const conn = getConnection("confirmed");

  let credits = 0;
  const spend = (n: number) => { if (credits + n > maxCredits) return false; credits += n; return true; };

  // Launches with a KNOWN deployer. An unknown deployer is not a zero-depth
  // deployer, so those rows are skipped and counted, not treated as easy cases.
  const rows: { mint: string; creator: string; signature: string }[] = [];
  let unknownCreator = 0;
  for (const line of fs.readFileSync(path.join("logs", "creators.jsonl"), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!r?.mint || !r?.signature) continue;
      if (!r.creator) { unknownCreator++; continue; }
      rows.push({ mint: r.mint, creator: r.creator, signature: r.signature });
    } catch { /* a bad line is skipped, not guessed at */ }
  }
  rows.reverse();                                    // newest first
  const picked = rows.slice(0, wantLaunches);

  console.log(`\n=== how deep is the pre-launch funding? ===\n`);
  console.log(`  launches with a known deployer  ${rows.length}   (skipped ${unknownCreator} with none recorded)`);
  console.log(`  tracing                         ${picked.length}`);
  console.log(`  hard ceiling                    ${maxCredits.toLocaleString()} credits for the whole run\n`);

  const perLaunch: { mint: string; deployer: string; depthRead: number; truncated: boolean; events: FundingEvent[]; recall: Record<number, number | null> }[] = [];

  for (const row of picked) {
    if (!spend(1)) { console.log(`  ceiling reached - stopping after ${perLaunch.length} launches`); break; }
    let sigs: string[] = [];
    let truncated = false;
    try {
      // Page backwards from the launch until maxDepth or the wallet's beginning.
      let before: string | undefined = row.signature;
      while (sigs.length < maxDepth) {
        const page: any[] = await conn.getSignaturesForAddress(new PublicKey(row.creator), { limit: Math.min(PAGE, maxDepth - sigs.length), before });
        if (page.length === 0) break;
        sigs.push(...page.map((p) => p.signature));
        before = page[page.length - 1].signature;
        if (page.length < PAGE) break;
        if (!spend(1)) { truncated = true; break; }
      }
      if (sigs.length >= maxDepth) truncated = true;
    } catch { continue; }

    const events: FundingEvent[] = [];
    let read = 0, stopped = false;
    for (let i = 0; i < sigs.length; i += 10) {
      const batch = sigs.slice(i, i + 10);
      if (!spend(batch.length)) { stopped = true; truncated = true; break; }
      try {
        const txs = await conn.getParsedTransactions(batch, { maxSupportedTransactionVersion: 0 });
        txs.forEach((tx, j) => {
          read++;
          for (const ix of (tx?.transaction?.message?.instructions ?? []) as any[]) {
            const info = ix?.parsed?.info;
            if (info?.destination && info?.lamports) events.push({ destination: String(info.destination), depth: i + j, lamports: Number(info.lamports) });
          }
        });
      } catch { /* a failed batch makes this launch's depth a floor; truncated says so */ }
    }

    perLaunch.push({ mint: row.mint, deployer: row.creator, depthRead: read, truncated: truncated || stopped, events, recall: recallByCap(events) });
    const deepest = events.length ? Math.max(...events.map((e) => e.depth)) : null;
    console.log(`  ${row.mint.slice(0, 10)}...  depth ${String(read).padStart(4)}${truncated ? "+" : " "}  funding events ${String(events.length).padStart(3)}  deepest ${deepest === null ? "none" : String(deepest).padStart(4)}   [${credits.toLocaleString()} credits]`);
  }

  // --- the answer ----------------------------------------------------------
  const withEvents = perLaunch.filter((p) => p.events.length > 0);
  console.log(`\n  ${perLaunch.length} launches traced, ${withEvents.length} had any deployer funding at all, ${perLaunch.filter((p) => p.truncated).length} hit a limit (their depth is a floor)`);
  console.log(`  ${credits.toLocaleString()} credits spent\n`);

  if (withEvents.length === 0) {
    console.log(`  NO FUNDING EVENTS FOUND in ${perLaunch.length} launches. That is a finding about the`);
    console.log(`  fingerprint, not about the cap - there is nothing here for any cap to miss.\n`);
  } else {
    console.log(`  RECALL BY CAP  (share of all funding events found within the most recent K signatures)`);
    console.log(`  n = ${withEvents.length} launches that had at least one event\n`);
    console.log(`     cap    mean recall   launches fully covered`);
    for (const k of CAPS) {
      const m = meanKnown(withEvents.map((p) => p.recall[k]));
      const full = withEvents.filter((p) => p.recall[k] === 1).length;
      console.log(`     ${String(k).padStart(4)}   ${m.mean === null ? "   unknown" : (100 * m.mean).toFixed(1).padStart(9) + "%"}   ${String(full).padStart(3)}/${withEvents.length}  (${(100 * full / withEvents.length).toFixed(0)}%)`);
    }
    const seg = segment(withEvents.map((p) => ({ depthRead: p.depthRead, events: p.events.length, recall: p.recall })));
    console.log(`\n  BUT THE MEAN ABOVE MIXES TWO POPULATIONS. Split by how much history the deployer has:\n`);
    for (const sgm of [seg.shallow, seg.deep]) {
      const r50 = sgm.meanRecallAt[50];
      console.log(`     ${sgm.label.padEnd(34)} ${String(sgm.launches).padStart(3)} launches, median ${String(sgm.medianEvents ?? "-").padStart(5)} events, recall@50 ${r50 === null ? "unknown" : (100 * r50).toFixed(1) + "%"}`);
    }
    console.log(`\n  The throwaway wallets are the shape the fingerprint targets. A wallet with a`);
    console.log(`  thousand transfers is an aggregator, and its unreachable depth is noise, not`);
    console.log(`  missed signal. Also note every one of the ${withEvents.length} deployers had SOME funding`);
    console.log(`  event, so "deployer funds other wallets" does not discriminate on its own.`);

    const at50 = meanKnown(withEvents.map((p) => p.recall[50]));
    console.log(`\n  At the cap the free tier affords (50): ${at50.mean === null ? "unknown" : (100 * at50.mean).toFixed(1) + "% of funding events"}, n = ${at50.n}.`);
  }

  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(path.join("reports", "depth-calibration.json"), JSON.stringify({
    at: new Date().toISOString(), tracedLaunches: perLaunch.length, launchesWithEvents: withEvents.length,
    truncated: perLaunch.filter((p) => p.truncated).length, creditsSpent: credits, maxDepth,
    recallByCap: Object.fromEntries(CAPS.map((k) => [k, meanKnown(withEvents.map((p) => p.recall[k]))])),
    segments: segment(withEvents.map((p) => ({ depthRead: p.depthRead, events: p.events.length, recall: p.recall }))),
    perLaunch: perLaunch.map((p) => ({ mint: p.mint, deployer: p.deployer, depthRead: p.depthRead, truncated: p.truncated, events: p.events.length, deepestEvent: p.events.length ? Math.max(...p.events.map((e) => e.depth)) : null, recall: p.recall })),
  }, null, 2));
  console.log(`  -> reports/depth-calibration.json\n`);
}

if (require.main === module) main();
