/**
 * Paper-trading performance analyzer - PURE functions over already-parsed
 * log records. No file I/O, no network, no config loading.
 *
 * Why pure and config-free: `loadConfig()` throws when RPC_URL is unset, so
 * importing config here would make this module (and its tests) impossible to
 * run without a .env. This is a post-hoc reporting tool that reads local
 * files - requiring an RPC endpoint to do that would be absurd. File paths
 * are passed in by the CLI wrapper instead (scripts/analyze-paper-performance.ts).
 *
 * Everything here treats "couldn't determine" as null, never as 0 - the same
 * fail-closed rule the filters use. A metric that could not be computed is
 * reported as unknown, not as a flattering zero.
 */

/** One line from logs/paper-trades.jsonl (or trades.jsonl). Only fields we read are typed. */
export interface TradeRecord {
  ts?: string;
  event?: string;
  isPaper?: boolean;
  mint?: string;
  entryPriceSol?: number;
  exitPriceSol?: number;
  sizeSol?: number;
  sizeSolReceived?: number;
  sizeTokens?: number;
  sizeTokensSold?: number;
  pnlSol?: number;
  pnlPercent?: number;
  reason?: string;
  txSignature?: string;
  [key: string]: unknown;
}

/** One line from logs/decisions.jsonl. */
export interface DecisionRecord {
  ts?: string;
  decision?: string;
  source?: string;
  mint?: string;
  reasons?: string[];
  evaluatedAt?: string;
  [key: string]: unknown;
}

/**
 * How a sell was triggered. Derived from the free-text `reason` string the
 * exit logic writes - there is no structured exit-type field in the log, so
 * classification is by prefix. See src/trading/exitLogic.ts for the wording.
 */
export type ExitKind =
  | "ladder"
  | "atr-stop"
  | "trailing-stop"
  | "time-stop"
  | "unclassified";

export interface ClassifiedExit {
  kind: ExitKind;
  /** For kind === "ladder", the tier multiple (2, 5, 10). Null otherwise. */
  ladderTier: number | null;
}

/** A buy plus every sell that closed against it. */
export interface ReconstructedPosition {
  mint: string;
  openedAt: string | null;
  closedAt: string | null;
  /** SOL put in at entry. */
  sizeSol: number;
  /** Sum of pnlSol across all sells attached to this position. */
  totalPnlSol: number;
  /** totalPnlSol / sizeSol * 100. Null when sizeSol is 0/unknown. */
  returnPercent: number | null;
  /** True once a sell of kind atr-stop / trailing-stop / time-stop landed, or the full size was sold. */
  isClosed: boolean;
  exits: ClassifiedExit[];
  holdingHours: number | null;
}

export interface LadderTierStat {
  tier: number;
  /** How many closed positions hit this tier at least once. */
  positionsHit: number;
  /** positionsHit as a % of all closed positions. */
  percentOfClosed: number;
}

export interface PerformanceReport {
  /** Positions that reached a terminal exit. Win rate etc. are computed over these only. */
  closedPositions: number;
  openPositions: number;
  wins: number;
  losses: number;
  breakEven: number;
  /** % of closed positions with totalPnlSol > 0. Null when there are no closed positions. */
  winRatePercent: number | null;
  lossRatePercent: number | null;
  /** Mean return % across winning positions only. Null when there are none. */
  averageWinPercent: number | null;
  /** Mean return % across losing positions only, reported POSITIVE (a 12% loss is 12). */
  averageLossPercent: number | null;
  /** winRate * avgWin - lossRate * avgLoss, in percentage points per trade. */
  expectancyPercent: number | null;
  totalPnlSol: number;
  /** Largest peak-to-trough fall on the cumulative closed-position equity curve, in SOL. */
  maxDrawdownSol: number;
  /** Same drawdown as a % of the running peak it fell from. Null when the peak was <= 0. */
  maxDrawdownPercent: number | null;
  medianHoldingHours: number | null;
  maxHoldingHours: number | null;
  ladderTiers: LadderTierStat[];
  /** Terminal (non-ladder) exit counts as a % of closed positions. */
  exitKindCounts: Record<ExitKind, number>;
  exitKindPercentOfClosed: Record<ExitKind, number>;
  /** Non-trade events, surfaced so they aren't silently ignored. */
  rejectedBuys: number;
  failedExecutions: number;
  abandoned: number;
  reconciliationMismatches: number;
  /** Records skipped because isPaper was not true while in paper mode. */
  skippedNonPaperRecords: number;
  decisionsTotal: number;
  decisionsPassed: number;
  decisionsSkipped: number;
  /** Most common SKIP reasons, descending. */
  topSkipReasons: Array<{ reason: string; count: number }>;
}

/**
 * Classify a sell's free-text reason. The exit logic writes these prefixes:
 *   "ATR stop-loss hit: ..."   "trailing stop hit: ..."
 *   "time-stop: ..."           "ladder tier hit: 2.00x >= 2x - selling 50% ..."
 * Anything else is "unclassified" rather than being forced into a bucket -
 * a mystery exit should be visible, not quietly counted as a stop-loss.
 */
export function classifyExitReason(reason: string | undefined): ClassifiedExit {
  const r = (reason ?? "").trim().toLowerCase();
  if (r.startsWith("ladder tier hit")) {
    // "ladder tier hit: 2.00x >= 2x - selling 50% of remainder" -> tier 2
    const m = r.match(/>=\s*([0-9]+(?:\.[0-9]+)?)x/);
    return { kind: "ladder", ladderTier: m ? Number(m[1]) : null };
  }
  if (r.startsWith("atr stop-loss hit")) return { kind: "atr-stop", ladderTier: null };
  if (r.startsWith("trailing stop hit")) return { kind: "trailing-stop", ladderTier: null };
  if (r.startsWith("time-stop")) return { kind: "time-stop", ladderTier: null };
  return { kind: "unclassified", ladderTier: null };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function hoursBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (b - a) / 3_600_000;
}

/**
 * Rebuild positions from the flat event log. A position opens on a `buy` for
 * a mint and accumulates every later `sell` for that mint until a terminal
 * exit lands; a second `buy` for the same mint starts a new position, so a
 * mint traded twice is two rows rather than one merged blob.
 *
 * A position counts as closed when a full-exit kind (atr-stop, trailing-stop,
 * time-stop) fires, or when the ladder has sold out the whole remainder.
 * Ladder tiers are partial by design, so a position sitting at 2x with 50%
 * still held is deliberately left OPEN and excluded from win rate.
 */
export function reconstructPositions(records: TradeRecord[]): ReconstructedPosition[] {
  const finished: ReconstructedPosition[] = [];
  const open = new Map<string, ReconstructedPosition & { remainingFraction: number }>();

  for (const rec of records) {
    const mint = rec.mint;
    if (!mint) continue;

    if (rec.event === "buy") {
      // A pre-existing open position for this mint is flushed as-is (still open).
      const existing = open.get(mint);
      if (existing) finished.push(stripInternal(existing));
      open.set(mint, {
        mint,
        openedAt: rec.ts ?? null,
        closedAt: null,
        sizeSol: typeof rec.sizeSol === "number" ? rec.sizeSol : 0,
        totalPnlSol: 0,
        returnPercent: null,
        isClosed: false,
        exits: [],
        holdingHours: null,
        remainingFraction: 1,
      });
      continue;
    }

    if (rec.event === "sell") {
      const pos = open.get(mint);
      if (!pos) continue; // a sell with no matching buy in this file - not attributable
      const exit = classifyExitReason(rec.reason);
      pos.exits.push(exit);
      if (typeof rec.pnlSol === "number") pos.totalPnlSol += rec.pnlSol;
      pos.closedAt = rec.ts ?? pos.closedAt;

      const terminal = exit.kind === "atr-stop" || exit.kind === "trailing-stop" || exit.kind === "time-stop";
      if (terminal) {
        pos.remainingFraction = 0;
      } else if (exit.kind === "ladder") {
        // "selling N% of remainder" - shrink what's left by that fraction.
        const m = (rec.reason ?? "").match(/selling\s+([0-9]+(?:\.[0-9]+)?)%/i);
        const pct = m ? Number(m[1]) : 100;
        pos.remainingFraction *= 1 - pct / 100;
      } else {
        pos.remainingFraction = 0; // unclassified full exit - treat as closed, but flagged
      }

      if (pos.remainingFraction <= 1e-9) {
        pos.isClosed = true;
        finished.push(stripInternal(pos));
        open.delete(mint);
      }
    }
  }

  for (const stillOpen of open.values()) finished.push(stripInternal(stillOpen));
  return finished;
}

function stripInternal(p: ReconstructedPosition & { remainingFraction?: number }): ReconstructedPosition {
  const { remainingFraction, ...rest } = p;
  const returnPercent = rest.sizeSol > 0 ? (rest.totalPnlSol / rest.sizeSol) * 100 : null;
  return { ...rest, returnPercent, holdingHours: hoursBetween(rest.openedAt, rest.closedAt) };
}

/**
 * Largest peak-to-trough decline on the cumulative equity curve built from
 * closed positions in close order. Returns SOL and, where the peak was
 * positive, the same fall as a % of that peak.
 */
export function computeMaxDrawdown(pnlSequence: number[]): { sol: number; percent: number | null } {
  let cumulative = 0;
  let peak = 0;
  let maxDdSol = 0;
  let peakAtMaxDd = 0;

  for (const pnl of pnlSequence) {
    cumulative += pnl;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDdSol) {
      maxDdSol = dd;
      peakAtMaxDd = peak;
    }
  }
  const percent = peakAtMaxDd > 0 ? (maxDdSol / peakAtMaxDd) * 100 : null;
  return { sol: maxDdSol, percent };
}

const ALL_EXIT_KINDS: ExitKind[] = ["ladder", "atr-stop", "trailing-stop", "time-stop", "unclassified"];

/**
 * Build the full report. `ladderTiersConfigured` is passed in (not read from
 * config) so the analyzer stays pure - the CLI supplies 2/5/10 by default.
 * `paperOnly` drops any record not explicitly marked isPaper, so real and
 * simulated history can never be averaged together by accident.
 */
export function analyze(
  trades: TradeRecord[],
  decisions: DecisionRecord[],
  ladderTiersConfigured: number[] = [2, 5, 10],
  paperOnly = true,
): PerformanceReport {
  let skippedNonPaperRecords = 0;
  const usable = trades.filter((t) => {
    if (!paperOnly) return true;
    if (t.isPaper === true) return true;
    skippedNonPaperRecords++;
    return false;
  });

  const positions = reconstructPositions(usable);
  const closed = positions.filter((p) => p.isClosed);
  const openCount = positions.length - closed.length;

  const wins = closed.filter((p) => p.totalPnlSol > 0);
  const losses = closed.filter((p) => p.totalPnlSol < 0);
  const breakEven = closed.filter((p) => p.totalPnlSol === 0);

  const winRatePercent = closed.length > 0 ? (wins.length / closed.length) * 100 : null;
  const lossRatePercent = closed.length > 0 ? (losses.length / closed.length) * 100 : null;

  const winReturns = wins.map((p) => p.returnPercent).filter((v): v is number => v !== null);
  const lossReturns = losses.map((p) => p.returnPercent).filter((v): v is number => v !== null);

  const averageWinPercent =
    winReturns.length > 0 ? winReturns.reduce((a, b) => a + b, 0) / winReturns.length : null;
  // Reported positive: a set of -20% losses averages to 20, so expectancy reads naturally.
  const averageLossPercent =
    lossReturns.length > 0 ? Math.abs(lossReturns.reduce((a, b) => a + b, 0) / lossReturns.length) : null;

  // expectancy = win_rate * avg_win% - loss_rate * avg_loss%, rates as fractions.
  let expectancyPercent: number | null = null;
  if (winRatePercent !== null && lossRatePercent !== null) {
    const w = (winRatePercent / 100) * (averageWinPercent ?? 0);
    const l = (lossRatePercent / 100) * (averageLossPercent ?? 0);
    expectancyPercent = w - l;
  }

  const byCloseTime = [...closed].sort((a, b) => Date.parse(a.closedAt ?? "") - Date.parse(b.closedAt ?? ""));
  const drawdown = computeMaxDrawdown(byCloseTime.map((p) => p.totalPnlSol));

  const holdTimes = closed.map((p) => p.holdingHours).filter((v): v is number => v !== null);

  const ladderTiers: LadderTierStat[] = ladderTiersConfigured.map((tier) => {
    const hit = closed.filter((p) => p.exits.some((e) => e.kind === "ladder" && e.ladderTier === tier)).length;
    return {
      tier,
      positionsHit: hit,
      percentOfClosed: closed.length > 0 ? (hit / closed.length) * 100 : 0,
    };
  });

  const exitKindCounts = Object.fromEntries(ALL_EXIT_KINDS.map((k) => [k, 0])) as Record<ExitKind, number>;
  for (const p of closed) {
    for (const kind of new Set(p.exits.map((e) => e.kind))) exitKindCounts[kind]++;
  }
  const exitKindPercentOfClosed = Object.fromEntries(
    ALL_EXIT_KINDS.map((k) => [k, closed.length > 0 ? (exitKindCounts[k] / closed.length) * 100 : 0]),
  ) as Record<ExitKind, number>;

  const skipReasonCounts = new Map<string, number>();
  let decisionsPassed = 0;
  let decisionsSkipped = 0;
  for (const d of decisions) {
    if (d.decision === "PASS") decisionsPassed++;
    else if (d.decision === "SKIP") {
      decisionsSkipped++;
      for (const reason of d.reasons ?? []) {
        skipReasonCounts.set(reason, (skipReasonCounts.get(reason) ?? 0) + 1);
      }
    }
  }
  const topSkipReasons = [...skipReasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return {
    closedPositions: closed.length,
    openPositions: openCount,
    wins: wins.length,
    losses: losses.length,
    breakEven: breakEven.length,
    winRatePercent,
    lossRatePercent,
    averageWinPercent,
    averageLossPercent,
    expectancyPercent,
    totalPnlSol: closed.reduce((a, p) => a + p.totalPnlSol, 0),
    maxDrawdownSol: drawdown.sol,
    maxDrawdownPercent: drawdown.percent,
    medianHoldingHours: median(holdTimes),
    maxHoldingHours: holdTimes.length > 0 ? Math.max(...holdTimes) : null,
    ladderTiers,
    exitKindCounts,
    exitKindPercentOfClosed,
    rejectedBuys: usable.filter((t) => t.event === "rejected-buy").length,
    failedExecutions: usable.filter((t) => t.event === "failed-execution").length,
    abandoned: usable.filter((t) => t.event === "abandoned").length,
    reconciliationMismatches: usable.filter((t) => t.event === "reconciliation-mismatch").length,
    skippedNonPaperRecords,
    decisionsTotal: decisions.length,
    decisionsPassed,
    decisionsSkipped,
    topSkipReasons,
  };
}
