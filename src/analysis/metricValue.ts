/**
 * Which metrics are worth their credits?
 *
 * Config-free by convention (see CLAUDE.md). Pure: every function takes
 * records and returns numbers; the script feeds it the logs.
 *
 * ## Two questions, kept apart
 *
 * 1. WHERE do the credits go? The RPC meter counts calls per METHOD. A method
 *    is not a metric: `getBalance` is spent by three different callers
 *    (outcome checkpoints, watchlist liquidity checks, stage-1 liquidity), and
 *    `getTransaction` by two (the watcher parsing each detection, and the
 *    wallet-activity sample of 20 transactions per promoted token). So calls
 *    are attributed to PURPOSES using counts from the other logs, and the
 *    attribution is checked: if the purposes do not add up to the meter's
 *    total within a tolerance, the report says so instead of pretending.
 *
 * 2. Does a metric SEPARATE winners from losers? Measured as AUC - the
 *    probability that a random winner scores higher on the metric than a
 *    random loser (0.5 = tells you nothing) - with a 95% interval and a
 *    Mann-Whitney p-value; boolean metrics get Fisher's exact test. The
 *    verdict is deliberately blunt: `insufficient` below a floor per group,
 *    `no evidence` when the interval covers 0.5, `separates` otherwise.
 *
 * ## Null is not zero, here of all places
 *
 * A metric that was never fetched for a token is EXCLUDED from that metric's
 * comparison, and the count of excluded tokens is printed. Treating an
 * unfetched top-holder percentage as 0% would make "unknown" look like the
 * safest tokens in the sample.
 */

export interface DecisionRecord {
  ts: string;
  mint?: string;
  decision?: string;
  source?: string;
  metrics?: Record<string, unknown> | null;
}
export interface PaperClose {
  mint: string;
  openedAt: string;
  outcome: string;
  entryProceedsSol: number;
  exitProceedsSol: number | null;
}
export interface OutcomeRecord {
  mint: string;
  checkpointSeconds: number;
  ok: boolean;
  liquiditySol: number | null;
  baselineLiquiditySol: number | null;
}
export interface WatchlistEvent {
  ts: string;
  event: string;
  mint: string;
  liquiditySol?: number | null;
  uniqueWallets?: number | null;
  transactionCount?: number | null;
  activitySkippedEarly?: boolean | null;
  topHolderPercent?: number | null;
  devWalletPercent?: number | null;
  holderSource?: string | null;
}
export interface MeterRecord {
  startedAt: string;
  at: string;
  rpcCalls: number;
  httpRequests: number;
  methods: { method: string; calls: number; share: number }[];
}

// ---- statistics -------------------------------------------------------------

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, |err| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export interface MannWhitney {
  n1: number;
  n2: number;
  /** U for group 1 (the "winners"). */
  u: number;
  /** P(random winner > random loser), ties counted half. */
  auc: number;
  aucCi95: [number, number];
  z: number;
  pTwoSided: number;
}

/** Average ranks with ties, then U. Group 1 = winners. */
export function mannWhitney(winners: number[], losers: number[]): MannWhitney | null {
  const n1 = winners.length, n2 = losers.length;
  if (n1 === 0 || n2 === 0) return null;
  const all = [...winners.map((v) => ({ v, g: 1 })), ...losers.map((v) => ({ v, g: 2 }))].sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(all.length);
  let tieCorrection = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    const t = j - i + 1;
    if (t > 1) tieCorrection += t * t * t - t;
    i = j + 1;
  }
  let r1 = 0;
  all.forEach((x, i) => { if (x.g === 1) r1 += ranks[i]; });
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieCorrection / (n * (n - 1))));
  const z = sigma > 0 ? (u - mu) / sigma : 0;
  const p = sigma > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1;
  const auc = u / (n1 * n2);
  // Hanley & McNeil (1982) standard error of the AUC.
  const q1 = auc / (2 - auc), q2 = (2 * auc * auc) / (1 + auc);
  const se = Math.sqrt(Math.max(0, (auc * (1 - auc) + (n1 - 1) * (q1 - auc * auc) + (n2 - 1) * (q2 - auc * auc)) / (n1 * n2)));
  return { n1, n2, u, auc, aucCi95: [Math.max(0, auc - 1.96 * se), Math.min(1, auc + 1.96 * se)], z, pTwoSided: Math.min(1, p) };
}

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}
function logHyper(a: number, b: number, c: number, d: number): number {
  // P(table | margins) for [[a,b],[c,d]]
  const n = a + b + c + d;
  return logFactorial(a + b) + logFactorial(c + d) + logFactorial(a + c) + logFactorial(b + d)
    - logFactorial(n) - logFactorial(a) - logFactorial(b) - logFactorial(c) - logFactorial(d);
}

export interface Fisher {
  /** [[winnersTrue, winnersFalse],[losersTrue, losersFalse]] */
  table: [[number, number], [number, number]];
  winnerRate: number;
  loserRate: number;
  pTwoSided: number;
}

/** Two-sided Fisher exact test: sum of probabilities of tables at least as extreme. */
export function fisherExact(a: number, b: number, c: number, d: number): Fisher {
  const r1 = a + b, c1 = a + c, n = a + b + c + d;
  const pObs = Math.exp(logHyper(a, b, c, d));
  let p = 0;
  const lo = Math.max(0, r1 - (n - c1)), hi = Math.min(r1, c1);
  for (let x = lo; x <= hi; x++) {
    const px = Math.exp(logHyper(x, r1 - x, c1 - x, n - r1 - c1 + x));
    if (px <= pObs * (1 + 1e-9)) p += px;
  }
  return {
    table: [[a, b], [c, d]],
    winnerRate: r1 > 0 ? a / r1 : NaN,
    loserRate: c + d > 0 ? c / (c + d) : NaN,
    pTwoSided: Math.min(1, p),
  };
}

// ---- metrics ------------------------------------------------------------------

export type Verdict = "separates" | "no evidence" | "insufficient";

export const MIN_PER_GROUP = 30;

export interface MetricAssessment {
  metric: string;
  kind: "numeric" | "boolean";
  /** Tokens in the sample where this metric had a value. */
  winnersWithValue: number;
  losersWithValue: number;
  /** Tokens EXCLUDED because the metric was never fetched. */
  winnersMissing: number;
  losersMissing: number;
  winnerMedian: number | null;
  loserMedian: number | null;
  winnerRate: number | null;
  loserRate: number | null;
  auc: number | null;
  aucCi95: [number, number] | null;
  pTwoSided: number | null;
  verdict: Verdict;
  /** Plain-language reason for the verdict. */
  because: string;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

export function assessNumeric(metric: string, winners: (number | null | undefined)[], losers: (number | null | undefined)[]): MetricAssessment {
  const w = winners.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const l = losers.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const base: MetricAssessment = {
    metric, kind: "numeric",
    winnersWithValue: w.length, losersWithValue: l.length,
    winnersMissing: winners.length - w.length, losersMissing: losers.length - l.length,
    winnerMedian: median(w), loserMedian: median(l), winnerRate: null, loserRate: null,
    auc: null, aucCi95: null, pTwoSided: null, verdict: "insufficient", because: "",
  };
  if (w.length < MIN_PER_GROUP || l.length < MIN_PER_GROUP) {
    return { ...base, because: `only ${w.length} winners and ${l.length} losers have a value; ${MIN_PER_GROUP} each is the floor` };
  }
  const mw = mannWhitney(w, l)!;
  const covers = mw.aucCi95[0] <= 0.5 && mw.aucCi95[1] >= 0.5;
  return {
    ...base, auc: mw.auc, aucCi95: mw.aucCi95, pTwoSided: mw.pTwoSided,
    verdict: covers ? "no evidence" : "separates",
    because: covers
      ? `AUC ${mw.auc.toFixed(2)} with 95% interval ${mw.aucCi95.map((x) => x.toFixed(2)).join("-")} covers 0.50 - indistinguishable from a coin flip at this sample`
      : `AUC ${mw.auc.toFixed(2)} (${mw.aucCi95.map((x) => x.toFixed(2)).join("-")}), p=${mw.pTwoSided.toExponential(1)} - winners score ${mw.auc > 0.5 ? "higher" : "lower"}`,
  };
}

export function assessBoolean(metric: string, winners: (boolean | null | undefined)[], losers: (boolean | null | undefined)[]): MetricAssessment {
  const w = winners.filter((v): v is boolean => typeof v === "boolean");
  const l = losers.filter((v): v is boolean => typeof v === "boolean");
  const a = w.filter(Boolean).length, b = w.length - a, c = l.filter(Boolean).length, d = l.length - c;
  const base: MetricAssessment = {
    metric, kind: "boolean",
    winnersWithValue: w.length, losersWithValue: l.length,
    winnersMissing: winners.length - w.length, losersMissing: losers.length - l.length,
    winnerMedian: null, loserMedian: null,
    winnerRate: w.length ? a / w.length : null, loserRate: l.length ? c / l.length : null,
    auc: null, aucCi95: null, pTwoSided: null, verdict: "insufficient", because: "",
  };
  if (w.length < MIN_PER_GROUP || l.length < MIN_PER_GROUP) {
    return { ...base, because: `only ${w.length} winners and ${l.length} losers have a value; ${MIN_PER_GROUP} each is the floor` };
  }
  const f = fisherExact(a, b, c, d);
  // For a boolean the AUC is 0.5 + (winnerRate - loserRate)/2.
  const auc = 0.5 + (f.winnerRate - f.loserRate) / 2;
  const sig = f.pTwoSided < 0.05;
  return {
    ...base, auc, pTwoSided: f.pTwoSided,
    verdict: sig ? "separates" : "no evidence",
    because: sig
      ? `true for ${(f.winnerRate * 100).toFixed(0)}% of winners vs ${(f.loserRate * 100).toFixed(0)}% of losers, Fisher p=${f.pTwoSided.toExponential(1)}`
      : `true for ${(f.winnerRate * 100).toFixed(0)}% of winners vs ${(f.loserRate * 100).toFixed(0)}% of losers, Fisher p=${f.pTwoSided.toFixed(2)} - not distinguishable at this sample`,
  };
}

/**
 * How many more winners would be needed before a metric could be assessed at
 * all, given how often it is actually fetched and how often a position wins.
 */
export function positionsNeeded(fetchRate: number, winRate: number, minWinnersWithValue = MIN_PER_GROUP): number | null {
  if (!(fetchRate > 0) || !(winRate > 0)) return null;
  return Math.ceil(minWinnersWithValue / (fetchRate * winRate));
}

// ---- samples ------------------------------------------------------------------

export interface PaperSample {
  winners: DecisionRecord[];
  losers: DecisionRecord[];
  /** Closed positions with no decision record - excluded, counted. */
  unjoined: number;
}

/** Joins closed paper positions to the FIRST decision record for the mint. */
export function joinPaperSample(closes: PaperClose[], decisions: DecisionRecord[]): PaperSample {
  const byMint = new Map<string, DecisionRecord>();
  for (const d of decisions) if (d.mint && !byMint.has(d.mint)) byMint.set(d.mint, d);
  const seen = new Set<string>();
  const out: PaperSample = { winners: [], losers: [], unjoined: 0 };
  for (const c of closes) {
    if (c.outcome !== "closed" || c.exitProceedsSol === null) continue;
    const key = `${c.mint}|${c.openedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = byMint.get(c.mint);
    if (!d) { out.unjoined++; continue; }
    (c.exitProceedsSol > c.entryProceedsSol ? out.winners : out.losers).push(d);
  }
  return out;
}

export interface OutcomeSample {
  winners: DecisionRecord[];
  losers: DecisionRecord[];
  /** Tokens with a usable checkpoint but no decision record. */
  unjoined: number;
  checkpointSeconds: number;
  winnerMultiple: number;
}

/**
 * The larger sample: every detected token with an OK checkpoint. A "winner"
 * here is a pool that held at least `winnerMultiple` x its detection baseline
 * at the checkpoint. This is a different question from the paper book's
 * (a trailing-stop exit above entry) and is labelled as such in the report.
 */
export function joinOutcomeSample(outcomes: OutcomeRecord[], decisions: DecisionRecord[], checkpointSeconds: number, winnerMultiple: number): OutcomeSample {
  const byMint = new Map<string, DecisionRecord>();
  for (const d of decisions) if (d.mint && !byMint.has(d.mint)) byMint.set(d.mint, d);
  const seen = new Set<string>();
  const out: OutcomeSample = { winners: [], losers: [], unjoined: 0, checkpointSeconds, winnerMultiple };
  for (const o of outcomes) {
    if (!o.ok || o.checkpointSeconds !== checkpointSeconds) continue;
    if (!(typeof o.liquiditySol === "number") || !(typeof o.baselineLiquiditySol === "number") || o.baselineLiquiditySol <= 0) continue;
    if (seen.has(o.mint)) continue;
    seen.add(o.mint);
    const d = byMint.get(o.mint);
    if (!d) { out.unjoined++; continue; }
    (o.liquiditySol / o.baselineLiquiditySol >= winnerMultiple ? out.winners : out.losers).push(d);
  }
  return out;
}

export interface PromotedSample {
  winners: WatchlistEvent[];
  losers: WatchlistEvent[];
  unjoined: number;
}

/**
 * Promoted tokens carry the expensive metrics (holder and activity) that the
 * detection-time decision almost never has. Outcome: pool SOL at the 6h
 * checkpoint vs the pool SOL at the moment the metric was read.
 */
export function joinPromotedSample(events: WatchlistEvent[], outcomes: OutcomeRecord[], eventName: string, checkpointSeconds: number, winnerMultiple: number): PromotedSample {
  const cp = new Map<string, OutcomeRecord>();
  for (const o of outcomes) if (o.ok && o.checkpointSeconds === checkpointSeconds && typeof o.liquiditySol === "number" && !cp.has(o.mint)) cp.set(o.mint, o);
  const seen = new Set<string>();
  const out: PromotedSample = { winners: [], losers: [], unjoined: 0 };
  for (const e of events) {
    if (e.event !== eventName || seen.has(e.mint)) continue;
    seen.add(e.mint);
    if (!(typeof e.liquiditySol === "number") || e.liquiditySol <= 0) continue;
    const o = cp.get(e.mint);
    if (!o) { out.unjoined++; continue; }
    ((o.liquiditySol as number) / e.liquiditySol >= winnerMultiple ? out.winners : out.losers).push(e);
  }
  return out;
}

export const num = (r: { metrics?: Record<string, unknown> | null } | Record<string, unknown>, key: string): number | null => {
  const m = ("metrics" in r && r.metrics ? r.metrics : r) as Record<string, unknown>;
  const v = m[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
export const bool = (r: { metrics?: Record<string, unknown> | null } | Record<string, unknown>, key: string): boolean | null => {
  const m = ("metrics" in r && r.metrics ? r.metrics : r) as Record<string, unknown>;
  const v = m[key];
  return typeof v === "boolean" ? v : null;
};

// ---- credits ------------------------------------------------------------------

/** Credits per token for each metric, from the code paths that fetch them. 1 credit per JSON-RPC call (Helius, confirmed in config comments). */
export const METRIC_COST: Record<string, { credits: number; method: string; when: string }> = {
  liquiditySol:             { credits: 1,  method: "getBalance",              when: "every evaluated token (stage 1)" },
  mintAuthorityRenounced:   { credits: 1,  method: "getAccountInfo",          when: "every evaluated token (stage 1); freeze, extensions and decimals ride on the same call" },
  topHolderPercent:         { credits: 1,  method: "getTokenLargestAccounts", when: "only tokens that pass the cheap checks, or are promoted from the watchlist" },
  devWalletPercent:         { credits: 1,  method: "getTokenAccountsByOwner", when: "same gate as top holder" },
  creatorLpPercent:         { credits: 2,  method: "getAccountInfo + getTokenAccountsByOwner", when: "Raydium only" },
  uniqueWallets:            { credits: 21, method: "getSignaturesForAddress + 20 x getTransaction", when: "only tokens that reach the activity check (walletActivitySampleSize=20); transactionCount rides on the same calls" },
};

export interface PurposeCounts {
  outcomeCheckpoints: number;
  watchlistChecks: number;
  stage1Liquidity: number;
  stage1Renounce: number;
  detectionsParsed: number;
  activitySamples: number;
  activitySampleSize: number;
  holderTopFetches: number;
  holderDevFetches: number;
}

export interface Attribution {
  windowHours: number;
  meterTotal: number;
  rows: { purpose: string; method: string; credits: number; share: number; isFilterMetric: boolean }[];
  attributed: number;
  unattributed: number;
  /** True when the purposes account for the meter total within tolerance. */
  reconciles: boolean;
}

export const RECONCILE_TOLERANCE = 0.05;

export function attribute(meter: MeterRecord, counts: PurposeCounts): Attribution {
  const hours = (Date.parse(meter.at) - Date.parse(meter.startedAt)) / 3_600_000;
  const rows: Attribution["rows"] = [
    { purpose: "outcome tracker checkpoints (1h/6h/24h liquidity)", method: "getBalance", credits: counts.outcomeCheckpoints, share: 0, isFilterMetric: false },
    { purpose: "watchlist liquidity checks", method: "getBalance", credits: counts.watchlistChecks, share: 0, isFilterMetric: false },
    { purpose: "stage-1 liquidity (filter metric)", method: "getBalance", credits: counts.stage1Liquidity, share: 0, isFilterMetric: true },
    { purpose: "stage-1 renounce/extensions/decimals (filter metric)", method: "getAccountInfo", credits: counts.stage1Renounce, share: 0, isFilterMetric: true },
    { purpose: "watcher: parse each detection's transaction", method: "getTransaction", credits: counts.detectionsParsed, share: 0, isFilterMetric: false },
    { purpose: "wallet-activity sample (filter metric)", method: "getSignaturesForAddress + getTransaction", credits: counts.activitySamples * (1 + counts.activitySampleSize), share: 0, isFilterMetric: true },
    { purpose: "top holder % (filter metric)", method: "getTokenLargestAccounts", credits: counts.holderTopFetches, share: 0, isFilterMetric: true },
    { purpose: "dev wallet % (filter metric)", method: "getTokenAccountsByOwner", credits: counts.holderDevFetches, share: 0, isFilterMetric: true },
  ];
  for (const r of rows) r.share = meter.rpcCalls > 0 ? r.credits / meter.rpcCalls : 0;
  const attributed = rows.reduce((a, r) => a + r.credits, 0);
  return {
    windowHours: hours, meterTotal: meter.rpcCalls, rows, attributed,
    unattributed: meter.rpcCalls - attributed,
    reconciles: meter.rpcCalls > 0 && Math.abs(meter.rpcCalls - attributed) / meter.rpcCalls <= RECONCILE_TOLERANCE,
  };
}

export const fmtP = (p: number | null) => (p === null ? "n/a" : p < 0.001 ? p.toExponential(1) : p.toFixed(3));
