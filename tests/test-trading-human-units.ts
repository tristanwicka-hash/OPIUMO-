/**
 * Spot sniper test: raw-unit <-> human-readable conversions used for
 * display in logs. Fully offline, pure functions.
 *
 * Covers a real gap found in review: trade logs used to record price/size
 * per RAW token unit only (internally correct, but not human-readable -
 * e.g. showing 1.2e-15 instead of 0.0000012 for a 6-decimal token).
 *
 * Run with: npm run test:trading-human-units
 */
import { toHumanTokenAmount, toHumanPricePerToken, formatHuman } from "../src/trading/humanUnits";

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
  console.log("=== Spot sniper test: human-unit conversions (all offline) ===");

  console.log("\n-- toHumanTokenAmount --");
  {
    // 6-decimal token: 1_500_000 raw units = 1.5 whole tokens.
    check("converts raw -> whole tokens correctly", toHumanTokenAmount(1_500_000, 6) === 1.5);
    check("0 decimals -> raw IS the human amount", toHumanTokenAmount(42, 0) === 42);
    check("unknown decimals -> null, not a wrong guess", toHumanTokenAmount(1_500_000, null) === null);
  }

  console.log("\n-- toHumanPricePerToken --");
  {
    // 6-decimal token priced at 1e-9 SOL per raw unit -> 1e-9 * 1e6 = 1e-3 SOL per whole token.
    const human = toHumanPricePerToken(1e-9, 6);
    check("converts raw-unit price -> whole-token price correctly", human !== null && Math.abs(human - 1e-3) < 1e-15);
    check("unknown decimals -> null", toHumanPricePerToken(1e-9, null) === null);
  }

  console.log("\n-- round-trip consistency --");
  {
    // price-per-raw-unit * raw-amount should equal (price-per-human * human-amount), always -
    // both just express the same total SOL value in different units.
    const rawPrice = 3.7e-8;
    const rawAmount = 42_500_000;
    const decimals = 6;
    const totalFromRaw = rawPrice * rawAmount;
    const humanPrice = toHumanPricePerToken(rawPrice, decimals)!;
    const humanAmount = toHumanTokenAmount(rawAmount, decimals)!;
    const totalFromHuman = humanPrice * humanAmount;
    check("raw-unit and human-unit totals agree (same value, different units)", Math.abs(totalFromRaw - totalFromHuman) / totalFromRaw < 1e-9);
  }

  console.log("\n-- formatHuman --");
  {
    check("formats a known value with the given suffix", formatHuman(1.23456789, " SOL") === "1.234568 SOL");
    check("unknown (null) value -> '?' placeholder, not a wrong number", formatHuman(null, " SOL") === "? SOL");
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
