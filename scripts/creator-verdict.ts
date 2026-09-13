/**
 * npm run report:creator-verdict
 *
 * The last untested entry signal, answered.
 *
 * Structure is deliberate and the order matters: SHAPE first, because if
 * creator wallets do not repeat there is no signal to find however cleverly it
 * is measured; then the CEILING, because an upper bound is worth more than
 * another variation; and only then the filter itself.
 *
 * Reads local files only. No RPC, no network. Writes reports/.
 */
import fs from "fs";
import path from "path";
import { LaunchRecord, describeShape, oracleCeiling, liveCost, summariseGroup, priorStats, MIN_PER_GROUP } from "../src/analysis/creatorReputation";

const L: string[] = [];
const say = (s = "") => { L.push(s); console.log(s); };

function readJsonl(file: string): any[] {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf-8"); } catch { return []; }
  const out: any[] = [];
  for (const line of raw.split("\n")) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* partial */ } }
  return out;
}

function main() {
  // --- attribution, entirely from disk -------------------------------------
  const creators = new Map<string, string>();
  for (const r of readJsonl(path.join("logs", "creators.jsonl"))) {
    if (r?.mint && r?.creator) creators.set(r.mint, r.creator);
  }
  const closedAll = readJsonl(path.join("logs", "paper-positions.jsonl")).filter(
    (r) => r?.outcome === "closed" && typeof r.entryProceedsSol === "number" && typeof r.exitProceedsSol === "number"
  );
  const attributed = closedAll
    .filter((r) => creators.has(r.mint))
    .map((r) => ({
      mint: r.mint as string,
      creator: creators.get(r.mint) as string,
      at: (r.openedAt ?? r.ts) as string,
      pnl: r.exitProceedsSol - r.entryProceedsSol,
      fate: (r.exitProceedsSol >= r.entryProceedsSol * 2 ? "ran" : r.exitProceedsSol <= r.entryProceedsSol * 0.25 ? "drained" : "flat") as LaunchRecord["fate"],
    }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  say("```");
  say("Creator wallet reputation: the last untested entry signal");
  say("=".repeat(90));
  say();
  say("ATTRIBUTION - from files already on disk, no RPC call was made by this report");
  say(`  ${closedAll.length} closed, valued paper positions.`);
  say(`  ${attributed.length} have a known creator (${((100 * attributed.length) / closedAll.length).toFixed(1)}%); ${closedAll.length - attributed.length} are not yet backfilled.`);
  say(`  Unattributed positions are EXCLUDED, not assumed. They are the newest ones.`);
  say();

  // --- 1. SHAPE, before any conclusion -------------------------------------
  const shape = describeShape(attributed as any);
  say("1. THE SHAPE OF THE DATA - reported before any conclusion is drawn from it");
  say(`  distinct creator wallets            : ${shape.distinctCreators}`);
  say(`  launches attributed                 : ${shape.launches}`);
  say(`  wallets with exactly ONE launch     : ${shape.oneOff}  (${((100 * shape.oneOff) / shape.distinctCreators).toFixed(1)}%)`);
  say(`  wallets with exactly two            : ${shape.twice}`);
  say(`  wallets with three or more          : ${shape.threeOrMore}`);
  say(`  most launches by a single wallet    : ${shape.maxLaunchesByOneCreator}`);
  say();
  say("  THE GATING NUMBER. A creator filter can only act on a launch whose creator");
  say("  it has seen BEFORE. For a wallet with k launches only k-1 qualify - the");
  say("  first one never does. Counting all k credits the filter with trades it");
  say("  could not have seen.");
  say(`  launches WITH prior history at the moment they opened : ${shape.launchesWithPriorAtTheTime} (${(shape.filterVisibleShare * 100).toFixed(1)}%)`);
  say(`  launches with NO prior history                        : ${shape.launchesWithNoPrior} (${((1 - shape.filterVisibleShare) * 100).toFixed(1)}%)`);
  say();
  say(`  ${shape.verdict}`);
  say();

  // Where the winners are - the part that decides whether the ceiling matters.
  const seen = new Map<string, number>();
  const visible: typeof attributed = [], blind: typeof attributed = [];
  for (const r of attributed) {
    ((seen.get(r.creator) ?? 0) > 0 ? visible : blind).push(r);
    seen.set(r.creator, (seen.get(r.creator) ?? 0) + 1);
  }
  const wins = attributed.filter((r) => r.pnl > 0);
  const winsVisible = visible.filter((r) => r.pnl > 0);
  say("  WHERE THE WINNERS ARE");
  say(`  winners overall                     : ${wins.length} of ${attributed.length} (${((100 * wins.length) / attributed.length).toFixed(1)}%)`);
  say(`  winners the filter could SEE        : ${winsVisible.length} of ${visible.length} (${((100 * winsVisible.length) / Math.max(1, visible.length)).toFixed(1)}%)`);
  say(`  winners it is BLIND to              : ${wins.length - winsVisible.length} of ${blind.length} (${((100 * (wins.length - winsVisible.length)) / Math.max(1, blind.length)).toFixed(1)}%)`);
  say();

  // --- 2. THE CEILING ------------------------------------------------------
  const o = oracleCeiling(attributed.map((r) => ({ creator: r.creator, at: r.at, pnl: r.pnl })));
  say("2. THE CEILING - the best a creator filter could POSSIBLY do");
  say("  Computed by cheating: keep every launch the filter cannot see, and among");
  say("  the ones it can see keep ONLY the winners. No real rule achieves this - it");
  say("  would have to know the answer in advance. It is an upper bound, and a");
  say("  bound is worth more than a sixth variation.");
  say();
  say(`  the book as it stands   : ${o.baselineTotal.toFixed(3)} SOL over ${o.baselineTrades} trades (${o.baselinePerTrade.toFixed(5)}/trade)`);
  say(`  with a PERFECT filter   : ${o.oracleTotal.toFixed(3)} SOL over ${o.oracleTrades} trades (${o.oraclePerTrade.toFixed(5)}/trade)`);
  say(`  most it could ever add  : ${o.bestPossibleGain.toFixed(3)} SOL`);
  say();
  say(`  ${o.verdict}`);
  say();

  // --- 3. the filter itself, only if the ceiling allows --------------------
  say("3. THE FILTER ON RECORDED DATA - point-in-time, no future data");
  const asLaunches: LaunchRecord[] = attributed.map((r) => ({ mint: r.mint, creator: r.creator, at: r.at, fate: r.fate, entrySol: null, peakMultiple: null }));
  const groups: Record<string, typeof attributed> = { "first seen": [], "prior: none drained": [], "prior: some drained": [], "prior: most drained": [] };
  for (const r of attributed) {
    const p = priorStats(asLaunches, r.creator, r.at);
    const key = p.priorLaunches === 0 ? "first seen"
      : p.priorDrainRate === null ? "first seen"
      : p.priorDrainRate === 0 ? "prior: none drained"
      : p.priorDrainRate > 0.5 ? "prior: most drained"
      : "prior: some drained";
    groups[key].push(r);
  }
  say(`  ${"group".padEnd(22)} ${"n".padStart(4)} ${"winners".padStart(8)} ${"win rate".padStart(9)} ${"SOL/trade".padStart(10)}  note`);
  for (const [label, rows] of Object.entries(groups)) {
    const g = summariseGroup(label, rows.map((r) => ({ fate: r.fate })));
    const w = rows.filter((r) => r.pnl > 0).length;
    const per = rows.length ? rows.reduce((a, b) => a + b.pnl, 0) / rows.length : 0;
    const rate = rows.length >= MIN_PER_GROUP ? `${((100 * w) / rows.length).toFixed(1)}%` : "WITHHELD";
    say(`  ${label.padEnd(22)} ${String(rows.length).padStart(4)} ${String(w).padStart(8)} ${rate.padStart(9)} ${per.toFixed(5).padStart(10)}  ${g.note ?? ""}`);
  }
  say();

  // --- 4. what live would cost --------------------------------------------
  const c = liveCost(379, 283098);
  say("4. WHAT THE LIVE VERSION WOULD COST - stated before anything goes live");
  say(`  ${c.note}`);
  say(`  launches/day (median full day, measured) : ${c.launchesPerDay}`);
  say(`  additional RPC calls per launch          : ${c.callsPerLaunch}`);
  say(`  additional credits per day               : ${c.creditsPerDay}`);
  say(`  as a share of the bot's current burn     : ${c.shareOfCurrentBurn === null ? "unknown" : (c.shareOfCurrentBurn * 100).toFixed(2) + "%"}`);
  say();
  say("VERDICT");
  if (!o.couldEverBeProfitable) {
    say("  The signal cannot save this strategy, and that is provable without testing");
    say("  any particular rule. A creator filter is blind to the majority of the book");
    say(`  and to ${wins.length - winsVisible.length} of the ${wins.length} winners, and even a perfect one - cheating with`);
    say("  future knowledge - leaves the book losing money per trade.");
    say();
    say("  Exit-rule work is finished and the loss is set at entry. This was the last");
    say("  untested entry signal. The honest conclusion is that THIS STRATEGY DOES NOT");
    say("  WORK on the data collected, and the next move is not a sixth variation.");
  } else {
    say("  There is a ceiling worth chasing. See section 2 for how much.");
  }
  say();
  say("  Live wiring stays OFF. Nothing in this report changed a config value.");
  say("```");

  const out = path.join("reports", `creator-verdict-${new Date().toISOString().slice(0, 10)}.md`);
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(out, L.join("\n") + "\n");
  console.log(`\nwritten to ${out}`);
}

if (require.main === module) main();
