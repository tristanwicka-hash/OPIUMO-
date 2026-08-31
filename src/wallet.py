"""
Loads the trading wallet's keypair from the WALLET_PRIVATE_KEY environment
variable. The key is NEVER hardcoded, logged, or written anywhere — only
the public key is ever surfaced in logs.

Use a dedicated hot wallet for this bot, funded only with what you are
willing to risk. Do not point this at a wallet holding other funds.
"""
from __future__ import annotations

import os

import base58
from solders.keypair import Keypair


class WalletError(RuntimeError):
    pass


def load_wallet(env_var: str = "WALLET_PRIVATE_KEY") -> Keypair:
    """
    Load a Keypair from a base58-encoded secret key in the given env var
    (the format Phantom/Solflare "export private key" and `solana-keygen`
    produce). Raises WalletError with a helpful message if missing/invalid.
    """
    secret = os.environ.get(env_var, "").strip()
    if not secret:
        raise WalletError(
            f"{env_var} is not set. Put a base58-encoded private key for "
            f"your dedicated trading wallet in .env (see .env.example). "
            f"Never hardcode it in source."
        )
    try:
        raw = base58.b58decode(secret)
    except Exception as exc:
        raise WalletError(f"{env_var} is not valid base58: {exc}") from exc

    try:
        if len(raw) == 64:
            keypair = Keypair.from_bytes(raw)
        elif len(raw) == 32:
            keypair = Keypair.from_seed(raw)
        else:
            raise ValueError(f"unexpected key length {len(raw)} bytes (expected 32 or 64)")
    except Exception as exc:
        raise WalletError(f"Could not construct a Keypair from {env_var}: {exc}") from exc

    return keypair


def public_key_str(keypair: Keypair) -> str:
    return str(keypair.pubkey())
