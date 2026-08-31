"""
Well-known Solana program IDs this bot watches for new-token/new-pool
activity, plus a couple of system constants.
"""
from __future__ import annotations

from solders.pubkey import Pubkey

# Pump.fun bonding-curve program (where the vast majority of Solana meme
# coins are first created/traded before any migrate to Raydium).
PUMP_FUN_PROGRAM_ID = Pubkey.from_string("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")

# Raydium AMM V4 program (classic liquidity-pool creation).
RAYDIUM_AMM_V4_PROGRAM_ID = Pubkey.from_string("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")

# Native SOL "mint" address as used by Jupiter/most Solana tooling.
WRAPPED_SOL_MINT = Pubkey.from_string("So11111111111111111111111111111111111111112")

# SPL Token program.
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

# Log strings that indicate a brand-new token/pool creation event, per
# source. These are matched against the `logs` array returned by
# `logsSubscribe`/`getTransaction`. Pump.fun and Raydium both emit a
# recognizable "Instruction: X" line for their create-style instructions.
PUMPFUN_CREATE_LOG_MARKERS = (
    "Program log: Instruction: Create",
)
RAYDIUM_INIT_LOG_MARKERS = (
    "Program log: initialize2",
    "Program log: Instruction: Initialize2",
)
