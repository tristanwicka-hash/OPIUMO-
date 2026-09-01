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

## Third hardening pass (2026-09-01) - after both strategies were built

Once the funding-arb and meme-coin strategies were both live-executable
(real Jupiter/Drift order placement, not just plumbing), a fresh "what's
actually missing before you'd trust this" review turned up two real bugs,
two real gaps, and - while chasing one of those down - a **third bug that
had been there since commit #1 and nothing had ever caught**:

| Issue | Fix |
|---|---|
| A failed sell (rugged token, zero liquidity, RPC hiccup) retried on **every single monitoring cycle forever**, no backoff, no way to ever stop - on a genuinely dead token that meant hammering Jupiter indefinitely | `src/trading/retry.ts`: exponential backoff (`sellFailureBackoffBaseMs`, doubling per failure, capped at `sellFailureBackoffMaxMs`); after `maxConsecutiveSellFailures` (default 5) the position is marked `abandoned` - no more automatic attempts, logged loudly, needs your manual review |
| `FundingArbStrategy` (Part 9) was fully built and tested but had **no way to actually run** - only a test ever instantiated it, and that test runs one cycle and exits | `src/perpsIndex.ts` - a real entry point (`npm run perps` / `npm run start:perps`), separate from the spot sniper's `src/index.ts`, connects once then calls `strategy.start()` to run on its own schedule until stopped |
| Nothing ever checked the position store against the wallet's actual on-chain balance - a missed sell confirmation (e.g. the process dying between broadcast and recording) would leave `remainingSizeTokens` silently wrong forever | `SpotTradingEngine.reconcilePosition()` compares tracked vs. real balance every cycle: corrects downward, removes the position if the wallet holds none of it, warns (never silently trusts) if the wallet holds *more* than tracked |
| Trade logs recorded price/size per **raw token unit** only - internally correct (see the UNIT CONVENTION note in `src/trading/engine.ts`) but not human-readable (e.g. `1.2e-15` instead of `0.0000012`) | `decimals` now flows through `collectTokenMetrics()` → `SpotPosition` → `src/trading/humanUnits.ts`, added to every buy/sell log line alongside the raw values, never used in the actual trading math |
| **`npm start` (`node dist/index.js`) has been broken since the very first commit.** `tsconfig.json`'s `rootDir: "."` (needed so `tests/` can import `../src/...`) means the real build output is `dist/src/index.js`, not `dist/index.js` - and separately, `config.ts` resolved `config/default.json` via `__dirname`, which pointed at the wrong depth once compiled AND `config/` is never copied into `dist/` at all. Never caught because every test in this repo runs via `ts-node` against source, never through a real build. | Fixed both: `package.json`'s `main`/`start`/`start:perps` now point at `dist/src/...`; `config.ts` resolves against `process.cwd()` instead of `__dirname`, matching the convention every other file path in this repo already uses (`logs/*.json(l)`). Verified end-to-end: `npm run build && npm start` now runs correctly. |

Also found and fixed while writing the human-units test: `formatHuman(null, suffix)`
returned just `"?"` instead of `"?" + suffix` - the suffix was dropped on the
null branch. Caught by the very test written to cover the new code, before
it shipped.

Two other real gaps from that review were **not** touched here, both
because the honest fix is bigger than a "fix it" pass and deserves its own
design, not a rushed addition:
- **No paper-trading mode.** The only two states today are "log decisions,
  never trade" (`trading.enabled=false`) and "trade with real SOL/leverage."
  There's no middle ground that runs the full pipeline - real prices, real
  sizing, real exit logic - against simulated fills. This is the highest-
  value thing to build next; it's how you'd validate the exit ladder/
  trailing-stop/ATR-stop logic (which has never executed against live data)
  without risking anything.
- **The Raydium `initialize2` account indices are still unverified against
  a real transaction** - flagged since the very first hardening pass, still
  needs your own RPC access to confirm, still not something fixable from
  this sandbox.

## Status

| # | Part | Status | Notes |
|---|------|--------|-------|
| 1 | Solana RPC connection | ✅ built, ⚠️ needs your own live RPC to verify | `npm run test:rpc` |
| 2 | New pool watcher (Pump.fun/Raydium) | ✅ built, ⚠️ account indices need live verification | `npm run test:watcher` |
| 3 | Token metrics (holders, liquidity, dev %, renounced, wallets/volume) | ✅ built + fully unit-tested offline | `npm run test:metrics` |
| 4 | Filter engine + PASS/SKIP logging (no buying) | ✅ built + fully unit-tested offline | `npm run test:filters` |
| 5-7 | **Meme-coin snipe/scalp strategy**: auto-buy (Jupiter), ATR stop / tiered take-profit / trailing stop / time-stop, trade logging | ✅ built + decision logic fully unit-tested offline | `npm run test:trading-signals`, `test:trading-engine-gating`, `test:trading-live` |
| 8 | **Perps trading (Drift Protocol)** - plumbing only, no strategy | ✅ built + risk engine fully unit-tested offline | `npm run test:perps-risk`, `npm run test:perps-connection` |
| 9 | **Funding Rate Arbitrage strategy** (Drift) - the first real strategy on top of Part 8's plumbing | ✅ built + signal logic fully unit-tested offline + has a real runner (`npm run perps`) | `npm run test:funding-arb-signals`, `npm run test:funding-arb-live` |

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

### Part 9: Funding Rate Arbitrage strategy (Drift)

The first actual entry/exit strategy, built on top of Part 8's plumbing per
your spec: **long spot + short perp, equal notional, farming a persistently
positive funding rate.** Same non-negotiables as everywhere else - separate
`fundingArb.enabled` flag (in addition to `perps.enabled` underneath it),
both default `false`; `perps.env` still defaults `devnet`.

**Two scope decisions worth knowing before you read the code:**

1. **This strategy does not buy your spot leg.** "Long spot equivalent" in
   your spec assumes you already hold (or have deposited into Drift as
   collateral) the base asset - `getSpotNotionalUsd()` *reads* your existing
   Drift spot balance, it never acquires one. If you have no spot position,
   `considerEntry()` blocks with `"no spot leg detected"` rather than
   quietly shorting naked. Building an auto-acquire-spot step would mean
   either a Jupiter spot swap (not built - that was the still-pending Part
   5) or a Drift spot deposit call - a reasonable next addition, just not
   assumed for you.
2. **Every order this strategy places still carries a stop-loss** (required
   by `perps.requireStopLoss`, reused as-is per your "reuse existing risk
   gates" instruction) - but it is a wide, last-resort **disaster backstop**
   (`perps.defaultStopLossPercent`, -10% by default), not the strategy's
   real exit mechanism. A delta-neutral position doesn't have a natural
   price-based stop - the actual protections are the basis/funding-flip
   exits and the margin-buffer emergency unwind below. The backstop exists
   purely so that if this bot process dies while a position is open, Drift
   still has a resting order that fires on a truly disastrous move instead
   of an unmonitored naked short forever. No take-profit is set on these
   orders - profit here comes from funding accrual over time, not price
   movement, so a price target would fight the hedge.

What's built, mapped to your spec:

| Your spec | Implementation |
|---|---|
| Monitor funding rate every [X min] | `fundingArb.checkIntervalMinutes` (default 5) drives `FundingArbStrategy.start()`'s timer |
| Enter after [N] consecutive settlements above threshold, not a spike | `signals.shouldEnter()` - checks the *last N* recorded settlements, one bad one anywhere in that window blocks entry |
| Long spot + short perp, equal notional | perp leg sized to `min(fundingArb.notionalUsd, your live spot balance)` |
| Leverage 1-3x max | `fundingArb.maxLeverage` (default 2, validated `<= perps.maxLeverage`), enforced by the same risk gate as Part 8 |
| Exit if funding flips negative for [N] settlements | `signals.shouldExitOnFundingFlip()` |
| Exit if basis widens beyond [X%] | `signals.shouldExitOnBasis()` |
| Rebalance if legs drift beyond [X%] | `signals.shouldRebalance()` - currently rebalances by **closing and reopening** at the corrected size (pays fees twice; a true partial-resize order is a reasonable future refinement, not built now) |
| Hard cap on leverage | reused from Part 8's `perps.maxLeverage` / risk gate |
| Margin buffer above maintenance floor | `signals.hasSufficientMarginBuffer()`, checked every cycle - a breach while a position is open triggers an immediate emergency unwind, independent of every other signal |
| Fee/slippage check before entry | `signals.passesCostGate()` - rejects entry if projected funding income over the entry-confirmation window doesn't clear `fundingArb.estimatedRoundTripCostBps` |

One correction from your spec worth flagging: **Drift settles funding
roughly hourly, not the 8hr cadence common on centralized exchanges** (read
live per-market via `amm.fundingPeriod`, not assumed). All the
`minFundingRateHourlyPercent`/settlement-count thresholds are expressed
against Drift's real cadence rather than the CEX-style 8hr unit from the
spec's example.

`FundingHistoryStore` persists the rolling settlement history to
`logs/funding-arb-history.json` (one real on-chain settlement per entry,
deduped against repeated polls via `amm.lastFundingRateTs`) so "N
consecutive settlements" survives a bot restart. Current phase (flat vs.
holding a position) is **not** separately persisted - `checkOnce()` derives
it fresh from Drift's own live position data every cycle, so it can never
drift out of sync with what's actually on-chain.

```bash
npm run test:funding-arb-signals  # 35/35 offline - read this before enabling anything
npm run test:funding-arb-live     # needs your own RPC + wallet; runs ONE real evaluation cycle, no order unless signals say to AND both enabled flags are true
npm run perps                     # the actual runner - connects once, then runs checkOnce() on fundingArb.checkIntervalMinutes until you Ctrl+C. Safe with both enabled flags false: it still watches and logs, just never orders.
```

### Parts 5-7: meme-coin snipe/scalp strategy (spot, Pump.fun/Raydium)

The strategy the whole spot side (Parts 1-4) was building toward: auto-buy
tokens that PASS the filter engine, manage them through a tiered exit
ladder, then log every trade. Per your spec, plus two things it didn't
address that had to be resolved somehow (flagged clearly, not silently):

**Note on `env: "devnet"` from your spec:** unlike Drift, Pump.fun has no
meaningful devnet deployment to test against - there's no real liquidity or
activity there. The actual safety mechanisms for this track are what the
spec's own risk gates called for: `trading.enabled` defaults `false`, and
**use a separate, minimally-funded wallet** (your spec's own words) - that's
on you to set up, code can't verify a wallet is "not your main one." Start
`trading.totalCapitalSol` small.

**The ATR-then-sizing chicken-and-egg problem:** the spec sizes positions
from stop-loss distance, and the stop-loss is ATR-based - but a brand-new
token has zero price history at the moment you'd enter, so there's no ATR
yet to compute anything from. Resolved with `trading.fallbackStopLossPercent`
(-30% default): used only for the very first stop (and therefore entry
sizing); once enough price samples accumulate, the stop switches to the real
ATR-based value and only ever *tightens* toward it from there, never loosens
back out to the fallback.

**Position count wasn't capped in the spec** (only per-trade size was) -
added `trading.maxOpenPositions` (default 5) so an unbounded number of
individually-small positions can't stack up to deploy far more capital in
aggregate than intended. Same category of gap as `perps.maxOpenPositions`,
which already existed on the Drift side.

What's built, mapped to your spec:

| Your spec | Implementation |
|---|---|
| Entry filters, PASS/SKIP with reasons | Part 4's filter engine, extended with LP-lock/burn and honeypot (Token-2022 extension) checks - see the hardening-pass-style commit for those |
| Max 0.5-1% of capital per trade, hard cap, non-overridable | `src/trading/sizing.ts` - a source-code constant (1%), not a config value, so config can't loosen it. Sized from stop-loss distance via the same fixed-fractional formula as the funding-arb strategy (`src/util/riskSizing.ts`, shared) |
| Exit ladder: 2x sell 50%, 5x sell 25% of remainder, 10x sell 25% of remainder | `trading.takeProfitLadder`, checked by `src/trading/exitLogic.ts`'s `checkLadderTier()` - each tier fires once |
| ATR stop-loss, ~1.5-2x the 14-period ATR | `trading.atrPeriod`/`atrStopMultiplier`, `src/trading/atr.ts`. Documented limitation: real OHLC candles don't exist for a token this new, so it's built from point-in-time price samples (see the code comment for what that costs in accuracy) |
| Time-stop: exit if the position hasn't moved in 24-72h | `trading.timeStopHours` (default 48), `checkTimeStop()` - "moved" means ever reached the first ladder tier, so a pump-then-dump doesn't false-trigger this |
| Trailing stop: after 2x, trail -30% from the highest price reached | `trading.trailingStopActivateMultiple`/`trailingStopPercent`, `checkTrailingStop()` |
| Separate, minimally-funded wallet | Not code-enforceable (see above) - your discipline, not a config flag |
| Trade logging (entry, exit, reason, P&L) | `src/trading/tradeLog.ts` → `logs/trades.jsonl`, same rotation as every other log here |

`src/trading/engine.ts` (`SpotTradingEngine`) is the orchestrator: Part 4's
`PASS` → `onFilterPass()` sizes and buys via Jupiter (`src/trading/jupiter.ts`
- a thin REST client against Jupiter's public Swap API, config-driven URL
since it couldn't be verified live from this sandbox and Jupiter has moved
this endpoint before) → position tracked in `src/trading/positionStore.ts`
(persisted JSON - unlike the funding-arb strategy, there's no on-chain
source of truth for "which ladder tiers already fired," this bot has to
remember it itself) → a timer (`trading.priceCheckIntervalMs`) runs every
open position through the exit checks in priority order (stop-loss →
trailing stop → time-stop → ladder tier) each cycle. Wired into
`src/index.ts`: a filter `PASS` calls straight into this when
`trading.enabled` is true, nothing changes when it's false.

```bash
npm run test:trading-signals         # 26/26 offline - sizing, ATR, all four exit signals - read this first
npm run test:trading-engine-gating   # 3/3 offline - the trading.enabled / non-PASS gates specifically
npm run test:trading-live            # needs real network; gets one real Jupiter quote, no swap, no funds moved
npm run test:trading-retry           # 14/14 offline - sell-failure backoff/abandonment (see the hardening-pass table above)
npm run test:trading-reconciliation  # 11/11 offline - position store vs. real wallet balance
npm run test:trading-human-units     # 8/8 offline - raw <-> human-readable display conversions
```

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
