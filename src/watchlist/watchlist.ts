import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig, WatchlistConfig } from "../config";
import { Logger, JsonlLog } from "../util/logger";
import { NewPoolEvent } from "../watcher/types";
import { collectTokenMetrics, getPumpFunLiquiditySol } from "../data/tokenMetrics";
import { evaluateFilters } from "../filters/engine";
import {
  DEFAULT_WATCH_POLICY,
  WatchEntry,
  WatchPolicyConfig,
  WatchStage,
  baselineSol,
  checkPriority,
  classifyStage,
  growthMultiple,
  latestSol,
  nextCheckDelayMs,
  shouldRunFullCheck,
} from "./policy";

/**
 * Keeps tokens under observation across their whole life instead of judging
 * them once at birth.
 *
 * ## Why the old shape could not work
 *
 * The live path evaluates a token a few hundred milliseconds after detection
 * and never looks again. Real data says that discards the winners: of 1,236
 * tracked tokens exactly 3 became worth buying, and the two examined closely
 * both started BELOW `filters.minLiquiditySol` and grew past it afterwards.
 * They were rejected for being new. Waiting longer before the single check
 * does not fix it either - that was tested to two hours and the activity curve
 * is flat. What is needed is not a later look but a continuing one.
 *
 * ## Two tiers, because the calls cost wildly different amounts
 *
 * A liquidity reading is one `getBalance`. A full metrics evaluation is ~110
 * calls (`polling.walletActivitySampleSize: 100`, ~91% of all RPC traffic per
 * the latency audit). So the cheap signal decides who earns the expensive one:
 * poll liquidity on a stage-dependent interval, and spend a full evaluation
 * only on tokens whose liquidity has actually moved. See `policy.ts`.
 *
 * ## The budget is a hard ceiling, not a hope
 *
 * This bot is already returning 429s on a free tier. A watchlist that polls
 * whatever it feels like would make that strictly worse and take the live path
 * down with it. So each tick spends at most `maxChecksPerTick` cheap reads,
 * chosen by priority, and anything that does not fit waits for the next tick
 * and is counted. Work that gets skipped is recorded rather than silently
 * dropped, because a silently-skipped check biases the sample toward whatever
 * the bot happened to keep up with.
 *
 * ## In memory only, deliberately
 *
 * A restart empties the watchlist. That is a real cost and it is accepted
 * rather than overlooked: entries age out after `maxAgeMs` (6h) anyway, so the
 * loss is bounded and self-healing, whereas persisting every entry would mean
 * writing the same pending-state machinery that the outcome tracker needed -
 * and that machinery had two real bugs in it before it worked. If restarts
 * turn out to cost real winners, persist it then, with that experience in hand.
 *
 * ## It does not decide to buy
 *
 * A full evaluation ends in `evaluateFilters`, exactly like the live path, and
 * a PASS is handed to the same `SpotTradingEngine.onFilterPass` the live path
 * uses - which still refuses everything unless `trading.enabled` is true. This
 * class adds no new route to a buy; it only changes *when* a token is offered
 * to the existing one.
 */

export interface WatchlistDeps {
  /** Called with any token that passes a full evaluation. The trading engine's own gates still apply. */
  onPass?: (event: NewPoolEvent, result: ReturnType<typeof evaluateFilters>) => Promise<void>;
  /**
   * Called with EVERY successful liquidity reading, pass or not.
   *
   * This exists so paper positions can be tracked at zero additional RPC cost:
   * the reading has already been paid for by the check above, and this hands it
   * on rather than fetching it again. A dedicated paper-position poll loop would
   * have cost 720-1,200 calls/hour; this costs nothing.
   *
   * Synchronous and wrapped by the caller: a consumer that throws must not be
   * able to break the watchlist's own tick.
   */
  onObservation?: (mint: string, liquiditySol: number, atIso: string) => void;
}

interface Tracked {
  entry: WatchEntry;
  /** Kept whole because a full evaluation needs the vault/curve addresses, not just the mint. */
  event: NewPoolEvent;
}

interface WatchlistRecord {
  ts: string;
  event: "added" | "checked" | "promoted" | "evicted" | "pass" | "skipped-budget" | "tick";
  mint?: string;
  stage?: WatchStage;
  liquiditySol?: number | null;
  baselineSol?: number | null;
  growth?: number | null;
  fullChecks?: number;
  reason?: string;
  watching?: number;
  dueNow?: number;
  checked?: number;
  skipped?: number;
}

export class Watchlist {
  private readonly connection: Connection;
  private readonly config: WatchlistConfig;
  private readonly policy: WatchPolicyConfig;
  private readonly logger: Logger;
  private readonly jsonl: JsonlLog;
  private readonly deps: WatchlistDeps;
  private readonly tracked = new Map<string, Tracked>();

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;

  private added = 0;
  private cheapChecks = 0;
  private fullChecks = 0;
  private passes = 0;
  private evicted = 0;
  private skippedForBudget = 0;

  constructor(
    connection: Connection,
    deps: WatchlistDeps = {},
    configOverride?: Partial<WatchlistConfig>,
    policyOverride?: Partial<WatchPolicyConfig>,
    logFileOverride?: string
  ) {
    const appConfig = loadConfig();
    this.connection = connection;
    this.config = { ...appConfig.watchlist, ...configOverride };
    this.policy = { ...DEFAULT_WATCH_POLICY, ...policyOverride, ...this.policyFromConfig() };
    this.logger = new Logger("watchlist", appConfig.logging.level);
    // Tests MUST pass an override. Without one this writes to the production log
    // and fixture tokens are later read back as real observations - which has
    // already happened twice in this repo.
    this.jsonl = new JsonlLog(logFileOverride ?? appConfig.logging.watchlistFile, appConfig.logging.maxLogFileSizeMB);
    this.deps = deps;
  }

  /** Config-supplied policy values, so the tunables live in config/default.json like everything else. */
  private policyFromConfig(): Partial<WatchPolicyConfig> {
    const c = this.config;
    const out: Partial<WatchPolicyConfig> = {};
    if (typeof c.deadBelowSol === "number") out.deadBelowSol = c.deadBelowSol;
    if (typeof c.patienceChecks === "number") out.patienceChecks = c.patienceChecks;
    if (typeof c.maxAgeMs === "number") out.maxAgeMs = c.maxAgeMs;
    if (typeof c.promoteOnMultiple === "number") out.promoteOnMultiple = c.promoteOnMultiple;
    if (typeof c.promoteOnAbsoluteSol === "number") out.promoteOnAbsoluteSol = c.promoteOnAbsoluteSol;
    if (typeof c.maxFullChecksPerToken === "number") out.maxFullChecksPerToken = c.maxFullChecksPerToken;
    if (typeof c.graduationSol === "number") out.graduationSol = c.graduationSol;
    if (typeof c.nearMigrationFraction === "number") out.nearMigrationFraction = c.nearMigrationFraction;
    if (typeof c.intervalFreshMs === "number") out.intervalFreshMs = c.intervalFreshMs;
    if (typeof c.intervalWarmingMs === "number") out.intervalWarmingMs = c.intervalWarmingMs;
    if (typeof c.intervalNearMigrationMs === "number") out.intervalNearMigrationMs = c.intervalNearMigrationMs;
    return out;
  }

  /** Put a freshly-detected token under observation. Returns immediately; never blocks the live path. */
  add(event: NewPoolEvent, baselineLiquiditySol: number | null, nowMs = Date.now()): void {
    if (!this.config.enabled || this.stopped) return;
    if (this.tracked.has(event.mint)) return;

    if (this.tracked.size >= this.config.maxWatched) {
      // Refusing is correct - growing without bound would eventually take the
      // process down - but it must be visible, because from here on the sample
      // is whatever arrived before the ceiling rather than a fair draw.
      this.log({ ts: new Date(nowMs).toISOString(), event: "skipped-budget", mint: event.mint, reason: `watchlist full (${this.config.maxWatched})` });
      return;
    }

    const entry: WatchEntry = {
      mint: event.mint,
      source: event.source,
      signature: event.signature,
      poolAddress: event.poolAddress,
      detectedAtMs: nowMs,
      readings: baselineLiquiditySol === null ? [] : [{ atMs: nowMs, sol: baselineLiquiditySol }],
      stage: "fresh",
      nextCheckAtMs: nowMs + this.policy.intervalFreshMs,
      fullChecks: 0,
      consecutiveFailures: 0,
    };

    this.tracked.set(event.mint, { entry, event });
    this.added++;
    this.log({
      ts: new Date(nowMs).toISOString(),
      event: "added",
      mint: event.mint,
      stage: "fresh",
      liquiditySol: baselineLiquiditySol,
    });
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.logger.info(
      `Watchlist ON: keeping tokens under observation instead of judging them once. ` +
        `Up to ${this.config.maxChecksPerTick} liquidity reads every ${Math.round(this.config.tickIntervalMs / 1000)}s, ` +
        `full evaluations only for tokens whose liquidity actually moves. -> ${loadConfig().logging.watchlistFile}`
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.tickIntervalMs);
    this.timer.unref?.();
  }

  /**
   * One budgeted round. Public so tests can drive it deterministically instead
   * of waiting on a timer.
   */
  async tick(nowMs = Date.now()): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      // Reclassify everything first - eviction is free and shrinks the work set
      // before any budget is spent on it.
      for (const [mint, t] of [...this.tracked]) {
        const stage = classifyStage(t.entry, this.policy, nowMs);
        t.entry.stage = stage;
        if (stage === "dead") {
          this.tracked.delete(mint);
          this.evicted++;
          this.log({
            ts: new Date(nowMs).toISOString(),
            event: "evicted",
            mint,
            stage,
            liquiditySol: latestSol(t.entry),
            growth: growthMultiple(t.entry),
            reason: nowMs - t.entry.detectedAtMs >= this.policy.maxAgeMs ? "aged out" : "no growth",
          });
        }
      }

      const due = [...this.tracked.values()]
        .filter((t) => t.entry.nextCheckAtMs <= nowMs)
        .sort((a, b) => checkPriority(a.entry, a.entry.stage, nowMs) - checkPriority(b.entry, b.entry.stage, nowMs));

      const batch = due.slice(0, this.config.maxChecksPerTick);
      const skipped = due.length - batch.length;
      if (skipped > 0) {
        this.skippedForBudget += skipped;
        this.log({
          ts: new Date(nowMs).toISOString(),
          event: "skipped-budget",
          skipped,
          dueNow: due.length,
          reason: `only ${this.config.maxChecksPerTick} checks per tick - the rest wait, they are not dropped`,
        });
      }

      for (const t of batch) {
        await this.checkOne(t, nowMs);
      }

      if (batch.length > 0 || skipped > 0) {
        this.log({
          ts: new Date(nowMs).toISOString(),
          event: "tick",
          watching: this.tracked.size,
          dueNow: due.length,
          checked: batch.length,
          skipped,
        });
      }
    } finally {
      this.running = false;
    }
  }

  /** One cheap liquidity read, then decide whether it has earned an expensive one. */
  private async checkOne(t: Tracked, nowMs: number): Promise<void> {
    const { entry, event } = t;
    let sol: number | null = null;
    let failure: string | null = null;

    if (event.source !== "pumpfun" || !event.poolAddress) {
      failure = `no cheap liquidity read for source "${event.source}" without a pool address`;
    } else {
      // A malformed address is PERMANENT and an RPC failure is TRANSIENT. Catching
      // both the same way means a token with a bad address gets retried until it
      // ages out, burning a check every interval and never producing a reading -
      // and nothing in the log would say why. Separating them costs one try/catch.
      let pubkey: PublicKey | null = null;
      try {
        pubkey = new PublicKey(event.poolAddress);
      } catch (err: any) {
        failure = `pool address is not a valid public key (${err?.message || err}) - permanent, evicting`;
      }

      if (pubkey) {
        try {
          sol = await getPumpFunLiquiditySol(this.connection, pubkey);
        } catch (err: any) {
          failure = `liquidity read failed: ${err?.message || err}`;
        }
      } else {
        // Nothing about this token can ever be read. Keeping it would spend a
        // check every interval forever in exchange for nothing.
        this.tracked.delete(entry.mint);
        this.evicted++;
        this.log({
          ts: new Date(nowMs).toISOString(),
          event: "evicted",
          mint: entry.mint,
          reason: failure ?? "unreadable pool address",
        });
        return;
      }
    }

    this.cheapChecks++;
    entry.readings.push({ atMs: nowMs, sol });
    // Bounded so a long-lived token cannot grow memory without limit.
    if (entry.readings.length > 40) entry.readings.splice(0, entry.readings.length - 40);
    entry.consecutiveFailures = sol === null ? entry.consecutiveFailures + 1 : 0;

    const stage = classifyStage(entry, this.policy, nowMs);
    entry.stage = stage;
    const delay = nextCheckDelayMs(stage, this.policy);
    entry.nextCheckAtMs = Number.isFinite(delay) ? nowMs + delay : Number.POSITIVE_INFINITY;

    // Hand the reading on before logging it. Costs nothing - the call was already
    // made above - and a consumer that throws must not break the tick, so it is
    // wrapped. A failed read (sol === null) is NOT passed on: an unreadable pool
    // is not an observation of zero liquidity.
    if (sol !== null && this.deps.onObservation) {
      try {
        this.deps.onObservation(entry.mint, sol, new Date(nowMs).toISOString());
      } catch (err: any) {
        this.logger.warn(`onObservation consumer threw for ${entry.mint}: ${err?.message || err}`);
      }
    }

    this.log({
      ts: new Date(nowMs).toISOString(),
      event: "checked",
      mint: entry.mint,
      stage,
      liquiditySol: sol,
      baselineSol: baselineSol(entry),
      growth: growthMultiple(entry),
      // Present only when the read failed, so a null liquidity always carries its reason.
      ...(failure ? { reason: failure } : {}),
    });

    if (shouldRunFullCheck(entry, this.policy, stage)) {
      await this.runFullCheck(t, nowMs);
    }
  }

  /**
   * The expensive path: full metrics, the real filters, and on a PASS the same
   * trading-engine entry point the live path uses.
   */
  private async runFullCheck(t: Tracked, nowMs: number): Promise<void> {
    const { entry, event } = t;
    entry.fullChecks++;
    this.fullChecks++;

    this.log({
      ts: new Date(nowMs).toISOString(),
      event: "promoted",
      mint: entry.mint,
      stage: entry.stage,
      liquiditySol: latestSol(entry),
      growth: growthMultiple(entry),
      fullChecks: entry.fullChecks,
      reason: "liquidity moved enough to be worth a full evaluation",
    });

    try {
      const metrics = await collectTokenMetrics(this.connection, event, undefined, undefined, {
        forceActivityMetrics: true,
      });
      const result = evaluateFilters(event, metrics, loadConfig().filters);

      /**
       * OPTION (d) FROM APPROVALS 16: holder data arrives HERE, late and cheap.
       *
       * At detection the largest-accounts index does not exist yet, so the
       * 1-credit call fails and the only way to get holder concentration is a
       * 10-credit DAS call - measured at 2,790 credits/h, over budget. By the
       * time the watchlist re-evaluates, the token is minutes old, the index
       * exists, and the SAME data costs 1 credit.
       *
       * Recorded even when the token SKIPs. The whole point is answering what
       * the rejected tokens actually looked like, and a metric computed and
       * thrown away answers nothing. Before this, a non-PASS full check
       * discarded the holder numbers it had just paid for.
       */
      const detectedAtMs = Date.parse(event.detectedAt);
      this.log({
        ts: new Date(nowMs).toISOString(),
        event: "holder-resolved",
        mint: entry.mint,
        stage: entry.stage,
        liquiditySol: metrics.liquiditySol,
        topHolderPercent: metrics.topHolderPercent,
        devWalletPercent: metrics.devWalletPercent,
        holderSource: metrics.holderSource ?? null,
        holderCreditsSpent: metrics.holderCreditsSpent ?? null,
        // How long after detection this arrived - the cost of waiting, in seconds.
        resolvedAfterMs: Number.isNaN(detectedAtMs) ? null : nowMs - detectedAtMs,
        decision: result.decision,
      } as unknown as WatchlistRecord);

      /**
       * ACTIVITY METRICS, resolved late - PROJECT 1.
       *
       * Same shape of problem as holder data, one layer down. At detection the
       * two-stage gate skips activity collection whenever stage 1 already
       * fails, and stage 1 fails because holder data is unknown at t=0. Result:
       * `activitySkippedEarly` on 10,930 of 10,993 records, and only 59 tokens
       * ever measured. That is ABSENCE, not a failed threshold.
       *
       * The re-evaluation passes forceActivityMetrics, so they are computed
       * here - and, until now, discarded on anything that was not a PASS.
       * Recorded as its own event, before the PASS branch, so the rejects are
       * captured. That is the entire point: the question is what the rejected
       * tokens actually looked like.
       */
      this.log({
        ts: new Date(nowMs).toISOString(),
        event: "activity-resolved",
        mint: entry.mint,
        stage: entry.stage,
        uniqueWallets: metrics.uniqueWallets,
        transactionCount: metrics.transactionCount,
        // False here means stage 2 actually ran, which is the point of forcing it.
        activitySkippedEarly: metrics.activitySkippedEarly ?? null,
        liquiditySol: metrics.liquiditySol,
        resolvedAfterMs: Number.isNaN(detectedAtMs) ? null : nowMs - detectedAtMs,
        decision: result.decision,
      } as unknown as WatchlistRecord);

      if (result.decision === "PASS") {
        this.passes++;
        this.log({
          ts: new Date(nowMs).toISOString(),
          event: "pass",
          mint: entry.mint,
          stage: entry.stage,
          liquiditySol: latestSol(entry),
          growth: growthMultiple(entry),
          reason: "cleared every filter on a re-evaluation - handed to the trading engine",
        });
        this.logger.info(
          `[WATCHLIST PASS] ${entry.mint} stage=${entry.stage} liquidity=${latestSol(entry)?.toFixed(3)}SOL ` +
            `growth=${growthMultiple(entry)?.toFixed(2)}x - handing to the trading engine`
        );
        // The engine still refuses unless trading.enabled is true. This adds no
        // new route to a buy, only a new moment at which one is offered.
        if (this.deps.onPass) await this.deps.onPass(event, result);
      }
    } catch (err: any) {
      this.logger.warn(`full evaluation failed for ${entry.mint}: ${err?.message || err}`);
    }
  }

  private log(record: WatchlistRecord): void {
    this.jsonl.append(record as unknown as Record<string, unknown>);
  }

  stats() {
    const byStage: Record<string, number> = {};
    for (const t of this.tracked.values()) byStage[t.entry.stage] = (byStage[t.entry.stage] ?? 0) + 1;
    return {
      watching: this.tracked.size,
      added: this.added,
      cheapChecks: this.cheapChecks,
      fullChecks: this.fullChecks,
      passes: this.passes,
      evicted: this.evicted,
      skippedForBudget: this.skippedForBudget,
      byStage,
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
