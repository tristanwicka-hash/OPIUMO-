/**
 * A hand-rolled graph runtime: shared State, Node functions, explicit Edges.
 *
 * ## Why this exists
 *
 * Most of this week's bugs were routing bugs - a gate that covered one entry
 * point but not three timers, a threshold that meant "never call", two
 * processes writing one file. Every one of them was control flow hidden in
 * if/else across several files. Declaring the flow as topology makes each
 * route a named thing that can be listed, drawn, walked and tested.
 *
 * ## The contract
 *
 * - A node is `(state) => Partial<State>`; the runtime merges the result.
 * - Edges are declared per node, IN ORDER. Each edge may carry a `when`
 *   predicate; the first edge whose predicate holds is taken. An edge with no
 *   predicate is the default. **Every non-terminal node must end its list
 *   with a default edge** - that is how "leads nowhere" becomes impossible by
 *   construction, and `validateGraph` refuses a graph that breaks it.
 * - Terminals are declared explicitly and have no edges.
 * - `runGraph` returns the final state AND the path taken (node, edge label),
 *   so a test can assert which route a given input took.
 *
 * No framework. ~120 lines. The graph definitions that use it are meant to
 * be readable as files on their own.
 */

export type NodeFn<S> = (state: S) => Promise<Partial<S> | void> | Partial<S> | void;

export interface Edge<S> {
  to: string;
  /** Absent = default edge (always taken if reached). */
  when?: (state: S) => boolean;
  /** Human-readable, shown in the diagram and in the trace. */
  label: string;
}

export interface GraphSpec<S> {
  name: string;
  start: string;
  nodes: Record<string, NodeFn<S>>;
  edges: Record<string, Edge<S>[]>;
  terminals: string[];
}

export interface Validation {
  ok: boolean;
  problems: string[];
  nodeCount: number;
  edgeCount: number;
  /** Edges that carry a predicate - roughly, the places a routing bug could hide. */
  conditionalEdges: number;
  unreachable: string[];
}

export function validateGraph<S>(g: GraphSpec<S>): Validation {
  const problems: string[] = [];
  const names = Object.keys(g.nodes);
  const terminals = new Set(g.terminals);
  if (!g.nodes[g.start]) problems.push(`start node "${g.start}" is not a node`);
  for (const t of g.terminals) if (!g.nodes[t]) problems.push(`terminal "${t}" is not a node`);
  let edgeCount = 0, conditional = 0;
  for (const [from, list] of Object.entries(g.edges)) {
    if (!g.nodes[from]) problems.push(`edges declared from "${from}", which is not a node`);
    if (terminals.has(from) && list.length > 0) problems.push(`terminal "${from}" has ${list.length} outgoing edge(s)`);
    for (const e of list) {
      edgeCount++;
      if (e.when) conditional++;
      if (!g.nodes[e.to]) problems.push(`edge ${from} -> "${e.to}" (${e.label}) leads nowhere: no such node`);
      if (!e.label) problems.push(`edge ${from} -> ${e.to} has no label`);
    }
    const defaults = list.filter((e) => !e.when);
    if (!terminals.has(from)) {
      if (list.length === 0) problems.push(`node "${from}" has no outgoing edge and is not a terminal - a state that reaches it goes nowhere`);
      else if (defaults.length === 0) problems.push(`node "${from}" has only conditional edges - a state matching none of them goes nowhere`);
      else if (list[list.length - 1].when) problems.push(`node "${from}": the default edge must be LAST, or the edges after it can never be taken`);
      if (defaults.length > 1) problems.push(`node "${from}" has ${defaults.length} default edges; only the first can ever be taken`);
    }
  }
  for (const n of names) {
    if (!terminals.has(n) && !g.edges[n]) problems.push(`node "${n}" has no edge list and is not a terminal`);
  }
  // Reachability from start.
  const seen = new Set<string>();
  const stack = [g.start];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const e of g.edges[n] ?? []) if (!seen.has(e.to)) stack.push(e.to);
  }
  const unreachable = names.filter((n) => !seen.has(n));
  for (const n of unreachable) problems.push(`node "${n}" is unreachable from "${g.start}"`);
  return { ok: problems.length === 0, problems, nodeCount: names.length, edgeCount, conditionalEdges: conditional, unreachable };
}

export interface Step { node: string; edge: string | null; to: string | null }

export interface RunResult<S> { state: S; path: Step[] }

const MAX_STEPS = 200;

/** Runs the graph from `start` to a terminal. Throws on a malformed graph or a route that leads nowhere. */
export async function runGraph<S extends object>(g: GraphSpec<S>, initial: S): Promise<RunResult<S>> {
  const v = validateGraph(g);
  if (!v.ok) throw new Error(`graph "${g.name}" is invalid:\n  ${v.problems.join("\n  ")}`);
  let state = initial;
  const path: Step[] = [];
  let node = g.start;
  const terminals = new Set(g.terminals);
  for (let i = 0; i < MAX_STEPS; i++) {
    const out = await g.nodes[node](state);
    if (out) state = { ...state, ...out };
    if (terminals.has(node)) { path.push({ node, edge: null, to: null }); return { state, path }; }
    const edge = (g.edges[node] ?? []).find((e) => !e.when || e.when(state));
    if (!edge) throw new Error(`graph "${g.name}": node "${node}" matched no edge - validateGraph should have refused this`);
    path.push({ node, edge: edge.label, to: edge.to });
    node = edge.to;
  }
  throw new Error(`graph "${g.name}": more than ${MAX_STEPS} steps - a cycle with no exit`);
}

/** Mermaid flowchart. Conditional edges carry their label; the default edge is drawn plain. */
export function toMermaid<S>(g: GraphSpec<S>, opts: { title?: string; direction?: "TD" | "LR" } = {}): string {
  const L: string[] = [];
  if (opts.title) L.push(`---`, `title: ${opts.title}`, `---`);
  L.push(`flowchart ${opts.direction ?? "TD"}`);
  const id = (n: string) => n.replace(/[^A-Za-z0-9_]/g, "_");
  const terminals = new Set(g.terminals);
  for (const n of Object.keys(g.nodes)) {
    L.push(terminals.has(n) ? `  ${id(n)}([${n}])` : n === g.start ? `  ${id(n)}[[${n}]]` : `  ${id(n)}[${n}]`);
  }
  for (const [from, list] of Object.entries(g.edges)) {
    for (const e of list) {
      const label = e.label.replace(/"/g, "'");
      L.push(e.when ? `  ${id(from)} -->|"${label}"| ${id(e.to)}` : `  ${id(from)} -.->|"${label}"| ${id(e.to)}`);
    }
  }
  return L.join("\n");
}

/** Every edge, listed - for the README table and for the test that walks them all. */
export function listEdges<S>(g: GraphSpec<S>): { from: string; to: string; label: string; conditional: boolean }[] {
  const out: { from: string; to: string; label: string; conditional: boolean }[] = [];
  for (const [from, list] of Object.entries(g.edges)) for (const e of list) out.push({ from, to: e.to, label: e.label, conditional: !!e.when });
  return out;
}
