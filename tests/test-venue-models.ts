/** Bonding-curve pricing identities, checked against the closed form and against the live-decoded curve of 2026-09-12. */
import { bondingCurveProceeds, bondingCurveFloorFraction, proceedsFor, venueOf, PUMPFUN_VIRTUAL_SOL_OFFSET, PUMPFUN_INITIAL_VIRTUAL_TOKENS } from "../src/analysis/venueModels";
import { constantProductProceeds } from "../src/trading/trailingStop";
let pass = 0, fail = 0;
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  PASS: ${n}`); } else { fail++; console.log(`  FAIL: ${n}${d ? " -- " + d : ""}`); } };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("\n=== the live-decoded curve (mint CPYJ...pump, 2026-09-12 07:05 UTC) ===");
{
  // Decoded on-chain: virtualSolReserves 30116961299 lamports, realSolReserves 116961299, virtualTokenReserves 1068832930627666 (6dp), total supply 1e15.
  const vS = 30116961299 / 1e9, rS = 116961299 / 1e9, vT = 1068832930627666 / 1e6;
  check("virtual SOL minus real SOL is exactly the 30 SOL offset", near(vS - rS, PUMPFUN_VIRTUAL_SOL_OFFSET, 1e-9));
  check("virtual tokens are just under the 1,073,000,000 initial (some bought)", vT < PUMPFUN_INITIAL_VIRTUAL_TOKENS && vT > 0.99 * PUMPFUN_INITIAL_VIRTUAL_TOKENS);
  // k from the live pair equals k from the initial pair: 30 * 1.073e9 (SOL*tokens).
  check("k is conserved: vS*vT matches 30 * initial virtual tokens within 0.01%", Math.abs(vS * vT - PUMPFUN_VIRTUAL_SOL_OFFSET * PUMPFUN_INITIAL_VIRTUAL_TOKENS) / (PUMPFUN_VIRTUAL_SOL_OFFSET * PUMPFUN_INITIAL_VIRTUAL_TOKENS) < 1e-4);
}

console.log("\n=== identities ===");
{
  const noFee = (S: number, L0: number, L1: number) => bondingCurveProceeds(S, L0, L1, 0)!;
  check("round trip with no fee loses only 2S/vS0 (0.2 into a fresh curve: ~1.3%)", near(noFee(0.2, 0, 0), 0.2 / (1 + 2 * 0.2 / 30), 1e-9) && noFee(0.2, 0, 0) > 0.197);
  check("with the 1% fee each way the round trip loses ~3.3%", bondingCurveProceeds(0.2, 0, 0)! > 0.192 && bondingCurveProceeds(0.2, 0, 0)! < 0.195);
  // For a small stake the S terms vanish and the floor is exactly (30/vS0)^2 = (30/35)^2 = 73.5%.
  check("a small stake drained from 5 SOL raised returns (30/35)^2 of itself (no fee): ~73%", Math.abs(noFee(0.01, 5, 0) / 0.01 - (30 / 35) ** 2) < 0.002, String(noFee(0.01, 5, 0) / 0.01));
  check("a 1-SOL stake pays more slippage on the way in: ~70%", noFee(1, 5, 0) > 0.69 && noFee(1, 5, 0) < 0.71, String(noFee(1, 5, 0)));
  // (30/32)^2 = 87.9% before fees and slippage on a 1-SOL stake; ~81% after. At 85 SOL raised: (30/115)^2 = 6.8%.
  check("the floor fraction rises as entry liquidity falls: 2 SOL -> ~81% (with fees), 85 SOL -> ~7%", bondingCurveFloorFraction(2) > 0.80 && bondingCurveFloorFraction(2) < 0.88 && bondingCurveFloorFraction(85) < 0.08, `${bondingCurveFloorFraction(2)} ${bondingCurveFloorFraction(85)}`);
  check("a run from 2 to 20 SOL raised pays out more than the stake", bondingCurveProceeds(0.2, 2, 20)! > 0.2 * 2);
  check("proceeds increase with realSolNow", noFee(0.2, 5, 10) > noFee(0.2, 5, 5) && noFee(0.2, 5, 5) > noFee(0.2, 5, 1));
  check("negative or non-numeric inputs are null, not zero", bondingCurveProceeds(-1, 5, 5) === null && bondingCurveProceeds(0.2, -1, 5) === null && bondingCurveProceeds(0.2, 5, NaN) === null);
  // Against the real-balance constant-product model the book uses today:
  const cp = constantProductProceeds(0.002, 0.2 / 5)!; // 0.2 into a 5-SOL pool, pool drained to 0.002 real
  check("the book's model calls a drain from 5 SOL a ~100% loss; the curve calls it ~28%", cp < 0.001 && bondingCurveProceeds(0.2, 5, 0.002)! > 0.14, `${cp} vs ${bondingCurveProceeds(0.2, 5, 0.002)}`);
}

console.log("\n=== venue routing ===");
{
  const pf = proceedsFor("pumpfun", 0.2, 5);
  check("pumpfun -> bonding curve, entry proceeds = round trip at entry", /bonding curve/.test(pf.model) && near(pf.entryProceedsSol!, bondingCurveProceeds(0.2, 5, 5)!));
  check("the pumpfun fn ignores the pool fraction argument", near(pf.fn(3, 0.05)!, pf.fn(3, 0.9)!));
  const ry = proceedsFor("raydium", 0.2, 5);
  check("raydium -> constant product on real reserves", /constant-product/.test(ry.model) && near(ry.entryProceedsSol!, constantProductProceeds(5, 0.04)!));
  check("venueOf maps sources and refuses the unknown", venueOf("pumpfun") === "pumpfun" && venueOf("raydium") === "raydium" && venueOf("x") === null && venueOf(undefined) === null);
}
console.log(`\nTotal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
