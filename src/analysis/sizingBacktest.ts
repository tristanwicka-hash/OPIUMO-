/**
 * Position-sizing backtest over the paper-execution log.
 *
 * Config-free by convention (see CLAUDE.md): reads no .env and no config file.
 * Every number in a report traces to a stake the caller passed in.
 *
 * ## The question
 *
 * The paper book sizes every entry at 5% of the token's pool. Tristan intends
 * to trade a flat 0.2 SOL. Was pool-fraction sizing itself a large part of the
 * loss? Stakes ranged 0.00008-4.05 SOL because pools ranged from tiny to 85 SOL,
 * and the biggest losses were the biggest stakes in the biggest pools.
 *
 * ## The trap, and why this module exists instead of a spreadsheet
 *
 * A naive version reuses each position's recorded exit/entry RATIO under a
 * different stake: "it returned 2x, so 0.2 SOL would have returned 0.4". Those
 * ratios were produced under 5%-of-pool slippage and do not transfer. A flat
 * 0.2 SOL into an 85-SOL pool is 0.24% of it - far less slippage than 5%; into
 * a 2-SOL pool it is 10% - more. An early sketch that skipped this returned
 * +705%. `naiveRatioReuse` is included, LABELLED WRONG, so the gap is shown
 * rather than asserted - the same reason `naiveProceeds` exists in
 * trailingStop.ts.
 *
 * ## How proceeds are recomputed
 *
 * The paper book prices every valuation through `constantProductProceeds`:
 * a position holding fraction `f` of a pool's tokens realises `L * f / (1+f)`
 * when the pool holds `L` SOL. That is linear in `L` for fixed `f`, which has
 * two consequences this module leans on:
 *
 * 1. The recorded exit and peak proceeds can be inverted EXACTLY back to the
 *    pool's SOL at exit and at peak: `L = P * (1+f) / f`. No approximation -
 *    it is the same formula run backwards with the `poolFraction` the record
 *    carries.
 * 2. The trailing stop's decisions depend only on `L_t / L_0`, not on `f`. So
 *    the exit POINT is the same at any fixed stake, and only the size of what
 *    was at risk changes. This is stated in the report because it is an
 *    assumption about the exit logic, not a fact about the market.
 *
 * A flat stake `S` into a pool observed at `L_0` buys `S / L_0` of the pool's
 * tokens under x*y=k (buy `S` into reserve `L_0`: tokens received over tokens
 * remaining is exactly `S / L_0`). The observed `L_t` is then treated as the
 * whole reserve, exactly as the paper book treats it - conservative, because it
 * does not credit the position's own SOL back to itself, and correct in the
 * case that dominates this data: a rug takes the whole pool, yours included.
 *
 * ## What it refuses to do
 *
 * Records whose outcome is not `closed` with a numeric exit are EXCLUDED from
 * every P&L figure and counted separately. A position that could not be sold
 * did not lose "its stake" in a way a P&L number can express; folding it in
 * either direction is a guess.
 */

/** The fields of a `paper-close` record this module reads. */
export interface ClosedPaperRecord {
  mint: string;
  openedAt: string;
  closedAt: string | null;
  liveVerdict: string;
  entryLiquiditySol: number;
  entryProceedsSol: number;
  poolFraction: number;
  outcome: string;
  exitProceedsSol: number | null;
  exitReason: string | null;
  peakProceedsSol: number;
}

/** `L * f / (1+f)` - the paper book's model, restated here so the inversion below is next to it. */
export function proceeds(liquiditySol: number, fraction: number): number | null {
  if (!(liquiditySol >= 0) || !(fraction > 0)) return null;
  return (liquiditySol * fraction) / (1 + fraction);
}

/** Exact inverse of `proceeds` for the fraction the record was priced at. */
export function recoverLiquidity(proceedsSol: number, fraction: number): number | null {
  if (!(proceedsSol >= 0) || !(fraction > 0)) return null;
  return (proceedsSol * (1 + fraction)) / fraction;
}

/** The pool's SOL at entry, exit and peak, recovered from one record. */
export interface LiquidityPath {
  entry: number;
  exit: number;
  peak: number;
}

export function liquidityPath(r: ClosedPaperRecord): LiquidityPath | null {
  if (r.outcome !== "closed" || r.exitProceedsSol === null) return null;
  const exit = recoverLiquidity(r.exitProceedsSol, r.poolFraction);
  const peak = recoverLiquidity(r.peakProceedsSol, r.poolFraction);
  if (exit === null || peak === null || !(r.entryLiquiditySol > 0)) return null;
  return { entry: r.entryLiquiditySol, exit, peak };
}

export interface PositionResult {
  mint: string;
  /** SOL committed across every tranche. */
  stakedSol: number;
  /** SOL realised at the recorded exit point. */
  returnedSol: number;
  netSol: number;
  /** Position's share of the pool's tokens at first entry. */
  entryFraction: number;
  entryLiquiditySol: number;
  tranches: number;
}

/** The strategy looked and declined - counted, unlike a null which means the record could not be priced. */
export interface Skipped {
  skipped: string;
}
export const isSkipped = (x: PositionResult | Skipped | null): x is Skipped => x !== null && "skipped" in x;

export interface Strategy {
  label: string;
  /** Null when the record cannot be priced; `Skipped` when the strategy declined to enter. */
  size(path: LiquidityPath): PositionResult | Skipped | null;
  /** True for the deliberately wrong model, so the report can mark it. */
  wrong?: boolean;
}

/**
 * The paper book's current behaviour: a fixed share of the pool. Stake is `f * L_0`.
 *
 * `minEntryLiquiditySol` restricts it to the pools another strategy actually
 * entered, so the two rows compare the same positions. Without that, a flat
 * stake that skips 164 dust pools looks better or worse for reasons that have
 * nothing to do with sizing.
 */
export function poolFractionStrategy(fraction: number, minEntryLiquiditySol = 0): Strategy {
  return {
    label: minEntryLiquiditySol > 0
      ? `pool fraction ${(fraction * 100).toFixed(1)}% on pools >= ${minEntryLiquiditySol} SOL (same pools as flat)`
      : `pool fraction ${(fraction * 100).toFixed(1)}% (current paper behaviour)`,
    size(path) {
      if (path.entry < minEntryLiquiditySol) return { skipped: `pool ${path.entry.toFixed(4)} SOL is below ${minEntryLiquiditySol}` };
      const staked = fraction * path.entry;
      const out = proceeds(path.exit, fraction);
      if (out === null || !(staked > 0)) return null;
      return single(path, staked, out, fraction);
    },
  };
}

/**
 * The largest share of a pool's tokens a fixed stake is allowed to take.
 *
 * The first run of this backtest put 0.2 SOL into a pool observed at 0.0016
 * SOL - 125x the pool - and that one position returned +4.6 SOL, more than
 * every other flat position combined lost. Under x*y=k the maths "works" (you
 * would own 99.2% of the tokens and be capped at the pool's later balance), but
 * the observed liquidity path of that pool was made by traders who did not
 * have to trade through a 125x buy. A stake that IS the pool does not get to
 * borrow the pool's history. Above this share the strategy records the
 * position as not entered, and the report counts it.
 */
export const DEFAULT_MAX_POOL_SHARE = 0.5;

/** A fixed SOL amount per entry. Its share of the pool is `S / L_0`. */
export function flatStakeStrategy(stakeSol: number, maxPoolShare = DEFAULT_MAX_POOL_SHARE): Strategy {
  return {
    label: `flat ${stakeSol} SOL per entry (skip if > ${(maxPoolShare * 100).toFixed(0)}% of pool)`,
    size(path) {
      if (!(stakeSol > 0)) return null;
      const f = stakeSol / path.entry;
      if (f > maxPoolShare) return { skipped: `stake is ${(f * 100).toFixed(0)}% of a ${path.entry.toFixed(4)}-SOL pool` };
      const out = proceeds(path.exit, f);
      if (out === null) return null;
      return single(path, stakeSol, out, f);
    },
  };
}

export interface PyramidConfig {
  unitSol: number;
  /** As for the flat stake; applies to the FIRST unit. */
  maxPoolShare?: number;
  /** Add a unit each time the pool reaches this multiple of the LAST add level. 2 = each doubling. */
  stepMultiple: number;
  /** Total units including the first. */
  maxUnits: number;
}

/**
 * Enter one unit, add another each time the position reaches `stepMultiple`
 * of its last add level, up to `maxUnits`.
 *
 * ASSUMPTION, stated because it flatters the strategy: the add is priced AT the
 * level, `L_0 * step^k`. The pool's recorded peak says the level was reached;
 * it does not say what the first observation past it read. On a 2-observation
 * series the overshoot could be large. Every tranche is then valued at the
 * recorded exit, and the exit point is the first tranche's - see the header.
 */
export function pyramidStrategy(cfg: PyramidConfig): Strategy {
  return {
    label: `pyramid ${cfg.unitSol} SOL, +${cfg.unitSol} per ${cfg.stepMultiple}x, max ${cfg.maxUnits} units (skip if > ${((cfg.maxPoolShare ?? DEFAULT_MAX_POOL_SHARE) * 100).toFixed(0)}%)`,
    size(path) {
      if (!(cfg.unitSol > 0) || !(cfg.stepMultiple > 1) || !(cfg.maxUnits >= 1)) return null;
      const maxShare = cfg.maxPoolShare ?? DEFAULT_MAX_POOL_SHARE;
      if (cfg.unitSol / path.entry > maxShare) {
        return { skipped: `first unit is ${((cfg.unitSol / path.entry) * 100).toFixed(0)}% of a ${path.entry.toFixed(4)}-SOL pool` };
      }
      let staked = 0;
      let returned = 0;
      let tranches = 0;
      for (let k = 0; k < cfg.maxUnits; k++) {
        const level = path.entry * Math.pow(cfg.stepMultiple, k);
        if (k > 0 && path.peak < level) break;
        const f = cfg.unitSol / level;
        const out = proceeds(path.exit, f);
        if (out === null) return null;
        staked += cfg.unitSol;
        returned += out;
        tranches++;
      }
      if (tranches === 0) return null;
      return {
        mint: "",
        stakedSol: staked,
        returnedSol: returned,
        netSol: returned - staked,
        entryFraction: cfg.unitSol / path.entry,
        entryLiquiditySol: path.entry,
        tranches,
      };
    },
  };
}

/**
 * THE WRONG MODEL. Reuses the recorded exit/entry ratio at a new stake, as if
 * slippage did not depend on size. Included only so the report can show what
 * it claims next to what the constant-product model claims.
 */
export function naiveRatioReuse(stakeSol: number): Strategy {
  return {
    label: `WRONG: flat ${stakeSol} SOL x recorded ratio (ignores slippage)`,
    wrong: true,
    size(path) {
      if (!(stakeSol > 0)) return null;
      const ratio = path.exit / path.entry;
      return single(path, stakeSol, stakeSol * ratio, stakeSol / path.entry);
    },
  };
}

function single(path: LiquidityPath, staked: number, returned: number, f: number): PositionResult {
  return { mint: "", stakedSol: staked, returnedSol: returned, netSol: returned - staked, entryFraction: f, entryLiquiditySol: path.entry, tranches: 1 };
}

export interface StrategyReport {
  label: string;
  wrong: boolean;
  positions: number;
  stakedSol: number;
  returnedSol: number;
  netSol: number;
  /** Null when nothing was staked - never 0%. */
  netPercent: number | null;
  wins: number;
  /** Null below `minForRate` positions. */
  winRate: number | null;
  medianNetSol: number | null;
  medianMultiple: number | null;
  /** Positions the strategy declined to enter (stake too large for the pool). Not in any total. */
  skipped: number;
  worst: PositionResult | null;
  best: PositionResult | null;
  /** Net with the single best position removed - how much one outlier carries. */
  netWithoutBestSol: number | null;
  /** Largest and smallest share of a pool the strategy ever took. */
  entryFractionRange: { min: number; max: number } | null;
}

export const MIN_FOR_RATE = 30;

export interface SizingBacktest {
  reports: StrategyReport[];
  /** Records used in every strategy. */
  evaluated: number;
  /** Records excluded and why - never folded in. */
  excluded: { count: number; reasons: Record<string, number> };
  sample: SampleLimits;
}

export interface SampleLimits {
  closedPositions: number;
  firstOpenedAt: string | null;
  lastClosedAt: string | null;
  spanHours: number | null;
  byLiveVerdict: Record<string, number>;
  entryLiquidity: { min: number; median: number; max: number } | null;
  /** Positions whose pool ever reached 2x entry - the pyramid's raw material. */
  everDoubled: number;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function evaluateStrategy(records: ClosedPaperRecord[], strategy: Strategy): StrategyReport {
  const results: PositionResult[] = [];
  let skipped = 0;
  for (const r of records) {
    const path = liquidityPath(r);
    if (!path) continue;
    const res = strategy.size(path);
    if (!res) continue;
    if (isSkipped(res)) { skipped++; continue; }
    results.push({ ...res, mint: r.mint });
  }
  const staked = results.reduce((a, r) => a + r.stakedSol, 0);
  const returned = results.reduce((a, r) => a + r.returnedSol, 0);
  const wins = results.filter((r) => r.netSol > 0).length;
  const sorted = [...results].sort((a, b) => a.netSol - b.netSol);
  const worst = sorted[0] ?? null;
  const best = sorted[sorted.length - 1] ?? null;
  const fr = results.map((r) => r.entryFraction);
  return {
    label: strategy.label,
    wrong: strategy.wrong === true,
    positions: results.length,
    stakedSol: staked,
    returnedSol: returned,
    netSol: returned - staked,
    netPercent: staked > 0 ? ((returned - staked) / staked) * 100 : null,
    wins,
    winRate: results.length >= MIN_FOR_RATE ? wins / results.length : null,
    skipped,
    medianNetSol: median(results.map((r) => r.netSol)),
    medianMultiple: median(results.filter((r) => r.stakedSol > 0).map((r) => r.returnedSol / r.stakedSol)),
    worst,
    best,
    netWithoutBestSol: best ? returned - staked - best.netSol : null,
    entryFractionRange: fr.length ? { min: Math.min(...fr), max: Math.max(...fr) } : null,
  };
}

export function sampleLimits(records: ClosedPaperRecord[]): SampleLimits {
  const usable = records.filter((r) => liquidityPath(r) !== null);
  const opened = usable.map((r) => r.openedAt).sort();
  const closed = usable.map((r) => r.closedAt).filter((x): x is string => !!x).sort();
  const first = opened[0] ?? null;
  const last = closed[closed.length - 1] ?? null;
  const by: Record<string, number> = {};
  for (const r of usable) by[r.liveVerdict] = (by[r.liveVerdict] ?? 0) + 1;
  const L = usable.map((r) => r.entryLiquiditySol);
  return {
    closedPositions: usable.length,
    firstOpenedAt: first,
    lastClosedAt: last,
    spanHours: first && last ? (Date.parse(last) - Date.parse(first)) / 3_600_000 : null,
    byLiveVerdict: by,
    entryLiquidity: L.length ? { min: Math.min(...L), median: median(L) as number, max: Math.max(...L) } : null,
    everDoubled: usable.filter((r) => {
      const p = liquidityPath(r);
      return p !== null && p.peak >= 2 * p.entry;
    }).length,
  };
}

export function runSizingBacktest(records: ClosedPaperRecord[], strategies: Strategy[]): SizingBacktest {
  const reasons: Record<string, number> = {};
  let excluded = 0;
  for (const r of records) {
    if (liquidityPath(r) !== null) continue;
    excluded++;
    const why = r.outcome !== "closed" ? `outcome ${r.outcome}` : r.exitProceedsSol === null ? "no exit proceeds" : "unreadable liquidity";
    reasons[why] = (reasons[why] ?? 0) + 1;
  }
  return {
    reports: strategies.map((s) => evaluateStrategy(records, s)),
    evaluated: records.length - excluded,
    excluded: { count: excluded, reasons },
    sample: sampleLimits(records),
  };
}

const sol = (x: number | null, d = 2) => (x === null ? "n/a" : x.toFixed(d));
const pct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);

export function formatReport(b: SizingBacktest): string {
  const L: string[] = [];
  L.push("Position sizing backtest - recomputed through the constant-product model at each stake");
  L.push("=".repeat(96));
  L.push(`  closed positions used: ${b.evaluated}   excluded: ${b.excluded.count}${
    b.excluded.count ? ` (${Object.entries(b.excluded.reasons).map(([k, v]) => `${k}: ${v}`).join(", ")})` : ""}`);
  L.push("");
  L.push(`  ${"strategy".padEnd(58)} ${"n".padStart(4)} ${"skip".padStart(4)} ${"staked".padStart(8)} ${"returned".padStart(9)} ${"net".padStart(8)} ${"net%".padStart(8)} ${"win rate".padStart(9)} ${"median x".padStart(9)} ${"worst".padStart(8)} ${"best".padStart(8)}`);
  L.push("  " + "-".repeat(140));
  for (const r of b.reports) {
    const wr = r.winRate === null ? `n/a(${r.wins}/${r.positions})` : `${(r.winRate * 100).toFixed(1)}%`;
    L.push(
      `  ${(r.wrong ? "!! " : "") + r.label}`.padEnd(60) +
        ` ${String(r.positions).padStart(4)} ${String(r.skipped).padStart(4)} ${sol(r.stakedSol).padStart(8)} ${sol(r.returnedSol).padStart(9)} ${sol(r.netSol).padStart(8)} ${pct(r.netPercent).padStart(8)} ${wr.padStart(9)} ${sol(r.medianMultiple, 3).padStart(9)} ${sol(r.worst?.netSol ?? null, 3).padStart(8)} ${sol(r.best?.netSol ?? null, 3).padStart(8)}`
    );
  }
  L.push("");
  for (const r of b.reports) {
    L.push(`  ${r.wrong ? "!! " : ""}${r.label}`);
    if (r.worst) {
      L.push(`      largest single loss: ${r.worst.netSol.toFixed(4)} SOL - staked ${r.worst.stakedSol.toFixed(4)} into a ${r.worst.entryLiquiditySol.toFixed(2)}-SOL pool (${(r.worst.entryFraction * 100).toFixed(2)}% of it), got back ${r.worst.returnedSol.toFixed(4)}  [${r.worst.mint.slice(0, 8)}…]`);
    }
    if (r.best) {
      L.push(`      largest single win:  +${r.best.netSol.toFixed(4)} SOL - staked ${r.best.stakedSol.toFixed(4)} into a ${r.best.entryLiquiditySol.toFixed(4)}-SOL pool (${(r.best.entryFraction * 100).toFixed(2)}% of it), got back ${r.best.returnedSol.toFixed(4)}  [${r.best.mint.slice(0, 8)}…]`);
      L.push(`      net WITHOUT that one position: ${sol(r.netWithoutBestSol)} SOL`);
    }
    if (r.entryFractionRange) {
      L.push(`      share of pool taken at entry: ${(r.entryFractionRange.min * 100).toFixed(3)}% to ${(r.entryFractionRange.max * 100).toFixed(1)}%`);
    }
    L.push(`      median net per position: ${sol(r.medianNetSol, 4)} SOL`);
    if (r.skipped) L.push(`      NOT ENTERED: ${r.skipped} position(s) where the stake exceeded the strategy's share cap - excluded from every figure above`);
  }
  L.push("");
  const s = b.sample;
  L.push("  SAMPLE LIMITS - read these before the numbers");
  L.push(`    ${s.closedPositions} closed positions between ${s.firstOpenedAt ?? "?"} and ${s.lastClosedAt ?? "?"} (${s.spanHours === null ? "?" : s.spanHours.toFixed(1)} hours).`);
  L.push(`    live verdict: ${Object.entries(s.byLiveVerdict).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} - ${
    Object.keys(s.byLiveVerdict).length === 1 && s.byLiveVerdict.REJECTED ? "EVERY one is a token the live filters rejected. This is the reject pile, not a random sample." : "mixed."}`);
  if (s.entryLiquidity) L.push(`    entry pools from ${s.entryLiquidity.min.toFixed(4)} to ${s.entryLiquidity.max.toFixed(2)} SOL, median ${s.entryLiquidity.median.toFixed(2)}.`);
  L.push(`    ${s.everDoubled} positions ever reached 2x entry - that is all the pyramid had to work with.`);
  L.push(`    Exit points are the trailing stop's RECORDED exits, which depend only on L_t/L_0 and so are the same at any fixed stake.`);
  L.push(`    Pyramid adds are priced AT each level, which flatters it: the real first observation past a level overshoots.`);
  L.push(`    Win rates are null below ${MIN_FOR_RATE} positions. Nothing here changes live sizing.`);
  return L.join("\n");
}
