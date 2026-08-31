"""
Core features #5/#6: turns a filter PASS into a real position (buy) and
then manages that position against the configured take-profit/stop-loss
ladder (auto-sell) until it's fully closed. Every fill is written to the
trade log via TradeStore (core feature #7).

This module is only ever reached when safety.live_trading_armed() has
returned True — see main.py. Everything here assumes it is allowed to
spend real SOL.
"""
from __future__ import annotations

import asyncio
import time

from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Commitment
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from src.config import AppConfig
from src.dex_programs import WRAPPED_SOL_MINT
from src.jupiter import JupiterClient, JupiterError, execute_swap
from src.logging_setup import get_logger
from src.monitor import NewTokenEvent
from src.storage import Position, TradeStore

log = get_logger("trader")

LAMPORTS_PER_SOL = 1_000_000_000


def to_raw_amount(ui_amount: float, decimals: int) -> int:
    return int(round(ui_amount * (10 ** decimals)))


def to_ui_amount(raw_amount: int, decimals: int) -> float:
    return raw_amount / (10 ** decimals)


class Trader:
    def __init__(
        self,
        config: AppConfig,
        rpc_client: AsyncClient,
        commitment: Commitment,
        jupiter: JupiterClient,
        keypair: Keypair,
        store: TradeStore,
    ):
        self.config = config
        self.rpc = rpc_client
        self.commitment = commitment
        self.jupiter = jupiter
        self.keypair = keypair
        self.store = store

    async def buy(self, event: NewTokenEvent) -> Position | None:
        open_positions = await self.store.get_open_positions()
        max_positions = self.config.trading.max_concurrent_positions
        if len(open_positions) >= max_positions:
            log.info(
                "Skipping buy for %s: already at max_concurrent_positions (%d)",
                event.mint, max_positions,
            )
            return None

        sol_amount = self.config.trading.position_size_sol
        lamports = to_raw_amount(sol_amount, 9)

        try:
            supply_resp = await self.rpc.get_token_supply(Pubkey.from_string(event.mint), commitment=self.commitment)
            decimals = supply_resp.value.decimals
        except Exception as exc:
            log.error("Could not fetch decimals for %s, aborting buy: %s", event.mint, exc)
            return None

        try:
            result = await execute_swap(
                jupiter=self.jupiter,
                rpc_client=self.rpc,
                keypair=self.keypair,
                commitment=self.commitment,
                input_mint=str(WRAPPED_SOL_MINT),
                output_mint=event.mint,
                amount=lamports,
                slippage_bps=self.config.trading.slippage_bps,
                priority_fee_microlamports=self.config.trading.priority_fee_microlamports,
            )
        except Exception as exc:  # noqa: BLE001 - never let a bad swap look silent
            log.error("[bold red]BUY FAILED[/bold red] for %s: %s", event.mint, exc)
            return None

        entry_amount_tokens = to_ui_amount(result.out_amount, decimals)
        entry_price_sol = sol_amount / entry_amount_tokens if entry_amount_tokens > 0 else 0.0

        position = await self.store.open_position(
            mint=event.mint,
            source=event.source,
            creator=event.creator,
            entry_price_sol=entry_price_sol,
            entry_amount_tokens=entry_amount_tokens,
            sol_spent=sol_amount,
            decimals=decimals,
            buy_signature=result.signature,
        )
        log.info(
            "[bold green]BUY[/bold green] %s: spent %.4f SOL for %.4f tokens "
            "(entry price %.10f SOL/token) sig=%s",
            event.mint, sol_amount, entry_amount_tokens, entry_price_sol, result.signature,
        )
        return position

    async def manage_positions_forever(self) -> None:
        interval = self.config.trading.price_poll_interval_sec
        while True:
            try:
                positions = await self.store.get_open_positions()
                for position in positions:
                    await self._check_position(position)
            except Exception as exc:
                log.error("Error while managing positions: %s", exc)
            await asyncio.sleep(interval)

    async def _check_position(self, position: Position) -> None:
        if position.remaining_tokens <= 0:
            return

        raw_amount = to_raw_amount(position.remaining_tokens, position.decimals)
        if raw_amount <= 0:
            return

        try:
            quote = await self.jupiter.get_quote(
                input_mint=position.mint,
                output_mint=str(WRAPPED_SOL_MINT),
                amount=raw_amount,
                slippage_bps=self.config.trading.slippage_bps,
            )
        except JupiterError as exc:
            log.debug("Price check failed for %s (will retry next poll): %s", position.mint, exc)
            return

        current_value_sol = quote.out_amount / LAMPORTS_PER_SOL
        cost_basis_remaining = position.remaining_tokens * position.entry_price_sol
        if cost_basis_remaining <= 0:
            return
        pct_change = (current_value_sol - cost_basis_remaining) / cost_basis_remaining * 100
        multiplier = current_value_sol / cost_basis_remaining

        log.debug(
            "%s remaining=%.4f value=%.4f SOL (%.1f%%, %.2fx)",
            position.mint, position.remaining_tokens, current_value_sol, pct_change, multiplier,
        )

        # 1) Stop-loss takes priority: full exit.
        if pct_change <= self.config.trading.stop_loss_pct:
            await self._sell(position, position.remaining_tokens, "stop_loss")
            return

        # 2) Take-profit ladder, in configured order, each fired at most once.
        for step in self.config.trading.take_profit:
            if step.multiplier in position.tp_hits:
                continue
            if multiplier >= step.multiplier:
                sell_amount = position.remaining_tokens * (step.sell_pct / 100)
                await self._sell(
                    position, sell_amount, f"take_profit_{step.multiplier}x", tp_multiplier=step.multiplier
                )
                return  # re-evaluate the rest on the next poll with fresh state

        # 3) Optional timeout exit if nothing has fired yet.
        timeout_min = self.config.trading.position_timeout_min
        if timeout_min > 0 and not position.tp_hits:
            age_min = (time.time() - position.entry_time) / 60
            if age_min >= timeout_min:
                await self._sell(position, position.remaining_tokens, "timeout")

    async def _sell(self, position: Position, amount_tokens: float, reason: str, tp_multiplier: float | None = None) -> None:
        amount_tokens = min(amount_tokens, position.remaining_tokens)
        raw_amount = to_raw_amount(amount_tokens, position.decimals)
        if raw_amount <= 0:
            return

        try:
            result = await execute_swap(
                jupiter=self.jupiter,
                rpc_client=self.rpc,
                keypair=self.keypair,
                commitment=self.commitment,
                input_mint=position.mint,
                output_mint=str(WRAPPED_SOL_MINT),
                amount=raw_amount,
                slippage_bps=self.config.trading.slippage_bps,
                priority_fee_microlamports=self.config.trading.priority_fee_microlamports,
            )
        except Exception as exc:  # noqa: BLE001
            log.error("[bold red]SELL FAILED[/bold red] for %s (%s): %s", position.mint, reason, exc)
            return

        sol_received = result.out_amount / LAMPORTS_PER_SOL
        sold_tokens = to_ui_amount(result.in_amount, position.decimals)
        price_sol = sol_received / sold_tokens if sold_tokens > 0 else 0.0

        await self.store.record_sell(
            position=position,
            amount_tokens=sold_tokens,
            price_sol=price_sol,
            sol_received=sol_received,
            reason=reason,
            tx_signature=result.signature,
            tp_multiplier=tp_multiplier,
        )

        cost_basis = sold_tokens * position.entry_price_sol
        pnl_sol = sol_received - cost_basis
        pnl_pct = (pnl_sol / cost_basis * 100) if cost_basis > 0 else 0.0
        color = "green" if pnl_sol >= 0 else "red"
        log.info(
            "[bold %s]SELL[/bold %s] %s (%s): %.4f tokens -> %.4f SOL | P&L %.4f SOL (%.1f%%) sig=%s",
            color, color, position.mint, reason, sold_tokens, sol_received, pnl_sol, pnl_pct, result.signature,
        )
