"""
Loads config/config.yaml + .env into typed, dot-accessible config objects.

All tunable thresholds live in the YAML file (see config/config.yaml for
documented defaults). Secrets (RPC URLs, private key) live in environment
variables and are substituted into the YAML via ${VAR_NAME} placeholders.
Nothing in this module hardcodes a secret.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

_ENV_VAR_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class ConfigError(RuntimeError):
    pass


def _substitute_env(value: Any) -> Any:
    """Recursively replace ${VAR} in strings with os.environ values."""
    if isinstance(value, str):
        def _replace(match: "re.Match[str]") -> str:
            name = match.group(1)
            return os.environ.get(name, "")
        return _ENV_VAR_PATTERN.sub(_replace, value)
    if isinstance(value, dict):
        return {k: _substitute_env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_substitute_env(v) for v in value]
    return value


@dataclass
class RpcConfig:
    http_url: str
    ws_url: str
    commitment: str = "confirmed"
    request_timeout_sec: int = 15


@dataclass
class SourcesConfig:
    watch_pumpfun: bool = True
    watch_raydium: bool = True
    ws_reconnect_delay_sec: int = 5


@dataclass
class FiltersConfig:
    min_liquidity_sol: float = 5.0
    max_top_holder_pct: float = 15.0
    max_dev_holder_pct: float = 8.0
    require_mint_renounced: bool = True
    require_freeze_renounced: bool = True
    min_unique_wallets: int = 15
    min_unique_wallet_ratio: float = 0.35
    lookback_tx_count: int = 100


@dataclass
class TakeProfitStep:
    multiplier: float
    sell_pct: float


@dataclass
class TradingConfig:
    position_size_sol: float = 0.1
    slippage_bps: int = 300
    priority_fee_microlamports: int = 200_000
    max_concurrent_positions: int = 3
    take_profit: list[TakeProfitStep] = field(default_factory=list)
    stop_loss_pct: float = -30.0
    price_poll_interval_sec: int = 5
    position_timeout_min: int = 60


@dataclass
class JupiterConfig:
    quote_url: str = "https://quote-api.jup.ag/v6/quote"
    swap_url: str = "https://quote-api.jup.ag/v6/swap"
    input_mint_sol: str = "So11111111111111111111111111111111111111112"


@dataclass
class StorageConfig:
    db_path: str = "data/trades.db"


@dataclass
class LoggingConfig:
    log_dir: str = "logs"
    level: str = "INFO"


@dataclass
class AppConfig:
    mode: str
    rpc: RpcConfig
    sources: SourcesConfig
    filters: FiltersConfig
    trading: TradingConfig
    jupiter: JupiterConfig
    storage: StorageConfig
    logging: LoggingConfig

    @property
    def is_live_mode(self) -> bool:
        return self.mode.strip().lower() == "live"


def load_config(config_path: str | Path = "config/config.yaml", env_path: str | Path = ".env") -> AppConfig:
    """Load and validate the app config. Raises ConfigError on problems."""
    env_path = Path(env_path)
    if env_path.exists():
        load_dotenv(env_path, override=False)
    else:
        # Still allow real environment variables (e.g. injected by a
        # process manager / container) even with no .env file present.
        load_dotenv(override=False)

    config_path = Path(config_path)
    if not config_path.exists():
        raise ConfigError(f"Config file not found: {config_path}")

    with config_path.open("r") as f:
        raw = yaml.safe_load(f) or {}

    raw = _substitute_env(raw)

    mode = str(raw.get("mode", "scan")).strip().lower()
    if mode not in ("scan", "live"):
        raise ConfigError(f"config 'mode' must be 'scan' or 'live', got: {mode!r}")

    rpc_raw = raw.get("rpc", {}) or {}
    rpc = RpcConfig(
        http_url=rpc_raw.get("http_url", ""),
        ws_url=rpc_raw.get("ws_url", ""),
        commitment=rpc_raw.get("commitment", "confirmed"),
        request_timeout_sec=int(rpc_raw.get("request_timeout_sec", 15)),
    )
    if not rpc.http_url:
        raise ConfigError(
            "rpc.http_url is empty. Set SOLANA_RPC_HTTP_URL in your .env "
            "(see .env.example) — e.g. a Helius or QuickNode endpoint."
        )
    if not rpc.ws_url:
        raise ConfigError(
            "rpc.ws_url is empty. Set SOLANA_RPC_WS_URL in your .env "
            "(see .env.example)."
        )

    sources_raw = raw.get("sources", {}) or {}
    sources = SourcesConfig(
        watch_pumpfun=bool(sources_raw.get("watch_pumpfun", True)),
        watch_raydium=bool(sources_raw.get("watch_raydium", True)),
        ws_reconnect_delay_sec=int(sources_raw.get("ws_reconnect_delay_sec", 5)),
    )

    filters_raw = raw.get("filters", {}) or {}
    filters = FiltersConfig(
        min_liquidity_sol=float(filters_raw.get("min_liquidity_sol", 5.0)),
        max_top_holder_pct=float(filters_raw.get("max_top_holder_pct", 15.0)),
        max_dev_holder_pct=float(filters_raw.get("max_dev_holder_pct", 8.0)),
        require_mint_renounced=bool(filters_raw.get("require_mint_renounced", True)),
        require_freeze_renounced=bool(filters_raw.get("require_freeze_renounced", True)),
        min_unique_wallets=int(filters_raw.get("min_unique_wallets", 15)),
        min_unique_wallet_ratio=float(filters_raw.get("min_unique_wallet_ratio", 0.35)),
        lookback_tx_count=int(filters_raw.get("lookback_tx_count", 100)),
    )

    trading_raw = raw.get("trading", {}) or {}
    tp_steps = [
        TakeProfitStep(multiplier=float(s["multiplier"]), sell_pct=float(s["sell_pct"]))
        for s in trading_raw.get("take_profit", [])
    ]
    trading = TradingConfig(
        position_size_sol=float(trading_raw.get("position_size_sol", 0.1)),
        slippage_bps=int(trading_raw.get("slippage_bps", 300)),
        priority_fee_microlamports=int(trading_raw.get("priority_fee_microlamports", 200_000)),
        max_concurrent_positions=int(trading_raw.get("max_concurrent_positions", 3)),
        take_profit=tp_steps,
        stop_loss_pct=float(trading_raw.get("stop_loss_pct", -30.0)),
        price_poll_interval_sec=int(trading_raw.get("price_poll_interval_sec", 5)),
        position_timeout_min=int(trading_raw.get("position_timeout_min", 60)),
    )

    jupiter_raw = raw.get("jupiter", {}) or {}
    jupiter = JupiterConfig(
        quote_url=jupiter_raw.get("quote_url", JupiterConfig.quote_url),
        swap_url=jupiter_raw.get("swap_url", JupiterConfig.swap_url),
        input_mint_sol=jupiter_raw.get("input_mint_sol", JupiterConfig.input_mint_sol),
    )

    storage_raw = raw.get("storage", {}) or {}
    storage = StorageConfig(db_path=storage_raw.get("db_path", "data/trades.db"))

    logging_raw = raw.get("logging", {}) or {}
    logging_cfg = LoggingConfig(
        log_dir=logging_raw.get("log_dir", "logs"),
        level=str(logging_raw.get("level", "INFO")).upper(),
    )

    return AppConfig(
        mode=mode,
        rpc=rpc,
        sources=sources,
        filters=filters,
        trading=trading,
        jupiter=jupiter,
        storage=storage,
        logging=logging_cfg,
    )
