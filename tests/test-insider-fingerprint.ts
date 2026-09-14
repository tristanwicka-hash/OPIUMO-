/**
 * The insider fingerprint.
 *
 * The failure that matters is not missing an insider - it is issuing a CLEAN
 * BILL OF HEALTH on a trace nobody could read. So most of these assert that
 * absent data produces "cannot-say", never "nothing".
 *
 * The second is the conjunction. Measured 2026-09-14: all 40 real deployers
 * traced had funded other wallets, so any scorer that adds up separate signals
 * will flag every launch on the chain. The four signals must land on the SAME
 * wallet, and these tests fail if they are ever counted separately.
 *
 * Pure, offline, no clock, no network.
 */
import { fingerprint, hasFullShape, Trace, TracedWallet, FRESH_MAX_PRIOR_TXS, FAST_EXIT_MINUTES, FIRST_SLOT_WINDOW } from "../src/analysis/insiderFingerprint";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; } else { fail++; console.log(`  FAIL: ${n}${d ? " -- " + d : ""}`); } };

const w = (over: Partial<TracedWallet> = {}): TracedWallet => ({
  address: "W" + Math.random().toString(36).slice(2, 8),
  priorTxs: 1, fundedMinutesBefore: 10, boughtAtSlotOffset: 1, exitMinutes: 2, ...over,
});
const trace = (wallets: TracedWallet[], over: Partial<Trace> = {}): Trace =>
  ({ mint: "MINT", deployer: "DEP", wallets, truncated: false, unreadableWallets: 0, ...over });

console.log("\n=== the conjunction is the signal, not the parts ===\n");
{
  check("all four on one wallet is the shape", hasFullShape(w()));
  check("not fresh -> not the shape", !hasFullShape(w({ priorTxs: 400 })));
  check("not funded before launch -> not the shape", !hasFullShape(w({ fundedMinutesBefore: null })));
  check("bought late -> not the shape", !hasFullShape(w({ boughtAtSlotOffset: 50 })));
  check("never exited -> not the shape", !hasFullShape(w({ exitMinutes: null })));

  // The load-bearing one. Four wallets, each with a DIFFERENT single signal.
  // A scorer that sums signals sees "4 fresh-ish indicators" and cries insider.
  const spread = trace([
    w({ priorTxs: 1, fundedMinutesBefore: null, boughtAtSlotOffset: null, exitMinutes: null }),
    w({ priorTxs: 900, fundedMinutesBefore: 5, boughtAtSlotOffset: null, exitMinutes: null }),
    w({ priorTxs: 900, fundedMinutesBefore: null, boughtAtSlotOffset: 0, exitMinutes: null }),
    w({ priorTxs: 900, fundedMinutesBefore: null, boughtAtSlotOffset: null, exitMinutes: 1 }),
  ]);
  const f = fingerprint(spread);
  check("four wallets with one signal each is NOT an insider shape", f.verdict !== "insider-shape", f.verdict);
  check("...and fullShape is zero", f.fullShape === 0, String(f.fullShape));
}

console.log("=== two complete shapes is the call ===\n");
{
  const f = fingerprint(trace([w(), w(), w({ priorTxs: 800, fundedMinutesBefore: null })]));
  check("two wallets with all four -> insider-shape", f.verdict === "insider-shape", f.verdict);
  check("the reason says all four landed on the same wallet", /All four on the same wallet/.test(f.because[0]));

  const one = fingerprint(trace([w(), w({ priorTxs: 900, fundedMinutesBefore: null, boughtAtSlotOffset: null, exitMinutes: null })]));
  check("ONE complete shape is only some-signals, not a call", one.verdict === "some-signals", one.verdict);
  check("...and says why one is not enough", /coincidence/.test(one.because[0]));
}

console.log("=== unknown is never a clean bill of health ===\n");
{
  const nothingRead = fingerprint(trace([], { unreadableWallets: 8 }));
  check("8 buyers found and none readable -> cannot-say, NOT nothing", nothingRead.verdict === "cannot-say", nothingRead.verdict);
  check("...and it says none could be followed", /none could be followed/.test(nothingRead.because[0]));

  const noBuyers = fingerprint(trace([]));
  check("no buyers identified at all -> cannot-say", noBuyers.verdict === "cannot-say", noBuyers.verdict);
  check("...explicitly called a gap in the trace, not a clean launch", /not a clean launch/.test(noBuyers.because[0]));

  const mostlyBlind = fingerprint(trace([w({ priorTxs: null }), w({ priorTxs: null }), w({ priorTxs: 900, fundedMinutesBefore: null, boughtAtSlotOffset: null, exitMinutes: null })], { unreadableWallets: 6 }));
  check("under half readable -> cannot-say", mostlyBlind.verdict === "cannot-say", mostlyBlind.verdict);
  check("...and the ratio is reported", mostlyBlind.confidence.readable === 1 && mostlyBlind.confidence.total === 9, JSON.stringify(mostlyBlind.confidence));

  // A null priorTxs must not count as fresh. That would invent insiders.
  check("an unreadable wallet is not counted as fresh", !hasFullShape(w({ priorTxs: null })));
}

console.log("=== rates are refused below the floor, never printed as 0 ===\n");
{
  const two = fingerprint(trace([w(), w()]));
  const fresh = two.findings.find((f) => f.label.startsWith("Fresh"))!;
  check("with 2 wallets, under the 3-buyer floor, the rate is null", fresh.rate === null, String(fresh.rate));
  check("...but the count and denominator are still shown", fresh.count === 2 && fresh.of === 2);

  const four = fingerprint(trace([w(), w(), w(), w({ priorTxs: 900 })]));
  const fresh4 = four.findings.find((f) => f.label.startsWith("Fresh"))!;
  check("at 4 wallets the rate appears", fresh4.rate !== null && Math.abs(fresh4.rate - 0.75) < 1e-9, String(fresh4.rate));
}

console.log("=== the caveats are always there ===\n");
{
  const t = fingerprint(trace([w(), w()], { truncated: true, unreadableWallets: 2 }));
  check("a truncated trace says its counts are floors", t.caveats.some((c) => /FLOOR/.test(c)));
  check("unfollowed buyers are named as unknown, not clean", t.caveats.some((c) => /neither clean nor dirty/.test(c)));
  check("every verdict warns a bot looks like this too", fingerprint(trace([w()])).caveats.some((c) => /sniper bot/.test(c)));

  // Alert-only: nothing in the output may read as an instruction.
  const text = JSON.stringify([fingerprint(trace([w(), w()])), fingerprint(trace([]))]).toLowerCase();
  for (const p of ["buy", "sell now", "enter", "place"]) {
    if (p === "buy") { check("no buy instruction (the word only appears as 'bought')", !/"[^"]*\bbuy\b[^"]*"/.test(text) || !/should buy|buy this|buy it/.test(text)); continue; }
    check(`never says "${p}"`, !text.includes(p));
  }
}

console.log("=== the boundaries ===\n");
{
  check(`exactly ${FRESH_MAX_PRIOR_TXS} prior txs is still fresh`, hasFullShape(w({ priorTxs: FRESH_MAX_PRIOR_TXS })));
  check(`${FRESH_MAX_PRIOR_TXS + 1} is not`, !hasFullShape(w({ priorTxs: FRESH_MAX_PRIOR_TXS + 1 })));
  check(`exiting at exactly ${FAST_EXIT_MINUTES} min counts`, hasFullShape(w({ exitMinutes: FAST_EXIT_MINUTES })));
  check(`at ${FAST_EXIT_MINUTES + 1} it does not`, !hasFullShape(w({ exitMinutes: FAST_EXIT_MINUTES + 1 })));
  check(`buying at slot ${FIRST_SLOT_WINDOW} counts`, hasFullShape(w({ boughtAtSlotOffset: FIRST_SLOT_WINDOW })));
  check(`at slot ${FIRST_SLOT_WINDOW + 1} it does not`, !hasFullShape(w({ boughtAtSlotOffset: FIRST_SLOT_WINDOW + 1 })));
  check("funding AFTER the launch is not pre-launch staging", !hasFullShape(w({ fundedMinutesBefore: -5 })));
}

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
