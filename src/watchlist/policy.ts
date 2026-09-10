/**
 * When to look at a token again, when to spend real RPC on it, and when to
 * give up on it. Pure functions over a token's liquidity history - no network,
 * no clock of its own, no config loading - so every rule here is testable in
 * isolation and gives the same answer for the same input.
 *
 * ## The problem this exists to solve
 *
 * The live path evaluates a token once, a few hundred milliseconds after it is
 * detected, and then forgets it forever. Real data from 2026-09-09 says that
 * cannot work: of 1,236 tracked tokens exactly 3 became worth buying, and BOTH
 * of the winners inspected in detail started BELOW `filters.minLiquiditySol`
 * and grew past it later (0.278 -> 4.348 SOL, and 1.429 -> 7.39 SOL). They were
 * rejected for being new, not for being bad. A token is not a thing you judge
 * once; it is a thing that develops or doesn't.
 *
 * ## The constraint that shapes everything
 *
 * Watching thousands of tokens continuously is trivially easy to write and
 * impossible to run. The bot is already returning 429s on a free RPC tier, and
 * the latency audit found the wallet-activity call alone accounts for ~91% of
 * all RPC traffic (`polling.walletActivitySampleSize: 100` means ~110 calls to
 * compute two numbers).
 *
 * So the cost structure decides the design:
 *
 *   - a liquidity reading is ONE `getBalance` call
 *   - a full metrics + filter evaluation is ~110 calls
 *
 * Which means the cheap signal has to decide who earns the expensive one. Poll
 * liquidity often; run the full evaluation only for tokens whose liquidity has
 * actually done something. That is roughly a hundredfold reduction in expensive
 * work versus re-evaluating everything, and it costs nothing in coverage
 * because liquidity growth is precisely what separated the winners in the real
 * data anyway.
 *
 * ## Nothing here decides to buy
 *
 * This file decides who gets *looked at*. Whether a token passes is still
 * `evaluateFilters`, and whether anything is bought is still the trading
 * engine behind `trading.enabled`. Keeping "deserves a closer look" separate
 * from "is worth buying" is what stops a scheduling heuristic quietly becoming
 * a trading rule.
 */

export type WatchStage =
  /** Detected, nothing has happened yet. The overwhelming majority stay here and die. */
  | "fresh"
  /** Liquidity is growing. Worth watching more closely. */
  | "warming"
  /** Close to the bonding-curve graduation threshold - the highest-information moment. */
  | "near-migration"
  /** Graduated to a real AMM pool. */
  | "migrated"
  /** Went nowhere, or collapsed. Stop spending calls on it. */
  | "dead";

export interface LiquidityReading {
  /** Epoch ms the reading was taken. */
  atMs: number;
  /** Bonding-curve SOL. Null when the read failed - which is NOT zero. */
  sol: number | null;
}

export interface WatchEntry {
  mint: string;
  source: string;
  signature: string;
  poolAddress?: string;
  detectedAtMs: number;
  /** Oldest first. Trimmed to a bounded window by the runtime. */
  readings: LiquidityReading[];
  stage: WatchStage;
  /** Epoch ms this token is next due a cheap liquidity check. */
  nextCheckAtMs: number;
  /** How many full (expensive) evaluations this token has already been given. */
  fullChecks: number;
  /** Consecutive failed liquidity reads - distinguishes "RPC is struggling" from "token is dead". */
  consecutiveFailures: number;
}

export interface WatchPolicyConfig {
  /** Liquidity at or below this, with no growth, means the token never started. */
  deadBelowSol: number;
  /** How many checks a token gets to show any life before it is evicted. */
  patienceChecks: number;
  /** Stop watching entirely past this age - beyond it, entering is no longer early. */
  maxAgeMs: number;

  /** Growth from the first reading that earns a full evaluation. */
  promoteOnMultiple: number;
  /** Absolute liquidity that earns a full evaluation regardless of growth. */
  promoteOnAbsoluteSol: number;
  /** Most full evaluations any single token may ever consume. */
  maxFullChecksPerToken: number;

  /**
   * Bonding-curve SOL at which a Pump.fun token graduates to a real pool.
   *
   * ASSUMPTION, not a measured constant. Pump.fun's graduation threshold has
   * changed over time and this project has not verified the current value
   * against chain data. It is config precisely so it can be corrected without
   * a code change, and `near-migration` is a scheduling hint rather than a
   * trading trigger, so being wrong here costs polling frequency and nothing
   * else. Verify before anything downstream treats it as fact.
   */
  graduationSol: number;
  /** Fraction of graduationSol at which a token counts as near-migration. */
  nearMigrationFraction: number;

  /** Check intervals per stage, in ms. */
  intervalFreshMs: number;
  intervalWarmingMs: number;
  intervalNearMigrationMs: number;
}

export const DEFAULT_WATCH_POLICY: WatchPolicyConfig = {
  // The median tracked token sat at 0.002 SOL an hour in, so this evicts the
  // bulk of them quickly while staying an order of magnitude above that median.
  deadBelowSol: 0.05,
  patienceChecks: 5,
  maxAgeMs: 6 * 60 * 60 * 1000,

  // Both known winners more than doubled off a small base before they were
  // worth anything. 2.5x off a tiny base is cheap to check and rare enough not
  // to flood the expensive path.
  promoteOnMultiple: 2.5,
  promoteOnAbsoluteSol: 3,
  maxFullChecksPerToken: 4,

  graduationSol: 85,
  nearMigrationFraction: 0.7,

  intervalFreshMs: 60_000,
  intervalWarmingMs: 30_000,
  intervalNearMigrationMs: 15_000,
};

/** Most recent successful reading, or null when none succeeded. */
export function latestSol(entry: WatchEntry): number | null {
  for (let i = entry.readings.length - 1; i >= 0; i--) {
    const r = entry.readings[i];
    if (r.sol !== null) return r.sol;
  }
  return null;
}

/** First successful reading - the baseline growth is measured against. */
export function baselineSol(entry: WatchEntry): number | null {
  for (const r of entry.readings) {
    if (r.sol !== null) return r.sol;
  }
  return null;
}

/**
 * Growth from baseline to latest. Null when either end is unmeasurable or the
 * baseline is zero - an unmeasured baseline is not a zero baseline, and
 * dividing by an assumed zero manufactures infinite growth out of a failed read.
 */
export function growthMultiple(entry: WatchEntry): number | null {
  const base = baselineSol(entry);
  const now = latestSol(entry);
  if (base === null || now === null || base <= 0) return null;
  return now / base;
}

/**
 * Which stage a token is in, from its liquidity history alone.
 *
 * Ordering matters: migration and near-migration are checked before death, so
 * a token that reached a real pool is never evicted for a subsequent dip.
 */
export function classifyStage(entry: WatchEntry, policy: WatchPolicyConfig, nowMs: number): WatchStage {
  // Already on a real AMM - it graduated, whatever its curve balance now reads.
  if (entry.source === "raydium") return "migrated";

  const now = latestSol(entry);
  const growth = growthMultiple(entry);
  const successfulReads = entry.readings.filter((r) => r.sol !== null).length;

  if (now !== null && now >= policy.graduationSol) return "migrated";
  if (now !== null && now >= policy.graduationSol * policy.nearMigrationFraction) return "near-migration";

  if (nowMs - entry.detectedAtMs >= policy.maxAgeMs) return "dead";

  // Only call it dead once it has actually been LOOKED at enough times. A token
  // with four failed reads has told us nothing about itself, and evicting it
  // would silently bias the sample toward whatever the RPC happened to answer.
  if (successfulReads >= policy.patienceChecks) {
    const flat = growth === null || growth < 1.2;
    if (now !== null && now <= policy.deadBelowSol && flat) return "dead";
  }

  if (growth !== null && growth >= 1.5) return "warming";
  if (now !== null && now >= policy.promoteOnAbsoluteSol) return "warming";
  return "fresh";
}

/**
 * Whether this token has earned a full (expensive) metrics evaluation.
 *
 * Deliberately conservative: the whole point is that ~110 RPC calls are spent
 * on a token only once it has shown it might be going somewhere.
 */
export function shouldRunFullCheck(entry: WatchEntry, policy: WatchPolicyConfig, stage: WatchStage): boolean {
  if (stage === "dead") return false;
  if (entry.fullChecks >= policy.maxFullChecksPerToken) return false;

  const now = latestSol(entry);
  const growth = growthMultiple(entry);

  // Near migration is the highest-information moment there is: demand is proven
  // and the graduation move has not happened yet. Always worth the calls.
  if (stage === "near-migration" || stage === "migrated") return true;

  if (now !== null && now >= policy.promoteOnAbsoluteSol) return true;
  if (growth !== null && growth >= policy.promoteOnMultiple && now !== null && now > policy.deadBelowSol) return true;

  return false;
}

/** When to take the next cheap liquidity reading. */
export function nextCheckDelayMs(stage: WatchStage, policy: WatchPolicyConfig): number {
  switch (stage) {
    case "near-migration":
      return policy.intervalNearMigrationMs;
    case "warming":
      return policy.intervalWarmingMs;
    case "migrated":
    case "fresh":
      return policy.intervalFreshMs;
    case "dead":
      return Number.POSITIVE_INFINITY;
  }
}

/**
 * Ordering for a budget-limited round: who gets checked when there aren't
 * enough calls for everyone.
 *
 * Most-overdue-first within stage, and closer-to-migration first across stages.
 * The alternative - plain insertion order - would spend a scarce budget on the
 * oldest fresh tokens, which are overwhelmingly the dead ones.
 */
export function checkPriority(entry: WatchEntry, stage: WatchStage, nowMs: number): number {
  const stageRank: Record<WatchStage, number> = {
    "near-migration": 0,
    warming: 1,
    migrated: 2,
    fresh: 3,
    dead: 4,
  };
  const overdueMs = Math.max(0, nowMs - entry.nextCheckAtMs);
  // Stage dominates; lateness breaks ties within a stage.
  return stageRank[stage] * 1_000_000_000 - overdueMs;
}
