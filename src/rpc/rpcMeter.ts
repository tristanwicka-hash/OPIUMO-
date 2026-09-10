/**
 * RPC request meter - measures how fast this bot burns Helius requests.
 *
 * ## Why this exists
 *
 * Helius returned "max usage reached" and the account is out of credits. Sizing
 * a plan needs a measured burn rate, and there wasn't one: nothing in this repo
 * counted outbound RPC calls, so every estimate of "how many requests an hour
 * does OPIUMO make" was arithmetic over assumptions about how many calls a
 * metrics collection performs, times a guessed detection rate.
 *
 * This counts them instead.
 *
 * ## Requests are NOT credits, and this file will not pretend otherwise
 *
 * Helius prices methods at different credit weights. This module reports
 * REQUESTS - total, per method, and per hour - because that is what it can
 * observe. It deliberately does not multiply anything by a credit table:
 * guessing the weights would produce a confident number with no evidence
 * behind it, which is exactly how the "credits are fine" conclusion went wrong
 * on 2026-09-10. Per-method counts are reported precisely so the conversion can
 * be done later against Helius's published table, by someone reading it.
 *
 * ## What it cannot see
 *
 * - **WebSocket subscriptions.** logsSubscribe/accountSubscribe traffic does
 *   not go over HTTP and never reaches this meter. The pool watcher's
 *   subscription is therefore uncounted, and providers bill it separately.
 * - **Response status.** The counter hooks web3.js's `fetchMiddleware`, which
 *   is a pass-through: it hands the request on and never sees the response. So
 *   a 429 looks identical to a 200 here. That is a deliberate trade - replacing
 *   `fetch` outright would expose status codes but puts custom code directly in
 *   the RPC path of a live bot, and a counter must not be able to break the
 *   thing it is measuring.
 */

/** A rate computed over less than this much data is not a rate. See `null` handling below. */
export const MIN_UPTIME_FOR_RATE_MS = 60_000;

/**
 * How often the periodic line is written, and where.
 *
 * These live here rather than in config/default.json only because that file is
 * being edited live by the owner while the bot runs, and adding keys to it
 * risks clobbering those edits. Both are read from `logging` when present, so
 * moving them into config later needs no code change - see readMeterSettings().
 */
export const DEFAULT_METER_INTERVAL_MS = 600_000; // 10 minutes -> 6 samples an hour
export const DEFAULT_METER_FILE = "logs/rpc-meter.jsonl";

export interface MethodShare {
  method: string;
  calls: number;
  /** Fraction of all calls, 0-1. */
  share: number;
}

export interface MeterSnapshot {
  startedAt: string;
  at: string;
  uptimeMs: number;
  /** HTTP POSTs made. A batched request is ONE of these. */
  httpRequests: number;
  /** JSON-RPC calls made. A batch of 10 counts as 10 - this is what a provider bills. */
  rpcCalls: number;
  /** Calls per hour averaged over the whole run. Null until there is enough uptime. */
  callsPerHourSinceStart: number | null;
  /** Length of the most recent reporting window. */
  windowMs: number;
  windowCalls: number;
  /** Calls per hour over just the last window - the current burn rate, not the lifetime average. */
  callsPerHourInWindow: number | null;
  /** Every method seen, busiest first. */
  methods: MethodShare[];
  /** Bodies that could not be parsed into JSON-RPC calls. Counted, never guessed at. */
  unparsedBodies: number;

  /**
   * HTTP status codes seen, by code. EMPTY unless status capture is enabled -
   * an empty map means "not being watched", not "no errors", and the report
   * says which.
   */
  statusCounts: Record<string, number>;
  /** True when the fetch wrapper is installed and statuses are actually observed. */
  statusCaptureOn: boolean;
  /** Responses with status 429. The credit/throttle signal. */
  rateLimited: number;
  /** ISO time of the FIRST 429 of this run, or null. */
  firstRateLimitedAt: string | null;
  /** ISO time of the most recent 429, or null. */
  lastRateLimitedAt: string | null;
}

/**
 * Counts RPC calls. Pure: the clock is injected, so tests are deterministic and
 * a rate can be asserted exactly rather than approximately.
 */
export class RpcMeter {
  private readonly startedAtMs: number;
  private httpRequests = 0;
  private rpcCalls = 0;
  private unparsed = 0;
  private readonly byMethod = new Map<string, number>();

  /** Marks the start of the current reporting window. */
  private windowStartMs: number;
  private windowStartCalls = 0;

  private statusCaptureOn = false;
  private readonly statusCounts = new Map<number, number>();
  private rateLimited = 0;
  private firstRateLimitedMs: number | null = null;
  private lastRateLimitedMs: number | null = null;

  constructor(nowMs: number) {
    this.startedAtMs = nowMs;
    this.windowStartMs = nowMs;
  }

  /**
   * Records one outbound HTTP request, given its JSON-RPC body.
   *
   * Returns how many RPC calls it counted. A batch body (a JSON array) counts
   * every element, because that is how a provider meters it - counting a batch
   * of 40 getAccountInfo calls as one request is the mistake that makes a burn
   * rate look survivable when it isn't.
   */
  record(body: unknown): number {
    this.httpRequests++;

    const parsed = parseRpcMethods(body);
    if (parsed === null) {
      // Unknown shape. Counted as one call so the total is never understated,
      // and tallied separately so the gap is visible rather than silent.
      this.unparsed++;
      this.rpcCalls++;
      this.bump("<unparsed>");
      return 1;
    }

    for (const method of parsed) this.bump(method);
    this.rpcCalls += parsed.length;
    return parsed.length;
  }

  /** Called once the fetch wrapper is installed, so a report can distinguish "no 429s" from "not watching". */
  enableStatusCapture(): void {
    this.statusCaptureOn = true;
  }

  /**
   * Records one HTTP response status.
   *
   * Status ONLY. The response body is never read here: reading it consumes the
   * stream and the caller then gets nothing back, which would turn a counter
   * into an outage. A 429 is the whole signal; the "max usage reached" string
   * adds nothing the status does not already say.
   *
   * Returns true when this was the FIRST 429 of the run, so the caller can log
   * that one loudly and immediately rather than at the next 10-minute tick.
   * Early warning delivered on the normal reporting cadence is not early
   * warning - that is the entire lesson of the credit exhaustion.
   */
  recordStatus(status: number, nowMs: number): boolean {
    this.statusCounts.set(status, (this.statusCounts.get(status) ?? 0) + 1);
    if (status !== 429) return false;

    this.rateLimited++;
    this.lastRateLimitedMs = nowMs;
    if (this.firstRateLimitedMs === null) {
      this.firstRateLimitedMs = nowMs;
      return true;
    }
    return false;
  }

  private bump(method: string): void {
    this.byMethod.set(method, (this.byMethod.get(method) ?? 0) + 1);
  }

  /** Reads the counters without disturbing the reporting window. */
  snapshot(nowMs: number): MeterSnapshot {
    const uptimeMs = Math.max(0, nowMs - this.startedAtMs);
    const windowMs = Math.max(0, nowMs - this.windowStartMs);
    const windowCalls = this.rpcCalls - this.windowStartCalls;

    const methods: MethodShare[] = [...this.byMethod.entries()]
      .map(([method, calls]) => ({
        method,
        calls,
        share: this.rpcCalls === 0 ? 0 : calls / this.rpcCalls,
      }))
      .sort((a, b) => b.calls - a.calls || a.method.localeCompare(b.method));

    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      at: new Date(nowMs).toISOString(),
      uptimeMs,
      httpRequests: this.httpRequests,
      rpcCalls: this.rpcCalls,
      callsPerHourSinceStart: perHour(this.rpcCalls, uptimeMs),
      windowMs,
      windowCalls,
      callsPerHourInWindow: perHour(windowCalls, windowMs),
      methods,
      unparsedBodies: this.unparsed,
      statusCounts: Object.fromEntries(
        [...this.statusCounts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])
      ),
      statusCaptureOn: this.statusCaptureOn,
      rateLimited: this.rateLimited,
      firstRateLimitedAt: this.firstRateLimitedMs === null ? null : new Date(this.firstRateLimitedMs).toISOString(),
      lastRateLimitedAt: this.lastRateLimitedMs === null ? null : new Date(this.lastRateLimitedMs).toISOString(),
    };
  }

  /** Snapshots, then starts a fresh window. Called by the periodic reporter. */
  snapshotAndRollWindow(nowMs: number): MeterSnapshot {
    const snap = this.snapshot(nowMs);
    this.windowStartMs = nowMs;
    this.windowStartCalls = this.rpcCalls;
    return snap;
  }
}

/**
 * Extrapolates an hourly rate, or returns null when there is not enough data.
 *
 * `null`, not 0, and not a number extrapolated from three seconds of uptime. A
 * rate measured over a moment is an artefact of when the sample was taken, and
 * the whole point of this meter is to produce a figure someone can size a plan
 * against. Same rule as regime.ts refusing a 20-day vol from 3 bars.
 */
export function perHour(calls: number, elapsedMs: number): number | null {
  if (elapsedMs < MIN_UPTIME_FOR_RATE_MS) return null;
  return (calls / elapsedMs) * 3_600_000;
}

/**
 * Pulls the method names out of a JSON-RPC request body.
 *
 * Returns null when the body is not recognisable JSON-RPC, so the caller can
 * count it as unknown rather than as zero calls.
 */
export function parseRpcMethods(body: unknown): string[] | null {
  let value: unknown = body;

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (Array.isArray(value)) {
    const methods: string[] = [];
    for (const entry of value) {
      const m = methodOf(entry);
      if (m === null) return null;
      methods.push(m);
    }
    // An empty array is not a valid batch; treat it as unrecognised.
    return methods.length > 0 ? methods : null;
  }

  const single = methodOf(value);
  return single === null ? null : [single];
}

function methodOf(entry: unknown): string | null {
  if (entry === null || typeof entry !== "object") return null;
  const m = (entry as { method?: unknown }).method;
  return typeof m === "string" && m.length > 0 ? m : null;
}

/**
 * The status half of the summary line.
 *
 * Says "not watched" rather than "0 rate-limited" when capture is off. Those
 * are different facts and printing the second when the first is true is exactly
 * how a blind spot gets read as a clean bill of health.
 */
export function formatStatusPart(s: MeterSnapshot): string {
  if (!s.statusCaptureOn) return "HTTP status: not watched (capture off)";
  const codes = Object.entries(s.statusCounts)
    .map(([code, n]) => `${code}x${n}`)
    .join(" ");
  const warn = s.rateLimited > 0 ? ` *** ${s.rateLimited} RATE-LIMITED (first ${s.firstRateLimitedAt}) ***` : "";
  return `HTTP: ${codes || "none yet"}${warn}`;
}

/** The one-line human summary written to the console on every tick. */
export function formatMeterLine(s: MeterSnapshot): string {
  const rate = (v: number | null) => (v === null ? "not enough uptime yet" : `${Math.round(v)}/h`);
  const top = s.methods
    .slice(0, 5)
    .map((m) => `${m.method} ${m.calls} (${(m.share * 100).toFixed(0)}%)`)
    .join(", ");
  return (
    `RPC burn: ${s.rpcCalls} calls in ${(s.uptimeMs / 3_600_000).toFixed(2)}h ` +
    `-> ${rate(s.callsPerHourSinceStart)} average, ${rate(s.callsPerHourInWindow)} in the last ` +
    `${(s.windowMs / 60_000).toFixed(0)}m` +
    `${s.httpRequests !== s.rpcCalls ? ` [${s.httpRequests} HTTP requests, batched]` : ""}` +
    (top ? ` | top: ${top}` : "") +
    ` | ${formatStatusPart(s)}` +
    ` | NOTE: requests, not credits - Helius weights methods differently`
  );
}
