"""
Core feature #4: apply the configured safety/quality thresholds to a
token's metrics and produce a PASS/SKIP verdict with the specific
reason(s) — no buying happens here, this module only decides and logs.

Every check runs independently and every failing check is reported (not
just the first one), so a SKIP line tells you everything wrong with a
token at a glance.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from src.config import FiltersConfig
from src.token_info import TokenMetrics


@dataclass
class FilterResult:
    mint: str
    passed: bool
    reasons: list[str] = field(default_factory=list)  # failure reasons; empty if passed

    @property
    def verdict(self) -> str:
        return "PASS" if self.passed else "SKIP"


class FilterEngine:
    def __init__(self, config: FiltersConfig):
        self.config = config

    def evaluate(self, metrics: TokenMetrics) -> FilterResult:
        reasons: list[str] = []
        cfg = self.config

        # Missing data is a SKIP, not a guess — never buy (or count as a
        # PASS) on a token we can't actually verify.
        for field_name, label in (
            ("liquidity_sol", "liquidity"),
            ("top_holder_pct", "top holder %"),
            ("dev_holder_pct", "dev holder %"),
            ("mint_renounced", "mint authority"),
            ("freeze_renounced", "freeze authority"),
            ("unique_wallets", "unique wallet count"),
            ("unique_wallet_ratio", "unique wallet ratio"),
        ):
            if getattr(metrics, field_name) is None:
                reasons.append(f"{label} unavailable")

        if metrics.liquidity_sol is not None and metrics.liquidity_sol < cfg.min_liquidity_sol:
            reasons.append(
                f"liquidity {metrics.liquidity_sol:.2f} SOL < min {cfg.min_liquidity_sol:.2f} SOL"
            )

        if metrics.top_holder_pct is not None and metrics.top_holder_pct > cfg.max_top_holder_pct:
            reasons.append(
                f"top holder {metrics.top_holder_pct:.2f}% > max {cfg.max_top_holder_pct:.2f}%"
            )

        if metrics.dev_holder_pct is not None and metrics.dev_holder_pct > cfg.max_dev_holder_pct:
            reasons.append(
                f"dev holder {metrics.dev_holder_pct:.2f}% > max {cfg.max_dev_holder_pct:.2f}%"
            )

        if cfg.require_mint_renounced and metrics.mint_renounced is False:
            reasons.append("mint authority not renounced")

        if cfg.require_freeze_renounced and metrics.freeze_renounced is False:
            reasons.append("freeze authority not renounced")

        if metrics.unique_wallets is not None and metrics.unique_wallets < cfg.min_unique_wallets:
            reasons.append(
                f"unique wallets {metrics.unique_wallets} < min {cfg.min_unique_wallets}"
            )

        if (
            metrics.unique_wallet_ratio is not None
            and metrics.unique_wallet_ratio < cfg.min_unique_wallet_ratio
        ):
            reasons.append(
                f"unique wallet ratio {metrics.unique_wallet_ratio:.2f} < min "
                f"{cfg.min_unique_wallet_ratio:.2f} (possible wash trading)"
            )

        return FilterResult(mint=metrics.mint, passed=not reasons, reasons=reasons)
