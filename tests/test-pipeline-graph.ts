/**
 * The detection and worker graphs, driven with fake dependencies.
 *
 * For each route the graphs declare, the events recorded and the counters
 * moved must be exactly what index.ts's old hand-written handler did: a halt is
 * recorded as a halt even outside the window (credit gate first), an
 * out-of-window token is recorded and never queued, a full queue records the
 * EVICTED token, shadow/paper run only when on, a SKIP goes to the watchlist,
 * a PASS goes to the engine only when one exists. Every declared edge is
 * walked, and the graphs validate.
 */
import { buildDetectionGraph, buildWorkerGraph, Counters, DetectionDeps, WorkerDeps } from "../src/graph/pipelineGraph";
import { runGraph, validateGraph, listEdges } from "../src/graph/graph";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); } else { fail++; console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
const section = (t: string) => console.log(`\n=== ${t} ===\n`);
const ev = (mint = "M1") => ({ source: "pumpfun", signature: "s-" + mint, slot: 1, mint, poolAddress: "P", detectedAt: new Date(Date.now() - 500).toISOString() }) as any;

function detectionDeps(o: { allowed?: boolean; active?: boolean; evict?: boolean } = {}) {
  const log: string[] = [];
  const counters: Counters = { detected: 0, decided: 0, dropped: 0, notEvaluated: 0, creditHalted: 0 };
  const deps: DetectionDeps = {
    counters,
    meterCredits: () => 1234,
    breaker: {
      chargeFromMeter: (c) => { log.push(`charge:${c}`); return 0; },
      decide: () => ({ allowed: o.allowed !== false, reason: o.allowed === false ? "daily-limit" : "ok", warning: false, detail: "d", resumesAt: null, dayCredits: 1, monthCredits: 2 } as any),
      persistThrottled: () => { log.push("persist"); },
    },
    evaluateSchedule: () => ({ active: o.active !== false, reason: o.active === false ? "outside-window" : "in-window", window: null, detail: "sd", nextOpenUtc: o.active === false ? "12:00" : null } as any),
    decisionLog: {
      recordCreditHalt: (p) => log.push(`credit-halt:${p.mint}:${p.reason}`),
      recordOutsideSchedule: (p) => log.push(`outside-schedule:${p.mint}:${p.reason}`),
      recordDropped: (p) => log.push(`dropped:${p.mint}`),
    },
    enqueue: (item) => { log.push(`enqueue:${item.event.mint}`); return o.evict ? { event: ev("OLD"), queuedAt: Date.now() - 900 } : null; },
    delayProbeSchedule: (e) => log.push(`probe:${e.mint}`),
    warn: (m) => log.push("warn:" + m.slice(0, 20)),
    maxQueued: 50,
  };
  return { deps, log, counters };
}
const detState = (event: any) => ({ event, now: new Date(), budget: null, schedule: null, dropped: null });

(async () => {
  section("detection graph: routes and what each records");
  const walked = new Set<string>();
  const runDet = async (o: any) => { const { deps, log, counters } = detectionDeps(o); const r = await runGraph(buildDetectionGraph(deps), detState(ev())); for (const p of r.path) if (p.edge) walked.add(`${p.node}|${p.edge}`); return { r, log, counters }; };

  const g = buildDetectionGraph(detectionDeps().deps);
  const v = validateGraph(g);
  check(`detection graph validates (${v.nodeCount} nodes, ${v.edgeCount} edges, ${v.conditionalEdges} conditional)`, v.ok, v.problems.join("; "));
  console.log(`  CONDITIONAL EDGES in the detection graph: ${v.conditionalEdges}`);

  const normal = await runDet({});
  check("normal: charged, decided, scheduled, enqueued, probe scheduled - in that order", normal.log.join(",") === "charge:1234,persist,enqueue:M1,probe:M1", normal.log.join(","));
  check("normal: detected=1, nothing else moved", normal.counters.detected === 1 && normal.counters.notEvaluated === 0 && normal.counters.dropped === 0);
  check("normal path: detect>creditGate>scheduleGate>enqueue>queued", normal.r.path.map((p) => p.node).join(">") === "detect>creditGate>scheduleGate>enqueue>queued");

  const halt = await runDet({ allowed: false, active: false });
  check("credit halt OUTSIDE the window is recorded as a HALT (credit gate first, as before)", halt.log.some((l) => l.startsWith("credit-halt:M1:daily-limit")) && !halt.log.some((l) => l.startsWith("outside-schedule")));
  check("halt: nothing enqueued, no probe", !halt.log.some((l) => /enqueue|probe/.test(l)));
  check("halt: creditHalted=1 and notEvaluated=1", halt.counters.creditHalted === 1 && halt.counters.notEvaluated === 1);

  const outside = await runDet({ active: false });
  check("outside the window: recorded, not enqueued, no probe", outside.log.some((l) => l.startsWith("outside-schedule:M1:outside-window")) && !outside.log.some((l) => /enqueue|probe/.test(l)));
  check("outside: notEvaluated=1, creditHalted=0", outside.counters.notEvaluated === 1 && outside.counters.creditHalted === 0);

  const full = await runDet({ evict: true });
  check("queue full: the EVICTED token (OLD) is recorded as dropped, this one is still queued", full.log.some((l) => l === "dropped:OLD") && full.log.some((l) => l === "enqueue:M1"));
  check("queue full: dropped=1 and the warning names the evicted mint", full.counters.dropped === 1 && full.log.some((l) => l.startsWith("warn:Queue full")));
  check("queue full path ends at queued via recordDropped", full.r.path.map((p) => p.node).join(">") === "detect>creditGate>scheduleGate>enqueue>recordDropped>queued");

  const declared = listEdges(g).map((e) => `${e.from}|${e.label}`);
  const missing = declared.filter((d) => !walked.has(d));
  check(`every declared detection edge was walked (${walked.size}/${declared.length})`, missing.length === 0, missing.join(", "));

  section("worker graph: routes and what each records");
  const wWalked = new Set<string>();
  const runWorker = async (o: { decision?: "PASS" | "SKIP"; shadow?: boolean; sets?: boolean; paper?: boolean; refuse?: boolean; engine?: boolean } = {}) => {
    const log: string[] = [];
    const counters: Counters = { detected: 0, decided: 0, dropped: 0, notEvaluated: 0, creditHalted: 0 };
    const metrics = { liquiditySol: 7 } as any;
    const deps: WorkerDeps = {
      counters,
      collect: async () => { log.push("collect"); return metrics; },
      evaluate: (e) => { log.push("evaluate"); return { mint: e.mint, source: e.source, signature: e.signature, decision: o.decision ?? "SKIP", reasons: o.decision === "PASS" ? [] : ["x"], metrics, evaluatedAt: "t" } as any; },
      decisionLog: { record: (r, t) => log.push(`record:${r.decision}:${typeof t.queueWaitMs}`) },
      shadow: { enabled: o.shadow === true, hasSets: o.sets !== false, evaluate: () => { log.push("shadow"); return { x: 1 }; }, log: (row) => log.push(`shadowlog:${row.event}`) },
      paper: { enabled: o.paper === true, open: (p) => { log.push(`paper-open:${p.liveVerdict}`); return o.refuse ? { opened: null, refusal: { mint: p.mint, reason: "cap" } } : { opened: { mint: p.mint, openedAt: "t", liveVerdict: p.liveVerdict, entryLiquiditySol: 7, entryProceedsSol: 0.3, poolFraction: 0.05 }, refusal: null }; }, openCount: () => 1, log: (row) => log.push(`paperlog:${row.event}`) },
      outcomeSchedule: (e, b) => log.push(`outcome:${b}`),
      watchlistAdd: (e, l) => log.push(`watch:${l}`),
      tradingPass: o.engine ? async () => { log.push("trade"); } : null,
    };
    const r = await runGraph(buildWorkerGraph(deps), { event: ev(), queuedAt: Date.now() - 100, startedAt: Date.now(), metrics: null, result: null });
    for (const p of r.path) if (p.edge) wWalked.add(`${p.node}|${p.edge}`);
    return { r, log, counters, graph: buildWorkerGraph(deps) };
  };
  const base = await runWorker({});
  const wv = validateGraph(base.graph);
  check(`worker graph validates (${wv.nodeCount} nodes, ${wv.edgeCount} edges, ${wv.conditionalEdges} conditional)`, wv.ok, wv.problems.join("; "));
  console.log(`  CONDITIONAL EDGES in the worker graph: ${wv.conditionalEdges}`);
  check("SKIP, nothing on: collect, evaluate, record, outcome, watchlist - and decided=1", base.log.join(",") === "collect,evaluate,record:SKIP:number,outcome:7,watch:7" && base.counters.decided === 1, base.log.join(","));
  const everything = await runWorker({ decision: "SKIP", shadow: true, paper: true });
  check("SKIP with shadow+paper on: shadow and paper run AFTER record, then outcome, then watchlist", everything.log.join(",") === "collect,evaluate,record:SKIP:number,shadow,shadowlog:shadow-eval,paper-open:REJECTED,paperlog:paper-open,outcome:7,watch:7", everything.log.join(","));
  const refused = await runWorker({ paper: true, refuse: true });
  check("a paper refusal is recorded, never silent", refused.log.includes("paperlog:paper-refused"));
  const noSets = await runWorker({ shadow: true, sets: false });
  check("shadow on but no sets: shadowEval is skipped", !noSets.log.includes("shadow"));
  const passEngine = await runWorker({ decision: "PASS", engine: true });
  check("PASS with an engine: handed to the engine, NOT watchlisted", passEngine.log.includes("trade") && !passEngine.log.some((l) => l.startsWith("watch")));
  const passNoEngine = await runWorker({ decision: "PASS" });
  check("PASS with no engine: neither traded nor watchlisted", !passNoEngine.log.includes("trade") && !passNoEngine.log.some((l) => l.startsWith("watch")) && passNoEngine.r.path[passNoEngine.r.path.length - 2].edge === "default: PASS with no trading engine");
  const wDeclared = listEdges(base.graph).map((e) => `${e.from}|${e.label}`);
  const wMissing = wDeclared.filter((d) => !wWalked.has(d));
  check(`every declared worker edge was walked (${wWalked.size}/${wDeclared.length})`, wMissing.length === 0, wMissing.join(", "));

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
