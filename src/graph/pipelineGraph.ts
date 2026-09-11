/**
 * The detection-to-decision pipeline as two explicit graphs.
 *
 * `index.ts` used to hold this as ~150 lines of handler code: the credit gate,
 * the schedule gate, the queue, and a worker that collected, decided, logged,
 * shadowed, papered, scheduled outcomes, added to the watchlist and maybe
 * traded - each branch an if/else in a different place. The routing is now
 * declared here, in EDGES, and index.ts only builds the dependencies and runs
 * the graphs.
 *
 * Two graphs, not one, because there is a QUEUE in the middle: the detection
 * graph runs synchronously on every newPool event and ends by enqueuing (or
 * recording why it did not); the worker graph runs later, per dequeued token.
 * The queue's drop is a real route and is declared as one.
 *
 *   DETECTION (per newPool event)
 *     detect > creditGate ─breaker says halt─> recordCreditHalt (terminal)
 *                        └default─> scheduleGate ─outside window─> recordOutsideSchedule (terminal)
 *                                               └default─> enqueue ─queue full─> recordDropped > queued (terminal)
 *                                                                  └default─> queued (terminal)
 *   WORKER (per dequeued token)
 *     collectMetrics > decide ─shadow filters on─> shadowEval ─> paperRoute
 *                            └default─> paperRoute ─paper on─> paperOpen ─> outcomeSchedule
 *                                                  └default─> outcomeSchedule ─not PASS─> watchlistAdd > done
 *                                                                            ─PASS & engine─> tradingPass > done
 *                                                                            └default─> done
 *
 * Order matters and is preserved from the old code: the credit gate is
 * evaluated BEFORE the schedule gate (a halt outside the window is recorded as
 * a halt), and everything after the decision runs AFTER decisionLog.record so
 * nothing downstream can influence the recorded verdict.
 *
 * Behaviour is unchanged by construction: every node body is the code that
 * was in index.ts. tests/test-pipeline-graph.ts drives both graphs with fake
 * dependencies and asserts the recorded events, in order, per route.
 */
import { GraphSpec } from "./graph";
import { NewPoolEvent } from "../watcher/types";
import { TokenMetrics } from "../data/tokenMetrics";
import { FilterResult } from "../filters/engine";
import { ScheduleDecision } from "../schedule/scheduler";
import { BudgetDecision } from "../rpc/creditBudget";

export interface Counters { detected: number; decided: number; dropped: number; notEvaluated: number; creditHalted: number }

export interface DetectionDeps {
  counters: Counters;
  /** The meter's lifetime credit count, or null when no meter exists yet. */
  meterCredits: () => number | null;
  breaker: { chargeFromMeter: (credits: number, at: Date) => number; decide: (at: Date) => BudgetDecision; persistThrottled: (nowMs: number) => void };
  evaluateSchedule: (at: Date) => ScheduleDecision;
  decisionLog: {
    recordCreditHalt: (p: { mint: string; signature: string; source: string; detectedAt: string; reason: string; detail: string; resumesAt: string | null; dayCredits: number; monthCredits: number }) => void;
    recordOutsideSchedule: (p: { mint: string; signature: string; source: string; detectedAt: string; reason: string; detail: string; nextOpenUtc: string | null }) => void;
    recordDropped: (p: { mint: string; signature: string; source: string; detectedAt: string; queueWaitMs: number }) => void;
  };
  /** Pushes to the bounded queue; returns the item the queue EVICTED to make room, if any (WorkQueue calls onDrop synchronously). */
  enqueue: (item: { event: NewPoolEvent; queuedAt: number }) => { event: NewPoolEvent; queuedAt: number } | null;
  delayProbeSchedule: (event: NewPoolEvent) => void;
  warn: (msg: string) => void;
  maxQueued: number;
}

export interface DetectionState {
  event: NewPoolEvent;
  now: Date;
  budget: BudgetDecision | null;
  schedule: ScheduleDecision | null;
  dropped: { event: NewPoolEvent; queuedAt: number } | null;
}

export function buildDetectionGraph(d: DetectionDeps): GraphSpec<DetectionState> {
  return {
    name: "detection",
    start: "detect",
    nodes: {
      detect: () => { d.counters.detected++; return {}; },
      // The credit gate, ahead of the schedule gate and ahead of anything that
      // spends. It charges nothing itself: it reads the meter's own lifetime
      // credit counter and books the delta, so the two can never drift.
      creditGate: (s) => {
        const credits = d.meterCredits();
        if (credits !== null) d.breaker.chargeFromMeter(credits, s.now);
        const budget = d.breaker.decide(s.now);
        d.breaker.persistThrottled(Date.now());
        return { budget };
      },
      recordCreditHalt: (s) => {
        d.counters.creditHalted++;
        d.counters.notEvaluated++;
        const b = s.budget!;
        d.decisionLog.recordCreditHalt({
          mint: s.event.mint, signature: s.event.signature, source: s.event.source, detectedAt: s.event.detectedAt,
          reason: b.reason, detail: b.detail, resumesAt: b.resumesAt, dayCredits: b.dayCredits, monthCredits: b.monthCredits,
        });
        // The delay probe and outcome tracker both spend, so a halt stops them too or it is not a halt.
        return {};
      },
      // Per detection rather than on a timer so the window boundary is exact,
      // and BEFORE anything that costs an RPC call.
      scheduleGate: (s) => ({ schedule: d.evaluateSchedule(s.now) }),
      recordOutsideSchedule: (s) => {
        d.counters.notEvaluated++;
        const v = s.schedule!;
        d.decisionLog.recordOutsideSchedule({
          mint: s.event.mint, signature: s.event.signature, source: s.event.source, detectedAt: s.event.detectedAt,
          reason: v.reason, detail: v.detail, nextOpenUtc: v.nextOpenUtc,
        });
        return {};
      },
      enqueue: (s) => {
        const dropped = d.enqueue({ event: s.event, queuedAt: Date.now() });
        // Scheduled alongside, not inside, the decision path.
        d.delayProbeSchedule(s.event);
        return { dropped };
      },
      // Recorded to the decision log, not just stdout: a dropped token that
      // leaves no trace would bias every later PASS/SKIP analysis.
      recordDropped: (s) => {
        const x = s.dropped!;
        d.counters.dropped++;
        d.decisionLog.recordDropped({ mint: x.event.mint, signature: x.event.signature, source: x.event.source, detectedAt: x.event.detectedAt, queueWaitMs: Date.now() - x.queuedAt });
        d.warn(`Queue full (${d.maxQueued}) - dropped OLDEST pending token ${x.event.mint} (${x.event.source}). Detection is outpacing metrics collection; raise polling.maxConcurrentTokens only if your RPC provider has rate-limit headroom.`);
        return {};
      },
      queued: () => ({}),
    },
    edges: {
      detect: [{ to: "creditGate", label: "new pool detected" }],
      creditGate: [
        { to: "recordCreditHalt", when: (s) => !s.budget!.allowed, label: "credit breaker: budget exhausted" },
        { to: "scheduleGate", label: "default: within budget" },
      ],
      scheduleGate: [
        { to: "recordOutsideSchedule", when: (s) => !s.schedule!.active, label: "outside the active window" },
        { to: "enqueue", label: "default: window open (or scheduler off)" },
      ],
      enqueue: [
        { to: "recordDropped", when: (s) => s.dropped !== null, label: "queue at maxQueued: OLDEST waiting token evicted" },
        { to: "queued", label: "default: waiting for a worker" },
      ],
      recordDropped: [{ to: "queued", label: "drop recorded; this token still queued" }],
      recordCreditHalt: [],
      recordOutsideSchedule: [],
      queued: [],
    },
    terminals: ["recordCreditHalt", "recordOutsideSchedule", "queued"],
  };
}

export interface WorkerDeps {
  counters: Counters;
  collect: (event: NewPoolEvent) => Promise<TokenMetrics>;
  evaluate: (event: NewPoolEvent, metrics: TokenMetrics) => FilterResult;
  decisionLog: { record: (result: FilterResult, timing: { detectionToDecisionMs?: number; queueWaitMs?: number }) => void };
  shadow: { enabled: boolean; hasSets: boolean; evaluate: (event: NewPoolEvent, metrics: TokenMetrics, live: "PASS" | "SKIP") => unknown; log: (row: Record<string, unknown>) => void };
  paper: {
    enabled: boolean;
    open: (p: { mint: string; at: string; liquiditySol: number | null; liveVerdict: "PASS" | "REJECTED" }) => { opened: any | null; refusal: { mint: string; reason: string } | null };
    openCount: () => number;
    log: (row: Record<string, unknown>) => void;
  };
  outcomeSchedule: (event: NewPoolEvent, baselineLiquiditySol: number | null) => void;
  watchlistAdd: (event: NewPoolEvent, liquiditySol: number | null) => void;
  /** Null when trading.enabled is false - there is nothing to hand a PASS to. */
  tradingPass: ((event: NewPoolEvent, result: FilterResult) => Promise<void>) | null;
}

export interface WorkerState {
  event: NewPoolEvent;
  queuedAt: number;
  startedAt: number;
  metrics: TokenMetrics | null;
  result: FilterResult | null;
}

export function buildWorkerGraph(d: WorkerDeps): GraphSpec<WorkerState> {
  return {
    name: "worker",
    start: "collectMetrics",
    nodes: {
      collectMetrics: async (s) => ({ metrics: await d.collect(s.event) }),
      decide: (s) => {
        const result = d.evaluate(s.event, s.metrics!);
        const detectedAtMs = Date.parse(s.event.detectedAt);
        const decidedAt = Date.now();
        d.decisionLog.record(result, {
          detectionToDecisionMs: Number.isNaN(detectedAtMs) ? undefined : decidedAt - detectedAtMs,
          queueWaitMs: s.startedAt - s.queuedAt,
        });
        d.counters.decided++;
        return { result };
      },
      // Shadow filters and paper execution are fed the metrics object the live
      // filters just used. Neither fetches anything, and both run AFTER the live
      // decision is recorded so they cannot influence it.
      shadowEval: (s) => {
        const shadow = d.shadow.evaluate(s.event, s.metrics!, s.result!.decision === "PASS" ? "PASS" : "SKIP");
        d.shadow.log({ event: "shadow-eval", ...(shadow as object) });
        return {};
      },
      paperRoute: () => ({}),
      paperOpen: (s) => {
        const { opened, refusal } = d.paper.open({
          mint: s.event.mint, at: new Date().toISOString(), liquiditySol: s.metrics!.liquiditySol,
          liveVerdict: s.result!.decision === "PASS" ? "PASS" : "REJECTED",
        });
        if (opened) {
          d.paper.log({ event: "paper-open", mint: opened.mint, openedAt: opened.openedAt, liveVerdict: opened.liveVerdict,
            entryLiquiditySol: opened.entryLiquiditySol, entryProceedsSol: opened.entryProceedsSol, poolFraction: opened.poolFraction, openNow: d.paper.openCount() });
        } else if (refusal) {
          // Recorded, never silent - a cap applied quietly would bias the sample.
          d.paper.log({ event: "paper-refused", mint: refusal.mint, reason: refusal.reason });
        }
        return {};
      },
      // Baseline is the liquidity the DECISION was made on. Scheduled after the
      // decision is recorded so it can never sit in front of the live path.
      outcomeSchedule: (s) => { d.outcomeSchedule(s.event, s.metrics!.liquiditySol ?? null); return {}; },
      // A SKIP at t+0 is no longer final: the token goes under observation.
      watchlistAdd: (s) => { d.watchlistAdd(s.event, s.metrics!.liquiditySol ?? null); return {}; },
      tradingPass: async (s) => { await d.tradingPass!(s.event, s.result!); return {}; },
      done: () => ({}),
    },
    edges: {
      collectMetrics: [{ to: "decide", label: "metrics collected (metrics graph)" }],
      decide: [
        { to: "shadowEval", when: () => d.shadow.enabled && d.shadow.hasSets, label: "shadow filters on" },
        { to: "paperRoute", label: "default: no shadow sets" },
      ],
      shadowEval: [{ to: "paperRoute", label: "shadow recorded" }],
      paperRoute: [
        { to: "paperOpen", when: () => d.paper.enabled, label: "paper execution on" },
        { to: "outcomeSchedule", label: "default: paper off" },
      ],
      paperOpen: [{ to: "outcomeSchedule", label: "paper open/refusal recorded" }],
      outcomeSchedule: [
        { to: "watchlistAdd", when: (s) => s.result!.decision !== "PASS", label: "decision is SKIP: watch it" },
        { to: "tradingPass", when: () => d.tradingPass !== null, label: "decision is PASS and trading engine exists" },
        { to: "done", label: "default: PASS with no trading engine" },
      ],
      watchlistAdd: [{ to: "done", label: "under observation" }],
      tradingPass: [{ to: "done", label: "handed to the engine (which still gates on trading.enabled)" }],
      done: [],
    },
    terminals: ["done"],
  };
}
