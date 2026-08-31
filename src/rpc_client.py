"""
Thin wrapper around the async Solana RPC client: connect, verify the
connection is healthy, and expose the commitment level configured by the
user. This is core feature #1 — everything else depends on this working.
"""
from __future__ import annotations

from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Commitment

from src.config import RpcConfig
from src.logging_setup import get_logger

log = get_logger("rpc")

_COMMITMENT_MAP = {
    "processed": Commitment("processed"),
    "confirmed": Commitment("confirmed"),
    "finalized": Commitment("finalized"),
}


class RpcConnectionError(RuntimeError):
    pass


class SolanaRpc:
    """Owns the AsyncClient and a couple of connection-health helpers."""

    def __init__(self, config: RpcConfig):
        self.config = config
        self.commitment = _COMMITMENT_MAP.get(config.commitment, Commitment("confirmed"))
        self.client = AsyncClient(
            config.http_url,
            commitment=self.commitment,
            timeout=config.request_timeout_sec,
        )

    async def connect_and_verify(self) -> None:
        """
        Confirm the RPC endpoint is reachable and serving requests. Raises
        RpcConnectionError with a clear message if not — fail fast rather
        than silently limping along with a dead endpoint.
        """
        try:
            connected = await self.client.is_connected()
        except Exception as exc:
            raise RpcConnectionError(
                f"Could not reach Solana RPC at {self.config.http_url!r}: {exc}"
            ) from exc

        if not connected:
            raise RpcConnectionError(
                f"Solana RPC at {self.config.http_url!r} responded but reported unhealthy."
            )

        try:
            version_resp = await self.client.get_version()
            slot_resp = await self.client.get_slot(commitment=self.commitment)
        except Exception as exc:
            raise RpcConnectionError(f"RPC connected but a follow-up call failed: {exc}") from exc

        version = getattr(version_resp.value, "solana_core", "unknown")
        slot = slot_resp.value
        log.info(
            "[bold green]RPC connected[/bold green]: %s (validator core %s, slot %s)",
            self.config.http_url,
            version,
            slot,
        )

    async def close(self) -> None:
        await self.client.close()
