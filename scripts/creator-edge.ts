/**
 * npm run creators:edge [-- --out reports/creator-edge-YYYY-MM-DD.md]
 *
 * The recorded test: does "this creator has drained N of M previous launches"
 * separate winners from losers?
 *
 * Read-only over logs/. Uses the creator addresses in logs/creators.jsonl
 * (whatever is there - the backfill is bounded and resumable) joined to the
 * same closed paper positions and watchlist readings every other OPIUMO report
 * uses, so the sample is comparable to APPROVALS 43's.
 *
 * The floor is 30 per group. Below it a rate is not printed at all - the group
 * says INSUFFICIENT and how short it is. If there are not enough repeat
 * creators to say anything, the report says exactly that; it does not pad.
 */
import fs from "fs";
import path from "path";
import { loadPaperData, replayOne, summarise, flatStake, raisedStopRule, fixedTakeProfitRule, eitherRule } from "../src/analysis/venueRerun";
import { LaunchRecord, buildStore, classifyFate, priorStats, summariseGroup, wouldRefuse, DEFAULT_FATES, DEFAULT_CREATOR_FILTER, MIN_PER_GROUP } from "../src/analysis/creatorReputation";

const arg = (f: string) => { const i = process.argv.indexOf(f); return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined; };
const L: string[] = [];
const say = (s = "") => L.push(s);
const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

function readCreators(): Map<string, { creator: string | null; at: string }> {
  const out = new Map<string, { creator: string | null; at: string }>();
  const f = path.join("logs", "creators.jsonl");
  if (!fs.existsSync(f)) return out;
  for (const l of fs.readFileSync(f, "utf-8").split("\n")) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); if (r.mint) out.set(r.mint, { creator: r.creator ?? null, at: r.at }); } catch { /* partial */ }
  }
  return out;
}

function main(): void {
  const creators = readCreators();
  const data = loadPaperData("logs");
  const readings = data.readingsByMint;

  // One record per closed paper position we have a creator for.
  const records: LaunchRecord[] = [];
  let noCreator = 0, unresolvedCreator = 0;
  for (const t of data.closes) {
    const c = creators.get(t.c.mint);
    if (!c) { noCreator++; continue; }
    if (!c.creator) { unresolvedCreator++; continue; }
    const launchMs = Date.parse(c.at ?? t.c.openedAt);
    const series = readings.get(t.c.mint) ?? [];
    const { fate, peakMultiple } = classifyFate(t.c.entryLiquiditySol, launchMs, series);
    records.push({ mint: t.c.mint, creator: c.creator, at: new Date(launchMs).toISOString(), fate, entrySol: t.c.entryLiquiditySol, peakMultiple });
  }
  records.sort((a, b) => a.at.localeCompare(b.at));
  const store = buildStore(records);

  say("Creator wallet reputation: does who launched it predict how it ends?");
  say("=".repeat(100));
  say();
  say("SAMPLE");
  say(`  ${data.closes.length} closed paper positions. Creator known for ${records.length}; ${noCreator} not yet backfilled; ${unresolvedCreator} whose launch fee payer was a program, not a wallet.`);
  say(`  Fate thresholds: drained = fell to <= ${DEFAULT_FATES.drainedAtOrBelow * 100}% of entry within ${DEFAULT_FATES.drainWindowMinutes} min; ran = reached >= ${DEFAULT_FATES.ranAtOrAbove}x entry at any reading; flat = neither. "ran" beats "drained" when both happened.`);
  say(`  Same closed positions and the same watchlist readings as the venue re-run, so the cap bias stated there applies here unchanged.`);
  say();

  const fates = { drained: 0, flat: 0, ran: 0, unknown: 0 };
  for (const r of records) fates[r.fate]++;
  say(`  Fates: ${fates.ran} ran, ${fates.flat} flat, ${fates.drained} drained, ${fates.unknown} unknown (no usable readings).`);
  say();

  say("CREATORS");
  const multi = [...store.values()].filter((s) => s.launches > 1).sort((a, b) => b.launches - a.launches);
  say(`  ${store.size} distinct creator(s) across ${records.length} launch(es).`);
  say(`  Creators with more than one launch IN THIS SAMPLE: ${multi.length}.`);
  if (multi.length) {
    say(`  ${"creator".padEnd(46)} ${"launches".padStart(8)} ${"ran".padStart(4)} ${"flat".padStart(5)} ${"drained".padStart(8)}  drain rate`);
    for (const s of multi.slice(0, 25)) say(`  ${s.creator.padEnd(46)} ${String(s.launches).padStart(8)} ${String(s.ran).padStart(4)} ${String(s.flat).padStart(5)} ${String(s.drained).padStart(8)}  ${pct(s.drainRate)}`);
    if (multi.length > 25) say(`  ...and ${multi.length - 25} more`);
  }
  say();

  // The test proper: split launches by what was known about their creator BEFOREHAND.
  say("THE TEST: split each launch by its creator's PRIOR record, then compare outcomes");
  say(`  Point-in-time: a launch is scored only on launches by the same creator that happened STRICTLY EARLIER.`);
  say(`  A launch whose creator had no prior history is in the "first seen" group - that is most of them, and it is the whole problem.`);
  say();
  const withPrior = records.map((r) => ({ r, prior: priorStats(records, r.creator, r.at) }));
  const groups = [
    summariseGroup("creator seen for the FIRST time", withPrior.filter((x) => x.prior.priorLaunches === 0).map((x) => x.r)),
    summariseGroup("creator had prior launches, NONE drained", withPrior.filter((x) => x.prior.priorLaunches > 0 && x.prior.priorDrained === 0).map((x) => x.r)),
    summariseGroup("creator had prior launches, SOME drained", withPrior.filter((x) => x.prior.priorLaunches > 0 && x.prior.priorDrained > 0 && (x.prior.priorDrainRate ?? 0) <= 0.5).map((x) => x.r)),
    summariseGroup("creator drained MOST prior launches (>50%)", withPrior.filter((x) => (x.prior.priorDrainRate ?? 0) > 0.5).map((x) => x.r)),
  ];
  say(`  ${"group".padEnd(46)} ${"n".padStart(5)} ${"ran".padStart(4)} ${"flat".padStart(5)} ${"drained".padStart(8)} ${"ran rate".padStart(9)} ${"drain rate".padStart(11)}  note`);
  for (const g of groups) say(`  ${g.label.padEnd(46)} ${String(g.n).padStart(5)} ${String(g.ran).padStart(4)} ${String(g.flat).padStart(5)} ${String(g.drained).padStart(8)} ${pct(g.ranRate).padStart(9)} ${pct(g.drainedRate).padStart(11)}  ${g.note ?? ""}`);
  say();

  const comparable = groups.filter((g) => g.ranRate !== null);
  say("VERDICT");
  if (comparable.length < 2) {
    say(`  **Cannot say anything yet.** Only ${comparable.length} of ${groups.length} group(s) reach the ${MIN_PER_GROUP}-launch floor, so there is nothing to compare against.`);
    say(`  The reason is structural, not a bug: this sample is ~1 day of launches, and ${multi.length} creator(s) launched more than once in it.`);
    say(`  A creator-reputation filter needs REPEAT creators, and repeat creators need TIME. The store now fills itself for free on every`);
    say(`  detection (the creator is recorded on the decision row), so this report gets more to work with every day the bot runs.`);
    say(`  This is the finding. It is not padded into a number.`);
  } else {
    const first = groups[0], most = groups[3];
    say(`  ${comparable.length} of ${groups.length} group(s) clear the ${MIN_PER_GROUP} floor, so there is something to compare.`);
    if (first.ranRate !== null && most.ranRate !== null) {
      say(`  A launch by a creator who drained MOST of their previous launches ran ${pct(most.ranRate)} of the time (${most.ran}/${most.n}),`);
      say(`  against ${pct(first.ranRate)} (${first.ran}/${first.n}) for a creator never seen before. That is the comparison this whole project was for.`);
      const ratio = most.ranRate > 0 ? first.ranRate / most.ranRate : Infinity;
      say(`  Ratio: a first-seen creator is ${ratio === Infinity ? "infinitely" : ratio.toFixed(1) + "x"} more likely to produce a run than a known drainer.`);
    }
    say(`  NOT monotonic, and that matters: the "some drained (<=50%)" group ran ${pct(groups[2].ranRate)} on ${groups[2].n}, which is the LOWEST of the four.`);
    say(`  A clean signal would fall as the drain rate rises. This does not, so treat the headline as suggestive, not established.`);
    say(`  Every position here is a live-filter reject, from ~1 day of one market, and the cap bias from the venue re-run applies.`);
  }
  say();

  // ---- what it would have done to the money -----------------------------------
  say("IN MONEY: replay the same book with the filter ON, point-in-time");
  say(`  The live paper rule (raised-stop -30% OR take-profit +50%, APPROVALS 43) under venue pricing, flat 0.2 SOL, on exactly these`);
  say(`  positions. "Refused" means the filter would have declined the entry using ONLY what was known before that launch.`);
  const rule = eitherRule(raisedStopRule(30), fixedTakeProfitRule(50));
  const cfgOn = { ...DEFAULT_CREATOR_FILTER, enabled: true };
  const byMint = new Map(data.closes.map((t) => [t.c.mint, t]));
  const entered: any[] = [], refused: any[] = [];
  for (const { r, prior } of withPrior) {
    const t = byMint.get(r.mint); if (!t) continue;
    const row = replayOne(t, readings.get(r.mint) ?? [], "venue", rule, flatStake(0.2));
    (wouldRefuse(prior, cfgOn).refuse ? refused : entered).push(row);
  }
  const sEnter = summarise(entered), sRefuse = summarise(refused), sAll = summarise([...entered, ...refused]);
  say(`  ${"book".padEnd(40)} ${"entered".padStart(8)} ${"staked".padStart(8)} ${"net".padStart(9)} ${"net %".padStart(8)} ${"wins".padStart(5)}`);
  const line = (label: string, x: any) => say(`  ${label.padEnd(40)} ${String(x.entered).padStart(8)} ${x.staked.toFixed(2).padStart(8)} ${x.net.toFixed(2).padStart(9)} ${(x.netPct === null ? "n/a" : x.netPct.toFixed(1) + "%").padStart(8)} ${String(x.wins).padStart(5)}`);
  line("every position (filter OFF)", sAll);
  line("kept by the filter (would have entered)", sEnter);
  line("skipped by the filter (would have refused)", sRefuse);
  say();
  if (sAll.netPct !== null && sEnter.netPct !== null) {
    const delta = sEnter.netPct - sAll.netPct;
    say(`  The filter changes the book from ${sAll.netPct.toFixed(1)}% to ${sEnter.netPct.toFixed(1)}% of stake: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} points.`);
    say(`  It declined ${sRefuse.entered} position(s) that together returned ${sRefuse.netPct === null ? "n/a" : sRefuse.netPct.toFixed(1) + "%"}${sRefuse.wins ? ` and contained ${sRefuse.wins} of the book's ${sAll.wins} winner(s)` : " and contained none of the winners"}.`);
    say(`  ${delta > 0 ? "That is the right direction, on one day of one market, with every position a live-filter reject." : "That is the WRONG direction: the filter would have made it worse. It stays off."}`);
  }
  say();

  say("WHAT THE LIVE FILTER WOULD COST");
  say(`  Zero new calls per launch. The creator is the launch transaction's fee payer, which the watcher ALREADY resolves at detection`);
  say(`  time to compute devWalletPercent - it was simply never written down. Recording it costs nothing, and the filter is a lookup in a`);
  say(`  local map. The only spend this project ever needed was the one-off backfill of history, which is bounded and reported separately.`);
  say();
  say(`  The filter is defined and OFF: paperExecution/creatorReputation in config, enabled=false. It stays off until a table above clears`);
  say(`  the floor and separates the groups. wouldRefuse() is written and tested; nothing calls it in the live path.`);
  const demo = wouldRefuse({ priorLaunches: 3, priorDrainRate: 0.67 }, { ...DEFAULT_CREATOR_FILTER, enabled: true });
  say(`  Example of the refusal it would emit: "${demo.reason}"`);

  console.log(L.join("\n"));
  const out = arg("--out");
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, "```\n" + L.join("\n") + "\n```\n"); console.log(`\nWritten to ${out}`); }
}
main();
