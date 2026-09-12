/**
 * Slippage by venue.
 *
 * The paper book prices every position with constant-product slippage on the
 * pool's REAL SOL balance. That is the right model for a Raydium AMM and the
 * wrong one for Pump.fun, which is a bonding curve with VIRTUAL reserves:
 *
 *   virtualSol = 30 SOL + realSol          (verified live 2026-09-12: vS - rS = 30.000000000)
 *   virtualTokens = k / virtualSol,  k = 3.219e25 lamports*raw  (initial virtual tokens 1,073,000,000)
 *
 * Buying S SOL when realSol = L0 takes t = k/vS0 - k/(vS0+S) tokens. Selling
 * them when realSol = L1 returns vS1 - k/(k/vS1 + t). k cancels:
 *
 *   proceeds(S, L0, L1) = vS1^2 * S / (vS0^2 + vS0*S + vS1*S),   vS = 30 + L
 *
 * Two things follow that the real-balance model gets badly wrong:
 *  - the price has a FLOOR at the curve's start: a token bought at L0 raised
 *    and fully drained (L1 = 0) returns (30/vS0)^2 of the stake, not ~0.
 *    Bought at 2 SOL raised -> worst case -12%; at 5 -> -27%; at 85 -> -93%.
 *  - round-trip slippage for a small stake is tiny: 2S/vS0, about 1.2% for
 *    0.2 SOL into a fresh curve - the order of magnitude Bitquery measured
 *    (median 0 bps, p75 6 bps on 4,844 trades).
 *
 * Pump.fun charges 1% on buys and sells; `fee` applies it. Raydium positions
 * keep the constant-product model on real reserves.
 */
import { ProceedsFn, constantProductProceeds } from "../trading/trailingStop";

export const PUMPFUN_VIRTUAL_SOL_OFFSET = 30;
export const PUMPFUN_INITIAL_VIRTUAL_TOKENS = 1_073_000_000;
export const PUMPFUN_FEE = 0.01;

export type Venue = "pumpfun" | "raydium";

/** SOL returned by selling a position bought with `stakeSol` at real liquidity `entryRealSol`, when real liquidity is `realSolNow`. */
export function bondingCurveProceeds(stakeSol: number, entryRealSol: number, realSolNow: number, fee = PUMPFUN_FEE): number | null {
  if (!(stakeSol > 0) || !(entryRealSol >= 0) || !(realSolNow >= 0)) return null;
  const s = stakeSol * (1 - fee);
  const vS0 = PUMPFUN_VIRTUAL_SOL_OFFSET + entryRealSol;
  const vS1 = PUMPFUN_VIRTUAL_SOL_OFFSET + realSolNow;
  const out = (vS1 * vS1 * s) / (vS0 * vS0 + vS0 * s + vS1 * s);
  return out * (1 - fee);
}

/** Worst case for a Pump.fun position: the curve drained back to zero. */
export function bondingCurveFloorFraction(entryRealSol: number, fee = PUMPFUN_FEE): number {
  const p = bondingCurveProceeds(1, entryRealSol, 0, fee);
  return p ?? 0;
}

/**
 * A ProceedsFn for the trailing stop, per venue and per position. The stop's
 * signature is (liquiditySol, poolFraction); for Pump.fun the fraction is
 * irrelevant - the stake and entry liquidity fix the position - so it is
 * ignored, and the function is built per position.
 */
export function proceedsFor(venue: Venue, stakeSol: number, entryRealSol: number, fee = PUMPFUN_FEE): { fn: ProceedsFn; entryProceedsSol: number | null; model: string } {
  if (venue === "raydium") {
    const f = stakeSol / entryRealSol;
    return { fn: constantProductProceeds, entryProceedsSol: constantProductProceeds(entryRealSol, f), model: "constant-product on real reserves" };
  }
  return {
    fn: (realSolNow) => bondingCurveProceeds(stakeSol, entryRealSol, realSolNow, fee),
    entryProceedsSol: bondingCurveProceeds(stakeSol, entryRealSol, entryRealSol, fee),
    model: "bonding curve (virtual reserves = real + 30 SOL), 1% fee each way",
  };
}

export function venueOf(source: string | undefined | null): Venue | null {
  if (source === "pumpfun" || source === "raydium") return source;
  return null;
}
