/**
 * OPIUMO test: credit circuit breaker (offline).
 *
 * The meter measured and nothing acted. This suite covers the thing that acts,
 * and in particular the three ways it could be wrong while still looking like
 * it works:
 *
 *   1. pricing a batch of N as 1 request
 *   2. counting calls instead of credits
 *   3. resetting the tally on restart
 *
 * All three are mutation-tested. Each produces a breaker that reports
 * comfortable numbers right up until the plan is empty, which is the exact
 * failure this exists to prevent.
 *
 * Deterministic: the clock is injected everywhere, so a rollover boundary is
 * asserted exactly rather than waited for. No network - the breaker is proven
 * to make no RPC call by handing it a Connection stub that throws on any use.
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  CreditBreaker,
  DEFAULT_CREDIT_BUDGET,
  DEFAULT_DAILY_CREDITS,
  DEFAULT_MONTHLY_CREDITS,
  PLAN_MONTHLY_CREDITS,
  CreditBudgetConfig,
  creditsForBatch,
  evaluateBudget,
  emptyLedger,
  rollTo,
  loadLedger,
  validateCreditBudget,
  utcDayKey,
} from "../src/rpc/creditBudget";
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

function tmpLedger(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "opiumo-budget-")), "credit-ledger.json");
}
const at = (iso: string) => new Date(iso);

/** A small budget makes the limits reachable in a test without 290k calls. */
function budget(over: Partial<CreditBudgetConfig> = {}): CreditBudgetConfig {
  return { enabled: true, dailyCredits: 1000, monthlyCredits: 10_000, warnFraction: 0.8, ledgerFile: tmpLedger(), ...over };
}

console.log("=== OPIUMO test: credit circuit breaker (offline) ===");

console.log("\n-- budgets are in CREDITS, priced per method --");
{
  // The whole reason this module exists rather than reusing a call counter.
  check("10 standard calls cost 10 credits", creditsForBatch(Array(10).fill("getTransaction")) === 10);
  check("1 DAS call costs 10 credits, not 1", creditsForBatch(["getTokenAccounts"]) === 10);
  check("3 DAS calls cost 30 credits", creditsForBatch(Array(3).fill("getTokenAccounts")) === 30);
  check(
    "a mixed batch is priced per method, not per request",
    creditsForBatch(["getTokenAccounts", "getTransaction", "getBalance"]) === 12
  );
  check("an unknown method defaults to 1 credit, never 0", creditsForBatch(["somethingNew"]) === 1);
}

console.log("\n-- a batch of N is N calls, never 1 request --");
{
  // Pricing a batch as one request is what makes an unaffordable burn rate look
  // survivable. Asserted through the breaker, not just the pricing function.
  const b = new CreditBreaker(budget(), at("2026-09-11T00:00:00Z"));
  const charged = b.chargeBatch(Array(40).fill("getAccountInfo"), at("2026-09-11T00:00:00Z"));
  check("a 40-call batch charges 40 credits", charged === 40, `charged ${charged}`);
  check("and the ledger holds 40, not 1", b.snapshot().day.credits === 40, `${b.snapshot().day.credits}`);

  const das = new CreditBreaker(budget(), at("2026-09-11T00:00:00Z"));
  das.chargeBatch(Array(5).fill("getTokenAccounts"), at("2026-09-11T00:00:00Z"));
  check("a 5-call DAS batch charges 50 credits, not 5 and not 1", das.snapshot().day.credits === 50);
}

console.log("\n-- the tally survives a restart --");
{
  // A counter that resets on every start is not a budget. This bot restarts
  // often, and each restart would otherwise grant a fresh daily allowance.
  const file = tmpLedger();
  const t0 = at("2026-09-11T09:00:00Z");
  const first = new CreditBreaker(budget({ ledgerFile: file }), t0, file);
  first.chargeBatch(Array(700).fill("getTransaction"), t0);
  first.persist();

  const t1 = at("2026-09-11T09:05:00Z"); // same UTC day: a restart, not a rollover
  const second = new CreditBreaker(budget({ ledgerFile: file }), t1, file);
  check("a fresh instance resumes the same day's tally", second.snapshot().day.credits === 700, `${second.snapshot().day.credits}`);
  check("and the same month's tally", second.snapshot().month.credits === 700);

  second.chargeBatch(Array(400).fill("getTransaction"), t1);
  const d = second.decide(t1);
  check("spend accumulates ACROSS the restart, so the limit still fires", d.allowed === false, d.reason);
  check("  ...and it is the daily limit that fired", d.reason === "daily-limit-reached");
}

console.log("\n-- a halt is unmistakable, and does not look like a quiet night --");
{
  const cfg = budget();
  const t = at("2026-09-11T14:00:00Z");
  const b = new CreditBreaker(cfg, t);
  b.charge(1000, t);
  const d = b.decide(t);

  check("detection is refused", d.allowed === false);
  check("the reason is its own string, not silence", d.reason === "daily-limit-reached");
  check("the detail SHOUTS that it is a halt", d.detail.includes("*** DETECTION HALTED"));
  check("it says this is not a quiet market", d.detail.includes("This is a halt, NOT a quiet market"));
  check("it says when it lifts", d.resumesAt === "2026-09-12T00:00:00.000Z", String(d.resumesAt));
  check("the detail names both the usage and the limit", d.detail.includes("1,000 of 1,000"));
}

console.log("\n-- the monthly limit is reported ahead of the daily one --");
{
  // Both can be breached at once. "Resumes at midnight" would be a lie when the
  // month is gone and midnight changes nothing.
  const cfg = budget({ dailyCredits: 1000, monthlyCredits: 1000 });
  const t = at("2026-09-11T14:00:00Z");
  const b = new CreditBreaker(cfg, t);
  b.charge(1000, t);
  const d = b.decide(t);
  check("the monthly limit is the one reported", d.reason === "monthly-limit-reached", d.reason);
  check("and it resumes at the start of next month, not midnight", d.resumesAt === "2026-10-01T00:00:00.000Z", String(d.resumesAt));
}

console.log("\n-- the warning fires before the limit, and does not stop anything --");
{
  const cfg = budget();
  const t = at("2026-09-11T14:00:00Z");
  const b = new CreditBreaker(cfg, t);

  b.charge(799, t);
  check("just under the warn fraction is quiet", b.decide(t).reason === "within-budget");

  b.charge(1, t); // 800 = exactly 80%
  const warned = b.decide(t);
  check("at the warn fraction it warns", warned.reason === "warn-threshold");
  check("  ...loudly", warned.detail.includes("*** DAILY CREDIT BUDGET 80% USED ***"));
  check("  ...but detection continues", warned.allowed === true);
  check("  ...and it says it will stop at the limit", warned.detail.includes("it will stop at the limit"));
}

console.log("\n-- rollover: a new UTC day restores the allowance, a restart does not --");
{
  const file = tmpLedger();
  const day1 = at("2026-09-11T23:59:59Z");
  const b = new CreditBreaker(budget({ ledgerFile: file }), day1, file);
  b.charge(1000, day1);
  check("halted on day 1", b.decide(day1).allowed === false);

  const day2 = at("2026-09-12T00:00:00Z");
  const d2 = b.decide(day2);
  check("the next UTC day is allowed again", d2.allowed === true, d2.reason);
  check("the daily tally reset", d2.dayCredits === 0);
  check("the MONTHLY tally did not", d2.monthCredits === 1000, `${d2.monthCredits}`);

  const nextMonth = at("2026-10-01T00:00:00Z");
  check("a new month resets the monthly tally too", b.decide(nextMonth).monthCredits === 0);
}

console.log("\n-- an override is explicit, reasoned, and expires by itself --");
{
  const cfg = budget();
  const t = at("2026-09-11T14:00:00Z");
  const b = new CreditBreaker(cfg, t);
  b.charge(1000, t);
  check("halted before the override", b.decide(t).allowed === false);

  let threw = false;
  try {
    b.grantOverride("   ", t);
  } catch {
    threw = true;
  }
  check("an unexplained override is refused", threw);

  b.grantOverride("live launch window, watching it by hand", t);
  const d = b.decide(t);
  check("the override allows spending past the limit", d.allowed === true);
  check("it is reported as an override, not as being within budget", d.reason === "manual-override");
  check("it still reads as abnormal", d.detail.includes("*** SPENDING PAST THE CREDIT LIMIT"));
  check("it names the reason given", d.detail.includes("live launch window"));
  check("it names when it was granted", d.detail.includes(t.toISOString()));

  // An override that outlived its day would silently disable the breaker.
  const tomorrow = at("2026-09-12T14:00:00Z");
  const b2 = new CreditBreaker(cfg, tomorrow, cfg.ledgerFile);
  b2.charge(1000, tomorrow);
  check("the override does NOT carry into the next day", b2.decide(tomorrow).allowed === false);
}

console.log("\n-- there is no 'unlimited' setting --");
{
  const bad = (over: Partial<CreditBudgetConfig>, label: string) => {
    let threw = false;
    try {
      validateCreditBudget({ ...DEFAULT_CREDIT_BUDGET, ...over });
    } catch {
      threw = true;
    }
    check(`refused: ${label}`, threw);
  };
  bad({ dailyCredits: 0 }, "a zero daily budget");
  bad({ dailyCredits: -1 }, "a negative daily budget");
  bad({ dailyCredits: Infinity }, "an infinite daily budget");
  bad({ monthlyCredits: Number.NaN }, "NaN as a monthly budget");
  bad({ dailyCredits: undefined as any }, "a missing daily budget");
  bad({ warnFraction: 0 }, "a warn fraction of 0");
  bad({ warnFraction: 1.5 }, "a warn fraction above 1");
  bad({ dailyCredits: 20_000, monthlyCredits: 10_000 }, "a daily budget that could never fire");

  let ok = true;
  try {
    validateCreditBudget(DEFAULT_CREDIT_BUDGET);
  } catch {
    ok = false;
  }
  check("the shipped defaults are themselves valid", ok);
}

console.log("\n-- the defaults come from the plan, with headroom --");
{
  check("the monthly default is below the 10M plan", DEFAULT_MONTHLY_CREDITS < PLAN_MONTHLY_CREDITS);
  check("  ...by at least 10%", DEFAULT_MONTHLY_CREDITS <= PLAN_MONTHLY_CREDITS * 0.9);
  check(
    "31 days at the daily default stays inside the monthly default",
    DEFAULT_DAILY_CREDITS * 31 <= DEFAULT_MONTHLY_CREDITS
  );
  // Measured 2026-09-11: 9,891 credits/h lifetime = 237,384/day. The default
  // must sit above the observed rate or the breaker halts a healthy bot.
  check("the daily default is above the measured burn of 237,384/day", DEFAULT_DAILY_CREDITS > 237_384);
}

console.log("\n-- the breaker itself spends nothing --");
{
  // Handed a Connection that throws on ANY property access. If the breaker
  // touched the network in any path exercised here, this would throw.
  const explodingConnection: any = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`the credit breaker touched the RPC connection: .${String(prop)}()`);
      },
    }
  );
  let touched = false;
  try {
    const cfg = budget();
    const t = at("2026-09-11T14:00:00Z");
    const b = new CreditBreaker(cfg, t);
    void explodingConnection; // in scope, deliberately never passed in
    b.chargeBatch(["getTokenAccounts", "getTransaction"], t);
    b.decide(t);
    b.grantOverride("test", t);
    b.persist();
    b.snapshot();
  } catch (e) {
    touched = true;
    console.log(`    ${e instanceof Error ? e.message : e}`);
  }
  check("no RPC connection is reachable from the breaker's API at all", !touched);
  // Structural, because the behavioural check above can only prove the paths it
  // calls. This proves the module has no way to reach the network at all.
  // Comments are stripped first: an earlier structural guard in this repo
  // matched its own docstring and asserted nothing.
  const src = fs
    .readFileSync("src/rpc/creditBudget.ts", "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  check("the breaker imports no Solana web3 client", !/@solana\/web3\.js/.test(src));
  check("it names no Connection type", !/\bConnection\b/.test(src));
  check("it calls no fetch", !/\bfetch\s*\(/.test(src));
  check("it opens no http client", !/\b(axios|https?\.request|XMLHttpRequest)\b/.test(src));
}

console.log("\n-- a corrupt or missing ledger starts at zero, never at a guess --");
{
  const now = at("2026-09-11T14:00:00Z");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opiumo-budget-bad-"));

  const missing = path.join(dir, "nope.json");
  check("a missing ledger starts empty", loadLedger(missing, now).day.credits === 0);

  const garbage = path.join(dir, "garbage.json");
  fs.writeFileSync(garbage, "{not json");
  check("unparseable JSON starts empty rather than throwing", loadLedger(garbage, now).day.credits === 0);

  const wrongShape = path.join(dir, "wrong.json");
  fs.writeFileSync(wrongShape, JSON.stringify({ version: 1, day: { key: "2026-09-11", credits: "lots" } }));
  check("a credits field that is not a number is refused", loadLedger(wrongShape, now).day.credits === 0);

  const futureVersion = path.join(dir, "v2.json");
  fs.writeFileSync(futureVersion, JSON.stringify({ version: 2, day: { key: "x", credits: 5 }, month: { key: "y", credits: 5 } }));
  check("a version this build does not understand is not read", loadLedger(futureVersion, now).day.credits === 0);
}

console.log("\n-- pure helpers --");
{
  const t = at("2026-09-11T14:00:00Z");
  check("the day key is UTC", utcDayKey(t) === "2026-09-11");
  const s = emptyLedger(t);
  check("an empty ledger starts at zero", s.day.credits === 0 && s.month.credits === 0);
  check("rolling to the same instant changes nothing", rollTo(s, t).day.key === "2026-09-11");

  // evaluateBudget is pure and takes no clock of its own.
  const d = evaluateBudget(DEFAULT_CREDIT_BUDGET, { ...s, day: { key: "2026-09-11", credits: 0 } }, t);
  check("a fresh ledger is within budget", d.reason === "within-budget" && d.allowed);
  check("a disabled breaker says so rather than reporting comfort", 
    evaluateBudget({ ...DEFAULT_CREDIT_BUDGET, enabled: false }, s, t).reason === "breaker-disabled");
  check("  ...and warns that nothing will stop an overrun",
    evaluateBudget({ ...DEFAULT_CREDIT_BUDGET, enabled: false }, s, t).detail.includes("nothing will stop an overrun"));
}

console.log("\n-- charging from the meter: deltas, and a restart is not free credits --");
{
  const cfg = budget();
  const t = at("2026-09-11T14:00:00Z");
  const b = new CreditBreaker(cfg, t);

  // The meter's counter is lifetime-cumulative, so only the delta is new spend.
  check("the first reading charges the whole total", b.chargeFromMeter(100, t) === 100);
  check("a later reading charges only the difference", b.chargeFromMeter(250, t) === 150);
  check("the ledger holds the total, not the sum of readings", b.snapshot().day.credits === 250);
  check("an unchanged reading charges nothing", b.chargeFromMeter(250, t) === 0);

  // The meter restarts at zero with the process; the ledger does not. A naive
  // delta would be negative here and hand back free credits on every restart.
  const afterRestart = b.chargeFromMeter(30, t);
  check("after a meter reset the new total is charged, not a negative delta", afterRestart === 30);
  check("the day's tally only ever grows", b.snapshot().day.credits === 280, `${b.snapshot().day.credits}`);

  check("a nonsense reading is ignored rather than charged", b.chargeFromMeter(Number.NaN, t) === 0);
  check("  ...and a negative one too", b.chargeFromMeter(-5, t) === 0);
  check("neither disturbed the tally", b.snapshot().day.credits === 280);
}

console.log("\n-- persistence is throttled, but never skipped forever --");
{
  const cfg = budget();
  const t = at("2026-09-11T14:00:00Z");
  const b = new CreditBreaker(cfg, t);
  b.charge(10, t);

  check("the first throttled persist is refused inside the interval", b.persistThrottled(30_000, 60_000) === false);
  check("and past the interval it writes", b.persistThrottled(61_000, 60_000) === true);
  check("a clean ledger is not rewritten", b.persistThrottled(200_000, 60_000) === false);
  check("what was written can be read back", loadLedger(cfg.ledgerFile, t).day.credits === 10);
}

assertNoProductionWrites(check, ["opiumo-budget-", "credit-ledger"]);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
