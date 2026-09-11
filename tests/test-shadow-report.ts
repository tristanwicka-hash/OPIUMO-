/**
 * OPIUMO test: the shadow-filter report (offline).
 *
 * The report answers one question - is the pass rate limited by THRESHOLDS or
 * by DATA - and the two call for opposite responses. Getting it backwards means
 * loosening a threshold that was never the constraint, which changes nothing
 * and looks like the filters are still too strict.
 *
 * The separation it makes: among tokens where nothing was left unchecked, what
 * passes? Those tokens have no data problem, so whatever fails there is
 * genuinely a threshold. Everything below tests that separation holds.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { loadShadowRecords, summarise, ruleOf, ShadowRecord } from "../src/analysis/shadowReport";
import { assertNoProductionWrites } from "./no-production-writes";

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

function rec(mint: string, shadows: [string, "PASS" | "SKIP", string[], string[]][]): ShadowRecord {
  return {
    // The loader requires this: the log is shared with other event types, and a
    // reader that accepted anything with a `shadows` array would count rows the
    // bot never wrote as shadow evaluations.
    event: "shadow-eval",
    ts: "2026-09-11T00:00:00Z",
    mint,
    liveDecision: "SKIP",
    shadows: shadows.map(([setId, decision, reasons, uncheckedFields]) => ({
      setId, decision, reasons, uncheckedFields,
    })),
  };
}

console.log("=== OPIUMO test: shadow-filter report (offline) ===");

console.log("\n-- complete-data tokens are separated from unchecked ones --");
{
  const records: ShadowRecord[] = [
    // Two tokens with complete data: one passes the loose set, one does not.
    rec("complete-pass", [
      ["tight", "SKIP", ["too few transactions (4 < min 30)"], []],
      ["loose", "PASS", [], []],
    ]),
    rec("complete-fail", [
      ["tight", "SKIP", ["liquidity too low (1.00 SOL < min 5 SOL)"], []],
      ["loose", "SKIP", ["liquidity too low (1.00 SOL < min 2 SOL)"], []],
    ]),
    // Three tokens where the metric was never fetched. No threshold can help.
    rec("unchecked-1", [
      ["tight", "SKIP", ["top holder % unknown (could not fetch largest accounts)"], ["topHolderPercent"]],
      ["loose", "SKIP", ["top holder % unknown (could not fetch largest accounts)"], ["topHolderPercent"]],
    ]),
    rec("unchecked-2", [
      ["tight", "SKIP", ["activity metrics not collected (skipped early)"], ["uniqueWallets"]],
      ["loose", "SKIP", ["activity metrics not collected (skipped early)"], ["uniqueWallets"]],
    ]),
    rec("unchecked-3", [
      ["tight", "SKIP", ["top holder % unknown (x)"], ["topHolderPercent", "devWalletPercent"]],
      ["loose", "SKIP", ["top holder % unknown (x)"], ["topHolderPercent", "devWalletPercent"]],
    ]),
  ];
  const s = summarise(records);

  check("every record is counted", s.records === 5);
  check("complete-data tokens are identified", s.completeDataTokens === 2, String(s.completeDataTokens));

  const loose = s.sets.find((x) => x.setId === "loose")!;
  const tight = s.sets.find((x) => x.setId === "tight")!;

  // The headline rate is dragged down by tokens no threshold could rescue.
  check("the loose set's OVERALL pass rate is 1 of 5", loose.passed === 1 && loose.evaluated === 5);
  // ...but among tokens that HAVE data it is 1 of 2, a different question.
  check("its complete-data pass count is 1 of 2", loose.passedWithCompleteData === 1, String(loose.passedWithCompleteData));
  check("the tight set passes nothing either way", tight.passed === 0 && tight.passedWithCompleteData === 0);

  // This is the whole point: 20% and 50% are different answers, and only one
  // of them is about thresholds.
  check(
    "the two rates genuinely differ, so the separation is doing work",
    loose.passed / loose.evaluated !== loose.passedWithCompleteData / s.completeDataTokens
  );
}

console.log("\n-- a token with ANY unchecked field is not complete-data --");
{
  const s = summarise([
    rec("one-missing", [["loose", "SKIP", ["x unknown"], ["devWalletPercent"]]]),
  ]);
  check("a single unchecked field disqualifies it", s.completeDataTokens === 0);
}

console.log("\n-- sets disagreeing on unchecked fields is reported, not ignored --");
{
  // Shadow sets evaluate the SAME already-fetched metrics, so they must always
  // agree on what was unchecked. If they ever disagree, a set is fetching
  // something of its own and the zero-RPC-cost guarantee is broken.
  const agree = summarise([
    rec("a", [["s1", "SKIP", [], ["topHolderPercent"]], ["s2", "SKIP", [], ["topHolderPercent"]]]),
  ]);
  check("identical unchecked fields read as agreement", agree.setsAgreeOnUnchecked);

  const disagree = summarise([
    rec("a", [["s1", "SKIP", [], ["topHolderPercent"]], ["s2", "SKIP", [], []]]),
  ]);
  check("a disagreement is detected", !disagree.setsAgreeOnUnchecked);
  check("  ...and is not silently absorbed into the completeness count",
    disagree.setsAgreeOnUnchecked === false);
}

console.log("\n-- blockers group by rule, not by measured value --");
{
  const s = summarise([
    rec("a", [["s", "SKIP", ["too few transactions (4 < min 30)"], []]]),
    rec("b", [["s", "SKIP", ["too few transactions (17 < min 30)"], []]]),
  ]);
  const set = s.sets[0];
  check("two measurements of one rule are one row", set.blockers["too few transactions"] === 2, JSON.stringify(set.blockers));
  check("the measured values are gone", !Object.keys(set.blockers).some((k) => k.includes("min 30")));
  check("ruleOf strips only a trailing parenthetical", ruleOf("liquidity unknown (could not fetch)") === "liquidity unknown");
  check("  ...and leaves a reason without one alone", ruleOf("activity metrics not collected") === "activity metrics not collected");
}

console.log("\n-- reading the log: junk is counted, non-shadow rows are skipped --");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opiumo-shadow-"));
  const file = path.join(dir, "shadow-filters.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify(rec("a", [["s", "PASS", [], []]])),
      JSON.stringify({ event: "something-else", mint: "b" }),
      // A row that LOOKS like a shadow evaluation - it has a shadows array -
      // but is a different event. Without the event check this is counted as
      // an evaluation, and the denominator of every rate above is wrong. The
      // first version of this test only had the row above, which has no
      // shadows array, so the fallback check caught it and the event check
      // could be deleted with the suite still green.
      JSON.stringify({
        event: "shadow-config-changed",
        mint: "d",
        liveDecision: "SKIP",
        shadows: [{ setId: "s", decision: "PASS", reasons: [], uncheckedFields: [] }],
      }),
      "{not json",
      "",
      JSON.stringify(rec("c", [["s", "SKIP", ["x"], []]])),
    ].join("\n") + "\n"
  );
  const { records, unparseable } = loadShadowRecords(file);
  check("only shadow-eval rows are loaded", records.length === 2, String(records.length));
  check("  ...including rejecting a non-shadow row that HAS a shadows array",
    !records.some((r) => r.mint === "d"));
  check("unparseable lines are counted, not ignored", unparseable === 1);

  const missing = loadShadowRecords(path.join(dir, "nope.jsonl"));
  check("a missing file is empty, and does not throw", missing.records.length === 0);
}

console.log("\n-- an empty log answers nothing rather than answering zero --");
{
  const s = summarise([]);
  check("no records", s.records === 0);
  check("no complete-data tokens", s.completeDataTokens === 0);
  check("no sets are invented", s.sets.length === 0);
  check("completeness has no judge", s.completenessJudgedBy === null);
}

assertNoProductionWrites(check, ["opiumo-shadow-", "complete-pass", "unchecked-1"]);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
