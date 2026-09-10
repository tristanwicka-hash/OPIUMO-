import { Connection, Commitment, FetchMiddleware, FetchFn } from "@solana/web3.js";
import { loadConfig } from "../config";
import { Logger, JsonlLog } from "../util/logger";
import {
  RpcMeter,
  formatMeterLine,
  DEFAULT_METER_FILE,
  DEFAULT_METER_INTERVAL_MS,
} from "./rpcMeter";

const logger = new Logger("rpc", loadConfig().logging.level);

let connection: Connection | null = null;
let meter: RpcMeter | null = null;
let meterTimer: NodeJS.Timeout | null = null;

/** The live meter, or null if no Connection has been created yet. For scripts and tests. */
export function getRpcMeter(): RpcMeter | null {
  return meter;
}

/**
 * Reads the meter's two settings from `logging` if they are present there,
 * falling back to the defaults in rpcMeter.ts.
 *
 * They are optional in LoggingConfig on purpose: config/default.json is being
 * edited live while the bot runs, and adding keys to it would risk clobbering
 * those edits. Adding them there later needs no code change.
 */
/**
 * Whether to install the status-capturing fetch wrapper.
 *
 * Committed default is FALSE (config/default.json), because this is the one
 * piece of custom code that sits directly in a live bot's RPC path. It can be
 * turned on for a single run without a rebuild via OPIUMO_CAPTURE_RPC_STATUS=1
 * in .env - which is gitignored, so a local run can differ from the committed
 * default without the two ever getting confused.
 *
 * See APPROVALS.md item 8 for the options weighed and why this one won.
 */
function statusCaptureEnabled(): boolean {
  const env = process.env.OPIUMO_CAPTURE_RPC_STATUS;
  if (env !== undefined) return /^(1|true|yes|on)$/i.test(env.trim());
  const logging = loadConfig().logging as unknown as Record<string, unknown>;
  return logging.captureRpcStatus === true;
}

function readMeterSettings(): { file: string; intervalMs: number } {
  const logging = loadConfig().logging as unknown as Record<string, unknown>;
  const file = typeof logging.rpcMeterFile === "string" ? logging.rpcMeterFile : DEFAULT_METER_FILE;
  const intervalMs =
    typeof logging.rpcMeterIntervalMs === "number" && logging.rpcMeterIntervalMs > 0
      ? logging.rpcMeterIntervalMs
      : DEFAULT_METER_INTERVAL_MS;
  return { file, intervalMs };
}

/**
 * Starts the periodic burn-rate line. Idempotent.
 *
 * The timer is unref'd so it can never hold the process open - a short-lived
 * script that happens to build a Connection must still exit when its work is
 * done, and a measurement tool that changes whether the bot terminates is a
 * bug, not an instrument.
 */
function startMeterReporting(): void {
  if (meterTimer || !meter) return;
  const { file, intervalMs } = readMeterSettings();
  const jsonl = new JsonlLog(file, loadConfig().logging.maxLogFileSizeMB);

  meterTimer = setInterval(() => {
    if (!meter) return;
    const snap = meter.snapshotAndRollWindow(Date.now());
    logger.info(formatMeterLine(snap));
    jsonl.append({ event: "rpc-burn-rate", ...snap });
  }, intervalMs);

  meterTimer.unref?.();
  logger.info(
    `RPC meter on - burn rate every ${Math.round(intervalMs / 60_000)}m to the console and ${file}`
  );
}

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

  meter = new RpcMeter(Date.now());
  const captureStatus = statusCaptureEnabled();

  /**
   * Counts every outbound JSON-RPC call, then hands the request straight on
   * untouched. This is a pass-through hook by design: it must not be able to
   * alter, delay or fail a request, because it exists to measure the bot, not
   * to participate in it. Used when status capture is OFF - it is the
   * zero-risk option and stays the default.
   */
  const countingMiddleware: FetchMiddleware = (info, init, next) => {
    try {
      meter?.record(init?.body);
    } catch {
      // A counter must never take down an RPC call. If recording throws, the
      // request still goes out and the count is simply short by one.
    }
    next(info, init);
  };

  /**
   * Counts calls AND observes the response status, which fetchMiddleware
   * cannot do - it never sees a response, so a 429 looks exactly like a 200.
   * That blind spot is what let the credit allowance drain with no warning.
   *
   * Four constraints, from the decision in APPROVALS.md item 8:
   *   1. Status only, NEVER the body. Reading the body consumes the stream and
   *      the caller gets nothing - that turns a counter into an outage.
   *   2. The original Response is returned unmodified, and rejections
   *      propagate untouched. This observes; it does not handle.
   *   3. Opt-in, defaulting off, so it can be disabled without a code change.
   *   4. The FIRST 429 is logged loudly and immediately, not at the next tick.
   */
  const meteringFetch = (async (input: any, init?: any): Promise<any> => {
    try {
      meter?.record(init?.body);
    } catch {
      // As above: never let the counter break the call.
    }

    // Deliberately NOT wrapped in try/catch: a network failure must reject
    // exactly as it would without this wrapper. Swallowing it here would hide
    // a real error behind a measurement feature.
    const response = await (globalThis as any).fetch(input, init);

    try {
      const isFirst = meter?.recordStatus(response.status, Date.now());
      if (isFirst) {
        logger.error(
          `*** FIRST HTTP 429 FROM THE RPC PROVIDER at ${new Date().toISOString()} *** ` +
            `This is the signal that went unnoticed while the last credit allowance drained. ` +
            `Check the Helius dashboard before assuming it is transient throttling.`
        );
      } else if (response.status >= 400) {
        logger.warn(`RPC responded HTTP ${response.status}`);
      }
    } catch {
      // Recording must never change what the caller receives.
    }

    return response;
  }) as unknown as FetchFn;

  connection = new Connection(config.rpcUrl, {
    commitment,
    wsEndpoint: config.wsUrl,
    // Exactly one of these is installed - both would double-count every call.
    ...(captureStatus ? { fetch: meteringFetch } : { fetchMiddleware: countingMiddleware }),
  });

  if (captureStatus) {
    meter.enableStatusCapture();
    logger.warn(
      "RPC status capture is ON - every response status is recorded and the first 429 is reported " +
        "immediately. This wraps fetch in the live RPC path; set OPIUMO_CAPTURE_RPC_STATUS=0 to disable."
    );
  } else {
    logger.info(
      "RPC status capture is OFF - request counts only. A 429 will look identical to a 200 in the meter."
    );
  }

  startMeterReporting();

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
