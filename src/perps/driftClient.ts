import { DriftClient, Wallet, initialize } from "@drift-labs/sdk";
import { Connection } from "@solana/web3.js";
import { loadConfig } from "../config";
import { Logger } from "../util/logger";
import { loadWalletFromBase58 } from "../util/wallet";
import { resolveMarketIndex } from "./marketRegistry";

const logger = new Logger("perps", loadConfig().logging.level);

let client: DriftClient | null = null;
let crashGuardInstalled = false;

/**
 * Drift's DriftClient.subscribe() spawns background account-subscription
 * tasks (websocket listeners / polling loops) that keep running after
 * subscribe() itself resolves. When one of those background tasks hits a
 * network error, it rejects a promise nothing in our code is holding a
 * reference to - by default Node treats that as an unhandled rejection and
 * KILLS THE WHOLE PROCESS, completely bypassing confirmDriftConnection()'s
 * try/catch (confirmed: reproduced this crash while building Part perps-1,
 * see README hardening notes). A transient RPC hiccup on a background
 * subscriber should never take down a bot that has open leveraged
 * positions to manage - so once perps functionality is used, install a
 * single process-wide handler that logs these instead of crashing.
 *
 * This is unavoidably process-global (Node's API has no scoped version),
 * but it only installs when getDriftClient() is actually called - the spot
 * sniper side of this bot never touches it.
 */
function installCrashGuard() {
  if (crashGuardInstalled) return;
  crashGuardInstalled = true;
  process.on("unhandledRejection", (reason: any) => {
    logger.error(
      `Unhandled rejection from a background Drift task (likely the account subscriber): ` +
        `${reason?.message || reason}. Continuing - this is logged instead of crashing the process, ` +
        "but if it keeps happening your RPC connection is unstable and orders may be unreliable."
    );
  });
}

/**
 * Builds (but does not subscribe) a DriftClient for config.perps.env, using
 * the same connection and wallet the rest of the bot uses. Call
 * confirmDriftConnection() to actually subscribe and prove it's alive.
 */
export function getDriftClient(connection: Connection): DriftClient {
  installCrashGuard();
  if (client) return client;

  const config = loadConfig();
  if (!config.walletPrivateKey) {
    throw new Error("WALLET_PRIVATE_KEY is not set in .env - required to build a DriftClient (it needs a signer).");
  }

  const keypair = loadWalletFromBase58(config.walletPrivateKey);
  const wallet = new Wallet(keypair);
  const driftConfig = initialize({ env: config.perps.env });

  const marketIndexes = config.perps.allowedMarkets
    .map((symbol) => resolveMarketIndex(config.perps.env, symbol))
    .filter((i): i is number => i !== null);

  if (marketIndexes.length !== config.perps.allowedMarkets.length) {
    const unresolved = config.perps.allowedMarkets.filter((s) => resolveMarketIndex(config.perps.env, s) === null);
    logger.warn(
      `Could not resolve a market index for: ${unresolved.join(", ")} on env=${config.perps.env} - ` +
        "check spelling/availability (some markets are mainnet-only or devnet-only)."
    );
  }

  client = new DriftClient({
    connection,
    wallet,
    env: config.perps.env,
    programID: undefined, // defaults to driftConfig.DRIFT_PROGRAM_ID for the given env
    activeSubAccountId: config.perps.subAccountId,
    subAccountIds: [config.perps.subAccountId],
    perpMarketIndexes: marketIndexes.length > 0 ? marketIndexes : undefined,
  });

  logger.info(
    `DriftClient built for env=${config.perps.env} programId=${driftConfig.DRIFT_PROGRAM_ID} ` +
      `subAccountId=${config.perps.subAccountId} markets=${config.perps.allowedMarkets.join(",")}`
  );
  return client;
}

export interface DriftConnectionStatus {
  ok: boolean;
  env: string;
  subAccountId: number;
  error?: string;
}

/**
 * Step 1-equivalent for perps: subscribe the DriftClient and confirm we can
 * actually read account/market state. Mirrors src/rpc/connection.ts's
 * confirmConnection() - returns a status object rather than throwing, so
 * callers/tests can decide what to do with a failure.
 */
export async function confirmDriftConnection(driftClient: DriftClient): Promise<DriftConnectionStatus> {
  const config = loadConfig();
  try {
    const subscribed = await driftClient.subscribe();
    if (!subscribed) {
      throw new Error("DriftClient.subscribe() returned false");
    }
    // Prove we can actually read something back, not just that subscribe() didn't throw.
    const userAccount = driftClient.getUserAccount(config.perps.subAccountId);
    logger.info(
      `Drift connection confirmed - subAccountId=${config.perps.subAccountId} ` +
        `userAccountExists=${userAccount !== undefined}`
    );
    return { ok: true, env: config.perps.env, subAccountId: config.perps.subAccountId };
  } catch (err: any) {
    const message = err?.message || String(err);
    logger.error(`Failed to confirm Drift connection: ${message}`);
    return { ok: false, env: config.perps.env, subAccountId: config.perps.subAccountId, error: message };
  }
}

export async function unsubscribeDriftClient(driftClient: DriftClient): Promise<void> {
  await driftClient.unsubscribe();
  client = null;
}
