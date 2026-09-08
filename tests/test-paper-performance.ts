/**
 * Paper-trading performance analyzer tests - fully offline, pure functions,
 * synthetic fixtures only. No file I/O, no network, no config.
 *
 * Every expected value below is hand-computed in the comment above the
 * assertion, so a future reader can check the arithmetic without re-running
 * the code. That matters more than usual here: these numbers are what the
 * filter-tuning decisions will be made from, so a plausible-looking wrong
 * number is worse than an obvious crash.
 *
 * Run with: npm run test:paper-performance
 */
import {
  analyze,
  classifyExitReason,
  computeMaxDrawdown,
  reconstructPositions,
  TradeRecord,
  DecisionRecord,
} from "../src/analysis/paperPerformance";
import { computeFundingCapture, summarizeFundingCapture } from "../src/analysis/fundingCapture";

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
/** Float comparison - these are all money/percentage figures. */
function near(actual: number | null, expected: number, tol = 1e-9): boolean {
  return actual !== null && Math.abs(actual - expected) < tol;
}

// --- fixture builders -------------------------------------------------

function buy(mint: string, ts: string, sizeSol: number): TradeRecord {
  return { ts, event: "buy", isPaper: true, mint, sizeSol, entryPriceSol: 1e-9, txSignature: `PAPER-${mint}-buy` };
}
function sell(mint: string, ts: string, pnlSol: number, reason: string): TradeRecord {
  return { ts, event: "sell", isPaper: true, mint, pnlSol, reason, txSignature: `PAPER-${mint}-sell` };
}

// Exact reason strings as src/trading/exitLogic.ts writes them.
const R_ATR = "ATR stop-loss hit: price 5e-10 <= stop 0.000000001";
const R_TRAIL = "trailing stop hit: price 1.4e-9 <= 30% below highest (0.000000002) = 0.000000001";
const R_TIME = "time-stop: 48.0h since entry (>= 48h) and price never reached the first ladder tier (2x)";
const ladder = (mult: number, tier: number, pct: number) =>
  `ladder tier hit: ${mult.toFixed(2)}x >= ${tier}x - selling ${pct}% of remainder`;

async function main() {
  console.log("=== Paper-trading performance analyzer (all offline, synthetic fixtures) ===");

  // ---------------------------------------------------------------
  console.log("\n-- classifyExitReason: every exit kind the bot can emit --");
  {
    check("ATR stop-loss classified", classifyExitReason(R_ATR).kind === "atr-stop");
    check("trailing stop classified", classifyExitReason(R_TRAIL).kind === "trailing-stop");
    check("time-stop classified", classifyExitReason(R_TIME).kind === "time-stop");

    const t2 = classifyExitReason(ladder(2.01, 2, 50));
    check("ladder tier classified as ladder", t2.kind === "ladder");
    check("ladder tier multiple extracted (2x)", t2.ladderTier === 2);
    check("ladder tier 5x extracted", classifyExitReason(ladder(5.3, 5, 25)).ladderTier === 5);
    check("ladder tier 10x extracted", classifyExitReason(ladder(11.0, 10, 25)).ladderTier === 10);

    // Fail-closed: an unrecognised reason must NOT be silently bucketed as a stop.
    check("unknown reason -> unclassified, not forced into a bucket", classifyExitReason("manual close by owner").kind === "unclassified");
    check("undefined reason -> unclassified", classifyExitReason(undefined).kind === "unclassified");
  }

  // ---------------------------------------------------------------
  console.log("\n-- reconstructPositions: buy + ladder sells group into one position --");
  {
    // Full ladder: 50% of remainder at 2x, then 25%, then 25%.
    // remaining: 1 -> 0.5 -> 0.375 -> 0.28125  ... never reaches 0, so still OPEN.
    const recs = [
      buy("MINT_LADDER", "2026-01-01T00:00:00.000Z", 1),
      sell("MINT_LADDER", "2026-01-01T01:00:00.000Z", 0.5, ladder(2.0, 2, 50)),
      sell("MINT_LADDER", "2026-01-01T02:00:00.000Z", 0.6, ladder(5.0, 5, 25)),
      sell("MINT_LADDER", "2026-01-01T03:00:00.000Z", 0.7, ladder(10.0, 10, 25)),
    ];
    const pos = reconstructPositions(recs);
    check("one position reconstructed from 1 buy + 3 sells", pos.length === 1);
    check("all three ladder exits attached", pos[0].exits.length === 3);
    // Ladder tiers are partial by design - 28% of the position is still held.
    check("ladder-only position stays OPEN (partial exits)", pos[0].isClosed === false);
    // 0.5 + 0.6 + 0.7 = 1.8
    check("total pnl summed across ladder sells = 1.8", near(pos[0].totalPnlSol, 1.8));

    // A terminal stop after the ladder closes it out.
    const closedOut = reconstructPositions([...recs, sell("MINT_LADDER", "2026-01-01T04:00:00.000Z", -0.1, R_TRAIL)]);
    check("trailing stop after ladder closes the position", closedOut[0].isClosed === true);
    // 1.8 - 0.1 = 1.7
    check("pnl includes the closing stop = 1.7", near(closedOut[0].totalPnlSol, 1.7));
    // size 1 SOL, pnl 1.7 -> +170%
    check("returnPercent = 170%", near(closedOut[0].returnPercent, 170));
    // 00:00 -> 04:00 = 4 hours
    check("holdingHours = 4", near(closedOut[0].holdingHours, 4));
  }

  // ---------------------------------------------------------------
  console.log("\n-- reconstructPositions: same mint traded twice = two positions --");
  {
    const pos = reconstructPositions([
      buy("MINT_TWICE", "2026-01-01T00:00:00.000Z", 1),
      sell("MINT_TWICE", "2026-01-01T01:00:00.000Z", -0.3, R_ATR),
      buy("MINT_TWICE", "2026-01-02T00:00:00.000Z", 1),
      sell("MINT_TWICE", "2026-01-02T01:00:00.000Z", 0.4, R_TRAIL),
    ]);
    check("two separate positions, not one merged blob", pos.length === 2);
    check("first position is the loser (-0.3)", near(pos[0].totalPnlSol, -0.3));
    check("second position is the winner (+0.4)", near(pos[1].totalPnlSol, 0.4));
  }

  // ---------------------------------------------------------------
  console.log("\n-- reconstructPositions: a sell with no matching buy is not attributed --");
  {
    const pos = reconstructPositions([sell("MINT_ORPHAN", "2026-01-01T01:00:00.000Z", 5, R_ATR)]);
    check("orphan sell produces no position (not a phantom win)", pos.length === 0);
  }

  // ---------------------------------------------------------------
  console.log("\n-- computeMaxDrawdown: hand-computed equity curve --");
  {
    // curve:      +1    +1    -0.5   -1.5   +2
    // cumulative:  1     2     1.5    0      2
    // peak:        1     2     2      2      2
    // drawdown:    0     0     0.5    2      0     -> max 2.0 SOL from a peak of 2 = 100%
    const dd = computeMaxDrawdown([1, 1, -0.5, -1.5, 2]);
    check("max drawdown = 2.0 SOL", near(dd.sol, 2));
    check("max drawdown = 100% of the peak it fell from", near(dd.percent, 100));

    const allUp = computeMaxDrawdown([1, 2, 3]);
    check("monotonically rising curve -> zero drawdown", near(allUp.sol, 0));
    check("no drawdown and no positive peak fall -> percent null", allUp.percent === null);

    // Straight down from zero: peak never goes above 0, so a % of peak is undefined.
    const straightDown = computeMaxDrawdown([-1, -1]);
    check("straight-down curve -> 2.0 SOL drawdown", near(straightDown.sol, 2));
    check("peak never positive -> percent is null, not Infinity", straightDown.percent === null);

    check("empty curve -> zero drawdown", near(computeMaxDrawdown([]).sol, 0));
  }

  // ---------------------------------------------------------------
  console.log("\n-- analyze: win rate, averages and expectancy, hand-computed --");
  {
    // Four closed positions, each 1 SOL in:
    //   W1 +0.5 -> +50%   (ladder 2x, then trailing stop)
    //   W2 +1.0 -> +100%  (ladder 2x + 5x + 10x, then trailing stop)
    //   L1 -0.3 -> -30%   (ATR stop)
    //   L2 -0.1 -> -10%   (time stop)
    // wins=2 losses=2 -> win rate 50%, loss rate 50%
    // avg win  = (50 + 100)/2 = 75%
    // avg loss = |(-30 + -10)/2| = 20%
    // expectancy = 0.5*75 - 0.5*20 = 37.5 - 10 = 27.5
    const trades: TradeRecord[] = [
      buy("W1", "2026-01-01T00:00:00.000Z", 1),
      sell("W1", "2026-01-01T01:00:00.000Z", 0.2, ladder(2.0, 2, 50)),
      sell("W1", "2026-01-01T02:00:00.000Z", 0.3, R_TRAIL),

      buy("W2", "2026-01-01T00:00:00.000Z", 1),
      sell("W2", "2026-01-01T01:00:00.000Z", 0.3, ladder(2.0, 2, 50)),
      sell("W2", "2026-01-01T02:00:00.000Z", 0.3, ladder(5.0, 5, 25)),
      sell("W2", "2026-01-01T03:00:00.000Z", 0.2, ladder(10.0, 10, 25)),
      sell("W2", "2026-01-01T06:00:00.000Z", 0.2, R_TRAIL),

      buy("L1", "2026-01-01T00:00:00.000Z", 1),
      sell("L1", "2026-01-01T04:00:00.000Z", -0.3, R_ATR),

      buy("L2", "2026-01-01T00:00:00.000Z", 1),
      sell("L2", "2026-01-03T00:00:00.000Z", -0.1, R_TIME),
    ];
    const r = analyze(trades, [], [2, 5, 10]);

    check("4 closed positions", r.closedPositions === 4);
    check("0 open positions", r.openPositions === 0);
    check("2 wins", r.wins === 2);
    check("2 losses", r.losses === 2);
    check("win rate = 50%", near(r.winRatePercent, 50));
    check("loss rate = 50%", near(r.lossRatePercent, 50));
    check("average win = +75%", near(r.averageWinPercent, 75));
    check("average loss = 20% (reported positive)", near(r.averageLossPercent, 20));
    check("expectancy = +27.5 percentage points per trade", near(r.expectancyPercent, 27.5));
    // 0.5 + 1.0 - 0.3 - 0.1 = 1.1
    check("total pnl = 1.1 SOL", near(r.totalPnlSol, 1.1, 1e-9));

    // Ladder hit-rate as a % of the 4 closed positions:
    //   2x  hit by W1 and W2 -> 2/4 = 50%
    //   5x  hit by W2 only   -> 1/4 = 25%
    //   10x hit by W2 only   -> 1/4 = 25%
    const t2 = r.ladderTiers.find((t) => t.tier === 2)!;
    const t5 = r.ladderTiers.find((t) => t.tier === 5)!;
    const t10 = r.ladderTiers.find((t) => t.tier === 10)!;
    check("2x tier hit by 2 positions = 50% of closed", t2.positionsHit === 2 && near(t2.percentOfClosed, 50));
    check("5x tier hit by 1 position = 25% of closed", t5.positionsHit === 1 && near(t5.percentOfClosed, 25));
    check("10x tier hit by 1 position = 25% of closed", t10.positionsHit === 1 && near(t10.percentOfClosed, 25));

    // Terminal exits: trailing x2 (W1,W2), ATR x1 (L1), time x1 (L2)
    check("trailing stop closed 2 of 4 = 50%", r.exitKindCounts["trailing-stop"] === 2 && near(r.exitKindPercentOfClosed["trailing-stop"], 50));
    check("ATR stop closed 1 of 4 = 25%", r.exitKindCounts["atr-stop"] === 1 && near(r.exitKindPercentOfClosed["atr-stop"], 25));
    check("time stop closed 1 of 4 = 25%", r.exitKindCounts["time-stop"] === 1 && near(r.exitKindPercentOfClosed["time-stop"], 25));
    check("no unclassified exits in a clean fixture", r.exitKindCounts["unclassified"] === 0);

    // Holding times: W1 2h, W2 6h, L1 4h, L2 48h -> sorted 2,4,6,48
    // median of an even-length set = (4+6)/2 = 5; max = 48
    check("median holding time = 5h", near(r.medianHoldingHours, 5));
    check("max holding time = 48h", near(r.maxHoldingHours, 48));

    // Equity curve in CLOSE order: L1 closes 04:00 (-0.3), W1 02:00 (+0.5),
    // W2 06:00 (+1.0), L2 Jan-03 (-0.1)
    // sorted by close: W1 +0.5, L1 -0.3, W2 +1.0, L2 -0.1
    // cumulative: 0.5, 0.2, 1.2, 1.1 ; peak: 0.5, 0.5, 1.2, 1.2
    // drawdown:   0,   0.3, 0,   0.1  -> max 0.3 SOL from peak 0.5 = 60%
    check("max drawdown = 0.3 SOL", near(r.maxDrawdownSol, 0.3, 1e-9));
    check("max drawdown = 60% of peak", near(r.maxDrawdownPercent, 60, 1e-9));
  }

  // ---------------------------------------------------------------
  console.log("\n-- analyze: null-vs-zero discipline on an empty log --");
  {
    const r = analyze([], [], [2, 5, 10]);
    check("no trades -> win rate is null, NOT 0%", r.winRatePercent === null);
    check("no trades -> expectancy is null, NOT 0", r.expectancyPercent === null);
    check("no trades -> average win is null", r.averageWinPercent === null);
    check("no trades -> median holding time is null", r.medianHoldingHours === null);
    check("no trades -> drawdown is genuinely 0 SOL (a real measurement)", near(r.maxDrawdownSol, 0));
    check("no trades -> closedPositions 0", r.closedPositions === 0);
  }

  // ---------------------------------------------------------------
  console.log("\n-- analyze: paper/real separation is enforced --");
  {
    const mixed: TradeRecord[] = [
      buy("PAPER1", "2026-01-01T00:00:00.000Z", 1),
      sell("PAPER1", "2026-01-01T01:00:00.000Z", 0.5, R_TRAIL),
      // A REAL trade record that must never be averaged into paper results.
      { ts: "2026-01-01T00:00:00.000Z", event: "buy", isPaper: false, mint: "REAL1", sizeSol: 1 },
      { ts: "2026-01-01T01:00:00.000Z", event: "sell", isPaper: false, mint: "REAL1", pnlSol: -99, reason: R_ATR },
    ];
    const r = analyze(mixed, [], [2, 5, 10]);
    check("only the paper position is counted", r.closedPositions === 1);
    check("the real -99 loss did NOT leak into paper pnl", near(r.totalPnlSol, 0.5));
    check("skipped non-paper records are reported, not hidden", r.skippedNonPaperRecords === 2);

    // A record with no isPaper flag at all is excluded too - fail closed.
    const unflagged = analyze([{ ts: "2026-01-01T00:00:00.000Z", event: "buy", mint: "NOFLAG", sizeSol: 1 }], [], [2, 5, 10]);
    check("record with missing isPaper flag is excluded (fail closed)", unflagged.skippedNonPaperRecords === 1);
  }

  // ---------------------------------------------------------------
  console.log("\n-- analyze: non-trade events are surfaced, not silently dropped --");
  {
    const r = analyze(
      [
        { ts: "2026-01-01T00:00:00.000Z", event: "rejected-buy", isPaper: true, mint: "X", reasons: ["nope"] },
        { ts: "2026-01-01T00:00:00.000Z", event: "failed-execution", isPaper: true, mint: "Y" },
        { ts: "2026-01-01T00:00:00.000Z", event: "abandoned", isPaper: true, mint: "Z" },
        { ts: "2026-01-01T00:00:00.000Z", event: "reconciliation-mismatch", isPaper: true, mint: "W" },
      ],
      [],
      [2, 5, 10],
    );
    check("rejected buys counted", r.rejectedBuys === 1);
    check("failed executions counted", r.failedExecutions === 1);
    check("abandoned positions counted", r.abandoned === 1);
    check("reconciliation mismatches counted", r.reconciliationMismatches === 1);
    check("none of them became a fake trade", r.closedPositions === 0);
  }

  // ---------------------------------------------------------------
  console.log("\n-- analyze: decision log PASS/SKIP tally and top skip reasons --");
  {
    const decisions: DecisionRecord[] = [
      { decision: "PASS", mint: "A", reasons: [] },
      { decision: "SKIP", mint: "B", reasons: ["liquidity 2 SOL < 5 SOL", "only 4 unique wallets"] },
      { decision: "SKIP", mint: "C", reasons: ["liquidity 1 SOL < 5 SOL", "only 4 unique wallets"] },
      { decision: "SKIP", mint: "D", reasons: ["only 4 unique wallets"] },
    ];
    const r = analyze([], decisions, [2, 5, 10]);
    check("4 decisions total", r.decisionsTotal === 4);
    check("1 PASS", r.decisionsPassed === 1);
    check("3 SKIPs", r.decisionsSkipped === 3);
    // "only 4 unique wallets" appears 3x, each liquidity string 1x -> wallets ranks first
    check("top skip reason is the most frequent one", r.topSkipReasons[0].reason === "only 4 unique wallets");
    check("top skip reason counted 3 times", r.topSkipReasons[0].count === 3);
  }

  // ---------------------------------------------------------------
  console.log("\n-- computeFundingCapture: theoretical --");
  {
    const openSec = 1_700_000_000;
    const closeSec = openSec + 10 * 3600; // 10 hours
    const samples = [
      { observedAt: 0, settlementTs: openSec - 60, shortRateHourlyPercent: 99 }, // before window - excluded
      { observedAt: 0, settlementTs: openSec + 3600, shortRateHourlyPercent: 0.01 },
      { observedAt: 0, settlementTs: openSec + 7200, shortRateHourlyPercent: 0.03 },
      { observedAt: 0, settlementTs: closeSec + 60, shortRateHourlyPercent: 99 }, // after window - excluded
    ];
    // in-window settlements: 2 ; avg rate = (0.01 + 0.03)/2 = 0.02 %/hr
    // theoretical = 1000 USD * 0.0002 * 10h = 2.00 USD
    const f = computeFundingCapture(samples, openSec, closeSec, 1000);
    check("only in-window settlements counted (2 of 4)", f.settlementsInWindow === 2);
    check("average hourly rate = 0.02%", near(f.averageHourlyRatePercent, 0.02));
    check("holding hours = 10", near(f.holdingHours, 10));
    check("theoretical funding = $2.00", near(f.theoreticalUsd, 2, 1e-9));

    // Boundary: a settlement exactly at open or close still counts.
    const edge = computeFundingCapture(
      [{ observedAt: 0, settlementTs: openSec, shortRateHourlyPercent: 0.05 }],
      openSec,
      closeSec,
      1000,
    );
    check("settlement exactly at window open is inclusive", edge.settlementsInWindow === 1);

    // No settlements -> theoretical is null (unknown), not 0 (a claim).
    const none = computeFundingCapture([], openSec, closeSec, 1000);
    check("no settlements -> theoretical null, not a misleading 0", none.theoreticalUsd === null);
    check("no settlements -> average rate null", none.averageHourlyRatePercent === null);
  }

  // ---------------------------------------------------------------
  console.log("\n-- computeFundingCapture: realized and capture rate --");
  {
    const openSec = 1_700_000_000;
    const closeSec = openSec + 10 * 3600;
    // avg 0.02%/hr over 10h on 1000 USD -> theoretical $2.00
    const samples = [
      { observedAt: 0, settlementTs: openSec + 3600, shortRateHourlyPercent: 0.01 },
      { observedAt: 0, settlementTs: openSec + 7200, shortRateHourlyPercent: 0.03 },
    ];

    // Realized $1.50 against theoretical $2.00 -> 75% capture (fees ate the rest).
    const f = computeFundingCapture(samples, openSec, closeSec, 1000, 1.5);
    check("realized figure carried through", near(f.realizedUsd, 1.5));
    check("capture rate = 75%", near(f.captureRatePercent, 75, 1e-9));
    check("no unavailable reason when both sides known", f.unavailableReason === null);

    // Realized can exceed theoretical (rates moved between settlements).
    const over = computeFundingCapture(samples, openSec, closeSec, 1000, 2.5);
    check("realized above theoretical -> capture rate 125%, not clamped", near(over.captureRatePercent, 125, 1e-9));

    // A negative realized (fees exceeded funding) is a real, reportable outcome.
    const neg = computeFundingCapture(samples, openSec, closeSec, 1000, -0.5);
    check("negative realized -> negative capture rate, not hidden", near(neg.captureRatePercent, -25, 1e-9));

    // Missing realized -> null rate WITH an explanation, never a fabricated 100%.
    const noReal = computeFundingCapture(samples, openSec, closeSec, 1000, null);
    check("missing realized -> capture rate null", noReal.captureRatePercent === null);
    check("missing realized -> explanation attached", (noReal.unavailableReason ?? "").includes("feesAndFundingUsd"));

    // Realized known but no settlements -> theoretical unknown, so no rate.
    const noTheo = computeFundingCapture([], openSec, closeSec, 1000, 1.5);
    check("realized without theoretical -> capture rate null", noTheo.captureRatePercent === null);
    check("realized without theoretical -> explanation names the missing side", (noTheo.unavailableReason ?? "").includes("no funding settlements"));

    // Division-by-zero guard: a 0% rate means theoretical 0.
    const zeroRate = computeFundingCapture(
      [{ observedAt: 0, settlementTs: openSec + 3600, shortRateHourlyPercent: 0 }],
      openSec,
      closeSec,
      1000,
      0.5,
    );
    check("theoretical exactly 0 -> capture rate null, not Infinity", zeroRate.captureRatePercent === null);
    check("theoretical 0 -> explanation says the rate is undefined", (zeroRate.unavailableReason ?? "").includes("undefined"));
  }

  // ---------------------------------------------------------------
  console.log("\n-- summarizeFundingCapture: pairing opens with closes across a log --");
  {
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
    const iso = (ms: number) => new Date(ms).toISOString();
    const openSec = Math.floor(t0 / 1000);

    const samplesByMarket = {
      "SOL-PERP": [
        { observedAt: 0, settlementTs: openSec + 3600, shortRateHourlyPercent: 0.01 },
        { observedAt: 0, settlementTs: openSec + 7200, shortRateHourlyPercent: 0.03 },
      ],
    };
    const records = [
      { ts: iso(t0), event: "open", market: "SOL-PERP", notionalUsd: 1000 },
      { ts: iso(t0 + 10 * 3600_000), event: "close", market: "SOL-PERP", notionalUsd: 1000, feesAndFundingUsd: 1.5 },
    ];
    const sum = summarizeFundingCapture(records, samplesByMarket);
    check("one close summarized", sum.closes === 1);
    check("close carried a realized figure", sum.closesWithRealized === 1);
    check("total realized = $1.50", near(sum.totalRealizedUsd, 1.5));
    check("total theoretical = $2.00", near(sum.totalTheoreticalUsd, 2, 1e-9));
    check("overall capture rate = 75%", near(sum.overallCaptureRatePercent, 75, 1e-9));

    // A close with no matching open has an unknowable window - skipped, not guessed.
    const orphan = summarizeFundingCapture(
      [{ ts: iso(t0 + 3600_000), event: "close", market: "SOL-PERP", notionalUsd: 1000, feesAndFundingUsd: 1 }],
      samplesByMarket,
    );
    check("close with no matching open is skipped, not guessed", orphan.closes === 0);

    // A close predating the field contributes nothing to the aggregate rate.
    const legacy = summarizeFundingCapture(
      [
        { ts: iso(t0), event: "open", market: "SOL-PERP", notionalUsd: 1000 },
        { ts: iso(t0 + 10 * 3600_000), event: "close", market: "SOL-PERP", notionalUsd: 1000 },
      ],
      samplesByMarket,
    );
    check("legacy close (no field) still summarized", legacy.closes === 1);
    check("legacy close counted as missing realized", legacy.closesWithRealized === 0);
    check("legacy close cannot drag the aggregate rate", legacy.overallCaptureRatePercent === null);

    check("empty log -> no closes", summarizeFundingCapture([], {}).closes === 0);
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
