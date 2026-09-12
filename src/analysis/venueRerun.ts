/**
 * Every paper result, re-run under venue-correct pricing (NIGHT-PROMPT-V5
 * Project 2; APPROVALS 37 decided 2026-09-12).
 *
 * The paper book priced every position with constant product on the pool's
 * REAL SOL. Pump.fun is a bonding curve on VIRTUAL reserves (real + 30 SOL).
 * Items 27 (sizing), 28 (winner/loser split), 34 (late entry), 38 (what
 * separates) and the trailing-stop backtests were all priced with the book
 * model. This module replays the same positions, on the same watchlist
 * readings, with the venue model, and adds exit rules defined on SOL RAISED -
 * the quantity the bot actually observes - so a stop can be judged that the
 * curve can actually trigger.
 *
 * Pure: the script supplies the data. No network, no config mutation, no order
 * path. Every figure here is a valuation on recorded readings; "held-to-end"
 * means the rule never fired and the position is valued at its LAST reading,
 * which assumes the token could still be sold into the curve at that state.
 */
import fs from "fs";
import path from "path";
import { runSeries, constantProductProceeds, Position, ProceedsFn, TrailingStopConfig } from "../trading/trailingStop";
import { proceedsFor, venueOf, Venue, bondingCurveFloorFraction } from "./venueModels";
import { ClosedPosition, Reading, isDrained } from "./lateEntry";

export type Model = "book" | "venue";

export interface TaggedClose { c: ClosedPosition; venue: Venue }

export interface PaperData {
  closes: TaggedClose[];
  unknownVenue: number;
  readingsByMint: Map<string, Reading[]>;
  /** How many open attempts the cap refused, by the cap in force when it did. */
  capRefusals: Record<string, number>;
  opens: number;
  firstOpened: string | null;
  lastClosed: string | null;
}

function readJsonl<T>(file: string): T[] {
  const out: T[] = [];
  if (!fs.existsSync(file)) return out;
  for (const l of fs.readFileSync(file, "utf-8").split("\n")) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* partial line */ } }
  return out;
}

/** Closed paper positions (deduplicated), their venue from the decision record, and the watchlist's `checked` readings. */
export function loadPaperData(logsDir = "logs"): PaperData {
  const rows = readJsonl<any>(path.join(logsDir, "paper-positions.jsonl"));
  const seen = new Set<string>(); const closes: ClosedPosition[] = [];
  let opens = 0; const capRefusals: Record<string, number> = {};
  for (const r of rows) {
    if (r.event === "paper-open") opens++;
    if (r.event === "paper-refused" && /cap reached/.test(r.reason ?? "")) { const m = /\((\d+) open\)/.exec(r.reason); const k = m ? m[1] : "?"; capRefusals[k] = (capRefusals[k] ?? 0) + 1; }
    if (r.event !== "paper-close" || r.outcome !== "closed" || r.exitProceedsSol === null) continue;
    const k = `${r.mint}|${r.openedAt}`; if (seen.has(k)) continue; seen.add(k); closes.push(r as ClosedPosition);
  }
  const venueByMint = new Map<string, Venue>();
  for (const f of fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter((x) => /^decisions.*\.jsonl$/.test(x)) : []) {
    for (const d of readJsonl<{ mint?: string; source?: string }>(path.join(logsDir, f))) { const v = venueOf(d.source); if (d.mint && v && !venueByMint.has(d.mint)) venueByMint.set(d.mint, v); }
  }
  const readingsByMint = new Map<string, Reading[]>();
  for (const r of readJsonl<{ ts: string; event: string; mint: string; liquiditySol?: number | null }>(path.join(logsDir, "watchlist.jsonl"))) {
    // "checked" only: the reading the paper book was fed. "promoted" repeats the last reading; "added" is the t=0 baseline.
    if (r.event !== "checked" || typeof r.liquiditySol !== "number") continue;
    if (!readingsByMint.has(r.mint)) readingsByMint.set(r.mint, []);
    readingsByMint.get(r.mint)!.push({ tMs: Date.parse(r.ts), sol: r.liquiditySol });
  }
  for (const rs of readingsByMint.values()) rs.sort((a, b) => a.tMs - b.tMs);
  const tagged: TaggedClose[] = []; let unknownVenue = 0;
  for (const c of closes) { const v = venueByMint.get(c.mint); if (v) tagged.push({ c, venue: v }); else unknownVenue++; }
  const opened = closes.map((c) => c.openedAt).sort(); const closedAts = closes.map((c) => c.closedAt ?? "").filter(Boolean).sort();
  return { closes: tagged, unknownVenue, readingsByMint, capRefusals, opens, firstOpened: opened[0] ?? null, lastClosed: closedAts[closedAts.length - 1] ?? null };
}

// ---- pricing ---------------------------------------------------------------

export interface Priced {
  /** SOL realised by selling the whole position when real liquidity is L. */
  value: (L: number) => number | null;
  entryValue: number;
  model: string;
}

/** A stake entered at real liquidity L0, priced by the chosen model. Null when the model cannot price it (e.g. constant product with L0 = 0). */
export function price(model: Model, venue: Venue, stakeSol: number, L0: number): Priced | null {
  if (!(stakeSol > 0) || !(L0 > 0)) return null;
  if (model === "book" || venue === "raydium") {
    const f = stakeSol / L0;
    const entry = constantProductProceeds(L0, f);
    if (entry === null) return null;
    return { value: (L) => constantProductProceeds(L, f), entryValue: entry, model: "constant product on real SOL" };
  }
  const p = proceedsFor("pumpfun", stakeSol, L0);
  if (p.entryProceedsSol === null) return null;
  return { value: (L) => p.fn(L, stakeSol / L0), entryValue: p.entryProceedsSol, model: p.model };
}

// ---- exit rules -----------------------------------------------------------

export interface Entry { mint: string; venue: Venue; entryTs: string; L0: number; stakeSol: number }
export interface RuleOutcome { result: "exited" | "held-to-end" | "no-readings"; realised: number | null; reason: string; exitTs: string | null; readings: number }
export type ExitRule = { label: string; describe: string; run: (e: Entry, priced: Priced, series: Reading[]) => RuleOutcome };

const MIN_HOLD_MS = 60_000;

/** The paper book's own stop, replayed through the same runSeries the book uses. */
export function currentStopRule(trailing: TrailingStopConfig): ExitRule {
  return {
    label: "current stop", describe: `hard ${trailing.hardStopPercent}% / arm +${trailing.activationPercent}% / trail ${trailing.trailPercent}% / persist ${trailing.persistenceObservations} / hold ${trailing.minHoldMs} ms, on the position's VALUE`,
    run: (e, priced, series) => {
      if (series.length === 0) return { result: "no-readings", realised: null, reason: "no readings after entry", exitTs: null, readings: 0 };
      const fn: ProceedsFn = (L) => priced.value(L);
      const pos: Position = { mint: e.mint, entryTs: e.entryTs, poolFraction: e.stakeSol / e.L0, entryProceedsSol: priced.entryValue };
      const out = runSeries(pos, series.map((r) => ({ ts: new Date(r.tMs).toISOString(), liquiditySol: r.sol })), trailing, fn);
      if (out.result === "exited") return { result: "exited", realised: out.exitProceedsSol, reason: out.reason, exitTs: out.exitIndex !== null ? new Date(series[out.exitIndex].tMs).toISOString() : null, readings: series.length };
      return { result: "held-to-end", realised: out.finalProceedsSol, reason: "stop never fired; valued at last reading", exitTs: null, readings: series.length };
    },
  };
}

export const doNothingRule: ExitRule = {
  label: "do nothing", describe: "hold to the last recorded reading and take whatever it is worth",
  run: (_e, priced, series) => {
    if (series.length === 0) return { result: "no-readings", realised: null, reason: "no readings after entry", exitTs: null, readings: 0 };
    return { result: "held-to-end", realised: priced.value(series[series.length - 1].sol), reason: "valued at last reading", exitTs: null, readings: series.length };
  },
};

export function fixedTakeProfitRule(targetPercent: number): ExitRule {
  return {
    label: `take-profit +${targetPercent}%`, describe: `sell the first time the position's value reaches entry x ${(1 + targetPercent / 100).toFixed(2)}; otherwise hold to the end`,
    run: (_e, priced, series) => {
      if (series.length === 0) return { result: "no-readings", realised: null, reason: "no readings after entry", exitTs: null, readings: 0 };
      for (const r of series) { const v = priced.value(r.sol); if (v !== null && v >= priced.entryValue * (1 + targetPercent / 100)) return { result: "exited", realised: v, reason: `value reached +${targetPercent}%`, exitTs: new Date(r.tMs).toISOString(), readings: series.length }; }
      return { result: "held-to-end", realised: priced.value(series[series.length - 1].sol), reason: "target never reached; valued at last reading", exitTs: null, readings: series.length };
    },
  };
}

/**
 * A stop on SOL RAISED, not on the position's value: sell when the pool's real
 * SOL has fallen `dropPercent` below what it was at entry, after the minimum
 * hold, confirmed by `persistence` consecutive readings. The curve floors the
 * VALUE, so a value stop cannot see a drain on a small raise; the pool's SOL
 * has no floor, so this one can.
 */
export function raisedStopRule(dropPercent: number, persistence = 2, minHoldMs = MIN_HOLD_MS): ExitRule {
  return {
    label: `raised-stop -${dropPercent}%`, describe: `sell when real SOL raised <= entry raised x ${(1 - dropPercent / 100).toFixed(2)} on ${persistence} consecutive readings after a ${minHoldMs / 1000}s hold`,
    run: (e, priced, series) => {
      if (series.length === 0) return { result: "no-readings", realised: null, reason: "no readings after entry", exitTs: null, readings: 0 };
      const t0 = Date.parse(e.entryTs); let streak = 0;
      for (const r of series) {
        if (r.tMs - t0 < minHoldMs) continue;
        streak = r.sol <= e.L0 * (1 - dropPercent / 100) ? streak + 1 : 0;
        if (streak >= persistence) { const v = priced.value(r.sol); return { result: "exited", realised: v, reason: `SOL raised ${r.sol.toFixed(3)} <= ${(e.L0 * (1 - dropPercent / 100)).toFixed(3)} (entry ${e.L0.toFixed(3)})`, exitTs: new Date(r.tMs).toISOString(), readings: series.length }; }
      }
      return { result: "held-to-end", realised: priced.value(series[series.length - 1].sol), reason: "raised never fell that far; valued at last reading", exitTs: null, readings: series.length };
    },
  };
}

/** Trail on SOL raised: arm once raised >= entry x (1+arm%), then sell when raised <= peak raised x (1-trail%), confirmed by `persistence` readings. Below the arm, the plain raised-stop applies. */
export function raisedTrailRule(armPercent: number, trailPercent: number, hardDropPercent: number, persistence = 2, minHoldMs = MIN_HOLD_MS): ExitRule {
  return {
    label: `raised-trail arm+${armPercent}/trail${trailPercent}/hard-${hardDropPercent}`, describe: `on SOL raised: hard stop at entry x ${(1 - hardDropPercent / 100).toFixed(2)}; once raised >= entry x ${(1 + armPercent / 100).toFixed(2)}, sell when raised <= peak x ${(1 - trailPercent / 100).toFixed(2)}; ${persistence} consecutive readings, ${minHoldMs / 1000}s hold`,
    run: (e, priced, series) => {
      if (series.length === 0) return { result: "no-readings", realised: null, reason: "no readings after entry", exitTs: null, readings: 0 };
      const t0 = Date.parse(e.entryTs); let peak = e.L0; let armed = false; let streak = 0;
      for (const r of series) {
        peak = Math.max(peak, r.sol);
        if (!armed && r.sol >= e.L0 * (1 + armPercent / 100)) armed = true;
        if (r.tMs - t0 < minHoldMs) continue;
        const hit = armed ? r.sol <= peak * (1 - trailPercent / 100) : r.sol <= e.L0 * (1 - hardDropPercent / 100);
        streak = hit ? streak + 1 : 0;
        if (streak >= persistence) return { result: "exited", realised: priced.value(r.sol), reason: armed ? `trail: raised ${r.sol.toFixed(3)} <= peak ${peak.toFixed(3)} x ${(1 - trailPercent / 100).toFixed(2)}` : `hard: raised ${r.sol.toFixed(3)} <= entry x ${(1 - hardDropPercent / 100).toFixed(2)}`, exitTs: new Date(r.tMs).toISOString(), readings: series.length };
      }
      return { result: "held-to-end", realised: priced.value(series[series.length - 1].sol), reason: "never triggered; valued at last reading", exitTs: null, readings: series.length };
    },
  };
}

/** Whichever of two rules fires first; held-to-end only if neither fires. */
export function eitherRule(a: ExitRule, b: ExitRule): ExitRule {
  return {
    label: `${a.label} OR ${b.label}`, describe: `first of: ${a.describe} | ${b.describe}`,
    run: (e, priced, series) => {
      const ra = a.run(e, priced, series), rb = b.run(e, priced, series);
      const ta = ra.exitTs ? Date.parse(ra.exitTs) : Infinity, tb = rb.exitTs ? Date.parse(rb.exitTs) : Infinity;
      if (ta === Infinity && tb === Infinity) return ra.result === "no-readings" ? ra : rb;
      return ta <= tb ? ra : rb;
    },
  };
}

// ---- replay ---------------------------------------------------------------

export const DEFAULT_MAX_POOL_SHARE = 0.5;

export interface Row { mint: string; venue: Venue; L0: number; stake: number; entered: boolean; realised: number | null; net: number | null; result: RuleOutcome["result"] | "not-entered"; reason: string; drain: boolean; floor: number | null }

/** Readings strictly after the entry time, at most `delaySec` late: entry moves to the first reading at/after the delay (late entry) or stays at the recorded open (delay 0). */
export function seriesFor(c: ClosedPosition, readings: Reading[], delaySec = 0): { entryTs: string; L0: number; series: Reading[] } | null {
  const t0 = Date.parse(c.openedAt);
  if (delaySec === 0) return { entryTs: c.openedAt, L0: c.entryLiquiditySol, series: readings.filter((r) => r.tMs > t0) };
  const idx = readings.findIndex((r) => r.tMs >= t0 + delaySec * 1000);
  if (idx === -1) return null;
  return { entryTs: new Date(readings[idx].tMs).toISOString(), L0: readings[idx].sol, series: readings.slice(idx + 1) };
}

export function replayOne(t: TaggedClose, readings: Reading[], model: Model, rule: ExitRule, stakeOf: (L0: number) => number | null, delaySec = 0): Row {
  const base: Row = { mint: t.c.mint, venue: t.venue, L0: t.c.entryLiquiditySol, stake: 0, entered: false, realised: null, net: null, result: "not-entered", reason: "", drain: isDrained(t.c), floor: t.venue === "pumpfun" ? bondingCurveFloorFraction(t.c.entryLiquiditySol) : null };
  const s = seriesFor(t.c, readings, delaySec);
  if (!s) return { ...base, reason: "no reading at or after the delay" };
  const stake = stakeOf(s.L0);
  if (stake === null) return { ...base, L0: s.L0, reason: "strategy declined to enter" };
  const priced = price(model, t.venue, stake, s.L0);
  if (!priced) return { ...base, L0: s.L0, reason: "cannot price at this liquidity" };
  const out = rule.run({ mint: t.c.mint, venue: t.venue, entryTs: s.entryTs, L0: s.L0, stakeSol: stake }, priced, s.series);
  if (out.result === "no-readings") return { ...base, L0: s.L0, stake, reason: out.reason };
  return { ...base, L0: s.L0, stake, entered: true, realised: out.realised, net: out.realised === null ? null : out.realised - stake, result: out.result, reason: out.reason };
}

export const flatStake = (stakeSol: number, maxShare = DEFAULT_MAX_POOL_SHARE) => (L0: number): number | null => (L0 > 0 && stakeSol / L0 <= maxShare ? stakeSol : null);
export const poolFractionStake = (f: number) => (L0: number): number | null => (L0 > 0 ? f * L0 : null);

export interface Summary { entered: number; notEntered: number; staked: number; realised: number; net: number; netPct: number | null; wins: number; winRate: number | null; exited: number; heldToEnd: number; largestLoss: number | null; largestWin: number | null; medianNet: number | null; drains: number; drainNet: number; drainsExited: number }
export const MIN_FOR_RATE = 30;

export function summarise(rows: Row[]): Summary {
  const e = rows.filter((r) => r.entered && r.net !== null);
  const staked = e.reduce((a, r) => a + r.stake, 0), realised = e.reduce((a, r) => a + (r.realised ?? 0), 0);
  const nets = e.map((r) => r.net as number).sort((a, b) => a - b);
  const drains = e.filter((r) => r.drain);
  return {
    entered: e.length, notEntered: rows.length - e.length, staked, realised, net: realised - staked, netPct: staked > 0 ? ((realised - staked) / staked) * 100 : null,
    wins: e.filter((r) => (r.net ?? 0) > 0).length, winRate: e.length >= MIN_FOR_RATE ? (e.filter((r) => (r.net ?? 0) > 0).length / e.length) * 100 : null,
    exited: e.filter((r) => r.result === "exited").length, heldToEnd: e.filter((r) => r.result === "held-to-end").length,
    largestLoss: nets[0] ?? null, largestWin: nets[nets.length - 1] ?? null, medianNet: nets.length ? nets[Math.floor(nets.length / 2)] : null,
    drains: drains.length, drainNet: drains.reduce((a, r) => a + (r.net ?? 0), 0), drainsExited: drains.filter((r) => r.result === "exited").length,
  };
}

/** Pyramid: 0.2 at entry, +0.2 each time the FIRST tranche's value doubles again (2x, 4x), up to maxUnits, each tranche priced from its own entry liquidity. Exit for all tranches when `rule` fires on the first tranche. */
export function replayPyramid(t: TaggedClose, readings: Reading[], model: Model, rule: ExitRule, unit: number, maxUnits: number, maxShare = DEFAULT_MAX_POOL_SHARE): Row {
  const base = replayOne(t, readings, model, rule, flatStake(unit, maxShare));
  if (!base.entered) return base;
  const s = seriesFor(t.c, readings, 0)!;
  const first = price(model, t.venue, unit, s.L0)!;
  const exitTsMs = (() => { const out = rule.run({ mint: t.c.mint, venue: t.venue, entryTs: s.entryTs, L0: s.L0, stakeSol: unit }, first, s.series); return out.exitTs ? Date.parse(out.exitTs) : null; })();
  const tranches: Priced[] = [first]; let staked = unit; let nextMultiple = 2;
  let lastL: number | null = null; let exitL: number | null = null;
  for (const r of s.series) {
    if (exitTsMs !== null && r.tMs > exitTsMs) break;
    lastL = r.sol; if (exitTsMs !== null && r.tMs === exitTsMs) { exitL = r.sol; break; }
    const v = first.value(r.sol);
    if (v !== null && tranches.length < maxUnits && v >= first.entryValue * nextMultiple && unit / r.sol <= maxShare) { const p = price(model, t.venue, unit, r.sol); if (p) { tranches.push(p); staked += unit; nextMultiple *= 2; } }
  }
  const L = exitL ?? lastL; if (L === null) return { ...base, entered: false, result: "not-entered", reason: "no readings" };
  const realised = tranches.reduce((a, p) => a + (p.value(L) ?? 0), 0);
  return { ...base, stake: staked, realised, net: realised - staked, result: exitL !== null ? "exited" : "held-to-end", reason: `${tranches.length} tranche(s)` };
}
