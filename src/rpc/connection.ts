import { Connection, Commitment } from "@solana/web3.js";
import { loadConfig } from "../config";
import { Logger } from "../util/logger";

const logger = new Logger("rpc", loadConfig().logging.level);

let connection: Connection | null = null;

/**
 * Returns a singleton Connection built from RPC_URL (and WS_URL if provided).
 * Does NOT verify the endpoint is reachable - call confirmConnection() for that.
 */
export function getConnection(commitment: Commitment = "confirmed"): Connection {
  if (connection) return connection;

  const config = loadConfig();
  if (!config.rpcUrl) {
    throw new Error("RPC_URL is not set. Copy .env.example to .env and fill it in.");
  }

  connection = new Connection(config.rpcUrl, {
    commitment,
    wsEndpoint: config.wsUrl,
  });

  logger.info(`Connection object created for ${maskUrl(config.rpcUrl)}`);
  return connection;
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return "<invalid RPC_URL>";
  }
}

export interface ConnectionStatus {
  ok: boolean;
  rpcUrl: string;
  version?: string;
  slot?: number;
  latencyMs?: number;
  error?: string;
}

/**
 * Step 1 of the bot: prove we can actually talk to the RPC node.
 * Calls getVersion() and getSlot() and logs the result. Throws nothing -
 * returns a status object so callers (and tests) can decide what to do.
 */
export async function confirmConnection(): Promise<ConnectionStatus> {
  const config = loadConfig();
  const conn = getConnection();
  const start = Date.now();

  try {
    const [version, slot] = await Promise.all([conn.getVersion(), conn.getSlot()]);
    const latencyMs = Date.now() - start;
    const solanaCoreVersion = version["solana-core"];

    logger.info(
      `Connected OK -> node version ${solanaCoreVersion}, current slot ${slot}, latency ${latencyMs}ms`
    );

    return {
      ok: true,
      rpcUrl: maskUrl(config.rpcUrl),
      version: solanaCoreVersion,
      slot,
      latencyMs,
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    logger.error(`Failed to connect to ${maskUrl(config.rpcUrl)}: ${message}`);
    return {
      ok: false,
      rpcUrl: maskUrl(config.rpcUrl),
      error: message,
    };
  }
}
