/**
 * Priority fee on swap transactions. Fully offline - the pure request-body
 * builder needs nothing, and the one wire-level check mocks global.fetch.
 * No RPC connection is opened.
 *
 * Why this exists: the latency audit found that NO transaction requested a
 * priority fee at all. `dynamicComputeUnitLimit` was already in the body, but
 * that sets the compute LIMIT (how many units may be consumed) - it is not a
 * price and does nothing for inclusion order.
 *
 * The asymmetry is the point: sells get a fee, buys do not. A sell that fails
 * to land leaves a position that is actively losing value; a buy that fails to
 * land just leaves no position.
 *
 * Run with: npm run test:priority-fee
 */
import { buildSwapRequestBody, getSwapTransactionBase64 } from "../src/trading/jupiter";
import { loadConfig } from "../src/config";

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

const quote = { inAmount: "1000", outAmount: "2000", priceImpactPct: "0.1" } as any;
const USER = "UserPubkey11111111111111111111111111111111";

async function main() {
  console.log("=== Priority fee on swaps (offline) ===");

  // ---------------------------------------------------------------
  console.log("\n-- SELL path: a fee is attached --");
  {
    const body = buildSwapRequestBody(quote, USER, 100_000);
    check("prioritizationFeeLamports is present", "prioritizationFeeLamports" in body);
    check("it carries the exact lamports requested", body.prioritizationFeeLamports === 100_000);
    check("the quote is still forwarded", body.quoteResponse === quote);
    check("userPublicKey is still forwarded", body.userPublicKey === USER);
    check("wrapAndUnwrapSol is untouched", body.wrapAndUnwrapSol === true);
    check("dynamicComputeUnitLimit is untouched", body.dynamicComputeUnitLimit === true);
  }

  // ---------------------------------------------------------------
  console.log("\n-- BUY path (fee 0): request is byte-identical to before the change --");
  {
    const body = buildSwapRequestBody(quote, USER, 0);
    // A zero fee omits the field rather than sending an explicit 0, so nothing
    // about the buy request changes.
    check("prioritizationFeeLamports is ABSENT, not 0", !("prioritizationFeeLamports" in body));
    check("exactly the four original fields are sent", Object.keys(body).sort().join(",") === "dynamicComputeUnitLimit,quoteResponse,userPublicKey,wrapAndUnwrapSol");

    // The literal body the old code produced, for a byte-level comparison.
    const legacy = JSON.stringify({
      quoteResponse: quote,
      userPublicKey: USER,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    });
    check("serialised body is byte-identical to the pre-change request", JSON.stringify(body) === legacy);
  }

  // ---------------------------------------------------------------
  console.log("\n-- edge cases --");
  {
    check("a negative fee is treated as no fee", !("prioritizationFeeLamports" in buildSwapRequestBody(quote, USER, -5)));
    const frac = buildSwapRequestBody(quote, USER, 1234.9);
    check("a fractional lamport value is floored (lamports are integers)", frac.prioritizationFeeLamports === 1234);
    check("a large fee is passed through unclamped", buildSwapRequestBody(quote, USER, 5_000_000).prioritizationFeeLamports === 5_000_000);
  }

  // ---------------------------------------------------------------
  console.log("\n-- config wiring: sells priced, buys free by default --");
  {
    const t = loadConfig().trading;
    check("sellPriorityFeeLamports is configured and > 0", typeof t.sellPriorityFeeLamports === "number" && t.sellPriorityFeeLamports > 0);
    check("buyPriorityFeeLamports defaults to 0", t.buyPriorityFeeLamports === 0);
    check("the sell fee is strictly greater than the buy fee", t.sellPriorityFeeLamports > t.buyPriorityFeeLamports);
    // Neither is hardcoded - both come from config/default.json so they can be
    // retuned without touching source.
    check("the fee is not hardcoded into the builder", buildSwapRequestBody(quote, USER, t.sellPriorityFeeLamports).prioritizationFeeLamports === t.sellPriorityFeeLamports);
  }

  // ---------------------------------------------------------------
  console.log("\n-- wire level: the field actually reaches the /swap request --");
  {
    const originalFetch = global.fetch;
    let captured: any = null;
    global.fetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ swapTransaction: "BASE64" }),
        text: async () => "",
      } as any;
    }) as any;

    try {
      await getSwapTransactionBase64(quote, USER, 100_000);
      check("the POST body carried the priority fee", captured?.prioritizationFeeLamports === 100_000);

      captured = null;
      await getSwapTransactionBase64(quote, USER, 0);
      check("a zero-fee POST omits the field entirely", captured !== null && !("prioritizationFeeLamports" in captured));

      captured = null;
      await getSwapTransactionBase64(quote, USER);
      check("the default (no argument) sends no fee - buys unchanged", captured !== null && !("prioritizationFeeLamports" in captured));
    } finally {
      global.fetch = originalFetch;
    }
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
