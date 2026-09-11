/**
 * Holder-data tests. Offline - the Connection is a stub, so no RPC is made.
 *
 * The load-bearing properties:
 *   - routing is by AGE, because age is what predicts the index being absent
 *   - DAS is 10 credits and the cost is REPORTED, never hidden
 *   - one DAS call serves BOTH metrics
 *   - a cheap-check failure means holder data is never fetched at all
 */
import { PublicKey } from "@solana/web3.js";
import { collectHolderData, fetchHolderDataViaDas, DEFAULT_DAS_AGE_THRESHOLD_MS } from "../src/data/holderData";
import { evaluateStage1Reasons } from "../src/filters/engine";
import { loadConfig } from "../src/config";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " -- " + detail : ""}`); console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
function section(t: string): void { console.log(`\n=== ${t} ===\n`); }

const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const CREATOR = new PublicKey("11111111111111111111111111111111");
const POOL = "9C1viRffR66pPj9RNjpmwBNw6VQmbtyXcaaaaaaaaaaa";
const SUPPLY = 1_000_000_000_000_000n;

/** Records what was called so the test can assert which path ran. */
function stubConnection(opts: {
  dasAccounts?: { address: string; owner: string; amount: string }[];
  dasError?: string;
  largestThrows?: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    conn: {
      _rpcRequest: async (method: string) => {
        calls.push(`das:${method}`);
        if (opts.dasError) return { error: { message: opts.dasError } };
        return { result: { token_accounts: opts.dasAccounts ?? [], total: (opts.dasAccounts ?? []).length } };
      },
      getTokenLargestAccounts: async () => {
        calls.push("largest");
        if (opts.largestThrows) throw new Error("Invalid param: not a Token mint");
        return { value: [{ address: new PublicKey(POOL), amount: "100000000000000" }] };
      },
      getParsedTokenAccountsByOwner: async () => {
        calls.push("byOwner");
        return { value: [] };
      },
    } as any,
  };
}

async function main() {
section("ROUTING IS BY AGE - young tokens go straight to DAS");

const young = stubConnection({ dasAccounts: [
  { address: "acctA", owner: "ownerA", amount: "300000000000000" },
  { address: "acctB", owner: CREATOR.toBase58(), amount: "100000000000000" },
]});
const yr = await collectHolderData(young.conn, {
  mint: MINT, supplyRaw: SUPPLY, creator: CREATOR, excludeAddresses: new Set([POOL]),
  tokenAgeMs: 1000,
});
check("a 1s-old token uses DAS", yr.source === "das", yr.source);
check("the cheap call is NOT attempted first", !young.calls.includes("largest"), young.calls.join(","));
check("exactly one DAS call is made", young.calls.filter((c) => c.startsWith("das")).length === 1);
check("it costs 10 credits, and says so", yr.creditsSpent === 10);

section("ONE DAS CALL SERVES BOTH METRICS");

check("topHolderPercent computed", yr.topHolderPercent === 30, `got ${yr.topHolderPercent}`);
check("devWalletPercent computed from the SAME response", yr.devWalletPercent === 10, `got ${yr.devWalletPercent}`);
check("no second call was needed for the dev wallet", young.calls.length === 1);

const excluded = stubConnection({ dasAccounts: [
  { address: POOL, owner: "poolOwner", amount: "900000000000000" },
  { address: "acctA", owner: "ownerA", amount: "50000000000000" },
]});
const er = await collectHolderData(excluded.conn, {
  mint: MINT, supplyRaw: SUPPLY, creator: null, excludeAddresses: new Set([POOL]), tokenAgeMs: 1000,
});
check("the pool's own account is excluded from top holder", er.topHolderPercent === 5, `got ${er.topHolderPercent}`);
check("no creator means devWalletPercent is NULL, not 0", er.devWalletPercent === null);

section("older tokens use the 1-CREDIT path");

const old = stubConnection({});
const or = await collectHolderData(old.conn, {
  mint: MINT, supplyRaw: SUPPLY, creator: CREATOR, excludeAddresses: new Set(),
  tokenAgeMs: DEFAULT_DAS_AGE_THRESHOLD_MS + 1,
});
check("uses largest-accounts", or.source === "largest-accounts", or.source);
check("no DAS call is made", !old.calls.some((c) => c.startsWith("das")));
check("costs 2 credits, not 10", or.creditsSpent === 2);
check("the threshold is the documented 120s", DEFAULT_DAS_AGE_THRESHOLD_MS === 120_000);

section("fallback: if the cheap path fails on an old token, DAS covers it");

const fb = stubConnection({ largestThrows: true, dasAccounts: [{ address: "a", owner: "o", amount: "250000000000000" }] });
const fr = await collectHolderData(fb.conn, {
  mint: MINT, supplyRaw: SUPPLY, creator: null, excludeAddresses: new Set(),
  tokenAgeMs: DEFAULT_DAS_AGE_THRESHOLD_MS + 1,
});
check("falls back to DAS", fr.source === "das");
check("and reports the WASTED credit too - 1 + 10", fr.creditsSpent === 11, `got ${fr.creditsSpent}`);
check("the metric is still produced", fr.topHolderPercent === 25);

section("allowDas=false means NEVER PAY 10x - not never look");

// CORRECTED after the first live run of option (d). The original behaviour was
// to give up without calling anything when a token was young and DAS was off.
// That produced source "none" at 0 credits on every watchlist re-evaluation -
// which promotes at a median of 66s, below the 120s threshold - so the option
// (d) path returned no data at all. The threshold is a GUESS about when the
// index appears; the 1-credit call is the actual test.
const offc = stubConnection({});
const offr = await collectHolderData(offc.conn, {
  mint: MINT, supplyRaw: SUPPLY, creator: CREATOR, excludeAddresses: new Set(),
  tokenAgeMs: 1000, allowDas: false,
});
check("a YOUNG token with DAS off still TRIES the 1-credit call", offc.calls.includes("largest"));
check("and never touches DAS", !offc.calls.some((c) => c.startsWith("das")));
check("source is the cheap path", offr.source === "largest-accounts", offr.source);
check("costing 2 credits, never 10", offr.creditsSpent === 2);

// When the index genuinely is not there, it fails - and that is reported, not guessed.
const offFail = stubConnection({ largestThrows: true });
const offFailR = await collectHolderData(offFail.conn, {
  mint: MINT, supplyRaw: SUPPLY, creator: CREATOR, excludeAddresses: new Set(),
  tokenAgeMs: 1000, allowDas: false,
});
check("if the index is absent, metrics are NULL not zero", offFailR.topHolderPercent === null);
check("no DAS fallback is taken when it is forbidden", !offFail.calls.some((c) => c.startsWith("das")));
check("it cost only the 1 credit it tried", offFailR.creditsSpent === 1);
check("and the reason names the disabled fallback", (offFailR.error ?? "").includes("DAS is disabled"));

section("a DAS error reports the credit as spent - the call still cost money");

const errc = stubConnection({ dasError: "boom" });
const errr = await collectHolderData(errc.conn, {
  mint: MINT, supplyRaw: SUPPLY, creator: null, excludeAddresses: new Set(), tokenAgeMs: 1000,
});
check("metrics are null", errr.topHolderPercent === null);
check("but 10 credits are still counted", errr.creditsSpent === 10);
check("and the error is carried", (errr.error ?? "").includes("boom"));

section("THE ORDERING GUARANTEE: cheap rules can be evaluated without holder data");

const filters = loadConfig().filters;
const cheapFail: any = {
  mint: "M", fetchedAt: "", decimals: 6, liquiditySol: 0.1,
  topHolderPercent: null, devWalletPercent: null,
  mintAuthorityRenounced: true, freezeAuthorityRenounced: true,
  uniqueWallets: null, transactionCount: null, riskyTokenExtensions: [],
};
const noHolder = evaluateStage1Reasons(cheapFail, filters, { includeHolderRules: false });
const withHolder = evaluateStage1Reasons(cheapFail, filters);
check("without holder rules, low liquidity still fails", noHolder.length > 0);
check("and the holder-unknown reasons are ABSENT", !noHolder.some((r) => r.includes("unknown")));
check("with holder rules, the unknowns DO appear", withHolder.some((r) => r.includes("top holder % unknown")));
check("so the cheap gate is strictly weaker", noHolder.length < withHolder.length);

const cheapPass: any = { ...cheapFail, liquiditySol: 999 };
check(
  "a token passing the cheap checks yields NO cheap reasons - it earns the DAS call",
  evaluateStage1Reasons(cheapPass, filters, { includeHolderRules: false }).length === 0
);
check(
  "the same token still fails the FULL rules while holder data is null - fail-closed intact",
  evaluateStage1Reasons(cheapPass, filters).length > 0
);

section("OPTION (d): holder data resolves LATE and CHEAP, via the watchlist");

const fsW = require("fs") as typeof import("fs");
  const pathW = require("path") as typeof import("path");
  const wl = fsW.readFileSync(pathW.resolve(process.cwd(), "src/watchlist/watchlist.ts"), "utf-8");
check("the full re-evaluation records a holder-resolved event", wl.includes('event: "holder-resolved"'));
check("it carries topHolderPercent", wl.includes("topHolderPercent: metrics.topHolderPercent"));
check("and devWalletPercent", wl.includes("devWalletPercent: metrics.devWalletPercent"));
check("and which path paid for it", wl.includes("holderSource: metrics.holderSource"));
check("and what it cost", wl.includes("holderCreditsSpent: metrics.holderCreditsSpent"));
check("and how long after detection it arrived", wl.includes("resolvedAfterMs"));

// The load-bearing property: recorded on SKIP too, not only on PASS.
const recIdx = wl.indexOf('event: "holder-resolved"');
const passIdx = wl.indexOf('if (result.decision === "PASS")');
check(
  "it is recorded BEFORE the PASS branch, so a SKIP is recorded too",
  recIdx !== -1 && passIdx !== -1 && recIdx < passIdx,
  `record at ${recIdx}, PASS branch at ${passIdx}`
);
check(
  "the decision is recorded alongside, so PASS and SKIP can be told apart",
  wl.includes("decision: result.decision")
);

// And the routing must actually make it cheap by then.
const lateAge = 10 * 60 * 1000;
const lateConn = stubConnection({});
const late = await collectHolderData(lateConn.conn, {
  mint: MINT, supplyRaw: SUPPLY, creator: CREATOR, excludeAddresses: new Set(), tokenAgeMs: lateAge,
});
check("a token 10 minutes old uses the 1-credit path", late.source === "largest-accounts");
check("costing 2 credits, not 10", late.creditsSpent === 2);
check("no DAS call is made", !lateConn.calls.some((c) => c.startsWith("das")));
check(
  "which is the entire point of option (d): the same data, an order of magnitude cheaper",
  late.creditsSpent < 10
);
  section("PROJECT 1: activity metrics resolve late too, and are recorded");

  check("an activity-resolved event is emitted", wl.includes('event: "activity-resolved"'));
  check("carrying uniqueWallets", wl.includes("uniqueWallets: metrics.uniqueWallets"));
  check("and transactionCount", wl.includes("transactionCount: metrics.transactionCount"));
  check("and whether stage 2 actually ran", wl.includes("activitySkippedEarly: metrics.activitySkippedEarly"));
  check("the re-evaluation forces stage 2", wl.includes("forceActivityMetrics: true"));
  const actIdx = wl.indexOf('event: "activity-resolved"');
  check(
    "it is recorded BEFORE the PASS branch, so SKIPs are captured",
    actIdx !== -1 && actIdx < wl.indexOf('if (result.decision === "PASS")'),
    `activity at ${actIdx}`
  );
  check("it is a DISTINCT event from holder-resolved", wl.includes('event: "holder-resolved"') && actIdx !== wl.indexOf('event: "holder-resolved"'));

  section("PROJECT 1 ANSWER: the threshold is arithmetically unreachable");

  // transactionCount = getSignaturesForAddress(..., {limit: sampleSize}).length,
  // so it is CAPPED at the sample size. A threshold above that cap can never be
  // met by any token in any market.
  const liveCfg = loadConfig();
  const sample = liveCfg.polling.walletActivitySampleSize;
  check(
    "transactionCount is capped by the sample size, in source",
    fsW.readFileSync(pathW.resolve(process.cwd(), "src/data/tokenMetrics.ts"), "utf-8")
      .includes("const transactionCount = signatures.length;")
  );
  const cfgSrc = fsW.readFileSync(pathW.resolve(process.cwd(), "src/config.ts"), "utf-8");
  check("config warns when minTransactionCount exceeds the sample size", cfgSrc.includes("UNREACHABLE FILTER THRESHOLD"));
  check("it names the arithmetic rather than just complaining", cfgSrc.includes("NO TOKEN CAN EVER PASS"));
  check("minUniqueWallets is checked the same way", cfgSrc.includes("minUniqueWallets ("));
  check(
    "the warning is NOT fatal - it must not take a running bot down over a judgment call",
    cfgSrc.includes("unreachableThresholds") && !cfgSrc.includes("errors.push(\n      `filters.minTransactionCount")
  );
  check(
    `the live config is currently in that state (minTx ${liveCfg.filters.minTransactionCount} > sample ${sample})`,
    liveCfg.filters.minTransactionCount > sample
  );

}
main().then(() => {
section("THE EXPENSIVE CALL IS ACTUALLY LAST - declared in the graph, and walked");

// Added after a mutation escaped: removing the cheap gate from the collector
// turned NOTHING red, because every test here exercised collectHolderData
// directly and none checked that the collector gates it. The gate now lives in
// src/graph/metricsGraph.ts as an EDGE, so this asserts the topology - and
// then runs the graph to prove the edge is taken and no holder call is made.
const { METRICS_GRAPH, initialMetricsState } = require("../src/graph/metricsGraph") as typeof import("../src/graph/metricsGraph");
const { runGraph, validateGraph } = require("../src/graph/graph") as typeof import("../src/graph/graph");
const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const graphSrc = fs.readFileSync(path.resolve(process.cwd(), "src/graph/metricsGraph.ts"), "utf-8");

check("the metrics graph validates", validateGraph(METRICS_GRAPH).ok, validateGraph(METRICS_GRAPH).problems.join("; "));
check("the cheap gate evaluates the rules without holder rules", graphSrc.includes("includeHolderRules: false"));
const gateEdges = METRICS_GRAPH.edges.cheapGate;
check("cheapGate's conditional edge goes to holderSkipped", gateEdges[0].to === "holderSkipped" && !!gateEdges[0].when);
check("cheapGate's default edge goes to holderRoute (the expensive path)", gateEdges[gateEdges.length - 1].to === "holderRoute" && !gateEdges[gateEdges.length - 1].when);
const skippedSrc = graphSrc.slice(graphSrc.indexOf("function holderSkipped("), graphSrc.indexOf("const excludeSet"));
check("holderSkipped fetches nothing and records why", !/fetchHolderData|getTokenLargestAccounts|_rpcRequest/.test(skippedSrc) && skippedSrc.includes("already failed a cheaper check"));
check("holderSkipped leads to stage1Assess, never to a holder node", METRICS_GRAPH.edges.holderSkipped.every((e) => e.to === "stage1Assess"));

(async () => {
  // Walk it: a token that fails the liquidity rule must take the holderSkipped edge and make NO holder call.
  let largestCalls = 0, dasCalls = 0;
  const conn = {
    getAccountInfo: async () => null, getBalance: async () => 0.1e9,
    getTokenLargestAccounts: async () => { largestCalls++; return { value: [] }; },
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    _rpcRequest: async () => { dasCalls++; return { result: { token_accounts: [] } }; },
    getSignaturesForAddress: async () => [], getParsedTransactions: async () => [],
  } as any;
  const event = { source: "pumpfun", signature: "s", slot: 1, mint: "So11111111111111111111111111111111111111112", poolAddress: "11111111111111111111111111111112", detectedAt: new Date().toISOString() } as any;
  const cfg = require("../src/config").loadConfig();
  const { path: walked, state } = await runGraph(METRICS_GRAPH, initialMetricsState({
    connection: conn, event, polling: cfg.polling, filters: cfg.filters,
    holderCfg: { allowDas: true, dasAgeThresholdMs: 120_000 }, rugCfg: { bundleDetection: true, maxLaunchSlotSignatures: 25 },
    forceActivityMetrics: false, log: { debug: () => undefined, warn: () => undefined },
  }));
  const nodes = walked.map((p) => p.node);
  check("a cheap failure walks cheapGate -> holderSkipped", nodes.includes("holderSkipped") && !nodes.includes("holderRoute"), nodes.join(">"));
  check("...and makes no holder call at all (largest-accounts or DAS)", largestCalls === 0 && dasCalls === 0, `${largestCalls}/${dasCalls}`);
  check("...and records skipped-cheap-fail", state.result?.holderSource === "skipped-cheap-fail");

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log("\nFailures:"); for (const f of failures) console.log(`  - ${f}`); }
  process.exit(fail > 0 ? 1 : 0);
})();

});
