"""
Core feature #2: watch for new token / liquidity-pool creation on
Pump.fun and/or Raydium via websocket log subscriptions, and turn matching
transactions into NewTokenEvent objects for the rest of the pipeline.

How it works
------------
`logsSubscribe` with a "mentions" filter gives us a live stream of every
transaction that touches a given program, including its log lines, as
soon as it's confirmed. We watch for the specific "Instruction: Create"
(Pump.fun) / "initialize2" (Raydium AMM v4) log lines that mark a brand
new token or pool, then fetch the full transaction to pull out the mint
address.

Accuracy note
-------------
Pulling the mint out of a transaction without a full Anchor IDL decoder
is inherently a best-effort heuristic (see `_extract_pumpfun_mint` /
`_extract_raydium_mint` below): we read it from the instruction's account
list by known index, and fall back to diffing pre/post token balances.
Account ordering can change if Pump.fun/Raydium ship a new program
version. If you see PARSE_FAILED events spike, check whether the
program's instruction layout has changed. For production-grade accuracy
consider Helius's Enhanced Transactions API, which returns pre-decoded
instructions instead of raw account indices.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Commitment
from solana.rpc.websocket_api import RpcTransactionLogsFilterMentions, connect
from solders.pubkey import Pubkey
from solders.signature import Signature

from src.config import SourcesConfig
from src.dex_programs import (
    PUMP_FUN_PROGRAM_ID,
    PUMPFUN_CREATE_LOG_MARKERS,
    RAYDIUM_AMM_V4_PROGRAM_ID,
    RAYDIUM_INIT_LOG_MARKERS,
    WRAPPED_SOL_MINT,
)
from src.logging_setup import get_logger

log = get_logger("monitor")

SOURCE_PUMPFUN = "pumpfun"
SOURCE_RAYDIUM = "raydium"


@dataclass
class NewTokenEvent:
    mint: str
    source: str  # "pumpfun" | "raydium"
    signature: str
    creator: str | None
    detected_at: float


def _logs_contain_any(logs: list[str], markers: tuple[str, ...]) -> bool:
    return any(marker in line for line in logs for marker in markers) if logs else False


def _pre_post_mint_diff(tx_value) -> set[str]:
    """Mints that appear in postTokenBalances but not preTokenBalances."""
    meta = getattr(tx_value, "meta", None)
    if meta is None:
        return set()
    pre = {b.mint.__str__() for b in (meta.pre_token_balances or [])}
    post = {b.mint.__str__() for b in (meta.post_token_balances or [])}
    return post - pre


def _find_program_instructions(tx_value, program_id: Pubkey) -> list:
    """
    With encoding=jsonParsed, instructions belonging to a program the RPC
    node doesn't natively recognize (true for Pump.fun and Raydium) come
    back as UiPartiallyDecodedInstruction, whose `accounts` field is
    already a list of Pubkeys (not indices into account_keys) — so no
    account-key table lookup is needed.
    """
    try:
        message = tx_value.transaction.transaction.message
    except AttributeError:
        return []
    matches = []
    for ix in getattr(message, "instructions", None) or []:
        if str(getattr(ix, "program_id", "")) == str(program_id):
            matches.append(ix)
    return matches


def _extract_pumpfun_mint(tx_value, signature: str) -> tuple[str | None, str | None]:
    """Best-effort (mint, creator) extraction for a Pump.fun Create tx."""
    try:
        for ix in _find_program_instructions(tx_value, PUMP_FUN_PROGRAM_ID):
            accounts = getattr(ix, "accounts", None)
            if accounts and len(accounts) >= 8:
                return str(accounts[0]), str(accounts[7])
    except Exception as exc:
        log.debug("pumpfun account extraction failed for %s: %s", signature, exc)

    diff = _pre_post_mint_diff(tx_value)
    if len(diff) == 1:
        return next(iter(diff)), None
    return None, None


def _extract_raydium_mint(tx_value, signature: str) -> tuple[str | None, str | None]:
    """Best-effort new-mint extraction for a Raydium initialize2 tx: the
    non-SOL mint among the pool's token balances."""
    diff = _pre_post_mint_diff(tx_value)
    candidates = diff - {str(WRAPPED_SOL_MINT)}
    if len(candidates) == 1:
        return next(iter(candidates)), None
    if len(candidates) > 1:
        log.debug("raydium tx %s has ambiguous mint candidates: %s", signature, candidates)
    return None, None


class TokenLaunchMonitor:
    """Watches configured sources and pushes NewTokenEvent onto a queue."""

    def __init__(self, ws_url: str, http_client: AsyncClient, sources: SourcesConfig, commitment: Commitment):
        self.ws_url = ws_url
        self.http_client = http_client
        self.sources = sources
        self.commitment = commitment
        self._seen_signatures: set[str] = set()
        self._seen_max = 5000  # bound memory; oldest entries dropped via simple reset

    async def run(self, out_queue: "asyncio.Queue[NewTokenEvent]") -> None:
        tasks = []
        if self.sources.watch_pumpfun:
            tasks.append(asyncio.create_task(self._watch_program(
                PUMP_FUN_PROGRAM_ID, SOURCE_PUMPFUN, PUMPFUN_CREATE_LOG_MARKERS, out_queue
            )))
        if self.sources.watch_raydium:
            tasks.append(asyncio.create_task(self._watch_program(
                RAYDIUM_AMM_V4_PROGRAM_ID, SOURCE_RAYDIUM, RAYDIUM_INIT_LOG_MARKERS, out_queue
            )))
        if not tasks:
            log.warning("No sources enabled in config (sources.watch_pumpfun / watch_raydium both false).")
            return
        await asyncio.gather(*tasks)

    async def _watch_program(
        self,
        program_id: Pubkey,
        source: str,
        markers: tuple[str, ...],
        out_queue: "asyncio.Queue[NewTokenEvent]",
    ) -> None:
        while True:
            try:
                async with connect(self.ws_url) as ws:
                    await ws.logs_subscribe(
                        RpcTransactionLogsFilterMentions(program_id),
                        commitment=self.commitment,
                    )
                    log.info("Subscribed to %s program logs (%s)", source, program_id)
                    async for messages in ws:
                        for msg in messages:
                            await self._handle_log_notification(msg, source, markers, out_queue)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning(
                    "%s log subscription dropped (%s); reconnecting in %ss",
                    source, exc, self.sources.ws_reconnect_delay_sec,
                )
                await asyncio.sleep(self.sources.ws_reconnect_delay_sec)

    async def _handle_log_notification(self, msg, source: str, markers: tuple[str, ...], out_queue) -> None:
        try:
            result = msg.result
            value = result.value
            logs = list(value.logs or [])
            signature = str(value.signature)
        except AttributeError:
            return

        if value.err is not None:
            return  # failed tx, not a real launch
        if signature in self._seen_signatures:
            return
        if not _logs_contain_any(logs, markers):
            return

        self._seen_signatures.add(signature)
        if len(self._seen_signatures) > self._seen_max:
            self._seen_signatures.clear()

        mint, creator = await self._fetch_and_extract(signature, source)
        if mint is None:
            log.debug("[%s] could not extract mint from tx %s (PARSE_FAILED)", source, signature)
            return

        event = NewTokenEvent(
            mint=mint,
            source=source,
            signature=signature,
            creator=creator,
            detected_at=time.time(),
        )
        log.info("[bold cyan]New %s launch detected[/bold cyan]: mint=%s sig=%s", source, mint, signature)
        await out_queue.put(event)

    async def _fetch_and_extract(self, signature: str, source: str) -> tuple[str | None, str | None]:
        try:
            resp = await self.http_client.get_transaction(
                Signature.from_string(signature),
                encoding="jsonParsed",
                max_supported_transaction_version=0,
                commitment=self.commitment,
            )
        except Exception as exc:
            log.debug("get_transaction failed for %s: %s", signature, exc)
            return None, None

        tx_value = resp.value
        if tx_value is None:
            return None, None

        if source == SOURCE_PUMPFUN:
            return _extract_pumpfun_mint(tx_value, signature)
        return _extract_raydium_mint(tx_value, signature)
