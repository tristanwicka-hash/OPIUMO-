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

export interface TradingConfig {
  enabled: boolean;
  positionSizeSol: number;
  maxSlippageBps: number;
  takeProfitLadder: TakeProfitStep[];
  stopLossPercent: number;
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
  maxLogFileSizeMB: number;
}

export interface AppConfig {
  trading: TradingConfig;
  filters: FiltersConfig;
  sources: SourcesConfig;
  polling: PollingConfig;
  logging: LoggingConfig;
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
  if (config.trading.positionSizeSol <= 0) errors.push("trading.positionSizeSol must be > 0");
  if (config.trading.stopLossPercent >= 0) errors.push("trading.stopLossPercent must be negative (e.g. -30)");
  if (config.trading.takeProfitLadder.length === 0) errors.push("trading.takeProfitLadder must have at least one step");
  if (config.trading.enabled && !config.walletPrivateKey) {
    errors.push("trading.enabled is true but WALLET_PRIVATE_KEY is not set in .env");
  }
  if (config.filters.minUniqueWalletToTxRatio < 0 || config.filters.minUniqueWalletToTxRatio > 1) {
    errors.push("filters.minUniqueWalletToTxRatio must be between 0 and 1");
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
