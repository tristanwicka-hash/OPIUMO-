/**
 * Part 4 test: the filter engine - the piece you must manually verify
 * before trading is ever enabled (see README non-negotiables).
 *
 * Run with: npm run test:filters
 *
 * Fully offline: evaluateFilters() is a pure function over
 * (event, metrics, filters), so every case here is deterministic - no RPC,
 * no mocks needed. This is the most important test suite in the whole bot;
 * read the cases below alongside config/default.json and confirm the
 * thresholds + reasons match what you actually want before flipping
 * trading.enabled.
 */
import fs from "fs";
import { evaluateFilters, formatDecisionLine } from "../src/filters/engine";
import { DecisionLog } from "../src/filters/decisionLog";
import { loadConfig } from "../src/config";
import { NewPoolEvent } from "../src/watcher/types";
import { TokenMetrics } from "../src/data/tokenMetrics";

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

const event: NewPoolEvent = {
  source: "pumpfun",
  signature: "sig-test",
  slot: 1,
  mint: "MintAddress1111111111111111111111111111111",
  poolAddress: "PoolAddress111111111111111111111111111111",
  creator: "CreatorAddress11111111111111111111111111111",
  detectedAt: new Date().toISOString(),
};

function goodMetrics(overrides: Partial<TokenMetrics> = {}): TokenMetrics {
  return {
    mint: event.mint,
    fetchedAt: new Date().toISOString(),
    liquiditySol: 10,
    topHolderPercent: 10,
    devWalletPercent: 5,
    mintAuthorityRenounced: true,
    freezeAuthorityRenounced: true,
    stale: false,
    uniqueWallets: 40,
    transactionCount: 60,
    warnings: [],
    ...overrides,
  };
}

async function main() {
  console.log("=== Part 4 test: filter engine ===");
  const filters = loadConfig().filters;
  console.log("Using thresholds from config/default.json:", JSON.stringify(filters));

  console.log("\n-- baseline: a comfortably-good token should PASS --");
  {
    const result = evaluateFilters(event, goodMetrics(), filters);
    check("decision is PASS", result.decision === "PASS");
    check("no reasons on PASS", result.reasons.length === 0);
  }

  console.log("\n-- boundary values (at-threshold should still PASS, filters are inclusive) --");
  {
    const boundary = goodMetrics({
      liquiditySol: filters.minLiquiditySol,
      topHolderPercent: filters.maxTopHolderPercent,
      devWalletPercent: filters.maxDevWalletPercent,
      uniqueWallets: filters.minUniqueWallets,
      transactionCount: filters.minTransactionCount,
    });
    const result = evaluateFilters(event, boundary, filters);
    check("exact-threshold values PASS (>= / <= are inclusive)", result.decision === "PASS");
  }

  console.log("\n-- each rule fails individually with a specific reason --");
  {
    const r = evaluateFilters(event, goodMetrics({ liquiditySol: filters.minLiquiditySol - 0.01 }), filters);
    check("low liquidity -> SKIP", r.decision === "SKIP");
    check("low liquidity -> reason mentions 'liquidity'", r.reasons.some((x) => x.includes("liquidity too low")));
  }
  {
    const r = evaluateFilters(event, goodMetrics({ topHolderPercent: filters.maxTopHolderPercent + 0.01 }), filters);
    check("high top holder % -> SKIP", r.decision === "SKIP");
    check("high top holder % -> reason mentions concentration", r.reasons.some((x) => x.includes("concentrated")));
  }
  {
    const r = evaluateFilters(event, goodMetrics({ devWalletPercent: filters.maxDevWalletPercent + 0.01 }), filters);
    check("high dev wallet % -> SKIP", r.decision === "SKIP");
    check("high dev wallet % -> reason mentions dev wallet", r.reasons.some((x) => x.includes("dev wallet")));
  }
  {
    const r = evaluateFilters(event, goodMetrics({ mintAuthorityRenounced: false }), filters);
    check("mint authority CONFIRMED not renounced -> SKIP", r.decision === "SKIP");
    check("reason says 'not renounced' (a confirmed fact), not 'unknown'", r.reasons.some((x) => x.includes("mint authority not renounced")));
  }
  {
    const r = evaluateFilters(event, goodMetrics({ freezeAuthorityRenounced: false }), filters);
    check("freeze authority CONFIRMED not renounced -> SKIP", r.decision === "SKIP");
    check("reason says 'not renounced' (a confirmed fact), not 'unknown'", r.reasons.some((x) => x.includes("freeze authority not renounced")));
  }
  {
    // null = "we couldn't verify" (e.g. an RPC call failed) - this must NEVER be worded
    // the same as false ("we checked, and it's confirmed not renounced"). Regression test
    // for the bug where a transient RPC failure looked identical to a real red flag.
    const r = evaluateFilters(event, goodMetrics({ mintAuthorityRenounced: null, freezeAuthorityRenounced: null }), filters);
    check("UNKNOWN renounce status -> SKIP (fails closed)", r.decision === "SKIP");
    check(
      "reasons say 'unknown', NOT 'not renounced' - never overstate an RPC failure as a confirmed finding",
      r.reasons.some((x) => x.includes("mint authority renounce status unknown")) &&
        r.reasons.some((x) => x.includes("freeze authority renounce status unknown")) &&
        !r.reasons.some((x) => x.includes("mint authority not renounced")) &&
        !r.reasons.some((x) => x.includes("freeze authority not renounced"))
    );
  }
  {
    const r = evaluateFilters(event, goodMetrics({ uniqueWallets: filters.minUniqueWallets - 1 }), filters);
    check("too few unique wallets -> SKIP", r.decision === "SKIP");
    check("reason mentions unique wallets", r.reasons.some((x) => x.includes("unique wallets")));
  }
  {
    const r = evaluateFilters(event, goodMetrics({ transactionCount: filters.minTransactionCount - 1 }), filters);
    check("too few transactions -> SKIP", r.decision === "SKIP");
    check("reason mentions transactions", r.reasons.some((x) => x.includes("transactions")));
  }
  {
    // Lots of tx volume, but from almost no distinct wallets -> wash-trading-shaped.
    const r = evaluateFilters(event, goodMetrics({ uniqueWallets: 5, transactionCount: 60 }), filters);
    check("low wallet/tx ratio -> SKIP", r.decision === "SKIP");
    check("reason mentions ratio", r.reasons.some((x) => x.includes("ratio")));
  }

  console.log("\n-- unknown metrics fail closed, never silently pass --");
  {
    const r = evaluateFilters(
      event,
      goodMetrics({ liquiditySol: null, topHolderPercent: null, devWalletPercent: null, uniqueWallets: null, transactionCount: null }),
      filters
    );
    check("all-unknown metrics -> SKIP", r.decision === "SKIP");
    check("4 distinct 'unknown' reasons reported", r.reasons.filter((x) => x.includes("unknown")).length === 4); // liquidity, topHolder, devWallet, wallet activity (combined)
  }

  console.log("\n-- stale metrics never silently PASS --");
  {
    const r = evaluateFilters(event, goodMetrics({ stale: true }), filters);
    check("stale metrics -> SKIP even though every value looks good", r.decision === "SKIP");
    check("reason mentions staleness", r.reasons.some((x) => x.includes("stale")));
  }

  console.log("\n-- multiple simultaneous failures are all reported, not just the first --");
  {
    const r = evaluateFilters(
      event,
      goodMetrics({ liquiditySol: 0.1, devWalletPercent: 50, mintAuthorityRenounced: false }),
      filters
    );
    check("multiple failures -> SKIP", r.decision === "SKIP");
    check("all 3 reasons present, not just the first", r.reasons.length === 3);
  }

  console.log("\n-- console formatting --");
  {
    const passLine = formatDecisionLine(evaluateFilters(event, goodMetrics(), filters));
    const skipLine = formatDecisionLine(evaluateFilters(event, goodMetrics({ liquiditySol: 0 }), filters));
    check("PASS line starts with [PASS]", passLine.startsWith("[PASS]"));
    check("SKIP line starts with [SKIP] and includes reasons", skipLine.startsWith("[SKIP]") && skipLine.includes("reasons:"));
    check("renounced=?/? shown when renounce status is unknown, not Y/Y or N/N", formatDecisionLine(evaluateFilters(event, goodMetrics({ mintAuthorityRenounced: null, freezeAuthorityRenounced: null }), filters)).includes("renounced=?/?"));
  }
  {
    // A PASS that only happened because a partial fetch failure was masked would be
    // invisible during manual review unless warnings are printed right on the line.
    const passWithWarning = evaluateFilters(event, goodMetrics({ warnings: ["devWalletPercent: rpc timeout"] }), filters);
    const line = formatDecisionLine(passWithWarning);
    check("PASS decision is unaffected by an unrelated warning", passWithWarning.decision === "PASS");
    check("warnings are printed on the console line even for a PASS", line.includes("warnings:") && line.includes("rpc timeout"));
  }

  console.log(`\nOffline checks: ${pass} passed, ${fail} failed`);

  console.log("\n-- decision log (console + logs/decisions.jsonl) --");
  {
    const config = loadConfig();
    const before = fs.existsSync(config.logging.decisionsFile)
      ? fs.readFileSync(config.logging.decisionsFile, "utf-8").split("\n").filter(Boolean).length
      : 0;

    const log = new DecisionLog();
    log.record(evaluateFilters(event, goodMetrics(), filters));
    log.record(evaluateFilters(event, goodMetrics({ liquiditySol: 0 }), filters));

    const all = log.readAll();
    check("decisions.jsonl grew by 2 records", all.length === before + 2);
    const last = all[all.length - 1] as any;
    check("last record is the SKIP with reasons persisted", last.decision === "SKIP" && Array.isArray(last.reasons) && last.reasons.length > 0);
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
