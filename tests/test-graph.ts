/**
 * The graph runtime, and the metrics graph walked edge by edge.
 *
 * Load-bearing: a node nobody can reach, an edge to nowhere, a node whose
 * edges are all conditional (a state matching none of them would vanish), a
 * default edge that is not last - every one is refused by validateGraph. Then
 * every declared edge of METRICS_GRAPH is actually traversed by at least one
 * mocked scenario, so a route that exists on paper but never in practice
 * shows up here as untested rather than as a surprise in production.
 */
import { validateGraph, runGraph, toMermaid, listEdges, GraphSpec } from "../src/graph/graph";
import { METRICS_GRAPH, initialMetricsState } from "../src/graph/metricsGraph";
import { SCENARIOS, mockConnection, encodeMint, MINT, POOL, CREATOR } from "./eval-golden-scenarios";
import { loadConfig } from "../src/config";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); } else { fail++; console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
const section = (t: string) => console.log(`\n=== ${t} ===\n`);

type S = { n: number; route?: string };
const ok: GraphSpec<S> = {
  name: "toy", start: "a",
  nodes: { a: (s) => ({ n: s.n + 1 }), b: () => ({ route: "b" }), c: () => ({ route: "c" }), end: () => ({}) },
  edges: { a: [{ to: "b", when: (s) => s.n > 5, label: "big" }, { to: "c", label: "default: small" }], b: [{ to: "end", label: "done" }], c: [{ to: "end", label: "done" }], end: [] },
  terminals: ["end"],
};

section("validateGraph refuses the ways a route can lead nowhere");
{
  const v = validateGraph(ok);
  check("a well-formed graph validates", v.ok && v.nodeCount === 4 && v.edgeCount === 4 && v.conditionalEdges === 1, v.problems.join("; "));
  const dangling = { ...ok, edges: { ...ok.edges, b: [{ to: "nowhere", label: "?" }] } };
  check("an edge to a missing node is refused", validateGraph(dangling).problems.some((p) => /leads nowhere/.test(p)));
  const unreachable = { ...ok, nodes: { ...ok.nodes, orphan: () => ({}) }, edges: { ...ok.edges, orphan: [{ to: "end", label: "x" }] } };
  check("an unreachable node is refused", validateGraph(unreachable).problems.some((p) => /unreachable/.test(p)));
  const noDefault = { ...ok, edges: { ...ok.edges, a: [{ to: "b", when: (s: S) => s.n > 5, label: "big" }] } };
  check("a node with only conditional edges is refused", validateGraph(noDefault).problems.some((p) => /only conditional edges/.test(p)));
  const defaultFirst = { ...ok, edges: { ...ok.edges, a: [{ to: "c", label: "default" }, { to: "b", when: (s: S) => s.n > 5, label: "big" }] } };
  check("a default edge that is not last is refused", validateGraph(defaultFirst).problems.some((p) => /must be LAST/.test(p)));
  const noEdges = { ...ok, edges: { ...ok.edges, b: [] } };
  check("a non-terminal with no edges is refused", validateGraph(noEdges).problems.some((p) => /no outgoing edge/.test(p)));
  const termEdges = { ...ok, edges: { ...ok.edges, end: [{ to: "a", label: "loop" }] } };
  check("a terminal with edges is refused", validateGraph(termEdges).problems.some((p) => /terminal "end" has/.test(p)));
  const badStart = { ...ok, start: "zzz" };
  check("a missing start node is refused", validateGraph(badStart).problems.some((p) => /start node/.test(p)));
  const unlabeled = { ...ok, edges: { ...ok.edges, b: [{ to: "end", label: "" }] } };
  check("an unlabeled edge is refused", validateGraph(unlabeled).problems.some((p) => /no label/.test(p)));
}

section("runGraph takes the first matching edge and records the path");
(async () => {
  const small = await runGraph(ok, { n: 0 });
  check("n=0 takes the default edge to c", small.state.route === "c" && small.path.map((p) => p.node).join(">") === "a>c>end");
  check("the path names the edge labels", small.path[0].edge === "default: small" && small.path[2].edge === null);
  const big = await runGraph(ok, { n: 9 });
  check("n=9 takes the conditional edge to b", big.state.route === "b" && big.path[0].edge === "big");
  let threw = "";
  try { await runGraph({ ...ok, edges: { ...ok.edges, b: [] } }, { n: 9 }); } catch (e: any) { threw = e.message; }
  check("running an invalid graph throws with the problems listed", /is invalid/.test(threw) && /no outgoing edge/.test(threw));
  const loop: GraphSpec<S> = { name: "loop", start: "a", nodes: { a: (s) => ({ n: s.n + 1 }), end: () => ({}) }, edges: { a: [{ to: "end", when: (s) => s.n > 1000, label: "never" }, { to: "a", label: "again" }], end: [] }, terminals: ["end"] };
  threw = ""; try { await runGraph(loop, { n: 0 }); } catch (e: any) { threw = e.message; }
  check("a cycle with no exit is stopped and named", /more than \d+ steps/.test(threw));
  const mm = toMermaid(ok, { title: "toy" });
  check("mermaid names every node and edge", /flowchart TD/.test(mm) && mm.includes("a[[a]]") && mm.includes("end([end])") && mm.includes('-->|"big"|') && mm.includes('-.->|"default: small"|'));
  check("listEdges marks conditional edges", listEdges(ok).filter((e) => e.conditional).length === 1 && listEdges(ok).length === 4);

  section("METRICS_GRAPH: valid, and every declared edge is walked by some scenario");
  const v = validateGraph(METRICS_GRAPH);
  check(`the metrics graph validates (${v.nodeCount} nodes, ${v.edgeCount} edges, ${v.conditionalEdges} conditional)`, v.ok, v.problems.join("; "));
  console.log(`  CONDITIONAL EDGES in the metrics graph: ${v.conditionalEdges}`);

  const cfg = loadConfig();
  const log = { debug: () => undefined, warn: () => undefined };
  const walked = new Set<string>();
  const run = async (name: string, connection: any, event: any, holderCfg = { allowDas: false, dasAgeThresholdMs: 120_000 }, rugCfg = { bundleDetection: true, maxLaunchSlotSignatures: 25 }, force = false, polling = cfg.polling) => {
    const r = await runGraph(METRICS_GRAPH, initialMetricsState({ connection, event, polling, filters: cfg.filters, holderCfg, rugCfg, forceActivityMetrics: force, log }));
    for (const p of r.path) if (p.edge) walked.add(`${p.node}|${p.edge}`);
    return r;
  };
  for (const s of SCENARIOS) await run(s.name, s.connection, s.event, undefined, undefined, s.options?.forceActivityMetrics === true, { ...cfg.polling, ...(s.polling ?? {}) });

  // Routes the goldens (captured with the live config: DAS off, bundle on) cannot reach:
  const renounced = { owner: TOKEN_PROGRAM_ID, data: encodeMint({ mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000n, decimals: 6 }) };
  const fresh = { source: "pumpfun", signature: "createSig", slot: 1000, mint: MINT, poolAddress: POOL, creator: CREATOR, detectedAt: new Date().toISOString() } as any;
  const dasConn = mockConnection({ getAccountInfo: async () => renounced, getBalance: async () => 10e9 });
  (dasConn as any)._rpcRequest = async () => ({ result: { token_accounts: [{ address: "x", owner: "y", amount: "50000000" }] } });
  const das = await run("das", dasConn, fresh, { allowDas: true, dasAgeThresholdMs: 120_000 });
  check("a fresh token with DAS allowed walks holderRoute -> holderDas", das.path.some((p) => p.node === "holderDas") && das.state.result?.holderSource === "das" && das.state.result?.holderCreditsSpent === 10);
  const fbConn = mockConnection({ getAccountInfo: async () => renounced, getBalance: async () => 10e9, getTokenLargestAccounts: async () => { throw new Error("no index"); } });
  (fbConn as any)._rpcRequest = async () => ({ result: { token_accounts: [] } });
  const old = { ...fresh, detectedAt: "2026-09-01T00:00:00.000Z" };
  const fb = await run("fallback", fbConn, old, { allowDas: true, dasAgeThresholdMs: 120_000 });
  check("an old token whose largest-accounts call fails walks holderLargestAccounts -> holderDasFallback (credits 11)", fb.path.some((p) => p.node === "holderDasFallback") && fb.state.result?.holderCreditsSpent === 11, fb.path.map((p) => p.node).join(">"));
  const off = await run("bundle off", mockConnection({ getAccountInfo: async () => renounced, getBalance: async () => 10e9, getTokenLargestAccounts: async () => ({ value: [{ address: new PublicKey(new Uint8Array(32).fill(3)), amount: "1" }] }) }), old, undefined, { bundleDetection: false, maxLaunchSlotSignatures: 25 });
  check("bundleDetection off walks bundleGate -> bundleDisabled and records 'disabled'", off.path.some((p) => p.node === "bundleDisabled") && off.state.result?.bundleSource === "disabled");

  const declared = listEdges(METRICS_GRAPH).map((e) => `${e.from}|${e.label}`);
  const missing = declared.filter((d) => !walked.has(d));
  check(`every declared edge was walked by at least one scenario (${walked.size}/${declared.length})`, missing.length === 0, `never walked: ${missing.join(", ")}`);
  check("every node was visited", Object.keys(METRICS_GRAPH.nodes).every((n) => [...walked].some((w) => w.startsWith(n + "|")) || METRICS_GRAPH.terminals.includes(n)));

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
