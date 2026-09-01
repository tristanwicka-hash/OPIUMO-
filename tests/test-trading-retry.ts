/**
 * Spot sniper test: sell-failure backoff/abandonment. Fully offline/
 * deterministic - pure functions over plain timestamps and counters.
 *
 * This covers a real bug found in review: a failed sell used to retry
 * every single monitoring cycle forever with no backoff and no way to
 * ever stop trying - on a genuinely dead token (rugged, zero liquidity)
 * that meant hammering Jupiter indefinitely. Fixed in src/trading/retry.ts.
 *
 * Run with: npm run test:trading-retry
 */
import { shouldAttemptSell, shouldAbandonPosition, nextAttemptInMs } from "../src/trading/retry";

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

async function main() {
  console.log("=== Spot sniper test: sell-failure retry/backoff/abandonment (all offline) ===");

  console.log("\n-- shouldAttemptSell --");
  {
    const fresh = { sellFailureCount: 0, lastSellFailureAt: null };
    check("no prior failures -> always attempt immediately", shouldAttemptSell(fresh, Date.now(), 30_000, 1_800_000));
  }
  {
    const now = Date.now();
    const justFailed = { sellFailureCount: 1, lastSellFailureAt: now };
    check("just failed once -> do NOT retry immediately", !shouldAttemptSell(justFailed, now, 30_000, 1_800_000));
    check("just failed once -> DO retry after the base backoff elapses", shouldAttemptSell(justFailed, now + 30_001, 30_000, 1_800_000));
  }
  {
    const now = Date.now();
    const failedTwice = { sellFailureCount: 2, lastSellFailureAt: now };
    // base=30s, failure #2 -> backoff = 30s * 2^(2-1) = 60s
    check("second failure backs off longer (exponential, not linear)", !shouldAttemptSell(failedTwice, now + 30_001, 30_000, 1_800_000));
    check("second failure's backoff matches 2x the base", shouldAttemptSell(failedTwice, now + 60_001, 30_000, 1_800_000));
  }
  {
    const now = Date.now();
    // failure #10 would be base * 2^9 = 30s * 512 = 4.27h - must be capped, not grow unbounded.
    const manyFailures = { sellFailureCount: 10, lastSellFailureAt: now };
    const maxMs = 1_800_000; // 30 min cap
    check("backoff is capped, doesn't grow forever", !shouldAttemptSell(manyFailures, now + maxMs - 1, 30_000, maxMs));
    check("retry is allowed again once the CAPPED wait elapses", shouldAttemptSell(manyFailures, now + maxMs + 1, 30_000, maxMs));
  }

  console.log("\n-- nextAttemptInMs (for logging/visibility) --");
  {
    check("no failures -> 0ms wait", nextAttemptInMs({ sellFailureCount: 0, lastSellFailureAt: null }, Date.now(), 30_000, 1_800_000) === 0);
  }
  {
    const now = Date.now();
    const remaining = nextAttemptInMs({ sellFailureCount: 1, lastSellFailureAt: now }, now + 10_000, 30_000, 1_800_000);
    check("reports the remaining wait, not the full backoff", Math.abs(remaining - 20_000) < 5);
  }
  {
    const now = Date.now();
    const remaining = nextAttemptInMs({ sellFailureCount: 1, lastSellFailureAt: now }, now + 999_999, 30_000, 1_800_000);
    check("never reports a negative wait once backoff has already elapsed", remaining === 0);
  }

  console.log("\n-- shouldAbandonPosition --");
  {
    check("below the limit -> not abandoned", !shouldAbandonPosition(4, 5));
    check("AT the limit -> abandoned (inclusive)", shouldAbandonPosition(5, 5));
    check("past the limit -> abandoned", shouldAbandonPosition(9, 5));
    check("zero failures -> never abandoned", !shouldAbandonPosition(0, 5));
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
