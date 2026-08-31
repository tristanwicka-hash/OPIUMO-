#!/usr/bin/env python3
"""
OPIUMO — Solana meme-coin sniper/scalper bot.

Pipeline: connect to RPC -> watch Pump.fun/Raydium for new launches ->
pull each token's safety/quality metrics -> filter -> log PASS/SKIP ->
(only if explicitly armed for live trading) buy PASS tokens and manage
them with the take-profit/stop-loss ladder until closed.

Usage:
    python main.py                 # scan-only: detect, evaluate, log. No trades. (default & safe)
    python main.py --live          # also required: config mode: "live" AND
                                    # CONFIRM_LIVE_TRADING=YES in the environment.
                                    # See src/safety.py and .env.example.

Config: config/config.yaml (thresholds, position size, TP/SL, everything
tunable). Secrets: .env (see .env.example) — never hardcoded.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

import aiohttp

from src.config import ConfigError, load_config
from src.filters import FilterEngine
from src.jupiter import JupiterClient
from src.logging_setup import get_logger, setup_logging
from src.monitor import NewTokenEvent, TokenLaunchMonitor
from src.rpc_client import RpcConnectionError, SolanaRpc
from src.safety import live_trading_armed
from src.storage import TradeStore
from src.token_info import TokenInfoService
from src.trader import Trader
from src.wallet import WalletError, load_wallet, public_key_str

log = get_logger("main")

EVALUATION_WORKERS = 3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OPIUMO Solana meme-coin sniper/scalper bot")
    parser.add_argument("--config", default="config/config.yaml", help="Path to config.yaml")
    parser.add_argument("--env", default=".env", help="Path to .env")
    parser.add_argument(
        "--live",
        action="store_true",
        help=(
            "Enable real trading. Also requires config mode: \"live\" and "
            "CONFIRM_LIVE_TRADING=YES in the environment — see .env.example. "
            "Without ALL three, the bot stays in scan-only mode no matter what."
        ),
    )
    return parser.parse_args()


async def evaluation_worker(
    worker_id: int,
    queue: "asyncio.Queue[NewTokenEvent]",
    token_info: TokenInfoService,
    filter_engine: FilterEngine,
    trader: Trader | None,
    live_armed: bool,
) -> None:
    while True:
        event = await queue.get()
        try:
            await evaluate_one(event, token_info, filter_engine, trader, live_armed)
        except Exception as exc:
            log.error("Worker %d: unhandled error evaluating %s: %s", worker_id, event.mint, exc)
        finally:
            queue.task_done()


async def evaluate_one(
    event: NewTokenEvent,
    token_info: TokenInfoService,
    filter_engine: FilterEngine,
    trader: Trader | None,
    live_armed: bool,
) -> None:
    metrics = await token_info.gather(event.mint, event.creator)
    result = filter_engine.evaluate(metrics)

    if result.passed:
        log.info(
            "[bold green]PASS[/bold green] %s (%s) | liquidity=%.2f SOL top_holder=%.2f%% "
            "dev_holder=%.2f%% mint_renounced=%s freeze_renounced=%s unique_wallets=%s "
            "wallet_ratio=%.2f",
            event.mint, event.source,
            metrics.liquidity_sol or 0.0, metrics.top_holder_pct or 0.0, metrics.dev_holder_pct or 0.0,
            metrics.mint_renounced, metrics.freeze_renounced,
            metrics.unique_wallets, metrics.unique_wallet_ratio or 0.0,
        )
        if live_armed and trader is not None:
            await trader.buy(event)
    else:
        log.info(
            "[yellow]SKIP[/yellow] %s (%s) | %s",
            event.mint, event.source, "; ".join(result.reasons),
        )


async def async_main() -> None:
    args = parse_args()

    try:
        config = load_config(args.config, args.env)
    except ConfigError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        sys.exit(1)

    setup_logging(config.logging.log_dir, config.logging.level)
    log.info("[bold]OPIUMO sniper bot starting[/bold] (config mode=%s)", config.mode)

    live_armed = live_trading_armed(config, args.live)

    rpc = SolanaRpc(config.rpc)
    try:
        await rpc.connect_and_verify()
    except RpcConnectionError as exc:
        log.error(str(exc))
        sys.exit(1)

    keypair = None
    store: TradeStore | None = None
    if live_armed:
        try:
            keypair = load_wallet()
        except WalletError as exc:
            log.error(str(exc))
            await rpc.close()
            sys.exit(1)
        log.info("Trading wallet: [bold]%s[/bold]", public_key_str(keypair))
        store = TradeStore(config.storage.db_path)
        log.info("Trade log: %s", config.storage.db_path)

    async with aiohttp.ClientSession() as http_session:
        token_info = TokenInfoService(rpc.client, rpc.commitment, http_session, config.filters)
        filter_engine = FilterEngine(config.filters)
        jupiter = JupiterClient(http_session, config.jupiter)

        trader: Trader | None = None
        if live_armed and keypair is not None and store is not None:
            trader = Trader(config, rpc.client, rpc.commitment, jupiter, keypair, store)

        queue: "asyncio.Queue[NewTokenEvent]" = asyncio.Queue()
        monitor = TokenLaunchMonitor(config.rpc.ws_url, rpc.client, config.sources, rpc.commitment)

        tasks = [asyncio.create_task(monitor.run(queue), name="monitor")]
        for i in range(EVALUATION_WORKERS):
            tasks.append(asyncio.create_task(
                evaluation_worker(i, queue, token_info, filter_engine, trader, live_armed),
                name=f"eval-worker-{i}",
            ))
        if trader is not None:
            tasks.append(asyncio.create_task(trader.manage_positions_forever(), name="position-manager"))

        log.info("Watching for new launches (pumpfun=%s, raydium=%s)...",
                  config.sources.watch_pumpfun, config.sources.watch_raydium)

        try:
            await asyncio.gather(*tasks)
        finally:
            for t in tasks:
                t.cancel()
            if store is not None:
                store.close()
            await rpc.close()


def main() -> None:
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
