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
npm test               # runs every test suite (Parts 1-4) - see "Hardening pass" below
```

## Hardening pass (2026-09-01)

After Parts 1-4 were built, they went through a dedicated "what could go
wrong" review (a code-review pass plus a manual sweep of the RPC/watcher/
metrics layers) before any Part 5 work started. Six real issues were found
and fixed - all covered by new/updated tests, all still offline/deterministic
except the Part 1/2 live checks that need your own RPC:

| Issue | Fix |
|---|---|
| A failed renounce-status RPC call was reported identically to a *confirmed* "not renounced" finding - one flaky call could produce a SKIP that looked like a real rug signal | `mintAuthorityRenounced`/`freezeAuthorityRenounced` are now `boolean \| null`; `null` gets its own "unknown (could not fetch...)" reason, matching every other metric |
| Partial-fetch warnings only showed up in `logs/decisions.jsonl`, never on the console line you actually watch live | `formatDecisionLine()` now prints `warnings: ...` under any decision (PASS or SKIP) that has them |
| `polling.metricsMaxAgeMs` / `metricsFetchTimeoutMs` were documented config knobs that no code ever read | every RPC call in `collectTokenMetrics()` is now wrapped in a timeout; collection slower than `metricsMaxAgeMs` sets `metrics.stale = true`, which the filter engine treats as an automatic SKIP |
| Token-2022 mints threw and were silently mistaken for a fetch failure (compounding the first issue above) | `getRenounceStatus()` detects the mint's owning program and decodes with the correct one |
| `PoolWatcher`'s websocket subscription had no reconnect logic - a silent drop meant the bot would just go quiet with no error | added an `onSlotChange` heartbeat + health-check timer; no slot update for `staleConnectionThresholdMs` (default 30s) triggers an automatic unsubscribe/resubscribe |
| A redelivered/duplicated log for the same signature could be processed twice | added a bounded in-memory dedup set keyed by signature |

Also fixed: `npm test` (`tests/run-all.ts`) was referenced in `package.json`
since the very first commit but the file didn't exist - it does now, and
chains all four suites with one combined pass/fail.

**Still open / by design, not fixed** (flagged here rather than silently
left out):
- Raydium `initialize2` account indices (`src/watcher/raydiumWatcher.ts`)
  still need a live spot-check against real Solscan transactions - this needs
  your own RPC access, not something fixable from this sandbox.
- Pump.fun's `liquiditySol` is the bonding curve's *real* SOL balance, not
  the *virtual*-reserve-inclusive number Pump.fun's own UI shows as market
  cap - worth eyeballing against a few live tokens before trusting the
  `minLiquiditySol` threshold as-is.
- `getTopHolderPercent` is capped at the RPC's top-20 accounts
  (`getTokenLargestAccounts`) - a dev who splits their bag across 20+ wallets
  won't be caught. Inherent RPC limitation, not a bug - nothing to fix here.

**Fixed since the table above** (2026-09-01, second pass): log rotation.
`JsonlLog` (`src/util/logger.ts`) now rotates `logs/decisions.jsonl` (and any
other JSONL log) to a timestamped file once it crosses
`logging.maxLogFileSizeMB` (default 20MB), so a long-running bot no longer
grows one unbounded file. Rotated files are never auto-deleted - clean them
up yourself once archived. Covered by `npm run test:logger` (5/5 pass).

## Status

| # | Part | Status | Notes |
|---|------|--------|-------|
| 1 | Solana RPC connection | ✅ built, ⚠️ needs your own live RPC to verify | `npm run test:rpc` |
| 2 | New pool watcher (Pump.fun/Raydium) | ✅ built, ⚠️ account indices need live verification | `npm run test:watcher` |
| 3 | Token metrics (holders, liquidity, dev %, renounced, wallets/volume) | ✅ built + fully unit-tested offline | `npm run test:metrics` |
| 4 | Filter engine + PASS/SKIP logging (no buying) | ✅ built + fully unit-tested offline | `npm run test:filters` |
| 5 | Auto-buy via Jupiter | ⏳ | gated by `trading.enabled` |
| 6 | Auto-sell TP/SL ladder | ⏳ | gated by `trading.enabled` |
| 7 | Trade logging (entry/exit/P&L) | ⏳ | |
| 8 | **Perps trading (Drift Protocol)** - plumbing only, no strategy | ✅ built + risk engine fully unit-tested offline | `npm run test:perps-risk`, `npm run test:perps-connection` |

Each part has its own `npm run test:<part>` script - run it and read the
console output before trusting that part.

### Part 8: perpetuals trading (Drift Protocol) - plumbing, not a strategy

This is a separate track from the spot sniper above (Parts 1-7) - same repo,
same wallet/config conventions, but trading leveraged perps on
[Drift Protocol](https://drift.trade) instead of spot Pump.fun/Raydium
tokens. **There is no entry strategy wired up.** Nothing decides *when* to
trade - what's here is the execution plumbing something else (you, manually;
an indicator-based strategy; a copy-trading bot) would call. Do not treat
this as "the bot trades perps now" - it's "the bot *can* place a perp trade,
correctly and with risk limits enforced, once something tells it to."

**Extra non-negotiable on top of the ones at the top of this file:** perps
use leverage. A bad order loses money faster than spot ever can, and can get
liquidated entirely. `perps.enabled` defaults `false` (mirrors
`trading.enabled`) **and** `perps.env` defaults `"devnet"` - Solana's free
test network, where SOL has no real value. Do not switch `perps.env` to
`"mainnet-beta"` until you've tested on devnet and read `src/perps/risk.ts`
end to end. If you do set `enabled: true` and `env: "mainnet-beta"`
together, the bot prints a loud warning on startup on purpose.

What's built:

- **`src/perps/driftClient.ts`** - connects to Drift (mirrors Part 1's RPC
  connection). `confirmDriftConnection()` subscribes and reads back account
  state. **Found and fixed a real crash bug here**: Drift's SDK runs
  background account-subscription tasks that can throw *outside* any
  promise our code awaits - by default Node's response to that is to kill
  the entire process, silently bypassing our try/catch. Reproduced it
  (a background subscriber hit this sandbox's blocked network and took the
  whole process down with a raw stack trace, no error handling triggered at
  all), fixed it with a scoped `unhandledRejection` handler that logs
  instead of crashing, verified the fix by reproducing the same scenario
  again and confirming it now fails gracefully through our own error
  path instead.
- **`src/perps/positions.ts`** - reads live account state (collateral,
  leverage, margin health, open positions, unrealized P&L) using Drift's
  own SDK calculations (`User.getHealth()`/`getLeverage()`/etc), not
  hand-rolled math - your real account health depends on your *whole*
  account across every position, which isn't something worth
  re-deriving by hand.
- **`src/perps/risk.ts`** - the risk gate, same PASS/SKIP-with-reasons
  design as the spot filter engine (Part 4): every order is checked against
  `perps.allowedMarkets`, `maxLeverage`, `maxPositionSizeUsd`,
  `maxOpenPositions`, and (if `requireStopLoss`) that a stop-loss is set,
  before anything touches the chain. Also has stop-loss/take-profit price
  target math and a **rough, clearly-labeled-as-an-estimate** liquidation
  price calculator for pre-trade display - always cross-check the real
  number in Drift's own UI, this ignores cross-margin effects from your
  other positions.
- **`src/perps/orders.ts`** - `openPerpPosition()` (market order + attaches
  a reduce-only stop-loss and, if set, take-profit trigger order) and
  `closePerpPosition()`. Refuses to do anything unless `perps.enabled` is
  true and the order clears the risk gate.
- **`src/perps/tradeLog.ts`** - JSONL log to `logs/perps-trades.jsonl`
  (entry, exit, reason, P&L, rejected orders + why), same rotation as the
  spot decision log.
- **`src/perps/marketRegistry.ts` / `sizing.ts`** - symbol↔market-index
  lookup and USD↔on-chain-precision conversions. Pure, offline-testable
  (Drift's `initialize()` just returns bundled static market metadata, no
  network call).

```bash
npm run test:perps-risk        # 31/31 offline - risk gate, sizing, SL/TP math
npm run test:perps-connection  # needs your own RPC + a wallet in .env, even on devnet
```

**Not built, and deliberately so** (you told me to build the plumbing, not
guess at a strategy): any signal for *when* to open a position - no
technical indicators, no manual-trigger CLI, no copy-trading. Also not
built: a live price-monitoring loop to react to a stop-loss/take-profit
actually filling (the trigger orders are placed on-chain and Drift itself
executes them - you don't need a bot running for that part - but nothing
here watches for the fill and logs the close automatically yet).

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

### Part 2: new pool/token watcher

`src/watcher/` subscribes to Pump.fun and Raydium AMM V4 program logs
(`Connection.onLogs`), recognizes their create/`initialize2` instructions,
fetches the full transaction, and emits a normalized `newPool` event with
the mint address and (when available) creator wallet and pool address.

```bash
npm run test:watcher
```

12/12 offline unit tests pass in this sandbox (log-pattern matching +
mint/creator extraction against fixture transactions). The live websocket
subscription smoke test also ran cleanly here (started, handled the
sandbox's network block gracefully, stopped) - but **the exact account
indices used to pull the mint out of a real transaction could not be
checked against a live transaction** (no RPC egress in this sandbox):

- Pump.fun's `create` account order is well-documented and stable
  (`src/watcher/pumpfunWatcher.ts`), but still worth a spot check.
- Raydium's `initialize2` account order (`src/watcher/raydiumWatcher.ts`)
  is known to drift slightly across Raydium SDK versions - **verify this one
  against a few real transactions on Solscan before trusting it**, and
  adjust `RAYDIUM_INITIALIZE2_ACCOUNT_INDEX` if the mint/pool addresses come
  out wrong.

### Part 3: token metrics

`src/data/tokenMetrics.ts` takes a `NewPoolEvent` from Part 2 and gathers
everything Part 4's filters need:

- **mint/freeze authority renounced** - `getMint` (SPL Token), authority `=== null`
- **top holder %** - `getTokenLargestAccounts`, with the pool/vault addresses
  excluded (otherwise the pool itself, which legitimately holds most of the
  pre-migration supply, always looks like "one whale owns 80%")
- **dev wallet %** - the token creator's own balance (from Part 2's `creator`
  field) as a % of supply
- **liquidity (SOL)** - Pump.fun: the bonding curve PDA's native SOL balance.
  Raydium: whichever vault is the WSOL side of the pool
- **unique wallets vs tx volume** - samples up to
  `polling.walletActivitySampleSize` (default 100) recent signatures against
  the pool address and counts distinct fee payers vs total tx count

A metric that fails to fetch is recorded as a `null` value + an entry in
`warnings`, not a crash - one flaky RPC call shouldn't throw away an
otherwise-complete picture. `collectTokenMetrics()` **fails closed** on
error for the renounce checks (defaults to "not renounced" if it can't
verify), so a partial outage never accidentally lets a risky token through.

```bash
npm run test:metrics
```

13/13 tests pass, all offline against a mocked `Connection` (including a
real SPL Token `MintLayout`-encoded fixture for the renounce check, and a
forced-total-RPC-failure case proving `collectTokenMetrics` degrades to
warnings instead of throwing). This part needed no live network to verify
its logic - it's pure data transformation once given valid RPC responses.

### Part 4: filter engine + PASS/SKIP logging (still no buying)

**This is the part to read closely before anything else.** It's the whole
point of the "manually verify the filter logic" non-negotiable.

`src/filters/engine.ts` -> `evaluateFilters(event, metrics, filters)` is a
pure function: given a token's metrics and your thresholds from
`config/default.json`, it returns `PASS` or `SKIP` plus **every** failed
rule's reason (not just the first one). Rules:

| Rule | Config key | 
|---|---|
| Liquidity ≥ threshold | `filters.minLiquiditySol` |
| Top holder % ≤ threshold (pool excluded) | `filters.maxTopHolderPercent` |
| Dev wallet % ≤ threshold | `filters.maxDevWalletPercent` |
| Mint authority renounced | `filters.requireMintAuthorityRenounced` |
| Freeze authority renounced | `filters.requireFreezeAuthorityRenounced` |
| Unique wallets ≥ threshold | `filters.minUniqueWallets` |
| Transaction count ≥ threshold | `filters.minTransactionCount` |
| Unique-wallet / tx ratio ≥ threshold | `filters.minUniqueWalletToTxRatio` |

**A metric the bot couldn't fetch (`null`) always fails its rule** - "we
don't know" is never treated as "good enough to buy." Thresholds are
inclusive (`>=` / `<=`), so a value exactly at the limit still PASSes.

`src/filters/decisionLog.ts` prints one line per token to the console and
appends the full record (including the raw metrics snapshot) to
`logs/decisions.jsonl`, e.g.:

```
[PASS] pumpfun MintAddress...  liquidity=10.00SOL topHolder=10.00% devWallet=5.00% renounced=Y/Y wallets=40 txs=60
[SKIP] pumpfun MintAddress...  liquidity=0.00SOL topHolder=10.00% devWallet=5.00% renounced=Y/Y wallets=40 txs=60
       reasons: liquidity too low (0.00 SOL < min 5 SOL)
```

`src/index.ts` now wires Parts 1-4 into a runnable bot: connect -> watch ->
fetch metrics -> filter -> log. It still never buys anything - even with
`trading.enabled: true` it only logs a warning that auto-buy isn't wired up
yet (that's Part 5).

```bash
npm run test:filters   # the filter-logic unit tests - read these carefully
npm run build && npm start   # or: npm run dev
```

27/27 tests pass, 100% offline (`evaluateFilters` is a pure function, no
network involved at all): baseline PASS, every threshold's exact boundary,
every rule failing individually with the right reason text, all-unknown-
metrics failing closed, multiple simultaneous failures all being reported,
console formatting, and the JSONL decision log round-tripping correctly.

**Before you move past this part**, edit `config/default.json`'s
`filters` block to your real thresholds, re-run `npm run test:filters`, and
once you're running the bot live (Part 1/2 need your own RPC), watch
`logs/decisions.jsonl` against tokens you separately check on Solscan/
Birdeye/Dexscreener to confirm the PASS/SKIP calls look right to you. That
manual check is the non-negotiable gate before Part 5 gets turned on.
