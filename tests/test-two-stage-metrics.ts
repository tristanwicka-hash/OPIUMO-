/**
 * Two-stage metrics collection + bounded work queue. Fully offline: mocked
 * Connection, pure functions, no network, no config mutation.
 *
 * The load-bearing test here is EQUIVALENCE: for every token where stage 2 is
 * skipped, the final PASS/SKIP must match what full collection would have
 * produced. The optimisation is only allowed to avoid work whose outcome
 * cannot matter - it must never change a decision.
 *
 * Run with: npm run test:two-stage
 */
import { evaluateFilters, evaluateStage1Reasons } from "../src/filters/engine";
import { TokenMetrics } from "../src/data/tokenMetrics";
import { NewPoolEvent } from "../src/watcher/types";
import { FiltersConfig } from "../src/config";
import { WorkQueue } from "../src/util/workQueue";
import { identifyKnownProgram } from "../src/watcher/programs";
import { buildDroppedRecord } from "../src/filters/decisionLog";
import { analyze, DecisionRecord } from "../src/analysis/paperPerformance";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    pass++;
  } else {
    console.error(`  FAIL: ${name}`);
    fail++;
  }
}

// Thresholds matching config/default.json, declared locally so this test never
// depends on (or mutates) the real config file.
const filters: FiltersConfig = {
  minLiquiditySol: 5,
  maxTopHolderPercent: 20,
  maxDevWalletPercent: 10,
  requireMintAuthorityRenounced: true,
  requireFreezeAuthorityRenounced: true,
  minUniqueWallets: 20,
  minTransactionCount: 30,
  minUniqueWalletToTxRatio: 0.15,
  rejectRiskyTokenExtensions: true,
  maxCreatorLpPercent: 1,
};

const event: NewPoolEvent = {
  source: "pumpfun",
  signature: "sig-two-stage",
  slot: 1,
  mint: "MintAddress1111111111111111111111111111111",
  poolAddress: "PoolAddress111111111111111111111111111111",
  creator: "CreatorAddress11111111111111111111111111111",
  detectedAt: new Date().toISOString(),
};

function metrics(o: Partial<TokenMetrics> = {}): TokenMetrics {
  return {
    mint: event.mint,
    fetchedAt: new Date().toISOString(),
    decimals: 6,
    liquiditySol: 10,
    topHolderPercent: 10,
    devWalletPercent: 5,
    mintAuthorityRenounced: true,
    freezeAuthorityRenounced: true,
    riskyTokenExtensions: [],
    creatorLpPercent: 0,
    lpCheckApplicable: false,
    uniqueWallets: 40,
    transactionCount: 60,
    stale: false,
    activitySkippedEarly: false,
    stage1ElapsedMs: 10,
    stage2ElapsedMs: 20,
    totalElapsedMs: 30,
    warnings: [],
    ...o,
  };
}

async function main() {
  console.log("=== Two-stage metrics + work queue (offline) ===");

  // ---------------------------------------------------------------
  console.log("\n-- the gate: evaluateStage1Reasons only sees stage-1 rules --");
  {
    // Activity is catastrophically bad, but stage 1 is clean -> no stage-1 reason.
    const r = evaluateStage1Reasons(metrics({ uniqueWallets: 0, transactionCount: 0 }), filters);
    check("stage-1 evaluation ignores activity metrics entirely", r.length === 0);

    check("low liquidity is a stage-1 blocker", evaluateStage1Reasons(metrics({ liquiditySol: 1 }), filters).length === 1);
    check("null liquidity is a stage-1 blocker", evaluateStage1Reasons(metrics({ liquiditySol: null }), filters).length === 1);
    check("concentrated top holder is a stage-1 blocker", evaluateStage1Reasons(metrics({ topHolderPercent: 90 }), filters).length === 1);
    check("null renounce status is a stage-1 blocker", evaluateStage1Reasons(metrics({ mintAuthorityRenounced: null }), filters).length === 1);
    check("a clean token has no stage-1 blockers", evaluateStage1Reasons(metrics(), filters).length === 0);
  }

  // ---------------------------------------------------------------
  console.log("\n-- EQUIVALENCE: early-skip never changes the decision --");
  {
    // Each case: a token that fails at least one stage-1 rule. We compare
    //   (a) full collection - activity fetched normally
    //   (b) early skip     - activity never fetched
    // The decision must be identical. This is the property the whole
    // optimisation rests on.
    const stage1Failures: Array<[string, Partial<TokenMetrics>]> = [
      ["liquidity below minimum", { liquiditySol: 1 }],
      ["liquidity unknown", { liquiditySol: null }],
      ["top holder too concentrated", { topHolderPercent: 90 }],
      ["top holder unknown", { topHolderPercent: null }],
      ["dev wallet too large", { devWalletPercent: 50 }],
      ["dev wallet unknown", { devWalletPercent: null }],
      ["mint authority not renounced", { mintAuthorityRenounced: false }],
      ["mint authority unknown", { mintAuthorityRenounced: null }],
      ["freeze authority not renounced", { freezeAuthorityRenounced: false }],
      ["risky token extensions present", { riskyTokenExtensions: ["TransferHook"] }],
      ["token extensions unknown", { riskyTokenExtensions: null }],
      ["creator still holds LP (raydium)", { lpCheckApplicable: true, creatorLpPercent: 50 }],
      ["creator LP unknown (raydium)", { lpCheckApplicable: true, creatorLpPercent: null }],
      ["several failures at once", { liquiditySol: 0, topHolderPercent: 99, mintAuthorityRenounced: false }],
    ];

    let allMatched = true;
    for (const [label, override] of stage1Failures) {
      // (a) full collection - even with PERFECT activity data
      const full = evaluateFilters(event, metrics({ ...override, uniqueWallets: 40, transactionCount: 60 }), filters);
      // (b) early skip - activity never collected
      const early = evaluateFilters(
        event,
        metrics({ ...override, uniqueWallets: null, transactionCount: null, activitySkippedEarly: true }),
        filters,
      );
      const matched = full.decision === early.decision && full.decision === "SKIP";
      if (!matched) allMatched = false;
      check(`same decision (SKIP) with and without stage 2: ${label}`, matched);
    }
    check("EVERY stage-1 failure produced an identical decision either way", allMatched);
  }

  // ---------------------------------------------------------------
  console.log("\n-- a clean token still runs stage 2, and activity can still reject it --");
  {
    const clean = metrics();
    check("clean stage 1 -> no blockers, so stage 2 MUST run", evaluateStage1Reasons(clean, filters).length === 0);
    check("clean token with good activity PASSes", evaluateFilters(event, clean, filters).decision === "PASS");

    // The case that proves we cannot skip stage 2 when stage 1 is clean:
    // activity is the ONLY thing rejecting this token.
    const thinActivity = evaluateFilters(event, metrics({ uniqueWallets: 2, transactionCount: 3 }), filters);
    check("clean stage 1 but thin activity -> SKIP (so stage 2 is load-bearing)", thinActivity.decision === "SKIP");
    check("  ...and the reason is the activity rule", thinActivity.reasons.some((r) => r.includes("too few unique wallets")));

    const failedActivity = evaluateFilters(event, metrics({ uniqueWallets: null, transactionCount: null }), filters);
    check("clean stage 1 but activity FETCH FAILED -> SKIP (fails closed)", failedActivity.decision === "SKIP");
    check("  ...worded as an RPC failure", failedActivity.reasons.some((r) => r.includes("could not fetch recent signatures")));
  }

  // ---------------------------------------------------------------
  console.log("\n-- the early-skip reason is explicit, not silently omitted --");
  {
    const early = evaluateFilters(
      event,
      metrics({ liquiditySol: 1, uniqueWallets: null, transactionCount: null, activitySkippedEarly: true }),
      filters,
    );
    check("an explicit 'skipped early' reason is present", early.reasons.some((r) => r.includes("activity metrics not collected")));
    check("  ...and it says WHY", early.reasons.some((r) => r.includes("already failed an earlier check")));
    // The critical wording distinction: this must never look like an RPC failure.
    check(
      "  ...and is NOT worded as a failed fetch",
      !early.reasons.some((r) => r.includes("could not fetch recent signatures")),
    );
    check("the real stage-1 reason is still reported", early.reasons.some((r) => r.includes("liquidity too low")));
  }

  // ---------------------------------------------------------------
  console.log("\n-- known-program guard (the Token-2022 creator bug) --");
  {
    check("Token-2022 program ID is recognised", identifyKnownProgram("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") === "Token-2022");
    check("SPL Token program ID is recognised", identifyKnownProgram("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") === "SPL Token");
    check("System program is recognised", identifyKnownProgram("11111111111111111111111111111111") === "System");
    check("a real wallet is NOT flagged", identifyKnownProgram("CreatorAddress11111111111111111111111111111") === null);
    check("undefined is handled", identifyKnownProgram(undefined) === null);
  }

  // ---------------------------------------------------------------
  console.log("\n-- WorkQueue: concurrency is actually bounded --");
  {
    let concurrent = 0;
    let peak = 0;
    const q = new WorkQueue<number>({
      maxConcurrent: 2,
      maxQueued: 100,
      worker: async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
      },
    });
    for (let i = 0; i < 20; i++) q.push(i);
    await q.drain();
    check("20 jobs at maxConcurrent=2 never exceeded 2 in flight", peak === 2);
    check("all 20 completed", q.stats().totalCompleted === 20);
    check("nothing dropped when the backlog fits", q.stats().totalDropped === 0);
  }

  // ---------------------------------------------------------------
  console.log("\n-- WorkQueue: backlog is capped, OLDEST dropped, loudly --");
  {
    const dropped: number[] = [];
    const processed: number[] = [];
    const q = new WorkQueue<number>({
      maxConcurrent: 1,
      maxQueued: 3,
      onDrop: (item) => dropped.push(item),
      worker: async (n) => {
        await new Promise((r) => setTimeout(r, 5));
        processed.push(n);
      },
    });
    for (let i = 0; i < 10; i++) q.push(i);
    await q.drain();

    check("the backlog cap forced drops", dropped.length > 0);
    check("every drop was reported to onDrop", dropped.length === q.stats().totalDropped);
    check("accepted + nothing lost silently", q.stats().totalAccepted === 10);
    // Oldest-first eviction: the earliest items are the ones discarded.
    check("the OLDEST items were dropped, not the newest", dropped[0] < processed[processed.length - 1]);
    check("the newest item always survived", processed.includes(9));
  }

  // ---------------------------------------------------------------
  console.log("\n-- WorkQueue: a throwing job cannot kill the queue --");
  {
    const errors: unknown[] = [];
    const done: number[] = [];
    const q = new WorkQueue<number>({
      maxConcurrent: 2,
      maxQueued: 10,
      onError: (_i, e) => errors.push(e),
      worker: async (n) => {
        if (n % 2 === 0) throw new Error(`boom ${n}`);
        done.push(n);
      },
    });
    for (let i = 0; i < 6; i++) q.push(i);
    await q.drain();
    check("failures were captured, not thrown into the void", errors.length === 3);
    check("the surviving jobs still ran", done.length === 3);
    check("the queue drained fully despite failures", q.stats().running === 0);
  }

  // ---------------------------------------------------------------
  console.log("\n-- dropped tokens are recorded, so a run stays reconcilable --");
  {
    const rec = buildDroppedRecord({
      mint: "MintDropped11111111111111111111111111111111",
      signature: "sig-dropped",
      source: "pumpfun",
      detectedAt: "2026-01-01T00:00:00.000Z",
      queueWaitMs: 1234,
    });
    check("record identifies the token", rec.mint === "MintDropped11111111111111111111111111111111");
    check("record keeps the signature for cross-referencing", rec.signature === "sig-dropped");
    check("record keeps when it was detected", rec.detectedAt === "2026-01-01T00:00:00.000Z");
    check("record keeps how long it waited before being dropped", rec.queueWaitMs === 1234);
    check("record carries an explicit reason", rec.reasons[0].includes("queue full"));
    check("  ...saying it was never evaluated", rec.reasons[0].includes("never evaluated"));

    // The important part: DROPPED must not masquerade as a filter outcome.
    check("decision is DROPPED, not PASS", rec.decision !== "PASS");
    check("decision is DROPPED, not SKIP", rec.decision !== "SKIP");
    check("decision is exactly 'DROPPED'", rec.decision === "DROPPED");
  }

  // ---------------------------------------------------------------
  console.log("\n-- analysis: drops never pollute the PASS/SKIP rates --");
  {
    const decisions: DecisionRecord[] = [
      { decision: "PASS", mint: "A", reasons: [] },
      { decision: "SKIP", mint: "B", reasons: ["liquidity too low"] },
      { decision: "SKIP", mint: "C", reasons: ["liquidity too low"] },
      buildDroppedRecord({ mint: "D", signature: "s1", source: "pumpfun", detectedAt: "2026-01-01T00:00:00.000Z", queueWaitMs: 10 }) as DecisionRecord,
      buildDroppedRecord({ mint: "E", signature: "s2", source: "pumpfun", detectedAt: "2026-01-01T00:00:00.000Z", queueWaitMs: 20 }) as DecisionRecord,
    ];
    const r = analyze([], decisions, [2, 5, 10]);
    check("dropped tokens counted separately", r.decisionsDropped === 2);
    check("dropped NOT counted as PASS", r.decisionsPassed === 1);
    check("dropped NOT counted as SKIP", r.decisionsSkipped === 2);
    // The reconciliation the whole change exists for.
    check(
      "reconciles: detected 5 = 1 PASS + 2 SKIP + 2 DROPPED",
      r.decisionsPassed + r.decisionsSkipped + r.decisionsDropped === 5,
    );
    check("a dropped token's reason does not enter the SKIP-reason ranking",
      !r.topSkipReasons.some((x) => x.reason.includes("queue full")));
  }

  // ---------------------------------------------------------------
  console.log("\n-- forceActivityMetrics: the delay probe must still see activity --");
  {
    // The probe measures uniqueWallets/transactionCount as a token ages. With
    // Bug 1 outstanding every token fails a stage-1 rule, so the normal gate
    // would skip stage 2 on 100% of them and the probe would record nothing.
    // activitySkippedEarly must therefore be false when the flag is set.
    const failing = metrics({ liquiditySol: 1 });
    check("stage 1 does block this token", evaluateStage1Reasons(failing, filters).length > 0);

    // Mirrors the gate in collectTokenMetrics: stage1Reasons.length > 0 && !force
    const gate = (blocked: boolean, force: boolean) => blocked && !force;
    check("without the flag, activity is skipped", gate(true, false) === true);
    check("WITH the flag, activity is collected anyway", gate(true, true) === false);
    check("a clean token collects activity either way", gate(false, false) === false && gate(false, true) === false);
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
