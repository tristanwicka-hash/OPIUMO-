/**
 * The depth calibration decides what the free-tier scanner is allowed to miss.
 * Its one dangerous failure is treating "this deployer funded nobody" as "a cap
 * of 10 caught everything" - that would average a launch with no evidence into
 * the coverage figure as a perfect score and make any cap look safe.
 *
 * Pure functions, no network, no clock.
 */
import { recallByCap, meanKnown, segment, FundingEvent, CAPS } from "../scripts/depth-calibration";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; } else { fail++; console.log(`  FAIL: ${n}${d ? " -- " + d : ""}`); } };

const ev = (depth: number): FundingEvent => ({ destination: "W" + depth, depth, lamports: 1 });

console.log("\n=== depth calibration: recall by cap ===\n");

// All the funding is recent: every cap catches everything.
{
  const r = recallByCap([ev(0), ev(3), ev(9)]);
  check("all events inside 10 -> recall 1 at every cap", CAPS.every((k) => r[k] === 1), JSON.stringify(r));
}

// Half recent, half deep. depth is zero-indexed, so `depth < k` is the rule.
{
  const r = recallByCap([ev(0), ev(5), ev(300), ev(700)]);
  check("cap 10 catches the 2 shallow of 4", r[10] === 0.5, String(r[10]));
  check("cap 50 still only catches those 2", r[50] === 0.5, String(r[50]));
  check("cap 500 catches 3 of 4", r[500] === 0.75, String(r[500]));
  check("cap 1000 catches all 4", r[1000] === 1, String(r[1000]));
}

// The boundary: an event at exactly depth 50 is the 51st signature and is OUTSIDE
// a cap of 50. Off by one here would overstate what the free tier sees.
{
  const r = recallByCap([ev(49)]);
  check("depth 49 is inside cap 50", r[50] === 1);
  const r2 = recallByCap([ev(50)]);
  check("depth 50 is OUTSIDE cap 50 - it is the 51st signature", r2[50] === 0, String(r2[50]));
}

// THE LOAD-BEARING ONE. No events is no evidence, not perfect coverage.
{
  const r = recallByCap([]);
  check("a deployer who funded nobody gives null at every cap, never 1", CAPS.every((k) => r[k] === null), JSON.stringify(r));
  check("...and null is not 0 either - 0 would say the cap missed something", CAPS.every((k) => r[k] !== 0));
}

console.log("=== averaging skips the unknowns rather than counting them ===\n");
{
  const m = meanKnown([1, 0.5, null, null]);
  check("mean of the two known values, not of four", m.mean === 0.75, String(m.mean));
  check("n reports how many it actually had", m.n === 2, String(m.n));
}
{
  const m = meanKnown([null, null]);
  check("all unknown -> mean null, never 0", m.mean === null && m.n === 0, JSON.stringify(m));
}
{
  // If nulls were silently read as 0, this would come out 0.5 instead of 1.
  const m = meanKnown([1, null]);
  check("a null does not drag a perfect score down to a half", m.mean === 1, String(m.mean));
}

console.log("=== segmenting: the mean across all deployers is the wrong number ===\n");
{
  // Mirrors the real measurement: a few throwaway wallets fully covered by a cap
  // of 50, and many high-volume wallets that no affordable cap reaches. Averaged
  // together they read as "the cap fails". Split, they read as "the cap is fine
  // for the wallets we are looking for". Both are computed from the same rows.
  const rows = [
    { depthRead: 3, events: 2, recall: { 10: 1, 50: 1, 200: 1, 1000: 1 } },
    { depthRead: 12, events: 6, recall: { 10: 0.5, 50: 1, 200: 1, 1000: 1 } },
    { depthRead: 900, events: 1000, recall: { 10: 0.01, 50: 0.05, 200: 0.3, 1000: 1 } },
    { depthRead: 1000, events: 1200, recall: { 10: 0.02, 50: 0.1, 200: 0.4, 1000: 1 } },
  ];
  const s = segment(rows, 50, [10, 50, 200, 1000]);
  check("throwaway wallets are separated out", s.shallow.launches === 2 && s.deep.launches === 2);
  check("a cap of 50 covers the throwaway wallets completely", s.shallow.meanRecallAt[50] === 1, String(s.shallow.meanRecallAt[50]));
  check("...and barely touches the high-volume ones", Math.abs((s.deep.meanRecallAt[50] ?? 0) - 0.075) < 1e-9, String(s.deep.meanRecallAt[50]));
  check("median events is reported per segment, not pooled", s.shallow.medianEvents === 6 && s.deep.medianEvents === 1200, JSON.stringify([s.shallow.medianEvents, s.deep.medianEvents]));

  // The whole point: the pooled mean is much worse than the segment that matters.
  const pooled = meanKnown(rows.map((r) => r.recall[50])).mean!;
  check("the pooled mean understates the throwaway segment", pooled < (s.shallow.meanRecallAt[50] ?? 0), `pooled ${pooled}`);

  const empty = segment([], 50, [10, 50]);
  check("no rows -> recall unknown, never 0 or 1", empty.shallow.meanRecallAt[50] === null && empty.shallow.medianEvents === null);
}

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
