/**
 * The lookahead trap, and the proof it is not sprung.
 *
 * A creator's reputation at the moment of a given trade must use ONLY launches
 * that happened strictly before it. Score a wallet with its whole history -
 * including launches that had not happened yet - and you get a beautiful result
 * that cannot be traded, because on the day you would have needed it the
 * information did not exist.
 *
 * This is the easiest self-deception in the whole project and the hardest to
 * spot afterwards, because the leaked version looks BETTER. So the tests here
 * are built to FAIL if any future data leaks in:
 *
 *   1. A creator whose only other launch is LATER must read as having no prior
 *      history at all - not as a creator with a known drain rate.
 *   2. Changing a launch's fate must not change the reputation of any launch
 *      that opened BEFORE it. This is the general property, and it is checked by
 *      mutating the future and requiring every earlier answer to be identical.
 *   3. The point-in-time count of "launches with prior history" must be
 *      strictly less than the count of "launches by repeat creators" whenever
 *      any creator repeats - because a creator's FIRST launch never has prior.
 *
 * Offline, deterministic, no clock.
 */
import {
  LaunchRecord, priorStats, describeShape, oracleCeiling, liveCost,
  summariseGroup, MIN_PER_GROUP, wouldRefuse, DEFAULT_CREATOR_FILTER,
} from "../src/analysis/creatorReputation";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  PASS: ${n}`); } else { fail++; console.log(`  FAIL: ${n}${d ? " -- " + d : ""}`); } };
const section = (t: string) => console.log(`\n=== ${t} ===\n`);

const L = (mint: string, creator: string, at: string, fate: LaunchRecord["fate"]): LaunchRecord =>
  ({ mint, creator, at, fate, entrySol: 10, peakMultiple: fate === "ran" ? 3 : 0.2 });

section("1. a creator whose other launches are all LATER has NO prior history");
{
  const rows = [
    L("m1", "alice", "2026-09-01T00:00:00Z", "drained"),
    L("m2", "alice", "2026-09-02T00:00:00Z", "drained"),
    L("m3", "alice", "2026-09-03T00:00:00Z", "drained"),
  ];
  const first = priorStats(rows, "alice", "2026-09-01T00:00:00Z");
  check("the FIRST launch sees zero prior launches", first.priorLaunches === 0);
  check("...and its prior drain rate is NULL, not 0 and not 1", first.priorDrainRate === null);
  const second = priorStats(rows, "alice", "2026-09-02T00:00:00Z");
  check("the second sees exactly one prior", second.priorLaunches === 1);
  const third = priorStats(rows, "alice", "2026-09-03T00:00:00Z");
  check("the third sees exactly two", third.priorLaunches === 2);
  check("no launch ever sees itself", third.priorLaunches < rows.length);
  // The leak this catches: using the whole history would give the first launch
  // a 100% drain rate off three launches, which is exactly the "beautiful
  // result that cannot be traded".
  check("the first launch is NOT handed the whole history's 100% drain rate", first.priorDrainRate !== 1);
}

section("2. changing the FUTURE must not change any earlier answer");
{
  const base: LaunchRecord[] = [
    L("m1", "bob", "2026-09-01T00:00:00Z", "drained"),
    L("m2", "bob", "2026-09-02T00:00:00Z", "ran"),
    L("m3", "bob", "2026-09-03T00:00:00Z", "drained"),
    L("m4", "bob", "2026-09-04T00:00:00Z", "flat"),
  ];
  const at = ["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z", "2026-09-04T00:00:00Z"];
  const before = at.map((t) => JSON.stringify(priorStats(base, "bob", t)));

  // Rewrite EVERY future fate to its opposite, one cutoff at a time, and demand
  // that every answer at or before that cutoff is byte-identical.
  let leaked = 0;
  for (let i = 0; i < at.length; i++) {
    const mutated = base.map((r, j) => (j > i ? { ...r, fate: (r.fate === "drained" ? "ran" : "drained") as LaunchRecord["fate"] } : r));
    for (let k = 0; k <= i; k++) {
      const after = JSON.stringify(priorStats(mutated, "bob", at[k]));
      if (after !== before[k]) leaked++;
    }
  }
  check("rewriting every future fate changes no earlier reputation", leaked === 0, `${leaked} answer(s) moved`);

  // And the control: rewriting the PAST must change the later answers, or the
  // test above would pass on a function that ignores history entirely.
  const pastChanged = base.map((r, j) => (j === 0 ? { ...r, fate: "ran" as const } : r));
  check("CONTROL: rewriting the past DOES change later answers - the check above is not vacuous",
    JSON.stringify(priorStats(pastChanged, "bob", at[3])) !== before[3]);
}

section("3. the point-in-time count is smaller than the naive one");
{
  const rows = [
    L("m1", "alice", "2026-09-01T00:00:00Z", "drained"),
    L("m2", "alice", "2026-09-02T00:00:00Z", "drained"),
    L("m3", "bob", "2026-09-03T00:00:00Z", "ran"),
    L("m4", "carol", "2026-09-04T00:00:00Z", "flat"),
  ];
  const s = describeShape(rows);
  // Naive: "launches by repeat creators" = 2 (both alice's). Point-in-time: 1.
  check("only alice's SECOND launch had prior history", s.launchesWithPriorAtTheTime === 1);
  check("the other three had none", s.launchesWithNoPrior === 3);
  check("...which is strictly fewer than the naive 'by a repeat creator' count of 2", s.launchesWithPriorAtTheTime < 2);
  check("distinct creators counted", s.distinctCreators === 3);
  check("one-offs counted", s.oneOff === 2 && s.twice === 1 && s.threeOrMore === 0);
  check("the maximum is reported", s.maxLaunchesByOneCreator === 2);
  check("the visible share is the point-in-time one", s.filterVisibleShare === 0.25);
}

section("the shape gate refuses to go on when nothing repeats");
{
  const allOneOff = Array.from({ length: 100 }, (_, i) => L(`m${i}`, `c${i}`, `2026-09-01T00:${String(i).padStart(2, "0")}:00Z`, "drained"));
  const s = describeShape(allOneOff);
  check("100 one-off wallets give a visible share of zero", s.filterVisibleShare === 0);
  check("and the verdict says the signal cannot exist here", s.verdict.includes("cannot exist in this dataset"));
  check("...and says to stop", s.verdict.includes("Stop here"));
  const repeats = Array.from({ length: 100 }, (_, i) => L(`m${i}`, `c${i % 20}`, `2026-09-01T00:${String(i).padStart(2, "0")}:00Z`, "drained"));
  check("with real repetition it says it is worth testing", describeShape(repeats).verdict.includes("Worth testing"));
  check("and states the ceiling in the same breath", describeShape(repeats).verdict.includes("blind to the rest"));
  check("an empty set says so rather than dividing by zero", describeShape([]).filterVisibleShare === 0 && describeShape([]).verdict.includes("nothing to say"));
}

section("the oracle ceiling cheats on purpose, and says so");
{
  const rows = [
    { creator: "a", at: "2026-09-01T00:00:00Z", pnl: -1 },
    { creator: "a", at: "2026-09-02T00:00:00Z", pnl: -1 },
    { creator: "a", at: "2026-09-03T00:00:00Z", pnl: +5 },
    { creator: "b", at: "2026-09-04T00:00:00Z", pnl: -1 },
  ];
  const o = oracleCeiling(rows);
  // Visible to a filter: a's 2nd and 3rd (-1 and +5). Blind: a's 1st and b's (-1, -1).
  check("the oracle keeps everything the filter cannot see", o.oracleTrades === 3);
  check("and among what it CAN see, only the winner", o.oracleTotal === 3);
  check("the baseline is the real book", o.baselineTotal === 2 && o.baselineTrades === 4);
  check("the best possible gain is stated", o.bestPossibleGain === 1);
  check("a book the oracle turns positive says there is something to chase", o.couldEverBeProfitable && o.verdict.includes("something to chase"));

  const hopeless = [
    { creator: "a", at: "2026-09-01T00:00:00Z", pnl: -10 },
    { creator: "a", at: "2026-09-02T00:00:00Z", pnl: -1 },
    { creator: "b", at: "2026-09-03T00:00:00Z", pnl: -10 },
  ];
  const h = oracleCeiling(hopeless);
  check("a book the oracle CANNOT save says so plainly", !h.couldEverBeProfitable && h.verdict.includes("still losing"));
  check("...and attributes it to the data, not the rule", h.verdict.includes("fact about the data"));
  check("the oracle never keeps a loser it could see", h.oracleTotal === -20 && h.oracleTrades === 2);
}

section("the floor and the unknowns still hold");
{
  // Pinned to the NUMBER, not to the constant.
  //
  // The first version of this said `Array.from({ length: MIN_PER_GROUP - 1 })`,
  // which is a test written in terms of the thing it is testing: setting
  // MIN_PER_GROUP to 1 moved the fixture with it and the mutation SURVIVED. A
  // floor that a one-line edit can lower to 1 without a single test going red
  // is not a floor.
  // `Number(...)` on purpose. `MIN_PER_GROUP === 30` is narrowed by TypeScript
  // to a literal comparison, so lowering the constant is caught at COMPILE time
  // (TS2367, no overlap) and never reaches an assertion. That is a real catch -
  // arguably the strongest one - but it made the mutation look like it had
  // survived, because the suite exited before printing a single FAIL. Defeating
  // the narrowing means it fails as an assertion as well, which is the form a
  // mutation run can actually read.
  check(`the floor is 30, not ${MIN_PER_GROUP} - the conventional threshold, pinned as a number`, Number(MIN_PER_GROUP) === 30);
  const twentyNine = Array.from({ length: 29 }, () => ({ fate: "drained" as const }));
  const thirty = Array.from({ length: 30 }, () => ({ fate: "drained" as const }));
  check("29 records is INSUFFICIENT, not a rate", summariseGroup("x", twentyNine).ranRate === null);
  check("and it says how short", (summariseGroup("x", twentyNine).note ?? "").includes("INSUFFICIENT"));
  check("30 records produces a rate", summariseGroup("x", thirty).ranRate !== null);
  check("a single record certainly does not", summariseGroup("x", [{ fate: "ran" as const }]).ranRate === null);
  // Unknown history must never read as clean.
  const noHistory = wouldRefuse({ priorLaunches: 0, priorDrainRate: null }, { ...DEFAULT_CREATOR_FILTER, enabled: true });
  check("a creator with NO history is not refused - but not called clean either", noHistory.refuse === false);
  check("...and the reason says the history is UNKNOWN, not that the creator is good", /not enough history to judge/i.test(noHistory.reason) && !/clean|good|safe/i.test(noHistory.reason), noHistory.reason);
}

section("the live cost is stated before anything goes live");
{
  const c = liveCost(1200, 170000);
  check("one call per launch, and it says which", c.callsPerLaunch === 1 && c.note.includes("getTransaction"));
  check("credits per day are computed", c.creditsPerDay === 1200);
  check("and expressed as a share of what the bot already spends", c.shareOfCurrentBurn !== null && c.shareOfCurrentBurn < 0.01);
  check("an unknown current burn gives null, not a made-up share", liveCost(1200, null).shareOfCurrentBurn === null);
}

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
