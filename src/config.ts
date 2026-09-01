import fs from "fs";
import path from "path";
import dotenv from "dotenv";

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
  /** Your total trading bankroll in SOL - position sizes are derived from this, not a flat amount. */
  totalCapitalSol: number;
  /** 0.5-1% per the strategy spec. Actual position is ALSO clamped by a non-overridable hard cap in code (src/trading/sizing.ts) that this value cannot loosen. */
  riskPercentPerTrade: number;
  /** Caps how many positions can be open AT ONCE - each trade respects the 1% hard cap individually, but nothing else stops 50 of them stacking up. Not in the original spec; added because that gap was worth closing. */
  maxOpenPositions: number;
  maxSlippageBps: number;
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
}

export interface LoggingConfig {
  level: "minimal" | "info" | "debug";
  logDir: string;
  decisionsFile: string;
  tradesFile: string;
  perpsTradesFile: string;
  maxLogFileSizeMB: number;
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
  logging: LoggingConfig;
  perps: PerpsConfig;
  fundingArb: FundingArbConfig;
  rpcUrl: string;
  wsUrl?: string;
  walletPrivateKey?: string;
}

function loadJsonConfig(): Omit<AppConfig, "rpcUrl" | "wsUrl" | "walletPrivateKey"> {
  const configPath = path.resolve(__dirname, "..", "config", "default.json");
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
  return strip(parsed);
}

function validate(config: AppConfig): void {
  const errors: string[] = [];

  if (!config.rpcUrl) errors.push("RPC_URL is not set in .env");
  if (config.trading.totalCapitalSol <= 0) errors.push("trading.totalCapitalSol must be > 0 (your trading bankroll, used to size every position)");
  if (config.trading.riskPercentPerTrade <= 0) errors.push("trading.riskPercentPerTrade must be > 0");
  if (config.trading.takeProfitLadder.length === 0) errors.push("trading.takeProfitLadder must have at least one step");
  if (config.trading.atrPeriod <= 0) errors.push("trading.atrPeriod must be > 0");
  if (config.trading.atrStopMultiplier <= 0) errors.push("trading.atrStopMultiplier must be > 0");
  if (config.trading.fallbackStopLossPercent >= 0) errors.push("trading.fallbackStopLossPercent must be negative (e.g. -30)");
  if (config.trading.maxOpenPositions <= 0) errors.push("trading.maxOpenPositions must be > 0");
  if (config.trading.trailingStopActivateMultiple <= 1) errors.push("trading.trailingStopActivateMultiple must be > 1 (it's a multiple of entry price)");
  if (config.trading.trailingStopPercent <= 0 || config.trading.trailingStopPercent >= 100) {
    errors.push("trading.trailingStopPercent must be between 0 and 100");
  }
  if (config.trading.timeStopHours <= 0) errors.push("trading.timeStopHours must be > 0");
  if (config.trading.enabled && !config.walletPrivateKey) {
    errors.push("trading.enabled is true but WALLET_PRIVATE_KEY is not set in .env");
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
