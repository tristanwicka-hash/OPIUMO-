import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { ScheduleConfig, DEFAULT_SCHEDULE, validateSchedule } from "./schedule/scheduler";

/**
 * Re-exported so callers can reach the schedule types from ./config like every
 * other config type. The schedule block is OPTIONAL in config/default.json:
 * when absent it defaults to DEFAULT_SCHEDULE (enabled: false), so the bot
 * behaves exactly as it did before the scheduler existed.
 */
export type { ScheduleConfig, ScheduleWindow } from "./schedule/scheduler";

dotenv.config();

/**
 * All tunables that a non-programmer should be able to change live in
 * config/default.json. Secrets (RPC URL, private key) come from .env.
 * Nothing trading-relevant should ever be hardcoded in src/ - if you find
 * yourself wanting to tweak a threshold, add it here instead.
 */

export interface TakeProfitStep {
  atMultipleOfEntry: number;
  sellPercentOfRemaining: number;
}

export interface JupiterConfig {
  quoteApiUrl: string;
  swapApiUrl: string;
  requestTimeoutMs: number;
}

export interface TradingConfig {
  enabled: boolean;
  /**
   * Safety net UNDER trading.enabled, not a replacement for it. Defaults true, meaning: even
   * once you flip trading.enabled=true, the engine still won't touch real money until you ALSO
   * explicitly set this to false. While true, the engine runs the exact same pipeline as live
   * trading - real Jupiter quotes for sizing/entry/exit prices, real position sizing math, real
   * ATR-stop/trailing-stop/time-stop/take-profit-ladder logic - but every "buy"/"sell" is a
   * simulated fill (see SpotTradingEngine.simulateFill): no transaction is ever built, signed,
   * or sent, and no wallet is required. Paper positions/trades are written to entirely separate
   * files (logging.paperTradesFile, logs/paper-positions.json, logs/paper-price-history.json) so
   * there is no way for simulated activity to ever mix with real position/trade history. This is
   * the tool for validating the exit ladder/trailing-stop/ATR-stop logic against live market data
   * before ever risking real SOL.
   */
  paperTrading: boolean;
  /** Your total trading bankroll in SOL - position sizes are derived from this, not a flat amount. */
  totalCapitalSol: number;
  /** 0.5-1% per the strategy spec. Actual position is ALSO clamped by a non-overridable hard cap in code (src/trading/sizing.ts) that this value cannot loosen. */
  riskPercentPerTrade: number;
  /** Caps how many positions can be open AT ONCE - each trade respects the 1% hard cap individually, but nothing else stops 50 of them stacking up. Not in the original spec; added because that gap was worth closing. */
  maxOpenPositions: number;
  maxSlippageBps: number;
  /**
   * Priority fee in lamports attached to SELL/exit swaps. Sells are the side
   * that matters: failing to exit a dumping token costs real money, and that is
   * precisely when the block is contested.
   */
  sellPriorityFeeLamports: number;
  /**
   * Priority fee for BUY/entry swaps. Defaults to 0 - a missed buy is an
   * opportunity cost, not a loss, and this bot deliberately does not compete on
   * entry speed. Kept configurable rather than hardcoded to 0.
   */
  buyPriorityFeeLamports: number;
  takeProfitLadder: TakeProfitStep[];
  /** ATR-based stop-loss: stopLossPrice = entryPrice - (atrStopMultiplier * ATR(atrPeriod)). */
  atrPeriod: number;
  atrStopMultiplier: number;
  /**
   * A brand-new token has zero price history at the moment you'd enter, so there's no ATR yet
   * to size the stop from - the spec doesn't address this gap, so this is a deliberate addition:
   * a flat % used ONLY for the very first stop (and therefore the entry position size, which is
   * derived from stop distance) until enough price samples accumulate to compute a real ATR
   * stop. Once ATR becomes available, the stop only ever TIGHTENS toward it (moves closer to
   * entry), never loosens back out - see src/trading/engine.ts.
   */
  fallbackStopLossPercent: number;
  /** Trailing stop activates once price has reached this multiple of entry, then trails at trailingStopPercent below the highest price seen since. */
  trailingStopActivateMultiple: number;
  trailingStopPercent: number;
  /** Exit if the position hasn't moved (see src/trading/exitLogic.ts for "moved") within this many hours of entry. */
  timeStopHours: number;
  priceCheckIntervalMs: number;
  /**
   * A failed sell (rugged token, zero liquidity, RPC hiccup, ...) used to retry every single
   * monitoring cycle forever with no backoff and no way to ever stop - on a genuinely dead
   * token that meant hammering Jupiter indefinitely. Fixed: failures now back off exponentially
   * (sellFailureBackoffBaseMs, doubling each consecutive failure, capped at
   * sellFailureBackoffMaxMs), and after maxConsecutiveSellFailures the position is marked
   * abandoned - no further automatic sell attempts, logged loudly, needs your manual review.
   * See src/trading/retry.ts.
   */
  maxConsecutiveSellFailures: number;
  sellFailureBackoffBaseMs: number;
  sellFailureBackoffMaxMs: number;
}

export interface FiltersConfig {
  minLiquiditySol: number;
  maxTopHolderPercent: number;
  maxDevWalletPercent: number;
  requireMintAuthorityRenounced: boolean;
  requireFreezeAuthorityRenounced: boolean;
  minUniqueWallets: number;
  minTransactionCount: number;
  minUniqueWalletToTxRatio: number;
  rejectRiskyTokenExtensions: boolean;
  maxCreatorLpPercent: number;
}

export interface SourcesConfig {
  watchPumpFun: boolean;
  watchRaydium: boolean;
}

export interface PollingConfig {
  metricsMaxAgeMs: number;
  metricsFetchTimeoutMs: number;
  walletActivitySampleSize: number;
  /** How many detected tokens are processed at once. Bounded so the RPC provider isn't flooded. */
  maxConcurrentTokens: number;
  /** Cap on the backlog of waiting tokens; past this the OLDEST is dropped. */
  maxQueuedTokens: number;
}

/**
 * Delayed re-measurement of already-detected tokens. Measurement only - nothing
 * here feeds a PASS/SKIP or a trade.
 */
export interface DelayProbeConfig {
  enabled: boolean;
  /** Ages (seconds after detection) at which to re-collect metrics. */
  delaysSeconds: number[];
  /** Concurrency for probe work, kept separate from the live pipeline's limit. */
  maxConcurrentProbes: number;
  maxQueuedProbes: number;
  /** Cap on tokens with probes still scheduled, so timers can't accumulate without bound. */
  maxPendingTokens: number;
  /**
   * Per-RPC-call timeout for probe collection, separate from
   * polling.metricsFetchTimeoutMs. The live path is latency-critical and wants
   * to give up fast; a probe is not, and giving up early wastes the whole
   * observation AND the calls already spent on it.
   */
  fetchTimeoutMs: number;
  /**
   * Fraction of detected tokens to probe (0-1). Measuring every token exceeds
   * the RPC rate limit; a sampled token is measured with FULL accuracy, so this
   * trades coverage - never precision - for sustainability.
   */
  sampleRate: number;
}

export interface WatchlistConfig {
  enabled: boolean;
  /** How often a budgeted round runs. */
  tickIntervalMs: number;
  /** Hard ceiling on cheap liquidity reads per round - the RPC budget, enforced not hoped for. */
  maxChecksPerTick: number;
  /** Most tokens under observation at once. Refusing past this is visible in the log, never silent. */
  maxWatched: number;

  /* Policy tunables - see src/watchlist/policy.ts for what each one is for. */
  deadBelowSol?: number;
  patienceChecks?: number;
  maxAgeMs?: number;
  promoteOnMultiple?: number;
  promoteOnAbsoluteSol?: number;
  maxFullChecksPerToken?: number;
  graduationSol?: number;
  nearMigrationFraction?: number;
  intervalFreshMs?: number;
  intervalWarmingMs?: number;
  intervalNearMigrationMs?: number;
}

export interface OutcomeTrackerConfig {
  enabled: boolean;
  /**
   * Ages (seconds after detection) at which to re-read the token's liquidity.
   * Longer than the delay probe's ladder on purpose: this measures what a token
   * BECAME, not whether it was measurable yet.
   */
  checkpointsSeconds: number[];
  maxConcurrentChecks: number;
  maxQueuedChecks: number;
  /** Cap on outstanding checkpoints so a detection burst can't grow memory or the state file without bound. */
  maxPendingCheckpoints: number;
  /**
   * Fraction of detected tokens to track (0-1). Defaults to 1 - unlike the
   * delay probe, one checkpoint is a single getBalance call, and winners are
   * rare enough that sampling them would mean observing almost none.
   */
  sampleRate: number;
  /** Where pending checkpoints are persisted so a restart doesn't silently drop a 24h reading. */
  pendingStateFile: string;
  /**
   * Minimum gap between writes of the pending-state file. The whole map is
   * serialised per write, so writing on every event made cost scale with both
   * pending size and detection rate. The exposure is the last few seconds of
   * pending state on a hard kill; SIGINT still flushes synchronously.
   */
  persistDebounceMs: number;
  /**
   * How overdue a restored checkpoint may be and still be taken. Beyond this it
   * is recorded as missed, because filing a badly-late reading as an on-time
   * one corrupts the distribution this exists to measure.
   */
  lateToleranceMs: number;
}

export interface PaperExecutionConfig {
  enabled: boolean;
  poolFraction: number;
  maxOpenPositions: number;
  includeRejected: boolean;
  trailing: {
    hardStopPercent: number;
    activationPercent: number;
    trailPercent: number;
    persistenceObservations: number;
    minHoldMs: number;
  };
  logFile: string;
}

export interface ShadowFilterSetConfig {
  id: string;
  rationale: string;
  /** Only the named keys are overridden; the rest are inherited from the live filters. */
  overrides: Partial<FiltersConfig>;
}

export interface ShadowFiltersConfig {
  enabled: boolean;
  logFile: string;
  sets: ShadowFilterSetConfig[];
}

export interface LoggingConfig {
  level: "minimal" | "info" | "debug";
  logDir: string;
  decisionsFile: string;
  tradesFile: string;
  /** Where paper-trading fills are logged - kept entirely separate from tradesFile (real trades) so the two can never mix. */
  paperTradesFile: string;
  perpsTradesFile: string;
  delayProbeFile: string;
  outcomeFile: string;
  watchlistFile: string;
  maxLogFileSizeMB: number;
  /**
   * RPC burn-rate meter. Both optional: they default in src/rpc/rpcMeter.ts, so
   * config/default.json needs no edit to turn the meter on. Set them here to
   * override. See rpcMeter.ts for why the defaults live in source for now.
   */
  rpcMeterFile?: string;
  rpcMeterIntervalMs?: number;
  /**
   * Install the status-capturing fetch wrapper. Committed default false.
   * OPIUMO_CAPTURE_RPC_STATUS in .env overrides it for a single run.
   */
  captureRpcStatus?: boolean;
}

export interface PerpsConfig {
  /** Master switch - mirrors trading.enabled. No order is ever placed while this is false. */
  enabled: boolean;
  /** 'devnet' (fake funds, safe to break) or 'mainnet-beta' (real money). Defaults to devnet on purpose. */
  env: "devnet" | "mainnet-beta";
  subAccountId: number;
  /** Only these market symbols (e.g. "SOL-PERP") may be traded - anything else is rejected. */
  allowedMarkets: string[];
  maxLeverage: number;
  maxPositionSizeUsd: number;
  maxOpenPositions: number;
  requireStopLoss: boolean;
  defaultStopLossPercent: number;
  defaultTakeProfitPercent: number;
  orderTimeoutMs: number;
}

export interface FundingArbConfig {
  /** Separate from perps.enabled - BOTH must be true for this strategy to place a single order. */
  enabled: boolean;
  market: string;
  spotMarket: string;
  checkIntervalMinutes: number;
  minFundingRateHourlyPercent: number;
  minConsecutiveSettlementsToEnter: number;
  minConsecutiveSettlementsToExit: number;
  maxBasisPercent: number;
  rebalanceDriftPercent: number;
  maxLeverage: number;
  notionalUsd: number;
  estimatedRoundTripCostBps: number;
  minMarginBufferPercent: number;
  historyFile: string;
}

export interface AppConfig {
  jupiter: JupiterConfig;
  trading: TradingConfig;
  filters: FiltersConfig;
  sources: SourcesConfig;
  polling: PollingConfig;
  delayProbe: DelayProbeConfig;
  outcomeTracker: OutcomeTrackerConfig;
  watchlist: WatchlistConfig;
  logging: LoggingConfig;
  schedule: ScheduleConfig;
  paperExecution: PaperExecutionConfig;
  shadowFilters: ShadowFiltersConfig;
  perps: PerpsConfig;
  fundingArb: FundingArbConfig;
  rpcUrl: string;
  wsUrl?: string;
  walletPrivateKey?: string;
}

function loadJsonConfig(): Omit<AppConfig, "rpcUrl" | "wsUrl" | "walletPrivateKey"> {
  // Resolved against process.cwd(), not __dirname - same convention every other file path in
  // this repo already uses (logs/*.jsonl, logs/*.json, etc - see src/util/logger.ts,
  // src/trading/positionStore.ts, ...). __dirname would have been wrong here regardless: it
  // points at wherever THIS compiled/source file happens to sit (dist/src/ after a build,
  // src/ under ts-node), and config/default.json is never copied into dist/ by the build at
  // all - found and fixed after `npm run build && npm start` (documented in the README as a
  // supported way to run this) turned out to have been broken since the very first commit,
  // never caught because every test in this repo runs via ts-node against source, not dist.
  const configPath = path.resolve(process.cwd(), "config", "default.json");
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);
  // Strip "_comment" keys so they never leak into runtime logic.
  const strip = (obj: any): any => {
    if (Array.isArray(obj)) return obj.map(strip);
    if (obj && typeof obj === "object") {
      const out: any = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "_comment") continue;
        out[k] = strip(v);
      }
      return out;
    }
    return obj;
  };
  const stripped = strip(parsed);

  // The schedule block is optional. Absent means DEFAULT_SCHEDULE, which is
  // disabled - so a config file written before the scheduler existed keeps
  // working and keeps behaving identically. A PARTIAL block is filled in from
  // the defaults field by field rather than rejected, so adding just
  // `{"enabled": true, "activeWindows": [...]}` does not also require
  // restating timezone and outsideWindow.
  stripped.schedule = { ...DEFAULT_SCHEDULE, ...(stripped.schedule ?? {}) };

  return stripped;
}

function validate(config: AppConfig): void {
  const errors: string[] = [];

  // Throws with a specific message rather than pushing onto `errors`: a
  // malformed window ("25:00", a start equal to its end) is not a tuning
  // mistake to list alongside others, it is a schedule nobody can reason
  // about, and the message names the exact window.
  validateSchedule(config.schedule);

  if (!config.rpcUrl) errors.push("RPC_URL is not set in .env");
  if (config.trading.totalCapitalSol <= 0) errors.push("trading.totalCapitalSol must be > 0 (your trading bankroll, used to size every position)");
  if (config.trading.riskPercentPerTrade <= 0) errors.push("trading.riskPercentPerTrade must be > 0");
  if (config.trading.takeProfitLadder.length === 0) errors.push("trading.takeProfitLadder must have at least one step");
  if (config.trading.atrPeriod <= 0) errors.push("trading.atrPeriod must be > 0");
  if (config.trading.atrStopMultiplier <= 0) errors.push("trading.atrStopMultiplier must be > 0");
  if (config.trading.fallbackStopLossPercent >= 0) errors.push("trading.fallbackStopLossPercent must be negative (e.g. -30)");
  if (config.trading.maxOpenPositions <= 0) errors.push("trading.maxOpenPositions must be > 0");
  if (config.trading.sellPriorityFeeLamports < 0) errors.push("trading.sellPriorityFeeLamports must be >= 0 (lamports)");
  if (config.trading.buyPriorityFeeLamports < 0) errors.push("trading.buyPriorityFeeLamports must be >= 0 (lamports)");
  if (config.polling.maxConcurrentTokens <= 0) errors.push("polling.maxConcurrentTokens must be > 0 (set it to 1 to process one token at a time)");
  if (config.polling.maxQueuedTokens <= 0) errors.push("polling.maxQueuedTokens must be > 0");
  if (config.delayProbe.enabled) {
    if (!Array.isArray(config.delayProbe.delaysSeconds) || config.delayProbe.delaysSeconds.length === 0) {
      errors.push("delayProbe.delaysSeconds must be a non-empty array of seconds (e.g. [30, 120, 300])");
    } else if (config.delayProbe.delaysSeconds.some((d) => typeof d !== "number" || d <= 0)) {
      errors.push("delayProbe.delaysSeconds must contain only positive numbers");
    }
    if (config.delayProbe.maxConcurrentProbes <= 0) errors.push("delayProbe.maxConcurrentProbes must be > 0");
    if (config.delayProbe.maxQueuedProbes <= 0) errors.push("delayProbe.maxQueuedProbes must be > 0");
    if (config.delayProbe.maxPendingTokens <= 0) errors.push("delayProbe.maxPendingTokens must be > 0");
    if (config.delayProbe.fetchTimeoutMs <= 0) errors.push("delayProbe.fetchTimeoutMs must be > 0");
    if (config.delayProbe.sampleRate <= 0 || config.delayProbe.sampleRate > 1) {
      errors.push("delayProbe.sampleRate must be > 0 and <= 1 (fraction of detected tokens to probe)");
    }
  }
  if (config.watchlist?.enabled) {
    if (config.watchlist.tickIntervalMs <= 0) errors.push("watchlist.tickIntervalMs must be > 0");
    if (config.watchlist.maxChecksPerTick <= 0) errors.push("watchlist.maxChecksPerTick must be > 0");
    if (config.watchlist.maxWatched <= 0) errors.push("watchlist.maxWatched must be > 0");
    if (config.watchlist.nearMigrationFraction !== undefined) {
      const f = config.watchlist.nearMigrationFraction;
      if (f <= 0 || f >= 1) errors.push("watchlist.nearMigrationFraction must be between 0 and 1 exclusive");
    }
  }
  if (config.outcomeTracker?.enabled) {
    if (!Array.isArray(config.outcomeTracker.checkpointsSeconds) || config.outcomeTracker.checkpointsSeconds.length === 0) {
      errors.push("outcomeTracker.checkpointsSeconds must be a non-empty array of seconds (e.g. [3600, 21600, 86400])");
    } else if (config.outcomeTracker.checkpointsSeconds.some((d) => typeof d !== "number" || d <= 0)) {
      errors.push("outcomeTracker.checkpointsSeconds must contain only positive numbers");
    }
    if (config.outcomeTracker.maxConcurrentChecks <= 0) errors.push("outcomeTracker.maxConcurrentChecks must be > 0");
    if (config.outcomeTracker.maxQueuedChecks <= 0) errors.push("outcomeTracker.maxQueuedChecks must be > 0");
    if (config.outcomeTracker.maxPendingCheckpoints <= 0) errors.push("outcomeTracker.maxPendingCheckpoints must be > 0");
    if (config.outcomeTracker.lateToleranceMs <= 0) errors.push("outcomeTracker.lateToleranceMs must be > 0");
    if (config.outcomeTracker.persistDebounceMs < 0) errors.push("outcomeTracker.persistDebounceMs must be >= 0");
    // Not a hard error - the right value depends on the launch rate, which varies - but a cap
    // far below steady-state demand silently biases the sample rather than merely shortening it.
    const longestCheckpointMin = Math.max(...config.outcomeTracker.checkpointsSeconds) / 60;
    if (config.outcomeTracker.maxPendingCheckpoints < longestCheckpointMin * config.outcomeTracker.checkpointsSeconds.length) {
      errors.push(
        `outcomeTracker.maxPendingCheckpoints (${config.outcomeTracker.maxPendingCheckpoints}) cannot hold even one ` +
          `token per minute out to the longest checkpoint (${Math.round(longestCheckpointMin)} min). Steady-state demand is ` +
          `roughly (detections/min) x (longest checkpoint in min) x (number of checkpoints).`
      );
    }
    if (!config.outcomeTracker.pendingStateFile) errors.push("outcomeTracker.pendingStateFile must be set");
    if (config.outcomeTracker.sampleRate <= 0 || config.outcomeTracker.sampleRate > 1) {
      errors.push("outcomeTracker.sampleRate must be > 0 and <= 1");
    }
  }
  if (config.trading.trailingStopActivateMultiple <= 1) errors.push("trading.trailingStopActivateMultiple must be > 1 (it's a multiple of entry price)");
  if (config.trading.trailingStopPercent <= 0 || config.trading.trailingStopPercent >= 100) {
    errors.push("trading.trailingStopPercent must be between 0 and 100");
  }
  if (config.trading.timeStopHours <= 0) errors.push("trading.timeStopHours must be > 0");
  if (config.trading.maxConsecutiveSellFailures <= 0) errors.push("trading.maxConsecutiveSellFailures must be > 0");
  if (config.trading.sellFailureBackoffBaseMs <= 0) errors.push("trading.sellFailureBackoffBaseMs must be > 0");
  if (config.trading.sellFailureBackoffMaxMs < config.trading.sellFailureBackoffBaseMs) {
    errors.push("trading.sellFailureBackoffMaxMs must be >= sellFailureBackoffBaseMs");
  }
  // A real wallet is only required for LIVE trading (enabled=true AND paperTrading=false) -
  // paper trading never signs or sends a transaction, so it never needs a real key.
  if (config.trading.enabled && !config.trading.paperTrading && !config.walletPrivateKey) {
    errors.push("trading.enabled is true and paperTrading is false (LIVE mode) but WALLET_PRIVATE_KEY is not set in .env");
  }
  if (config.trading.enabled && !config.trading.paperTrading) {
    // Not a hard error (you may genuinely mean to go live), but this is exactly the kind of
    // thing that should make you stop and double check - see the perps.enabled/mainnet-beta
    // warning below for the same pattern.
    console.warn(
      "\n*** WARNING: trading.enabled=true AND trading.paperTrading=false - this bot will place REAL " +
        "buy/sell orders with REAL SOL on the next filter PASS. If that isn't deliberate, stop and fix " +
        "config/default.json now. ***\n"
    );
  }
  if (config.filters.minUniqueWalletToTxRatio < 0 || config.filters.minUniqueWalletToTxRatio > 1) {
    errors.push("filters.minUniqueWalletToTxRatio must be between 0 and 1");
  }

  if (config.perps.enabled && !config.walletPrivateKey) {
    errors.push("perps.enabled is true but WALLET_PRIVATE_KEY is not set in .env");
  }
  if (config.perps.maxLeverage <= 0) errors.push("perps.maxLeverage must be > 0");
  if (config.perps.maxPositionSizeUsd <= 0) errors.push("perps.maxPositionSizeUsd must be > 0");
  if (config.perps.maxOpenPositions <= 0) errors.push("perps.maxOpenPositions must be > 0");
  if (config.perps.requireStopLoss && config.perps.defaultStopLossPercent >= 0) {
    errors.push("perps.defaultStopLossPercent must be negative (e.g. -10) when requireStopLoss is true");
  }
  if (config.perps.allowedMarkets.length === 0) {
    errors.push("perps.allowedMarkets must list at least one market symbol (e.g. \"SOL-PERP\")");
  }
  if (config.perps.enabled && config.perps.env === "mainnet-beta") {
    // Not a hard error (you may genuinely mean to run on mainnet), but this is exactly the
    // kind of thing that should make you stop and double check, so it's surfaced loudly.
    console.warn(
      "\n*** WARNING: perps.enabled=true AND perps.env=mainnet-beta - this bot will place REAL leveraged " +
        "orders with REAL money on your next perps order. If that isn't deliberate, stop and fix config/default.json now. ***\n"
    );
  }

  if (config.fundingArb.enabled && !config.perps.enabled) {
    errors.push("fundingArb.enabled is true but perps.enabled is false - the strategy can decide to trade, but the order gate underneath it will refuse everything. Enable both deliberately, or neither.");
  }
  if (config.fundingArb.enabled && !config.perps.allowedMarkets.some((m) => m.toUpperCase() === config.fundingArb.market.toUpperCase())) {
    errors.push(`fundingArb.market ("${config.fundingArb.market}") must also be listed in perps.allowedMarkets`);
  }
  if (config.fundingArb.maxLeverage > config.perps.maxLeverage) {
    errors.push(`fundingArb.maxLeverage (${config.fundingArb.maxLeverage}) must be <= perps.maxLeverage (${config.perps.maxLeverage})`);
  }
  if (config.fundingArb.notionalUsd > config.perps.maxPositionSizeUsd) {
    errors.push(`fundingArb.notionalUsd (${config.fundingArb.notionalUsd}) must be <= perps.maxPositionSizeUsd (${config.perps.maxPositionSizeUsd})`);
  }
  if (config.fundingArb.checkIntervalMinutes <= 0) errors.push("fundingArb.checkIntervalMinutes must be > 0");
  if (config.fundingArb.minConsecutiveSettlementsToEnter <= 0) errors.push("fundingArb.minConsecutiveSettlementsToEnter must be > 0");
  if (config.fundingArb.minConsecutiveSettlementsToExit <= 0) errors.push("fundingArb.minConsecutiveSettlementsToExit must be > 0");
  if (config.fundingArb.maxBasisPercent <= 0) errors.push("fundingArb.maxBasisPercent must be > 0");
  if (config.fundingArb.rebalanceDriftPercent <= 0) errors.push("fundingArb.rebalanceDriftPercent must be > 0");
  if (config.fundingArb.minMarginBufferPercent <= 0 || config.fundingArb.minMarginBufferPercent >= 100) {
    errors.push("fundingArb.minMarginBufferPercent must be between 0 and 100");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join("\n  - ")}`);
  }
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  const fileConfig = loadJsonConfig();
  const config: AppConfig = {
    ...fileConfig,
    rpcUrl: process.env.RPC_URL || "",
    wsUrl: process.env.WS_URL || undefined,
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY || undefined,
  };

  validate(config);
  cached = config;
  return config;
}

/** For tests: force a fresh read of config/default.json + .env. */
export function reloadConfig(): AppConfig {
  cached = null;
  return loadConfig();
}
