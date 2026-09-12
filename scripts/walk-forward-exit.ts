/**
 * npm run walk-forward:exit [-- --out reports/walk-forward-exit-YYYY-MM-DD.md] [--split N]
 *
 * APPROVALS 43's condition. The proposed exit rule ("raised-stop -30% OR
 * take-profit +50%") was picked as the best of a table computed on one day of
 * positions. Picking the best row of a table on a sample and then quoting its
 * score on that same sample is how a rule gets overfit. So: split the closed
 * paper positions chronologically in two halves, CHOOSE the rule on one half
 * (best net% among the candidates), SCORE that rule on the other half against
 * the current stop on the same half, then do the reverse. Both halves are
 * reported. The rule only earns a switch if it beats the current stop on data
 * it was not chosen on - in both directions.
 *
 * Same positions, same readings, same pricing (venue model) and the same rule
 * implementations as `npm run rerun:venue`. Read-only over logs/. Changes
 * nothing live.
 */
import fs from "fs";
import path from "path";
import {
  loadPaperData, replayOne, summarise, currentStopRule, doNothingRule, fixedTakeProfitRule, raisedStopRule, raisedTrailRule, eitherRule,
  flatStake, Row, Summary, ExitRule, TaggedClose, MIN_FOR_RATE,
} from "../src/analysis/venueRerun";
import { Reading } from "../src/analysis/lateEntry";
import { TrailingStopConfig } from "../src/trading/trailingStop";

export const PROPOSED_LABEL = "raised-stop -30% OR take-profit +50%";

/** The candidates the rule is chosen from: the 13 rows of the venue re-run table plus the rest of the raised-stop x take-profit grid, so the choice is a real selection and not a foregone conclusion. */
export function candidateRules(trailing: TrailingStopConfig): ExitRule[] {
  const rules: ExitRule[] = [
    currentStopRule(trailing), doNothingRule, fixedTakeProfitRule(100), fixedTakeProfitRule(50), fixedTakeProfitRule(30),
    raisedStopRule(30), raisedStopRule(50), raisedStopRule(70),
    raisedTrailRule(30, 20, 30), raisedTrailRule(30, 20, 50), raisedTrailRule(50, 25, 50),
  ];
  for (const drop of [20, 30, 50]) for (const tp of [30, 50, 100]) rules.push(eitherRule(raisedStopRule(drop), fixedTakeProfitRule(tp)));
  return rules;
}

export interface HalfScore { label: string; summary: Summary }
export interface Direction {
  chooseOn: "A" | "B"; scoreOn: "A" | "B";
  /** Every candidate's in-sample summary on the choosing half, best first. */
  inSample: HalfScore[];
  chosen: string;
  /** Rules with fewer than MIN_FOR_RATE entered positions on the choosing half are not eligible to be chosen. */
  eligible: number;
  chosenOutOfSample: Summary;
  currentOutOfSample: Summary;
  proposedOutOfSample: Summary;
  /** net% chosen - net% current, on the held-out half. */
  chosenEdgePct: number | null;
  proposedEdgePct: number | null;
}
export interface WalkForward {
  n: number; splitAt: number;
  a: { n: number; first: string | null; last: string | null }; b: { n: number; first: string | null; last: string | null };
  directions: [Direction, Direction];
  /** The proposed rule beat the current stop on BOTH held-out halves. */
  proposedBeatsCurrentBothHalves: boolean;
  /** The in-sample choice was the proposed rule in both directions. */
  choiceStable: boolean;
}

const netPct = (s: Summary): number => (s.netPct === null ? -Infinity : s.netPct);

export function splitChronologically(closes: TaggedClose[], splitAt?: number): { a: TaggedClose[]; b: TaggedClose[] } {
  const sorted = [...closes].sort((x, y) => Date.parse(x.c.openedAt) - Date.parse(y.c.openedAt) || x.c.mint.localeCompare(y.c.mint));
  const at = splitAt ?? Math.ceil(sorted.length / 2);
  return { a: sorted.slice(0, at), b: sorted.slice(at) };
}

function score(rule: ExitRule, half: TaggedClose[], R: (m: string) => Reading[]): Summary {
  return summarise(half.map((t) => replayOne(t, R(t.c.mint), "venue", rule, flatStake(0.2))));
}

function direction(chooseOn: "A" | "B", train: TaggedClose[], test: TaggedClose[], rules: ExitRule[], R: (m: string) => Reading[], current: ExitRule, proposed: ExitRule): Direction {
  const inSample = rules.map((r) => ({ label: r.label, summary: score(r, train, R) })).sort((x, y) => netPct(y.summary) - netPct(x.summary));
  const eligibleRows = inSample.filter((h) => h.summary.entered >= MIN_FOR_RATE);
  const best = eligibleRows[0];
  if (!best) throw new Error(`no candidate has ${MIN_FOR_RATE} entered positions on half ${chooseOn} (${train.length} positions) - too few to choose a rule on; not choosing`);
  const chosenRule = rules.find((r) => r.label === best.label)!;
  const chosenOutOfSample = score(chosenRule, test, R);
  const currentOutOfSample = score(current, test, R);
  const proposedOutOfSample = score(proposed, test, R);
  const edge = (s: Summary) => (s.netPct === null || currentOutOfSample.netPct === null ? null : s.netPct - currentOutOfSample.netPct);
  return {
    chooseOn, scoreOn: chooseOn === "A" ? "B" : "A", inSample, chosen: best.label, eligible: eligibleRows.length,
    chosenOutOfSample, currentOutOfSample, proposedOutOfSample, chosenEdgePct: edge(chosenOutOfSample), proposedEdgePct: edge(proposedOutOfSample),
  };
}

export function walkForward(closes: TaggedClose[], R: (m: string) => Reading[], rules: ExitRule[], current: ExitRule, proposed: ExitRule, splitAt?: number): WalkForward {
  const { a, b } = splitChronologically(closes, splitAt);
  const range = (h: TaggedClose[]) => ({ n: h.length, first: h[0]?.c.openedAt ?? null, last: h[h.length - 1]?.c.openedAt ?? null });
  const d1 = direction("A", a, b, rules, R, current, proposed);
  const d2 = direction("B", b, a, rules, R, current, proposed);
  const beats = (d: Direction) => d.proposedEdgePct !== null && d.proposedEdgePct > 0;
  return {
    n: closes.length, splitAt: a.length, a: range(a), b: range(b), directions: [d1, d2],
    proposedBeatsCurrentBothHalves: beats(d1) && beats(d2),
    choiceStable: d1.chosen === proposed.label && d2.chosen === proposed.label,
  };
}

// ---- report --------------------------------------------------------------------

const arg = (f: string) => { const i = process.argv.indexOf(f); return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined; };
const sol = (x: number | null, d = 2) => (x === null ? "n/a" : x.toFixed(d));
const pct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);

function table(L: string[], title: string, rows: HalfScore[]): void {
  L.push(`  ${title}`);
  L.push(`  ${"rule".padEnd(48)} ${"entered".padStart(7)} ${"staked".padStart(7)} ${"net".padStart(8)} ${"net%".padStart(7)} ${"wins".padStart(5)} ${"exited".padStart(7)} ${"held".padStart(5)}  drains n/exited`);
  for (const { label, summary: s } of rows) L.push(`  ${label.padEnd(48)} ${String(s.entered).padStart(7)} ${sol(s.staked).padStart(7)} ${sol(s.net).padStart(8)} ${pct(s.netPct).padStart(7)} ${String(s.wins).padStart(5)} ${String(s.exited).padStart(7)} ${String(s.heldToEnd).padStart(5)}  ${s.drains}/${s.drainsExited}${s.entered < MIN_FOR_RATE ? "   (under the floor, not eligible)" : ""}`);
  L.push("");
}

export function renderReport(wf: WalkForward, generatedAt: string): string {
  const L: string[] = [];
  L.push(`Walk-forward test of the paper book's exit rule (APPROVALS 43 condition) - generated ${generatedAt}`);
  L.push("=".repeat(110));
  L.push(`  ${wf.n} closed Pump.fun/Raydium paper positions, chronological by open time, split at position ${wf.splitAt}.`);
  L.push(`  Half A: ${wf.a.n} positions, opened ${wf.a.first} -> ${wf.a.last}`);
  L.push(`  Half B: ${wf.b.n} positions, opened ${wf.b.first} -> ${wf.b.last}`);
  L.push(`  Flat 0.2 SOL, venue pricing, the same readings and rule code as npm run rerun:venue. Choice = highest net% on the choosing half among rules with >= ${MIN_FOR_RATE} entered positions.`);
  L.push(`  The sample bias stated in the venue re-run (cap refusals, live-filter rejects, one market) applies to both halves; a chronological split is the only split that says anything about "the same day".`);
  L.push("");
  for (const d of wf.directions) {
    L.push(`CHOOSE ON HALF ${d.chooseOn}, SCORE ON HALF ${d.scoreOn}`);
    table(L, `in-sample on half ${d.chooseOn} (all candidates, best first; ${d.eligible} eligible)`, d.inSample);
    L.push(`  chosen on ${d.chooseOn}: ${d.chosen}`);
    table(L, `out-of-sample on half ${d.scoreOn}`, [
      { label: `chosen: ${d.chosen}`, summary: d.chosenOutOfSample },
      { label: `proposed: ${PROPOSED_LABEL}`, summary: d.proposedOutOfSample },
      { label: "current stop", summary: d.currentOutOfSample },
    ]);
    L.push(`  chosen vs current, out of sample: ${pct(d.chosenEdgePct)} of stake;  proposed vs current, out of sample: ${pct(d.proposedEdgePct)} of stake`);
    L.push("");
  }
  L.push("VERDICT");
  L.push(`  proposed rule beats the current stop on both held-out halves: ${wf.proposedBeatsCurrentBothHalves ? "YES" : "NO"}`);
  L.push(`  in-sample choice was the proposed rule in both directions: ${wf.choiceStable ? "YES" : `NO (chose "${wf.directions[0].chosen}" on A, "${wf.directions[1].chosen}" on B)`}`);
  L.push("  A YES on the first line is the condition for switching the paper book (records only). A NO means the rule does not survive data it was not picked on and the current stop stays.");
  L.push("  Nothing here changes live config.");
  return L.join("\n");
}

function main(): void {
  const cfg = JSON.parse(fs.readFileSync("config/default.json", "utf-8"));
  const trailing: TrailingStopConfig = cfg.paperExecution.trailing;
  const data = loadPaperData("logs");
  const R = (m: string): Reading[] => data.readingsByMint.get(m) ?? [];
  const rules = candidateRules(trailing);
  const proposed = rules.find((r) => r.label === PROPOSED_LABEL)!;
  const split = arg("--split"); 
  const wf = walkForward(data.closes, R, rules, rules[0], proposed, split ? Number(split) : undefined);
  const text = renderReport(wf, new Date().toISOString());
  console.log(text);
  const out = arg("--out"); if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, "```\n" + text + "\n```\n"); console.log(`\nWritten to ${out}`); }
}
if (require.main === module) main();
