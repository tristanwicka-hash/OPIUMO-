import { FiltersConfig } from "../config";
import { NewPoolEvent } from "../watcher/types";
import { TokenMetrics } from "../data/tokenMetrics";

export type Decision = "PASS" | "SKIP";

export interface FilterResult {
  mint: string;
  source: string;
  signature: string;
  decision: Decision;
  /** Every failed rule, in the order the rules are evaluated. Empty when decision === "PASS". */
  reasons: string[];
  metrics: TokenMetrics;
  evaluatedAt: string;
}

/**
 * Part 4: the thing you must manually verify before Part 5/6 are ever
 * allowed to run (see README non-negotiables). Pure function: same inputs
 * always produce the same PASS/SKIP + reasons, so it's fully testable
 * without touching the network - and easy to hand-check against real
 * tokens you look up on Solscan/Birdeye yourself.
 *
 * Philosophy: a metric we couldn't fetch (null) is treated as a FAILED
 * rule, not a skipped check. "Unknown" is never good enough to buy on.
 */
/**
 * Every check that depends ONLY on stage-1 metrics (liquidity, top holder,
 * dev wallet, renounce status, token extensions, creator LP).
 *
 * Exported so collectTokenMetrics() can ask "given what stage 1 found, is this
 * token still capable of passing?" without duplicating the rules. Sharing one
 * implementation is the whole point: a second copy of these checks would drift
 * from this one and the early-skip optimisation would start changing decisions.
 *
 * Because `reasons` is append-only and no stage-1 rule reads an activity
 * metric, a non-empty result here means the final decision is ALREADY SKIP -
 * running stage 2 could only add more reasons, never remove one.
 */
/**
 * `includeHolderRules: false` runs every stage-1 rule EXCEPT the two that need
 * holder data. It exists so the collector can ask "is this token still capable
 * of passing on the CHEAP checks alone?" before deciding to spend a 10-credit
 * DAS call on it - see src/data/holderData.ts.
 *
 * It is the same function rather than a copy on purpose: a second
 * implementation of these rules would drift, and the gate deciding whether to
 * spend money must not disagree with the rules that spend it.
 */
export function evaluateStage1Reasons(
  metrics: TokenMetrics,
  filters: FiltersConfig,
  opts: { includeHolderRules?: boolean } = {}
): string[] {
  const includeHolderRules = opts.includeHolderRules !== false;
  const reasons: string[] = [];

  // -- liquidity --
  if (metrics.liquiditySol === null) {
    reasons.push("liquidity unknown (could not fetch pool balance)");
  } else if (metrics.liquiditySol < filters.minLiquiditySol) {
    reasons.push(
      `liquidity too low (${metrics.liquiditySol.toFixed(2)} SOL < min ${filters.minLiquiditySol} SOL)`
    );
  }

  // -- top holder concentration --
  if (!includeHolderRules) {
    // Skipped deliberately: the caller is deciding whether holder data is worth
    // fetching at all, so it cannot require it yet.
  } else if (metrics.topHolderPercent === null) {
    reasons.push("top holder % unknown (could not fetch largest accounts)");
  } else if (metrics.topHolderPercent > filters.maxTopHolderPercent) {
    reasons.push(
      `top holder too concentrated (${metrics.topHolderPercent.toFixed(2)}% > max ${filters.maxTopHolderPercent}%)`
    );
  }

  // -- dev wallet holding --
  if (!includeHolderRules) {
    // As above.
  } else if (metrics.devWalletPercent === null) {
    reasons.push("dev wallet % unknown (could not fetch creator balance)");
  } else if (metrics.devWalletPercent > filters.maxDevWalletPercent) {
    reasons.push(
      `dev wallet holds too much (${metrics.devWalletPercent.toFixed(2)}% > max ${filters.maxDevWalletPercent}%)`
    );
  }

  // -- renounce status --
  // null = "couldn't verify" (RPC failure, unsupported mint program, etc) - this is NOT
  // the same as false ("confirmed still has an authority") and must never be worded like it.
  if (filters.requireMintAuthorityRenounced) {
    if (metrics.mintAuthorityRenounced === null) {
      reasons.push("mint authority renounce status unknown (could not fetch mint account)");
    } else if (!metrics.mintAuthorityRenounced) {
      reasons.push("mint authority not renounced (dev can still mint more supply)");
    }
  }
  if (filters.requireFreezeAuthorityRenounced) {
    if (metrics.freezeAuthorityRenounced === null) {
      reasons.push("freeze authority renounce status unknown (could not fetch mint account)");
    } else if (!metrics.freezeAuthorityRenounced) {
      reasons.push("freeze authority not renounced (dev can still freeze holder wallets)");
    }
  }

  // -- honeypot check: risky Token-2022 extensions (transfer hook, permanent delegate) --
  // "Bundle" detection (many wallets funded from one source at launch) is NOT a separate check
  // here - it's already served by the wallet/tx ratio rule just below, which catches the same
  // underlying pattern (volume concentrated in very few distinct wallets) without needing an
  // expensive per-holder funding-source trace.
  if (filters.rejectRiskyTokenExtensions) {
    if (metrics.riskyTokenExtensions === null) {
      reasons.push("token extensions unknown (could not fetch mint account)");
    } else if (metrics.riskyTokenExtensions.length > 0) {
      reasons.push(`risky token extensions present: ${metrics.riskyTokenExtensions.join(", ")}`);
    }
  }

  // -- LP locked/burned (Raydium only - see TokenMetrics.lpCheckApplicable) --
  if (metrics.lpCheckApplicable) {
    if (metrics.creatorLpPercent === null) {
      reasons.push("creator LP % unknown (could not fetch LP mint/holdings)");
    } else if (metrics.creatorLpPercent > filters.maxCreatorLpPercent) {
      reasons.push(
        `creator still holds ${metrics.creatorLpPercent.toFixed(2)}% of LP supply (> max ${filters.maxCreatorLpPercent}%) ` +
          `- liquidity is not locked/burned, creator could withdraw it`
      );
    }
  }
  // Pump.fun (lpCheckApplicable === false): no separate LP token pre-migration, and the bonding
  // curve's own program logic makes the liquidity structurally un-rug-pullable by the creator -
  // this check is not applicable and does not add a reason either way.

  return reasons;
}

/**
 * The stage-2 (activity) checks plus staleness. Split out only so
 * evaluateStage1Reasons() can be shared; the ordering of the combined list is
 * unchanged from before the split.
 */
function evaluateActivityAndStalenessReasons(metrics: TokenMetrics, filters: FiltersConfig): string[] {
  const reasons: string[] = [];

  // -- unique wallets vs tx volume --
  if (metrics.activitySkippedEarly) {
    // Deliberately not collected - the token had already failed a stage-1 rule,
    // so the ~101 RPC calls behind this metric could not have changed the
    // outcome. Stated explicitly rather than omitted, and worded so it can
    // never be mistaken for an RPC failure.
    reasons.push("activity metrics not collected (skipped early - token already failed an earlier check)");
  } else if (metrics.uniqueWallets === null || metrics.transactionCount === null) {
    reasons.push("wallet activity unknown (could not fetch recent signatures)");
  } else {
    if (metrics.uniqueWallets < filters.minUniqueWallets) {
      reasons.push(
        `too few unique wallets (${metrics.uniqueWallets} < min ${filters.minUniqueWallets})`
      );
    }
    if (metrics.transactionCount < filters.minTransactionCount) {
      reasons.push(
        `too few transactions (${metrics.transactionCount} < min ${filters.minTransactionCount})`
      );
    }
    if (metrics.transactionCount > 0) {
      const ratio = metrics.uniqueWallets / metrics.transactionCount;
      if (ratio < filters.minUniqueWalletToTxRatio) {
        reasons.push(
          `wallet/tx ratio too low (${ratio.toFixed(2)} < min ${filters.minUniqueWalletToTxRatio}, ` +
            `suggests a few wallets doing most of the volume - possible wash trading)`
        );
      }
    }
  }

  // -- staleness --
  // Metrics that took longer than metricsMaxAgeMs to collect might no longer reflect
  // the token's current state (liquidity could have been pulled, holders could have
  // changed) by the time you act on this decision.
  if (metrics.stale) {
    reasons.push("metrics are stale (took too long to collect - see config.polling.metricsMaxAgeMs)");
  }

  return reasons;
}

export function evaluateFilters(
  event: NewPoolEvent,
  metrics: TokenMetrics,
  filters: FiltersConfig
): FilterResult {
  // Order is stage-1 rules, then activity, then staleness - exactly as before
  // these were split into two functions.
  const reasons = [
    ...evaluateStage1Reasons(metrics, filters),
    ...evaluateActivityAndStalenessReasons(metrics, filters),
  ];

  return {
    mint: event.mint,
    source: event.source,
    signature: event.signature,
    decision: reasons.length === 0 ? "PASS" : "SKIP",
    reasons,
    metrics,
    evaluatedAt: new Date().toISOString(),
  };
}

/** One-line (plus warnings/reasons) human-scannable summary for the live console feed. */
export function formatDecisionLine(result: FilterResult): string {
  const m = result.metrics;
  const fmt = (v: number | null, suffix = "") => (v === null ? "?" : `${v.toFixed(2)}${suffix}`);
  const fmtBool = (v: boolean | null) => (v === null ? "?" : v ? "Y" : "N");

  const summary =
    `liquidity=${fmt(m.liquiditySol, "SOL")} topHolder=${fmt(m.topHolderPercent, "%")} ` +
    `devWallet=${fmt(m.devWalletPercent, "%")} renounced=${fmtBool(m.mintAuthorityRenounced)}/${fmtBool(
      m.freezeAuthorityRenounced
    )} wallets=${m.uniqueWallets ?? "?"} txs=${m.transactionCount ?? "?"}${m.stale ? " [STALE]" : ""}`;

  const lines = [
    result.decision === "PASS"
      ? `[PASS] ${result.source.padEnd(7)} ${result.mint}  ${summary}`
      : `[SKIP] ${result.source.padEnd(7)} ${result.mint}  ${summary}\n       reasons: ${result.reasons.join("; ")}`,
  ];

  // Always surface partial-fetch warnings, even on a PASS - "we couldn't verify X so we
  // fell back to a safe default" is exactly the kind of thing the manual-verification
  // step (README non-negotiables) needs to see, not just the raw JSONL log.
  if (m.warnings.length > 0) {
    lines.push(`       warnings: ${m.warnings.join("; ")}`);
  }

  return lines.join("\n");
}
