/**
 * npm run report:what-separates
 *
 * Project G: winners versus losers over EVERY recorded metric, with the same
 * discipline as metric-value (AUC + 95% interval, floors, null excluded and
 * counted), plus two things that did not exist then: the rug split (instant
 * drain / faded / won) as a third group, and the three shadow filter sets run
 * against the winners - does any set pass the winners it should?
 *
 * Read-only over the logs. Winner = trailing-stop exit above entry as the
 * paper book priced it (constant product on real SOL). That pricing is
 * SUPERSEDED for Pump.fun (APPROVALS 37); the label is kept so the numbers
 * line up with items 27/28/34, and the caveat is printed.
 */
import fs from "fs";
import { loadPaperData, replayOne, currentStopRule, poolFractionStake } from "../src/analysis/venueRerun";
import path from "path";
import { DecisionRecord, PaperClose, joinPaperSample, assessNumeric, assessBoolean, num, bool, positionsNeeded, fmtP, MIN_PER_GROUP, MetricAssessment } from "../src/analysis/metricValue";
import { isDrained } from "../src/analysis/lateEntry";
import { evaluateFilters } from "../src/filters/engine";

function readJsonl<T>(file: string): T[] { const out: T[] = []; if (!fs.existsSync(file)) return out; for (const l of fs.readFileSync(file, "utf-8").split("\n")) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* counted elsewhere */ } } return out; }

interface ShadowRow { mint: string; at: string; liveDecision: string; shadows: { setId: string; decision: string; reasons: string[] }[] }

function main(): void {
  const decisions = fs.readdirSync("logs").filter((f) => /^decisions.*\.jsonl$/.test(f)).sort().flatMap((f) => readJsonl<DecisionRecord>(path.join("logs", f)));
  const closes = readJsonl<PaperClose & { event: string; closedAt: string; peakProceedsSol: number }>("logs/paper-positions.jsonl").filter((r) => r.event === "paper-close");
  const shadows = readJsonl<ShadowRow>("logs/shadow-filters.jsonl");
  const ps = joinPaperSample(closes, decisions);
  const byMint = new Map<string, DecisionRecord>(); for (const d of decisions) if (d.mint && !byMint.has(d.mint)) byMint.set(d.mint, d);
  const seen = new Set<string>(); const uniq = closes.filter((c) => { const k = `${c.mint}|${c.openedAt}`; if (seen.has(k) || c.outcome !== "closed" || c.exitProceedsSol === null) return false; seen.add(k); return true; });
  // --venue (NIGHT-PROMPT-V5 Project 2): winner = net > 0 under VENUE pricing with the
  // book's own sizing (5% of pool) and the current stop, replayed on the watchlist
  // readings - instead of "exit above entry under the book model".
  const venueMode = process.argv.includes("--venue");
  const wonUnderVenue = new Set<string>();
  let venueEntered = 0;
  if (venueMode) {
    const data = loadPaperData("logs");
    const trailing = JSON.parse(fs.readFileSync("config/default.json", "utf-8")).paperExecution.trailing;
    const stop = currentStopRule(trailing);
    for (const t of data.closes) {
      const row = replayOne(t, data.readingsByMint.get(t.c.mint) ?? [], "venue", stop, poolFractionStake(0.05));
      if (!row.entered) continue;
      venueEntered++;
      if ((row.net ?? 0) > 0) wonUnderVenue.add(`${t.c.mint}|${t.c.openedAt}`);
    }
  }
  const won = (c: PaperClose) => (venueMode ? wonUnderVenue.has(`${c.mint}|${c.openedAt}`) : c.exitProceedsSol! > c.entryProceedsSol);
  const winners = uniq.filter((c) => won(c));
  const drained = uniq.filter((c) => !won(c) && isDrained(c as any));
  const faded = uniq.filter((c) => !won(c) && !isDrained(c as any));
  const recs = (xs: typeof uniq) => xs.map((c) => byMint.get(c.mint)).filter((d): d is DecisionRecord => !!d);

  const L: string[] = []; const say = (s = "") => { L.push(s); console.log(s); };
  say("What separates the winners? Every recorded metric, winners vs losers, plus the rug split and the shadow sets");
  say("=".repeat(112));
  say(venueMode
    ? `  ${uniq.length} closed positions: ${winners.length} winners (${((winners.length / uniq.length) * 100).toFixed(1)}%), ${drained.length} instant drains, ${faded.length} faded. Winner = net > 0 under VENUE pricing (bonding curve, APPROVALS 37) with 5%-of-pool sizing and the current stop, replayed on the watchlist readings (${venueEntered} entered). Item 38 re-run.`
    : `  ${uniq.length} closed positions: ${winners.length} winners (${((winners.length / uniq.length) * 100).toFixed(1)}%), ${drained.length} instant drains, ${faded.length} faded. Winner = exit above entry under the BOOK's pricing (SUPERSEDED for Pump.fun, APPROVALS 37 - run with --venue for the current model).`);
  say();

  const numeric = ["liquiditySol", "topHolderPercent", "devWalletPercent", "uniqueWallets", "transactionCount", "creatorLpPercent", "decimals", "launchSlotBuyers", "launchSlotTxs", "stage1ElapsedMs", "holderCreditsSpent"];
  const boolean = ["mintAuthorityRenounced", "freezeAuthorityRenounced", "lpBurned", "activitySkippedEarly", "stale"];
  const assess = (W: DecisionRecord[], Lo: DecisionRecord[]): MetricAssessment[] => [
    ...numeric.map((k) => assessNumeric(k, W.map((d) => num(d, k)), Lo.map((d) => num(d, k)))),
    ...boolean.map((k) => assessBoolean(k, W.map((d) => bool(d, k)), Lo.map((d) => bool(d, k)))),
    assessBoolean("hasRiskyExtensions", W.map((d) => Array.isArray(d.metrics?.riskyTokenExtensions) ? (d.metrics!.riskyTokenExtensions as unknown[]).length > 0 : null), Lo.map((d) => Array.isArray(d.metrics?.riskyTokenExtensions) ? (d.metrics!.riskyTokenExtensions as unknown[]).length > 0 : null)),
    assessBoolean("bundleFetched", W.map((d) => (d.metrics?.bundleSource === undefined ? null : d.metrics.bundleSource === "fetched")), Lo.map((d) => (d.metrics?.bundleSource === undefined ? null : d.metrics.bundleSource === "fetched"))),
  ];
  const table = (title: string, rows: MetricAssessment[]) => {
    say(`  ${title}`);
    say(`  ${"metric".padEnd(26)} ${"W".padStart(5)} ${"L".padStart(6)} ${"missing W/L".padStart(12)} ${"median W".padStart(10)} ${"median L".padStart(10)} ${"AUC".padStart(6)} ${"95% CI".padStart(12)} ${"p".padStart(8)}  verdict`);
    for (const r of rows) {
      const med = (x: number | null, rate: number | null) => x !== null ? x.toFixed(2) : rate !== null ? `${(rate * 100).toFixed(0)}% true` : "-";
      say(`  ${r.metric.padEnd(26)} ${String(r.winnersWithValue).padStart(5)} ${String(r.losersWithValue).padStart(6)} ${`${r.winnersMissing}/${r.losersMissing}`.padStart(12)} ${med(r.winnerMedian, r.winnerRate).padStart(10)} ${med(r.loserMedian, r.loserRate).padStart(10)} ${(r.auc === null ? "-" : r.auc.toFixed(2)).padStart(6)} ${(r.aucCi95 ? r.aucCi95.map((x) => x.toFixed(2)).join("-") : "-").padStart(12)} ${fmtP(r.pTwoSided).padStart(8)}  ${r.verdict.toUpperCase()}`);
    }
    say();
  };
  const W = recs(winners);
  table("A. WINNERS vs ALL LOSERS (metrics recorded at the detection-time decision)", assess(W, recs([...drained, ...faded])));
  table("B. WINNERS vs INSTANT DRAINS only (the rug split)", assess(W, recs(drained)));
  table("C. WINNERS vs FADED only", assess(W, recs(faded)));
  const notYet = ["launchSlotBuyers", "launchSlotTxs", "lpBurned", "bundleFetched"];
  const anyRecorded = decisions.filter((d) => d.metrics && "bundleSource" in d.metrics).length;
  say(`  Bundle / LP-burn metrics: recorded on ${anyRecorded} decision(s) so far - collection started with the 07:12 UTC restart, inside the OFF window. Nothing to compare yet; ${notYet.join(", ")} are INSUFFICIENT by construction today.`);
  const winRate = winners.length / Math.max(1, uniq.length);
  const fetchRate = (k: string) => (W.filter((d) => num(d, k) !== null).length + recs([...drained, ...faded]).filter((d) => num(d, k) !== null).length) / Math.max(1, uniq.length);
  for (const k of ["topHolderPercent", "uniqueWallets"]) {
    const need = positionsNeeded(fetchRate(k), winRate);
    say(`  ${k}: fetched for ${(fetchRate(k) * 100).toFixed(1)}% of positions at a ${(winRate * 100).toFixed(1)}% win rate -> ~${need === null ? "?" : need.toLocaleString()} closed positions for ${MIN_PER_GROUP} winners with a value (there are ${uniq.length}).`);
  }
  say();

  // ---- shadow sets vs the winners ------------------------------------------------
  // The shadow log only began 2026-09-11 16:57 UTC and every closed position
  // predates it (recorded rows covering these winners: see below). So the sets
  // are RE-EVALUATED here on each position's recorded decision metrics with the
  // same engine and the same overrides from config - not read from the log.
  say("  D. THE THREE SHADOW FILTER SETS AGAINST THE WINNERS - does any set pass the winners it should?");
  const shadowByMint = new Map<string, ShadowRow>(); for (const s of shadows) if (!shadowByMint.has(s.mint)) shadowByMint.set(s.mint, s);
  const recordedForWinners = winners.filter((c) => shadowByMint.has(c.mint)).length;
  say(`  recorded shadow rows covering these winners: ${recordedForWinners}/${winners.length} (log starts ${(shadows[0] as any)?.ts ?? "?"}) - sets re-evaluated on recorded metrics with evaluateFilters and the config overrides.`);
  const cfg = JSON.parse(fs.readFileSync("config/default.json", "utf-8"));
  const sets: { id: string; overrides: Record<string, unknown> }[] = cfg.shadowFilters.sets;
  const evalSet = (d: DecisionRecord, overrides: Record<string, unknown>) => evaluateFilters({ mint: d.mint, source: d.source, signature: "" } as any, d.metrics as any, { ...cfg.filters, ...overrides });
  const groups: [string, DecisionRecord[]][] = [["winners", recs(winners)], ["instant drains", recs(drained)], ["faded", recs(faded)]];
  say(`  ${"set".padEnd(20)} ${groups.map(([g]) => `${g} pass/n`.padStart(22)).join("")}   precision if live (winners passed / all passed)`);
  const blocks = new Map<string, Map<string, number>>();
  for (const st of [{ id: "LIVE (current filters)", overrides: {} }, ...sets]) {
    const cells: string[] = []; let pw = 0, pa = 0;
    for (const [g, ds] of groups) {
      let ok = 0;
      for (const d of ds) { const r = evalSet(d, st.overrides); if (r.decision === "PASS") ok++; if (g === "winners") for (const reason of r.reasons) { const rule = reason.split(" (")[0]; const m = blocks.get(st.id) ?? new Map(); m.set(rule, (m.get(rule) ?? 0) + 1); blocks.set(st.id, m); } }
      cells.push(`${ok}/${ds.length}`.padStart(22)); pa += ok; if (g === "winners") pw = ok;
    }
    say(`  ${st.id.padEnd(20)} ${cells.join("")}   ${pa ? `${pw}/${pa} = ${((pw / pa) * 100).toFixed(0)}%` : "passes nothing"}`);
  }
  for (const [id, m] of blocks) say(`    what blocks the winners under ${id}: ${[...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} ×${n}`).join("; ")}`);
  say();
  say("  READ THIS FIRST: 32 winners is the sample. Every verdict above is 'insufficient' or 'no evidence' where the interval says so, and the shadow-set counts are counts, not rates.");
  const out = venueMode ? "reports/what-separates-venue-2026-09-12.md" : "reports/what-separates-2026-09-12.md"; fs.writeFileSync(out, "```\n" + L.join("\n") + "\n```\n"); console.log(`\nWritten to ${out}`);
}
main();
