"""
Core features #5/#6: buy/sell execution via the Jupiter Aggregator swap
API (https://station.jup.ag/docs/apis/swap-api).

Flow for every swap:
  1. GET  {quote_url}   -> best route + expected output for the trade
  2. POST {swap_url}    -> an unsigned, ready-to-send transaction for
                            that exact route
  3. sign the transaction with our wallet and broadcast it via our own
     RPC connection, then confirm it.

This module never decides *whether* to trade — trader.py does that and
calls in here only once a buy/sell has already been approved. Nothing
here reads config beyond the numeric values it's handed as arguments,
which keeps position size / slippage / priority fee fully controlled by
config.yaml (see trading: in config.yaml).
"""
from __future__ import annotations

import base64
from dataclasses import dataclass

import aiohttp
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Commitment
from solders.keypair import Keypair
from solders.rpc.config import RpcSendTransactionConfig
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from src.config import JupiterConfig
from src.logging_setup import get_logger

log = get_logger("jupiter")


class JupiterError(RuntimeError):
    pass


@dataclass
class SwapQuote:
    input_mint: str
    output_mint: str
    in_amount: int          # raw smallest-unit amount in
    out_amount: int         # raw smallest-unit amount out (expected)
    price_impact_pct: float
    raw: dict                # full Jupiter quote response, needed for /swap


@dataclass
class SwapResult:
    signature: str
    in_amount: int
    out_amount: int


class JupiterClient:
    def __init__(self, http_session: aiohttp.ClientSession, config: JupiterConfig):
        self.http = http_session
        self.config = config

    async def get_quote(self, input_mint: str, output_mint: str, amount: int, slippage_bps: int) -> SwapQuote:
        params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount),
            "slippageBps": str(slippage_bps),
        }
        async with self.http.get(
            self.config.quote_url, params=params, timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            body = await resp.json(content_type=None)
            if resp.status != 200:
                raise JupiterError(f"quote request failed ({resp.status}): {body}")

        try:
            return SwapQuote(
                input_mint=input_mint,
                output_mint=output_mint,
                in_amount=int(body["inAmount"]),
                out_amount=int(body["outAmount"]),
                price_impact_pct=float(body.get("priceImpactPct", 0) or 0),
                raw=body,
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise JupiterError(f"unexpected quote response shape: {body}") from exc

    async def get_swap_transaction(
        self, quote: SwapQuote, user_pubkey: str, priority_fee_microlamports: int
    ) -> str:
        payload = {
            "quoteResponse": quote.raw,
            "userPublicKey": user_pubkey,
            "wrapAndUnwrapSol": True,
            "dynamicComputeUnitLimit": True,
            "prioritizationFeeLamports": {
                "priorityLevelWithMaxLamports": {
                    "priorityLevel": "high",
                    "maxLamports": priority_fee_microlamports,
                }
            },
        }
        async with self.http.post(
            self.config.swap_url, json=payload, timeout=aiohttp.ClientTimeout(total=15)
        ) as resp:
            body = await resp.json(content_type=None)
            if resp.status != 200:
                raise JupiterError(f"swap-transaction request failed ({resp.status}): {body}")

        tx_b64 = body.get("swapTransaction")
        if not tx_b64:
            raise JupiterError(f"swap response missing swapTransaction: {body}")
        return tx_b64


async def sign_and_send_swap(
    tx_b64: str,
    keypair: Keypair,
    rpc_client: AsyncClient,
    commitment: Commitment,
) -> str:
    """Deserialize a Jupiter swap transaction, sign it with our wallet
    (the only required signer for a standard Jupiter swap), broadcast it,
    and wait for confirmation. Returns the transaction signature."""
    raw_tx = VersionedTransaction.from_bytes(base64.b64decode(tx_b64))
    signed_tx = VersionedTransaction(raw_tx.message, [keypair])

    send_resp = await rpc_client.send_raw_transaction(
        bytes(signed_tx),
        opts=RpcSendTransactionConfig(skip_preflight=False, max_retries=3),
    )
    signature: Signature = send_resp.value
    log.info("Swap transaction sent: %s", signature)

    await rpc_client.confirm_transaction(signature, commitment=commitment)
    return str(signature)


async def execute_swap(
    jupiter: JupiterClient,
    rpc_client: AsyncClient,
    keypair: Keypair,
    commitment: Commitment,
    input_mint: str,
    output_mint: str,
    amount: int,
    slippage_bps: int,
    priority_fee_microlamports: int,
) -> SwapResult:
    """Quote, build, sign, send, and confirm one swap. Raises JupiterError
    or an RPC exception on failure — callers must handle both, a failed
    swap must never be silently treated as a successful trade."""
    quote = await jupiter.get_quote(input_mint, output_mint, amount, slippage_bps)
    tx_b64 = await jupiter.get_swap_transaction(quote, str(keypair.pubkey()), priority_fee_microlamports)
    signature = await sign_and_send_swap(tx_b64, keypair, rpc_client, commitment)
    return SwapResult(signature=signature, in_amount=quote.in_amount, out_amount=quote.out_amount)
