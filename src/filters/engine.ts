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
export function evaluateFilters(
  event: NewPoolEvent,
  metrics: TokenMetrics,
  filters: FiltersConfig
): FilterResult {
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
  if (metrics.topHolderPercent === null) {
    reasons.push("top holder % unknown (could not fetch largest accounts)");
  } else if (metrics.topHolderPercent > filters.maxTopHolderPercent) {
    reasons.push(
      `top holder too concentrated (${metrics.topHolderPercent.toFixed(2)}% > max ${filters.maxTopHolderPercent}%)`
    );
  }

  // -- dev wallet holding --
  if (metrics.devWalletPercent === null) {
    reasons.push("dev wallet % unknown (could not fetch creator balance)");
  } else if (metrics.devWalletPercent > filters.maxDevWalletPercent) {
    reasons.push(
      `dev wallet holds too much (${metrics.devWalletPercent.toFixed(2)}% > max ${filters.maxDevWalletPercent}%)`
    );
  }

  // -- renounce status --
  if (filters.requireMintAuthorityRenounced && !metrics.mintAuthorityRenounced) {
    reasons.push("mint authority not renounced (dev can still mint more supply)");
  }
  if (filters.requireFreezeAuthorityRenounced && !metrics.freezeAuthorityRenounced) {
    reasons.push("freeze authority not renounced (dev can still freeze holder wallets)");
  }

  // -- unique wallets vs tx volume --
  if (metrics.uniqueWallets === null || metrics.transactionCount === null) {
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

/** One-line, human-scannable summary for the live console feed. */
export function formatDecisionLine(result: FilterResult): string {
  const m = result.metrics;
  const fmt = (v: number | null, suffix = "") => (v === null ? "?" : `${v.toFixed(2)}${suffix}`);

  const summary =
    `liquidity=${fmt(m.liquiditySol, "SOL")} topHolder=${fmt(m.topHolderPercent, "%")} ` +
    `devWallet=${fmt(m.devWalletPercent, "%")} renounced=${m.mintAuthorityRenounced ? "Y" : "N"}/${
      m.freezeAuthorityRenounced ? "Y" : "N"
    } wallets=${m.uniqueWallets ?? "?"} txs=${m.transactionCount ?? "?"}`;

  if (result.decision === "PASS") {
    return `[PASS] ${result.source.padEnd(7)} ${result.mint}  ${summary}`;
  }
  return `[SKIP] ${result.source.padEnd(7)} ${result.mint}  ${summary}\n       reasons: ${result.reasons.join("; ")}`;
}
