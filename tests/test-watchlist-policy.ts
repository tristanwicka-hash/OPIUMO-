/**
 * Offline, deterministic, no network, no RNG.
 *
 * The cases below are built from tokens this bot actually observed on
 * 2026-09-09 rather than invented shapes, because the whole point of the
 * watchlist is to catch the specific thing the old design missed. Two real
 * winners are in here by their real numbers, and so is the median dead token.
 * If a rule change would have thrown away either winner, one of these fails.
 */

import {
  DEFAULT_WATCH_POLICY,
  WatchEntry,
  baselineSol,
  checkPriority,
  classifyStage,
  growthMultiple,
  latestSol,
  nextCheckDelayMs,
  shouldRunFullCheck,
} from "../src/watchlist/policy";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`);
  }
}

const T0 = Date.parse("2026-09-09T12:00:00.000Z");
const P = DEFAULT_WATCH_POLICY;

function entry(sols: (number | null)[], over: Partial<WatchEntry> = {}): WatchEntry {
  return {
    mint: "MintUnderTest",
    source: "pumpfun",
    signature: "sig",
    poolAddress: "pool",
    detectedAtMs: T0,
    readings: sols.map((sol, i) => ({ atMs: T0 + i * 60_000, sol })),
    stage: "fresh",
    nextCheckAtMs: T0,
    fullChecks: 0,
    consecutiveFailures: 0,
    ...over,
  };
}

console.log("=== reading the liquidity history ===\n");
{
  const e = entry([0.3, null, 1.2, null]);
  check("baseline is the first SUCCESSFUL reading", baselineSol(e) === 0.3);
  check("latest is the last SUCCESSFUL reading, skipping failures", latestSol(e) === 1.2);
  check("growth is latest over baseline", Math.abs((growthMultiple(e) ?? 0) - 4) < 1e-9);

  const allFailed = entry([null, null]);
  check("no successful reading means null baseline, not zero", baselineSol(allFailed) === null);
  check("...and null growth, never Infinity", growthMultiple(allFailed) === null);

  const zeroBase = entry([0, 5]);
  check("a zero baseline yields null growth rather than dividing by it", growthMultiple(zeroBase) === null);
}

console.log("\n=== the two real winners must survive ===\n");
{
  // Observed 2026-09-09: 0.278 -> 4.348 SOL over the tracking window. Under the
  // old design this was rejected at t+0 for sitting below minLiquiditySol: 5.
  const winner1 = entry([0.278, 0.9, 2.1, 4.348]);
  const s1 = classifyStage(winner1, P, T0 + 4 * 60_000);
  check("winner #1 (0.278 -> 4.348) is not dead", s1 !== "dead", s1);
  check("winner #1 reads as warming", s1 === "warming", s1);
  check(
    "winner #1 earns a full evaluation",
    shouldRunFullCheck(winner1, P, s1),
    `growth=${growthMultiple(winner1)} latest=${latestSol(winner1)}`
  );

  // Observed 2026-09-09: 1.429 -> 7.39 SOL.
  const winner2 = entry([1.429, 3.0, 7.39]);
  const s2 = classifyStage(winner2, P, T0 + 3 * 60_000);
  check("winner #2 (1.429 -> 7.39) is not dead", s2 !== "dead", s2);
  check("winner #2 earns a full evaluation", shouldRunFullCheck(winner2, P, s2));

  // The point of the whole exercise: caught while still BELOW the old floor.
  const early = entry([0.278, 0.7, 1.4]);
  check(
    "winner #1 is promoted while still under filters.minLiquiditySol (5) - the old design's blind spot",
    shouldRunFullCheck(early, P, classifyStage(early, P, T0 + 3 * 60_000)),
    `latest=${latestSol(early)} growth=${growthMultiple(early)}`
  );
}

console.log("\n=== the median token must be dropped, and quickly ===\n");
{
  // The median tracked token sat at 0.002 SOL an hour in. Thousands of these.
  const dead = entry([0.002, 0.002, 0.0019, 0.002, 0.0021]);
  const sd = classifyStage(dead, P, T0 + 5 * 60_000);
  check("a flat dust token is classified dead", sd === "dead", sd);
  check("...and never earns an expensive check", !shouldRunFullCheck(dead, P, sd));
  check("...and is scheduled never again", nextCheckDelayMs(sd, P) === Number.POSITIVE_INFINITY);

  const notYetPatient = entry([0.002, 0.002]);
  check(
    "the same token is NOT declared dead before patienceChecks readings",
    classifyStage(notYetPatient, P, T0 + 2 * 60_000) !== "dead"
  );
}

console.log("\n=== failed reads are not evidence of death ===\n");
{
  // A token the RPC could not read tells us nothing about itself. Evicting it
  // would bias the sample toward whatever the RPC happened to answer, which is
  // exactly the direction that makes a rare-winner rate look lower than it is.
  const unread = entry([null, null, null, null, null, null]);
  check("six failed reads is not death", classifyStage(unread, P, T0 + 6 * 60_000) !== "dead");

  const mostlyFailed = entry([0.002, null, null, null, null, null]);
  check(
    "one dust reading plus five failures is not enough to declare death",
    classifyStage(mostlyFailed, P, T0 + 6 * 60_000) !== "dead",
    "patience counts SUCCESSFUL reads, not attempts"
  );
}

console.log("\n=== migration is the highest-information moment ===\n");
{
  const near = entry([2, 30, 62]); // 62 of 85 = 73%, past the 70% mark
  const sn = classifyStage(near, P, T0 + 3 * 60_000);
  check("a token at 73% of the graduation threshold reads as near-migration", sn === "near-migration", sn);
  check("near-migration always earns the expensive check", shouldRunFullCheck(near, P, sn));
  check("...and is polled fastest", nextCheckDelayMs(sn, P) === P.intervalNearMigrationMs);
  check("faster than warming, which is faster than fresh",
    P.intervalNearMigrationMs < P.intervalWarmingMs && P.intervalWarmingMs < P.intervalFreshMs);

  const graduated = entry([2, 40, 90]);
  check("past the threshold reads as migrated", classifyStage(graduated, P, T0 + 3 * 60_000) === "migrated");

  const onRaydium = entry([0.5], { source: "raydium" });
  check("anything detected on Raydium is migrated by definition", classifyStage(onRaydium, P, T0) === "migrated");
  check(
    "a migrated token is never evicted for a later dip",
    classifyStage(entry([0.01], { source: "raydium" }), P, T0 + 99 * 60_000) === "migrated"
  );
}

console.log("\n=== age cutoff ===\n");
{
  const old = entry([1, 1.1]);
  check("past maxAgeMs a token is dead however it looks", classifyStage(old, P, T0 + P.maxAgeMs + 1) === "dead");
  check("just inside maxAgeMs it is still watched", classifyStage(old, P, T0 + P.maxAgeMs - 1) !== "dead");
}

console.log("\n=== the expensive check is rationed ===\n");
{
  const hot = entry([1, 5]);
  const stage = classifyStage(hot, P, T0 + 2 * 60_000);
  check("a promising token earns a check", shouldRunFullCheck(hot, P, stage));

  const spent = entry([1, 5], { fullChecks: P.maxFullChecksPerToken });
  check(
    "the same token stops earning them once its per-token budget is used",
    !shouldRunFullCheck(spent, P, stage),
    `fullChecks=${spent.fullChecks}`
  );

  const bigMultipleOnDust = entry([0.001, 0.004]); // 4x, but on nothing
  check(
    "a big multiple on dust does NOT earn an expensive check",
    !shouldRunFullCheck(bigMultipleOnDust, P, classifyStage(bigMultipleOnDust, P, T0 + 2 * 60_000)),
    "growth alone would spend ~110 RPC calls on four thousandths of a SOL"
  );
}

console.log("\n=== budget ordering: who gets checked when calls are scarce ===\n");
{
  const nowMs = T0 + 10 * 60_000;
  const nearM = entry([2, 30, 62], { nextCheckAtMs: nowMs - 1_000, mint: "NEAR" });
  const warm = entry([1, 2], { nextCheckAtMs: nowMs - 500_000, mint: "WARM" });
  const fresh = entry([0.01], { nextCheckAtMs: nowMs - 900_000, mint: "FRESH" });

  const ranked = [fresh, warm, nearM]
    .map((e) => ({ e, p: checkPriority(e, classifyStage(e, P, nowMs), nowMs) }))
    .sort((a, b) => a.p - b.p)
    .map((x) => x.e.mint);

  check(
    "near-migration outranks warming outranks fresh, even when fresh is far more overdue",
    ranked.join(",") === "NEAR,WARM,FRESH",
    ranked.join(",")
  );

  const lateFresh = entry([0.01], { nextCheckAtMs: nowMs - 900_000, mint: "LATE" });
  const earlyFresh = entry([0.01], { nextCheckAtMs: nowMs - 1_000, mint: "EARLY" });
  const freshRanked = [earlyFresh, lateFresh]
    .map((e) => ({ e, p: checkPriority(e, "fresh", nowMs) }))
    .sort((a, b) => a.p - b.p)
    .map((x) => x.e.mint);
  check("within a stage, the most overdue goes first", freshRanked.join(",") === "LATE,EARLY", freshRanked.join(","));
}

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
