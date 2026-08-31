# OPIUMO — Solana Meme Coin Sniper / Scalper Bot

Watches Solana for new Pump.fun / Raydium token launches in real time,
scores each one against configurable safety/quality filters, logs a
PASS/SKIP verdict with the reason, and — **only once explicitly armed for
live trading** — auto-buys tokens that PASS and manages them with a
take-profit/stop-loss ladder until the position is fully closed. Every
fill is written to a local SQLite trade log.

## Safety model (read this first)

The bot ships in **scan-only mode by default**: it connects, watches,
evaluates, and logs PASS/SKIP — it never places an order. To place real
trades, **all three** of the following must be true at once:

1. `config/config.yaml` has `mode: "live"`
2. the process is started with `python main.py --live`
3. the environment variable `CONFIRM_LIVE_TRADING=YES` is set (in `.env`)

Any one missing keeps it in scan-only mode. This is deliberate and
redundant on purpose — see `src/safety.py`. **Stay in scan mode until
you've manually reviewed PASS/SKIP output against tokens you already
know the story of, and are confident the filter logic is doing what you
expect.**

Your wallet's private key is read only from the `WALLET_PRIVATE_KEY`
environment variable (`src/wallet.py`) — it is never hardcoded, logged,
or written anywhere. Use a **dedicated hot wallet** funded only with
what you're willing to risk; never point this at a wallet holding other
funds.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# edit .env:
#   - SOLANA_RPC_HTTP_URL / SOLANA_RPC_WS_URL: a Helius or QuickNode
#     endpoint. Public RPCs rate-limit and drop websocket subscriptions
#     under real load, so use a paid/private one for anything beyond
#     quick testing.
#   - WALLET_PRIVATE_KEY: only needed once you move to --live.
#   - CONFIRM_LIVE_TRADING: leave blank until you're ready to go live.
```

Run in scan-only mode (safe, default):

```bash
python main.py
```

You'll see console output like:

```
INFO  RPC connected: https://mainnet.helius-rpc.com/... (validator core 1.18.x, slot 301...)
INFO  Scan-only mode (no trades will be placed). ...
INFO  Watching for new launches (pumpfun=True, raydium=True)...
INFO  New pumpfun launch detected: mint=... sig=...
INFO  PASS 7xKX...pump (pumpfun) | liquidity=6.40 SOL top_holder=9.10% dev_holder=2.30% ...
INFO  SKIP 3fQz...pump (pumpfun) | liquidity 1.20 SOL < min 5.00 SOL; top holder 41.00% > max 15.00%
```

Once you've validated the filter output, enable live trading:

```bash
python main.py --live
```

## Configuration

Everything tunable lives in `config/config.yaml` — filter thresholds,
position size, slippage, take-profit ladder, stop-loss %, poll
intervals — fully documented inline there. Nothing that affects trading
behavior is buried in Python code. Secrets live only in `.env`.

Key sections:

- `filters:` — the PASS/SKIP thresholds (liquidity, top-holder %,
  dev-holder %, renounced mint/freeze authority, unique-wallet count and
  ratio).
- `trading:` — position size in SOL, slippage, priority fee, the
  take-profit ladder (`multiplier` / `sell_pct` steps, evaluated against
  the *current remaining* position size), stop-loss %, and an optional
  timeout exit.

## Architecture

```
main.py                  entrypoint: wiring, CLI args, graceful shutdown
config/config.yaml        all tunable thresholds/parameters
.env                       secrets (RPC URLs, wallet key, live-trading confirm)

src/config.py              loads + validates config.yaml/.env into typed objects
src/wallet.py               loads the trading Keypair from WALLET_PRIVATE_KEY
src/rpc_client.py           connects to Solana RPC, verifies health          (feature 1)
src/dex_programs.py         Pump.fun / Raydium program IDs + log markers
src/monitor.py              websocket log-subscription watcher -> NewTokenEvent (feature 2)
src/token_info.py           pulls holder %, liquidity, dev %, renounced, wallet stats (feature 3)
src/filters.py              PASS/SKIP decision engine with reasons           (feature 4)
src/jupiter.py               Jupiter quote/swap API client + sign & send      (feature 5/6)
src/trader.py                buy + take-profit/stop-loss position management (feature 5/6)
src/storage.py               SQLite position + trade log                     (feature 7)
src/safety.py                the live-trading interlock
src/logging_setup.py         console (rich) + rotating file logging
```

Data flow: `monitor.py` pushes a `NewTokenEvent` onto a queue for every
detected launch → a small worker pool calls `token_info.gather()` to
pull its metrics → `filters.py` evaluates them and logs PASS/SKIP → if
PASS and live trading is armed, `trader.buy()` executes the swap and
opens a position → a background loop in `trader.py` re-quotes each open
position on an interval and fires TP/SL/timeout exits → every fill is
recorded via `storage.py`.

## Known limitations / accuracy notes

This is a working scaffold, not a black-box guarantee — a few pieces are
documented best-effort heuristics rather than exact science, called out
in code comments where they occur:

- **Mint extraction** (`src/monitor.py`): pulling the new mint address
  out of a Pump.fun/Raydium transaction is done via known account
  positions / balance diffing rather than a full Anchor IDL decode. If
  either program ships a new instruction layout, extraction can start
  failing (logged as a debug-level "could not extract mint" line). For
  production-grade parsing, consider Helius's Enhanced Transactions API.
- **Top-holder %** (`src/token_info.py`): a single holder owning >50% of
  supply is assumed to be the pool/bonding-curve reserve (normal for a
  pre-migration Pump.fun token) and excluded in favor of the next
  largest holder. This is a heuristic, not an on-chain label.
- **Liquidity** comes from DexScreener's public API rather than manual
  bonding-curve/AMM account decoding. A token only seconds old may not
  be indexed yet — in that case liquidity comes back unknown and the
  token is SKIPped with that reason, not guessed.
- **Unique wallet / tx-volume stats** sample the `lookback_tx_count`
  most recent signatures touching the mint and fetch each transaction to
  find its fee payer. This costs one RPC call per sampled transaction —
  tune `lookback_tx_count` in config for your RPC provider's rate limits.

## Trade log

Every buy and every partial/full sell is written to the SQLite database
at `storage.db_path` (default `data/trades.db`) — `positions` (one row
per position) and `trades` (one row per fill, with entry/exit price,
reason, and P&L). Inspect it with any SQLite tool, e.g.:

```bash
sqlite3 data/trades.db "select mint, side, reason, amount_tokens, price_sol, pnl_sol, pnl_pct from trades order by executed_at;"
```
