/**
 * npm run report:metric-value
 *
 * Which metrics are worth their credits? Reads the local logs, attributes the
 * meter's calls to purposes, and asks of every filter metric whether it
 * separates winners from losers - on the paper book's sample as the brief
 * specified, and on two larger samples the same logs already hold, each
 * labelled with the question it actually answers.
 *
 * Read-only. Changes no metric collection, no threshold, no config.
 *
 *   npm run report:metric-value
 *   npm run report:metric-value -- --out reports/metric-value.md
 *   npm run report:metric-value -- --process 2026-09-11T15:50:06.688Z   attribute a specific bot process
 */
import fs from "fs";
import path from "path";
import {
  DecisionRecord, PaperClose, OutcomeRecord, WatchlistEvent, MeterRecord,
  joinPaperSample, joinOutcomeSample, joinPromotedSample,
  assessNumeric, assessBoolean, positionsNeeded, attribute, num, bool, fmtP,
  METRIC_COST, MetricAssessment, MIN_PER_GROUP,
} from "../src/analysis/metricValue";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

/** Every line parsed; unparseable lines COUNTED. */
function readJsonl<T>(file: string): { records: T[]; bad: number } {
  if (!fs.existsSync(file)) return { records: [], bad: 0 };
  const records: T[] = [];
  let bad = 0;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as T); } catch { bad++; }
  }
  return { records, bad };
}
function readMany<T>(files: string[]): { records: T[]; bad: number; files: string[] } {
  const out: T[] = []; let bad = 0;
  for (const f of files) { const r = readJsonl<T>(f); out.push(...r.records); bad += r.bad; }
  return { records: out, bad, files };
}

const inWindow = (ts: string | undefined, a: number, b: number) => !!ts && Date.parse(ts) >= a && Date.parse(ts) <= b;

function main(): void {
  const decisionFiles = fs.readdirSync("logs").filter((f) => /^decisions.*\.jsonl$/.test(f)).sort().map((f) => path.join("logs", f));
  const outcomeFiles = fs.readdirSync("logs").filter((f) => /^outcomes.*\.jsonl$/.test(f)).sort().map((f) => path.join("logs", f));
  const decisions = readMany<DecisionRecord>(decisionFiles);
  const outcomes = readMany<OutcomeRecord>(outcomeFiles);
  const paper = readJsonl<PaperClose & { event: string }>("logs/paper-positions.jsonl");
  const watch = readJsonl<WatchlistEvent>("logs/watchlist.jsonl");
  const meter = readJsonl<MeterRecord>("logs/rpc-meter.jsonl");
  const closes = paper.records.filter((r) => r.event === "paper-close");
  const L: string[] = [];
  const say = (s = "") => { L.push(s); console.log(s); };

  say("Which metrics are worth their credits?");
  say("=".repeat(100));
  say(`  decisions ${decisions.records.length} from ${decisions.files.length} file(s), outcomes ${outcomes.records.length}, paper closes ${closes.length}, watchlist events ${watch.records.length}, meter records ${meter.records.length}`);
  const bad = decisions.bad + outcomes.bad + paper.bad + watch.bad + meter.bad;
  if (bad) say(`  ${bad} UNPARSEABLE line(s) across the logs - counted, not ignored`);

  // ---- 1. where the credits go --------------------------------------------------
  say(); say("1. WHERE THE CREDITS GO - one bot process, attributed by purpose");
  const processes = new Map<string, MeterRecord[]>();
  for (const m of meter.records) { if (!processes.has(m.startedAt)) processes.set(m.startedAt, []); processes.get(m.startedAt)!.push(m); }
  const wanted = arg("--process");
  // The longest-running real process is the fairest window. Test processes leave
  // records too (a hook ran test-watcher through the live meter today): they are
  // tiny, and they are listed so nobody mistakes one for the bot.
  const candidates = [...processes.entries()].map(([k, v]) => ({ startedAt: k, last: v[v.length - 1] }));
  const tiny = candidates.filter((c) => c.last.rpcCalls < 100);
  if (tiny.length) say(`  NOTE: ${tiny.length} meter process(es) with <100 calls - test runs, not the bot: ${tiny.map((t) => `${t.startedAt.slice(0, 19)} (${t.last.rpcCalls} calls)`).join(", ")}`);
  const chosen = wanted ? candidates.find((c) => c.startedAt === wanted) : candidates.filter((c) => c.last.rpcCalls >= 100).sort((a, b) => Date.parse(b.last.at) - Date.parse(a.last.at))[0];
  if (!chosen) { say("  no meter process to attribute"); }
  else {
    const m = chosen.last;
    const a = Date.parse(m.startedAt), b = Date.parse(m.at);
    const decWin = decisions.records.filter((d) => inWindow(d.ts, a, b) && d.decision === "SKIP" || (inWindow(d.ts, a, b) && d.decision === "BUY"));
    const evaluated = decWin;
    const stage1Liquidity = evaluated.filter((d) => num(d, "liquiditySol") !== null).length;
    const stage1Renounce = evaluated.filter((d) => bool(d, "mintAuthorityRenounced") !== null).length;
    const holderAttempts = evaluated.filter((d) => { const s = d.metrics?.holderSource; return s === "none" || s === "largest-accounts" || s === "das"; }).length;
    const watchWin = watch.records.filter((w) => inWindow(w.ts, a, b));
    const checks = watchWin.filter((w) => w.event === "checked").length;
    const promotedHolder = watchWin.filter((w) => w.event === "holder-resolved" && w.holderSource !== "skipped-cheap-fail").length;
    const promotedActivity = watchWin.filter((w) => w.event === "activity-resolved" && w.activitySkippedEarly === false).length;
    const decisionActivity = evaluated.filter((d) => d.metrics?.activitySkippedEarly === false).length;
    const checkpoints = outcomes.records.filter((o) => inWindow((o as any).ts, a, b)).length;
    const txMethod = m.methods.find((x) => x.method === "getTransaction")?.calls ?? 0;
    const activitySamples = promotedActivity + decisionActivity;
    const sampleSize = 20; // polling.walletActivitySampleSize as shipped; read from config would need RPC_URL
    // Detections parsed = getTransaction calls not explained by activity sampling. Derived, and said so.
    const detectionsParsed = Math.max(0, txMethod - activitySamples * sampleSize);
    const att = attribute(m, {
      outcomeCheckpoints: checkpoints, watchlistChecks: checks, stage1Liquidity, stage1Renounce,
      detectionsParsed, activitySamples, activitySampleSize: sampleSize,
      holderTopFetches: holderAttempts + promotedHolder, holderDevFetches: m.methods.find((x) => x.method === "getTokenAccountsByOwner")?.calls ?? 0,
    });
    say(`  process started ${m.startedAt}, ${att.windowHours.toFixed(1)}h, ${m.rpcCalls.toLocaleString()} credits (${m.httpRequests.toLocaleString()} HTTP requests - batched getTransaction is billed per transaction)`);
    say(`  meter by method: ${m.methods.filter((x) => x.calls > 1).map((x) => `${x.method} ${(x.share * 100).toFixed(1)}%`).join(", ")}`);
    say();
    say(`  ${"purpose".padEnd(58)} ${"method".padEnd(42)} ${"credits".padStart(8)} ${"share".padStart(6)}  filter metric?`);
    for (const r of [...att.rows].sort((x, y) => y.credits - x.credits)) {
      say(`  ${r.purpose.padEnd(58)} ${r.method.padEnd(42)} ${r.credits.toLocaleString().padStart(8)} ${(r.share * 100).toFixed(1).padStart(5)}%  ${r.isFilterMetric ? "yes" : "no"}`);
    }
    say(`  ${"attributed".padEnd(58)} ${"".padEnd(42)} ${att.attributed.toLocaleString().padStart(8)} ${((att.attributed / m.rpcCalls) * 100).toFixed(1).padStart(5)}%`);
    say(`  ${att.reconciles ? "RECONCILES" : "DOES NOT RECONCILE"}: ${att.unattributed.toLocaleString()} credit(s) unattributed (${((att.unattributed / m.rpcCalls) * 100).toFixed(1)}%; tolerance 5%). Detections-parsed is DERIVED (getTransaction minus activity samples x ${sampleSize}); every other row is a count from its own log.`);
    const filterShare = att.rows.filter((r) => r.isFilterMetric).reduce((s, r) => s + r.share, 0);
    say(`  Filter metrics take ${(filterShare * 100).toFixed(1)}% of credits. The rest is detection parsing and outcome/watchlist measurement.`);
  }

  // ---- 2. the paper sample, as the brief specified --------------------------------
  say(); say("2. PAPER BOOK SAMPLE - closed positions, winner = trailing-stop exit above entry (the brief's sample)");
  const ps = joinPaperSample(closes, decisions.records);
  say(`  ${ps.winners.length} winners, ${ps.losers.length} losers, ${ps.unjoined} closed position(s) with no decision record (excluded)`);
  const numericMetrics = ["liquiditySol", "topHolderPercent", "devWalletPercent", "uniqueWallets", "transactionCount", "creatorLpPercent", "decimals"];
  const boolMetrics = ["mintAuthorityRenounced", "freezeAuthorityRenounced"];
  const assessOn = (winners: DecisionRecord[], losers: DecisionRecord[]): MetricAssessment[] => [
    ...numericMetrics.map((k) => assessNumeric(k, winners.map((d) => num(d, k)), losers.map((d) => num(d, k)))),
    ...boolMetrics.map((k) => assessBoolean(k, winners.map((d) => bool(d, k)), losers.map((d) => bool(d, k)))),
    assessBoolean("hasRiskyExtensions", winners.map((d) => Array.isArray(d.metrics?.riskyTokenExtensions) ? (d.metrics!.riskyTokenExtensions as unknown[]).length > 0 : null),
      losers.map((d) => Array.isArray(d.metrics?.riskyTokenExtensions) ? (d.metrics!.riskyTokenExtensions as unknown[]).length > 0 : null)),
  ];
  const table = (rows: MetricAssessment[]) => {
    say(`  ${"metric".padEnd(26)} ${"winners".padStart(9)} ${"losers".padStart(9)} ${"missing W/L".padStart(12)} ${"median W".padStart(10)} ${"median L".padStart(10)} ${"AUC".padStart(6)} ${"95% CI".padStart(12)} ${"p".padStart(8)}  verdict`);
    for (const r of rows) {
      const med = (x: number | null, rate: number | null) => x !== null ? x.toFixed(2) : rate !== null ? `${(rate * 100).toFixed(0)}% true` : "-";
      say(`  ${r.metric.padEnd(26)} ${String(r.winnersWithValue).padStart(9)} ${String(r.losersWithValue).padStart(9)} ${`${r.winnersMissing}/${r.losersMissing}`.padStart(12)} ${med(r.winnerMedian, r.winnerRate).padStart(10)} ${med(r.loserMedian, r.loserRate).padStart(10)} ${(r.auc === null ? "-" : r.auc.toFixed(2)).padStart(6)} ${(r.aucCi95 ? r.aucCi95.map((x) => x.toFixed(2)).join("-") : "-").padStart(12)} ${fmtP(r.pTwoSided).padStart(8)}  ${r.verdict.toUpperCase()}`);
    }
    for (const r of rows) say(`      ${r.metric}: ${r.because}`);
  };
  const paperRows = assessOn(ps.winners, ps.losers);
  table(paperRows);
  const winRate = ps.winners.length / Math.max(1, ps.winners.length + ps.losers.length);
  say();
  say(`  What this sample CANNOT say: the expensive metrics were fetched for almost none of these tokens, because a token that`);
  say(`  fails the cheap checks never reaches them. At the observed fetch rates and a ${(winRate * 100).toFixed(1)}% win rate, to get ${MIN_PER_GROUP} winners WITH a value:`);
  for (const k of ["topHolderPercent", "uniqueWallets"]) {
    const r = paperRows.find((x) => x.metric === k)!;
    const fetchRate = (r.winnersWithValue + r.losersWithValue) / Math.max(1, ps.winners.length + ps.losers.length);
    const need = positionsNeeded(fetchRate, winRate);
    say(`    ${k.padEnd(18)} fetched for ${(fetchRate * 100).toFixed(1)}% of positions -> ${need === null ? "cannot estimate" : `~${need.toLocaleString()} closed positions`} (there are ${ps.winners.length + ps.losers.length})`);
  }

  // ---- 3. the larger samples ------------------------------------------------------
  say(); say("3. LARGER SAMPLE A - every detected token with a 1h checkpoint; winner = pool held >= 2x its detection baseline at 1h");
  say("   (a different question from the paper book's: 'did the pool grow', not 'would the trailing stop have exited above entry')");
  const os = joinOutcomeSample(outcomes.records, decisions.records, 3600, 2);
  say(`  ${os.winners.length} winners, ${os.losers.length} losers, ${os.unjoined} with no decision record`);
  table(assessOn(os.winners, os.losers));

  say(); say("3. LARGER SAMPLE B - promoted watchlist tokens, which DO carry the expensive metrics; winner = pool at 6h >= 2x pool when the metric was read");
  const act = joinPromotedSample(watch.records.filter((w) => w.activitySkippedEarly === false), outcomes.records, "activity-resolved", 21600, 2);
  const hold = joinPromotedSample(watch.records.filter((w) => w.holderSource && w.holderSource !== "skipped-cheap-fail"), outcomes.records, "holder-resolved", 21600, 2);
  say(`  activity-resolved: ${act.winners.length} winners, ${act.losers.length} losers, ${act.unjoined} without a 6h checkpoint yet`);
  say(`  holder-resolved:   ${hold.winners.length} winners, ${hold.losers.length} losers, ${hold.unjoined} without a 6h checkpoint yet`);
  const promotedRows: MetricAssessment[] = [
    assessNumeric("uniqueWallets", act.winners.map((e) => e.uniqueWallets ?? null), act.losers.map((e) => e.uniqueWallets ?? null)),
    assessNumeric("transactionCount", act.winners.map((e) => e.transactionCount ?? null), act.losers.map((e) => e.transactionCount ?? null)),
    assessNumeric("uniqueWalletToTxRatio",
      act.winners.map((e) => (e.uniqueWallets != null && e.transactionCount ? e.uniqueWallets / e.transactionCount : null)),
      act.losers.map((e) => (e.uniqueWallets != null && e.transactionCount ? e.uniqueWallets / e.transactionCount : null))),
    assessNumeric("topHolderPercent", hold.winners.map((e) => e.topHolderPercent ?? null), hold.losers.map((e) => e.topHolderPercent ?? null)),
    assessNumeric("devWalletPercent", hold.winners.map((e) => e.devWalletPercent ?? null), hold.losers.map((e) => e.devWalletPercent ?? null)),
  ];
  table(promotedRows);
  // How long until the promoted route can answer: it needs MIN_PER_GROUP winners with a value.
  const promotedTotal = act.winners.length + act.losers.length;
  const promotedWinRate = promotedTotal ? act.winners.length / promotedTotal : 0;
  const promotedNeeded = positionsNeeded(1, promotedWinRate);
  const firstTs = watch.records.find((w) => w.event === "activity-resolved")?.ts, lastTs = [...watch.records].reverse().find((w) => w.event === "activity-resolved")?.ts;
  const promotedPerHour = firstTs && lastTs && Date.parse(lastTs) > Date.parse(firstTs) ? promotedTotal / ((Date.parse(lastTs) - Date.parse(firstTs)) / 3_600_000) : null;
  say(`  Promoted route: ${act.winners.length} winners in ${promotedTotal} with a 6h checkpoint (${(promotedWinRate * 100).toFixed(1)}%). ${promotedNeeded === null ? "Cannot estimate" : `~${promotedNeeded.toLocaleString()} promoted tokens with checkpoints would give ${MIN_PER_GROUP} winners`}${promotedPerHour ? ` - at ${promotedPerHour.toFixed(0)}/h of resolved promotions that is ~${promotedNeeded === null ? "?" : (promotedNeeded / promotedPerHour / 24).toFixed(1)} more days of running` : ""}.`);

  // ---- 4. ranking -----------------------------------------------------------------
  say(); say("4. VALUE PER CREDIT - cost per token from the code paths, separation from the largest sample that has the metric");
  const best = new Map<string, MetricAssessment>();
  for (const r of [...paperRows, ...assessOn(os.winners, os.losers), ...promotedRows]) {
    const cur = best.get(r.metric);
    const n = r.winnersWithValue + r.losersWithValue;
    if (!cur || n > cur.winnersWithValue + cur.losersWithValue) best.set(r.metric, r);
  }
  say(`  ${"metric".padEnd(26)} ${"credits/token".padStart(13)}  ${"best sample n".padStart(13)}  ${"AUC".padStart(5)}  verdict        method`);
  for (const [k, cost] of Object.entries(METRIC_COST)) {
    const r = best.get(k);
    say(`  ${k.padEnd(26)} ${String(cost.credits).padStart(13)}  ${String(r ? r.winnersWithValue + r.losersWithValue : 0).padStart(13)}  ${(r?.auc == null ? "-" : r.auc.toFixed(2)).padStart(5)}  ${(r?.verdict ?? "insufficient").toUpperCase().padEnd(13)}  ${cost.method}`);
  }
  say();
  say("  Nothing here changes any metric collection or threshold. Decision goes to APPROVALS.md.");

  const out = arg("--out");
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, "```\n" + L.join("\n") + "\n```\n"); console.log(`\nWritten to ${out}`); }
}
main();
