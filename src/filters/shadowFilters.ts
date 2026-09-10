/**
 * Shadow filters: what LOOSER threshold sets would have decided, on the same tokens.
 *
 * ## Why
 *
 * The live filters have a 0% pass rate. That is unreadable on its own - it is a
 * good filter if none of the rejects went anywhere, and a broken one if some
 * did. Running looser sets alongside, on the same data, turns it into a
 * comparison: how many would each set have passed, and what did those tokens
 * become.
 *
 * ## ZERO additional RPC calls. This is a hard constraint, not a goal.
 *
 * `evaluateFilters(event, metrics, filters)` takes thresholds as a parameter, so
 * a shadow set is a second call on the SAME already-fetched `TokenMetrics`
 * object, in memory. This module never touches a Connection - it does not
 * import one and could not make a call if it wanted to.
 *
 * If a shadow set would need a field the live path did not fetch, that field is
 * `null` in the metrics and the shadow result records it as UNCHECKED. It is
 * never fetched to fill the gap. Credit headroom is ~28% and this must not eat
 * any of it.
 *
 * ## No behaviour change
 *
 * Nothing here can influence a live PASS/SKIP or a trade. It returns records.
 * The live filters still control everything.
 */
import { NewPoolEvent } from "../watcher/types";
import { TokenMetrics } from "../data/tokenMetrics";
import { FiltersConfig } from "../config";
import { evaluateFilters } from "./engine";

export interface ShadowSet {
  id: string;
  /** Why this set exists - what question it is asking of the live thresholds. */
  rationale: string;
  filters: FiltersConfig;
}

export interface ShadowVerdict {
  setId: string;
  decision: "PASS" | "SKIP";
  reasons: string[];
  /**
   * Fields this set depends on that the live fetch did not produce. The set's
   * verdict is still recorded, but it was reached WITHOUT these.
   */
  uncheckedFields: string[];
}

export interface ShadowEvaluation {
  mint: string;
  at: string;
  liveDecision: "PASS" | "SKIP";
  shadows: ShadowVerdict[];
}

/**
 * Which metric fields are absent from this fetch.
 *
 * Reported per evaluation rather than assumed, because a shadow PASS reached
 * without the top-holder check is a weaker claim than one that had it, and the
 * two must not be counted together silently.
 */
export function uncheckedFields(metrics: TokenMetrics): string[] {
  const out: string[] = [];
  if (metrics.liquiditySol === null) out.push("liquiditySol");
  if (metrics.topHolderPercent === null) out.push("topHolderPercent");
  if (metrics.devWalletPercent === null) out.push("devWalletPercent");
  if (metrics.mintAuthorityRenounced === null) out.push("mintAuthorityRenounced");
  if (metrics.freezeAuthorityRenounced === null) out.push("freezeAuthorityRenounced");
  if (metrics.uniqueWallets === null) out.push("uniqueWallets");
  if (metrics.transactionCount === null) out.push("transactionCount");
  // Token-2022 extension scan. null means the check could not be made, which is
  // NOT the same as "no risky extensions found" (an empty array).
  if (metrics.riskyTokenExtensions === null) out.push("riskyTokenExtensions");
  return out;
}

/**
 * Evaluates every shadow set against ALREADY-FETCHED metrics.
 *
 * The `metrics` argument is the live path's own object. Nothing is re-fetched,
 * and this function is synchronous precisely so it cannot await a network call.
 */
export function evaluateShadows(
  event: NewPoolEvent,
  metrics: TokenMetrics,
  liveDecision: "PASS" | "SKIP",
  sets: ShadowSet[]
): ShadowEvaluation {
  const missing = uncheckedFields(metrics);
  return {
    mint: metrics.mint,
    at: metrics.fetchedAt,
    liveDecision,
    shadows: sets.map((s) => {
      const r = evaluateFilters(event, metrics, s.filters);
      return {
        setId: s.id,
        decision: r.decision === "PASS" ? "PASS" : "SKIP",
        reasons: r.reasons,
        uncheckedFields: missing,
      };
    }),
  };
}

export interface ShadowTally {
  setId: string;
  evaluated: number;
  passed: number;
  /** Passes reached while at least one depended-on field was unchecked. */
  passedWithUnchecked: number;
  passRate: number | null;
}

export function tally(evaluations: ShadowEvaluation[], setIds: string[]): {
  live: { evaluated: number; passed: number; passRate: number | null };
  shadows: ShadowTally[];
} {
  const n = evaluations.length;
  const livePassed = evaluations.filter((e) => e.liveDecision === "PASS").length;
  return {
    live: { evaluated: n, passed: livePassed, passRate: n > 0 ? livePassed / n : null },
    shadows: setIds.map((id) => {
      const vs = evaluations.map((e) => e.shadows.find((s) => s.setId === id)).filter(Boolean) as ShadowVerdict[];
      const passed = vs.filter((v) => v.decision === "PASS");
      return {
        setId: id,
        evaluated: vs.length,
        passed: passed.length,
        passedWithUnchecked: passed.filter((v) => v.uncheckedFields.length > 0).length,
        // Null, not 0, when nothing was evaluated: no rate exists for an empty sample.
        passRate: vs.length > 0 ? passed.length / vs.length : null,
      };
    }),
  };
}
