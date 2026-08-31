"""
The live-trading interlock.

Non-negotiable: this bot must never place a real trade until it has been
explicitly, deliberately armed for live trading. That requires ALL THREE
of the following to be true at once — any one of them missing keeps the
bot in scan-only (log PASS/SKIP, no orders) mode:

  1. config.yaml has `mode: "live"`
  2. the process was started with the `--live` CLI flag
  3. the environment variable CONFIRM_LIVE_TRADING is exactly "YES"

This is intentionally redundant. A stray config edit, a copy-pasted
launch command, or a leftover env var from a previous run should never
be enough, on its own, to start spending real SOL.
"""
from __future__ import annotations

import os

from src.config import AppConfig
from src.logging_setup import get_logger

log = get_logger("safety")

CONFIRM_ENV_VAR = "CONFIRM_LIVE_TRADING"
CONFIRM_ENV_VALUE = "YES"


def live_trading_armed(config: AppConfig, cli_live_flag: bool) -> bool:
    checks = {
        "config.yaml mode == 'live'": config.is_live_mode,
        "--live CLI flag passed": cli_live_flag,
        f"{CONFIRM_ENV_VAR}={CONFIRM_ENV_VALUE}": os.environ.get(CONFIRM_ENV_VAR) == CONFIRM_ENV_VALUE,
    }
    armed = all(checks.values())

    if armed:
        log.warning(
            "[bold red]LIVE TRADING ARMED[/bold red] — real orders will be placed with real funds."
        )
    else:
        missing = [name for name, ok in checks.items() if not ok]
        log.info(
            "[bold green]Scan-only mode[/bold green] (no trades will be placed). "
            "To enable live trading, all of these must hold: %s. Currently missing: %s",
            ", ".join(checks.keys()),
            ", ".join(missing) if missing else "none",
        )
    return armed
