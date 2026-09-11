/**
 * Tests for the schedule-savings analysis. Offline, synthetic meter records.
 *
 * The load-bearing case is the LAST one: if an OFF hour costs as much as an ON
 * hour, the tool must say the schedule cut evaluation rather than credits. A
 * tool that can only confirm the projection is not a measurement.
 */
import { MeterRecord, bucketByHour, analyseSavings, formatSavings } from "../src/analysis/scheduleSavings";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " -- " + detail : ""}`); console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
function section(t: string): void { console.log(`\n=== ${t} ===\n`); }

const HOUR_MS = 3_600_000;
/** n whole hours of records at `rate` calls/h, ending at hour `h`. */
function win(h: number, rate: number, hours = 1): MeterRecord[] {
  const out: MeterRecord[] = [];
  for (let i = 0; i < hours * 6; i++) {
    const at = new Date(Date.UTC(2026, 8, 11, h, 0, 0) + (i + 1) * 600_000).toISOString();
    out.push({ at, windowCalls: Math.round(rate / 6), windowMs: 600_000 });
  }
  return out;
}
const OFF = [7, 8, 9, 10, 11];

section("bucketing, and unmetered hours are null rather than zero");

const b = bucketByHour(win(13, 12000));
check("the metered hour has a rate", b[13].callsPerHour !== null);
check("it is about right", Math.abs((b[13].callsPerHour as number) - 12000) < 60, `got ${b[13].callsPerHour}`);
check("an unmetered hour is NULL, not 0", b[3].callsPerHour === null);
check("and reports zero metered time", b[3].meteredHours === 0);
check("a record with no window is ignored", bucketByHour([{ at: "2026-09-11T05:00:00Z" }])[5].callsPerHour === null);
check("a malformed timestamp is ignored", bucketByHour([{ at: "nope", windowCalls: 5, windowMs: 600_000 }]).every((x) => x.callsPerHour === null));

section("NOT READY until an OFF hour has actually been metered");

const onlyOn = analyseSavings([...win(13, 12000), ...win(19, 13000)], OFF);
check("not ready", onlyOn.ready === false);
check("offRate is null, not 0", onlyOn.offRate === null);
check("the reason names the unmetered OFF hours", (onlyOn.notReadyReason ?? "").includes("07:00"));
check("and refuses to conclude", formatSavings(onlyOn).includes("NOT READY"));
check(
  "it does NOT print a savings figure it cannot support",
  !formatSavings(onlyOn).includes("AN OFF HOUR COSTS")
);

section("a genuinely cheap OFF hour is reported as a real saving");

const cheap = analyseSavings([...win(6, 12000), ...win(8, 900), ...win(12, 12500)], OFF);
check("ready once an OFF hour is metered", cheap.ready === true);
check("offRate is measured", Math.abs((cheap.offRate as number) - 900) < 60, `got ${cheap.offRate}`);
check("the adjacent ON hours are 06 and 12", cheap.adjacentHours.join(",") === "6,12");
check("OFF is a small fraction of ON", (cheap.offAsFractionOfOn as number) < 0.15);
const cheapText = formatSavings(cheap);
check("it says the schedule genuinely cuts credits", cheapText.includes("genuinely cutting credits"));
check("and states the real saving", cheapText.includes("Real saving:"));
check("uncovered OFF hours are still listed", cheap.offHoursUncovered.length === 4);

section("THE LOAD-BEARING CASE: an OFF hour that costs as much as an ON hour");

const notCheap = analyseSavings([...win(6, 12000), ...win(8, 11500), ...win(12, 12000)], OFF);
check("it is ready", notCheap.ready === true);
check("OFF is nearly ALL of ON", (notCheap.offAsFractionOfOn as number) > 0.9, `got ${notCheap.offAsFractionOfOn}`);
const notCheapText = formatSavings(notCheap);
check(
  "it says the schedule is cutting EVALUATION, not credits",
  notCheapText.includes("mostly cutting EVALUATION")
);
check(
  "and says APPROVALS 13 needs correcting",
  notCheapText.includes("APPROVALS 13 needs correcting")
);
check(
  "it does NOT claim the projected saving",
  !notCheapText.includes("genuinely cutting credits")
);

section("the middle case is called out too, not rounded to one of the extremes");

section("the fraction is measured against the ADJACENT hour, not the all-on mean");

// The OFF block deliberately covers the QUIETEST hours of the day, so an all-on
// average that includes the evening peak makes an OFF hour look cheaper than it
// is. On the first real window that was 30% versus 38% - and the saving figure
// below already used the adjacent hour, so the headline and the saving were
// quoting two different baselines, with the headline being the generous one.
{
  // Adjacent ON hours are quiet (6,000); a distant ON hour is busy (20,000).
  // An OFF hour at 3,000 is 50% of adjacent but only ~23% of the all-on mean.
  const skewed = analyseSavings(
    [...win(6, 6000), ...win(12, 6000), ...win(20, 20000), ...win(8, 3000)],
    OFF
  );
  check("it is ready", skewed.ready === true);
  check("the baseline used is named", skewed.fractionBaseline === "adjacent", String(skewed.fractionBaseline));
  check(
    "the fraction is ~50% (vs adjacent), NOT ~23% (vs the all-on mean)",
    Math.abs((skewed.offAsFractionOfOn as number) - 0.5) < 0.05,
    `got ${skewed.offAsFractionOfOn}`
  );
  const text = formatSavings(skewed);
  check("the printed line says which baseline it used", text.includes("measured against the ADJACENT rate"));
  // The saving and the percentage must now agree on their baseline.
  check("the saving is computed from the same adjacent rate", text.includes("3,000/h x 5 OFF hours"));
}

const partial = analyseSavings([...win(6, 12000), ...win(8, 3600), ...win(12, 12000)], OFF);
check("OFF is ~30% of ON", Math.abs((partial.offAsFractionOfOn as number) - 0.3) < 0.05);
check(
  "it says the OFF hour is not free and the projection was optimistic",
  formatSavings(partial).includes("NOT free")
);

section("coverage threshold: a barely-metered OFF hour is not trusted");

const thin = analyseSavings([...win(6, 12000), ...win(8, 900, 1 / 12), ...win(12, 12000)], OFF, 0.5);
check("6 minutes of coverage is below the 0.5h floor", thin.ready === false);
check("that OFF hour counts as uncovered", thin.offHoursUncovered.includes(8));

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (failures.length) { console.log("\nFailures:"); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail > 0 ? 1 : 0);
