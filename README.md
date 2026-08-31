# OPIUMO Sniper Bot

A Solana new-token filter/sniper bot for Pump.fun and Raydium launches.
Built incrementally, part by part - see **Status** below for what's live,
tested, and safe to run vs. what's implemented but still gated off.

## Non-negotiables (do not change these defaults without reading this)

1. **No auto-execution until you've manually verified the filter logic.**
   `config/default.json -> trading.enabled` defaults to `false`. Buying and
   selling are fully disabled until you flip it by hand.
2. **All tunables live in `config/default.json`**, not in source code:
   position size, take-profit/stop-loss %, and every filter threshold.
   Secrets (RPC URL, private key) live in `.env` (copy from `.env.example`).
3. **Every decision is logged to the console and to `logs/*.jsonl`** so you
   can see exactly what the bot is doing and why, in real time.

## Setup

```bash
npm install
cp .env.example .env   # fill in RPC_URL (and later WALLET_PRIVATE_KEY)
```

## Status

| # | Part | Status | Notes |
|---|------|--------|-------|
| 1 | Solana RPC connection | ✅ built, ⚠️ needs your own live RPC to verify | `npm run test:rpc` |
| 2 | New pool watcher (Pump.fun/Raydium) | ⏳ | |
| 3 | Token metrics (holders, liquidity, dev %, renounced, wallets/volume) | ⏳ | |
| 4 | Filter engine + PASS/SKIP logging (no buying) | ⏳ | |
| 5 | Auto-buy via Jupiter | ⏳ | gated by `trading.enabled` |
| 6 | Auto-sell TP/SL ladder | ⏳ | gated by `trading.enabled` |
| 7 | Trade logging (entry/exit/P&L) | ⏳ | |

Each part has its own `npm run test:<part>` script - run it and read the
console output before trusting that part.

### Part 1: RPC connection

`src/rpc/connection.ts` opens a `Connection` to `RPC_URL` and
`confirmConnection()` calls `getVersion()` + `getSlot()` to prove it's alive.

```bash
npm run test:rpc
```

This sandbox's network egress does not allow reaching Solana RPC hosts
(confirmed: `403 Forbidden: Host not in allowlist`), so this step could only
be verified for correct build/typecheck/error-handling here - **you need to
run `npm run test:rpc` yourself** against your real RPC endpoint (Helius,
QuickNode, Triton, or even the public endpoint for a first smoke test)
before moving on.
