"""
Core feature #3: for a freshly detected token, pull the on-chain and
market data the filters need:

  - top holder %          (largest non-pool wallet's share of supply)
  - liquidity size         (SOL locked against the token, via DexScreener)
  - dev wallet holding %   (creator's share of supply)
  - mint/freeze renounced  (on-chain mint account authorities)
  - unique wallets vs. tx volume (wash-trading / fake-volume signal)

Data sources
------------
On-chain ground truth (holder balances, mint/freeze authority, recent
signatures) comes straight from RPC calls — exact, but rate-limited by
your provider. Liquidity comes from DexScreener's free public API, which
converts "which pool holds how much SOL" into one clean number without
us having to hand-decode bonding-curve/AMM account layouts; a very fresh
token may not be indexed there yet, in which case liquidity comes back
as None and `data_complete` is False (see comments below) rather than a
guessed value.
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field

import aiohttp
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Commitment
from solders.pubkey import Pubkey
from solders.rpc.config import RpcTokenAccountsFilterMint

from src.config import FiltersConfig
from src.dex_programs import WRAPPED_SOL_MINT
from src.logging_setup import get_logger

log = get_logger("token_info")

DEXSCREENER_TOKEN_URL = "https://api.dexscreener.com/latest/dex/tokens/{mint}"

# A single holder owning more than this share of supply is assumed to be
# the pool/bonding-curve reserve rather than a real "top holder" for rug
# purposes (Pump.fun bonding curves routinely hold >70-80% of supply
# pre-migration; that's normal, not a red flag). We exclude it and use
# the next-largest holder instead.
_POOL_RESERVE_HEURISTIC_PCT = 50.0

_TX_FETCH_CONCURRENCY = 10


@dataclass
class TokenMetrics:
    mint: str
    top_holder_pct: float | None = None
    liquidity_sol: float | None = None
    dev_holder_pct: float | None = None
    mint_renounced: bool | None = None
    freeze_renounced: bool | None = None
    unique_wallets: int | None = None
    tx_sample_count: int | None = None
    unique_wallet_ratio: float | None = None
    fetched_at: float = field(default_factory=time.time)
    errors: list[str] = field(default_factory=list)

    @property
    def data_complete(self) -> bool:
        return not self.errors and None not in (
            self.top_holder_pct,
            self.liquidity_sol,
            self.dev_holder_pct,
            self.mint_renounced,
            self.freeze_renounced,
            self.unique_wallets,
            self.unique_wallet_ratio,
        )


class TokenInfoService:
    def __init__(self, rpc_client: AsyncClient, commitment: Commitment, http_session: aiohttp.ClientSession, filters: FiltersConfig):
        self.rpc = rpc_client
        self.commitment = commitment
        self.http = http_session
        self.filters = filters

    async def gather(self, mint: str, creator: str | None) -> TokenMetrics:
        metrics = TokenMetrics(mint=mint)
        mint_pubkey = Pubkey.from_string(mint)

        results = await asyncio.gather(
            self._fetch_supply_and_holders(mint_pubkey, metrics),
            self._fetch_authorities(mint_pubkey, metrics),
            self._fetch_liquidity(mint, metrics),
            self._fetch_wallet_stats(mint_pubkey, metrics),
            return_exceptions=True,
        )
        for r in results:
            if isinstance(r, Exception):
                metrics.errors.append(str(r))
                log.debug("token_info gather sub-task failed for %s: %s", mint, r)

        if creator:
            try:
                await self._fetch_dev_holding(mint_pubkey, creator, metrics)
            except Exception as exc:
                metrics.errors.append(f"dev_holding: {exc}")
        else:
            metrics.errors.append("dev_holding: creator wallet unknown (extraction failed)")

        return metrics

    async def _fetch_supply_and_holders(self, mint_pubkey: Pubkey, metrics: TokenMetrics) -> None:
        supply_resp = await self.rpc.get_token_supply(mint_pubkey, commitment=self.commitment)
        supply = supply_resp.value
        total_ui = float(supply.ui_amount_string or supply.ui_amount or 0)
        if total_ui <= 0:
            metrics.errors.append("supply: total supply is zero")
            return

        largest_resp = await self.rpc.get_token_largest_accounts(mint_pubkey, commitment=self.commitment)
        accounts = largest_resp.value or []
        if not accounts:
            metrics.errors.append("holders: no token accounts returned")
            return

        amounts_ui = sorted(
            (float(a.amount.ui_amount_string or a.amount.ui_amount or 0) for a in accounts), reverse=True
        )
        top = amounts_ui[0]
        top_pct = (top / total_ui) * 100
        if top_pct > _POOL_RESERVE_HEURISTIC_PCT and len(amounts_ui) > 1:
            # Almost certainly the bonding curve / AMM vault, not a wallet.
            top_pct = (amounts_ui[1] / total_ui) * 100

        metrics.top_holder_pct = round(top_pct, 3)

    async def _fetch_authorities(self, mint_pubkey: Pubkey, metrics: TokenMetrics) -> None:
        resp = await self.rpc.get_account_info_json_parsed(mint_pubkey, commitment=self.commitment)
        value = resp.value
        if value is None:
            metrics.errors.append("authorities: mint account not found")
            return
        try:
            info = value.data.parsed["info"]
        except Exception:
            metrics.errors.append("authorities: could not parse mint account data")
            return
        metrics.mint_renounced = info.get("mintAuthority") is None
        metrics.freeze_renounced = info.get("freezeAuthority") is None

    async def _fetch_dev_holding(self, mint_pubkey: Pubkey, creator: str, metrics: TokenMetrics) -> None:
        supply_resp = await self.rpc.get_token_supply(mint_pubkey, commitment=self.commitment)
        total_ui = float(supply_resp.value.ui_amount_string or supply_resp.value.ui_amount or 0)
        if total_ui <= 0:
            return

        creator_pubkey = Pubkey.from_string(creator)
        resp = await self.rpc.get_token_accounts_by_owner_json_parsed(
            creator_pubkey,
            RpcTokenAccountsFilterMint(mint_pubkey),
            commitment=self.commitment,
        )
        held = 0.0
        for acc in resp.value or []:
            try:
                info = acc.account.data.parsed["info"]
                held += float(info["tokenAmount"]["uiAmount"] or 0)
            except Exception:
                continue
        metrics.dev_holder_pct = round((held / total_ui) * 100, 3)

    async def _fetch_liquidity(self, mint: str, metrics: TokenMetrics) -> None:
        url = DEXSCREENER_TOKEN_URL.format(mint=mint)
        try:
            async with self.http.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    metrics.errors.append(f"liquidity: dexscreener HTTP {resp.status}")
                    return
                data = await resp.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError) as exc:
            metrics.errors.append(f"liquidity: dexscreener request failed ({exc})")
            return

        pairs = data.get("pairs") or []
        wsol = str(WRAPPED_SOL_MINT)
        best_sol_liq = None
        for pair in pairs:
            liq = pair.get("liquidity") or {}
            base = pair.get("baseToken") or {}
            quote = pair.get("quoteToken") or {}
            sol_side_amount = None
            if quote.get("address") == wsol:
                sol_side_amount = liq.get("quote")
            elif base.get("address") == wsol:
                sol_side_amount = liq.get("base")
            if sol_side_amount is None:
                continue
            sol_side_amount = float(sol_side_amount)
            if best_sol_liq is None or sol_side_amount > best_sol_liq:
                best_sol_liq = sol_side_amount

        if best_sol_liq is None:
            # Not indexed yet, or not paired against SOL. Leave as unknown
            # rather than guess — filters.py treats unknown liquidity as
            # a SKIP with a clear reason.
            metrics.errors.append("liquidity: not yet indexed by DexScreener")
            return

        metrics.liquidity_sol = round(best_sol_liq, 4)

    async def _fetch_wallet_stats(self, mint_pubkey: Pubkey, metrics: TokenMetrics) -> None:
        limit = max(1, self.filters.lookback_tx_count)
        sigs_resp = await self.rpc.get_signatures_for_address(mint_pubkey, limit=limit, commitment=self.commitment)
        sig_infos = sigs_resp.value or []
        if not sig_infos:
            metrics.unique_wallets = 0
            metrics.tx_sample_count = 0
            metrics.unique_wallet_ratio = 0.0
            return

        semaphore = asyncio.Semaphore(_TX_FETCH_CONCURRENCY)

        async def fetch_fee_payer(sig_str: str) -> str | None:
            from solders.signature import Signature
            async with semaphore:
                try:
                    tx_resp = await self.rpc.get_transaction(
                        Signature.from_string(sig_str),
                        encoding="json",
                        max_supported_transaction_version=0,
                        commitment=self.commitment,
                    )
                except Exception:
                    return None
            value = tx_resp.value
            if value is None:
                return None
            try:
                return str(value.transaction.transaction.message.account_keys[0])
            except Exception:
                return None

        fee_payers = await asyncio.gather(*(fetch_fee_payer(str(s.signature)) for s in sig_infos))
        successful = [p for p in fee_payers if p is not None]
        unique = set(successful)

        metrics.tx_sample_count = len(sig_infos)
        metrics.unique_wallets = len(unique)
        metrics.unique_wallet_ratio = round(len(unique) / len(sig_infos), 3) if sig_infos else 0.0
