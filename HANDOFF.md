# OPIUMO — Session Handoff

Complete context transfer for a fresh session. Assumes you have never seen
this project. Written 2026-09-08. Repo state at time of writing:
branch `claude/solana-token-trading-bot-xpqxv0`, all work pushed.

Read this alongside `CLAUDE.md` (the permanent working agreement, loaded
automatically every session) and `README.md` (deeper per-part detail).

---

## 1. Project overview

### What this is

**OPIUMO** — a Solana trading bot, TypeScript / Node, **CLI only, no web UI**.
Two independent tracks sharing one repo, one config file, and one set of
conventions:

1. **Spot sniper** (Parts 1–7, 10) — watches Pump.fun and Raydium for
   newly-created liquidity pools, pulls safety metrics on each new token,
   runs hard filters, and (when enabled) auto-buys via Jupiter and manages
   the exit through a stop-loss / take-profit ladder / trailing stop /
   time-stop.
2. **Perpetuals track** (Parts 8–9) — Drift Protocol plumbing plus one real
   strategy, funding-rate arbitrage. Runs from a **separate entry point**
   (`npm run perps`) and never shares state with the spot sniper.

### Owner's stated goals

- **Hands-off operation.** The end state is: bot runs, detects launches,
  filters them, buys what passes, and manages exits automatically without
  manual intervention. It is built for that, and gated off until proven.
- **Understand every decision.** Every PASS/SKIP and every trade is logged
  with its reason, to console and to disk, in real time — so the owner can
  audit *why* something happened rather than trusting a black box.
- **Learn as we go.** The owner is **new to coding and to crypto
  infrastructure**. Explain in plain language, define jargon on first use,
  and describe failures in terms of what they mean practically — not just a
  stack trace. Never assume familiarity with git, npm, shell conventions,
  or Solana concepts.

### Working constraints (how sessions are expected to run)

- **One piece at a time.** Build it, test it, show the result, then move on.
  Never dump a large amount of code in a single step.
- **Every change gets `npm run typecheck` plus the relevant test suite, and
  the actual output shown**, before it is called done.
- **Be honest about verification.** "I ran this and it passed" and "this
  typechecks but has never executed against real data" are different claims
  and must be stated differently.
- **Don't silently widen scope.** Flag unrelated problems, ask, don't fold
  them into an unrelated change.

### Safety posture (agreed, non-negotiable)

Three independent gates, all defaulting to the safe position:

| Gate | Default | Meaning |
| --- | --- | --- |
| `trading.enabled` | `false` | Spot sniper does not buy or sell at all |
| `trading.paperTrading` | `true` | Even when enabled, fills are simulated |
| `perps.enabled` | `false` | No perp orders placed |
| `perps.env` | `"devnet"` | Fake-money network |
| `fundingArb.enabled` | `false` | Strategy watches and logs, never orders |

**Real spot money is at risk only when BOTH `trading.enabled: true` AND
`trading.paperTrading: false`.** Never flip any of these as a side effect of
another change. Config validation prints a loud warning on startup when the
live combination is set (`src/config.ts`), mirroring the existing
`perps.enabled` + `mainnet-beta` warning.

Additional standing rules:

- **All tunables live in `config/default.json`.** Never hardcode a
  threshold, size, interval, or URL in source.
- **Secrets live in `.env` only.** The GitHub repo is **public**.
  `.gitignore` covers `.env`, `vault/`, `.obsidian/`, `logs/*.jsonl`.
- **Fail closed.** Unknown/unverifiable data is always a failing condition.
  `null` ("couldn't check") and `false` ("checked, it's bad") are distinct
  everywhere and are worded differently in every log line.

---

## 2. Architecture

### Repo facts that are easy to get wrong

- Remote: `https://github.com/tristanwicka-hash/OPIUMO-` — **public**.
- Working branch: `claude/solana-token-trading-bot-xpqxv0`.
  **There is no `main` branch.** All work lives on that branch. Clone with
  `-b claude/solana-token-trading-bot-xpqxv0`.
- `tsconfig.json` sets `rootDir: "."` (so `tests/` can import `../src/...`).
  Build output is therefore **`dist/src/index.js`, not `dist/index.js`**.
- File paths resolve against **`process.cwd()`, never `__dirname`** — this
  was a real production bug (see §5).

### Directory layout

```
OPIUMO-/
├── CLAUDE.md                  # working agreement, auto-loaded every session
├── HANDOFF.md                 # this file
├── README.md                  # per-part detail, hardening-pass history
├── config/default.json        # ALL tunables. The only file to edit to retune.
├── .env.example               # copy to .env; RPC_URL, WALLET_PRIVATE_KEY, LOG_LEVEL
├── docs/vault-starter/        # Obsidian starter notes (copy OUTSIDE the repo)
├── scripts/verify-raydium-tx.ts
├── src/
│   ├── index.ts               # ENTRY POINT — spot sniper (npm run dev)
│   ├── perpsIndex.ts          # ENTRY POINT — perps/funding-arb (npm run perps)
│   ├── config.ts              # loads + validates config/default.json and .env
│   ├── rpc/connection.ts      # Solana connection + confirmConnection()
│   ├── util/
│   │   ├── logger.ts          # console Logger + JsonlLog (with size rotation)
│   │   ├── wallet.ts          # loadWalletFromBase58()
│   │   └── riskSizing.ts      # shared risk math
│   ├── watcher/
│   │   ├── index.ts           # PoolWatcher — log subscriptions, heartbeat, dedup
│   │   ├── programs.ts        # program IDs + log markers
│   │   ├── pumpfunWatcher.ts  # extractPumpFunNewPool()
│   │   ├── raydiumWatcher.ts  # extractRaydiumNewPool() + ACCOUNT_INDEX map
│   │   └── types.ts           # NewPoolEvent
│   ├── data/tokenMetrics.ts   # collectTokenMetrics() — all safety metrics
│   ├── filters/
│   │   ├── engine.ts          # evaluateFilters() → PASS/SKIP + reasons
│   │   └── decisionLog.ts     # → logs/decisions.jsonl
│   ├── trading/               # SPOT SNIPER
│   │   ├── engine.ts          # SpotTradingEngine — orchestrates buy/monitor/exit
│   │   ├── jupiter.ts         # getQuote(), executeSwap() (REST, not the SDK)
│   │   ├── sizing.ts          # computeSpotPositionSizeSol() + HARD CAP
│   │   ├── exitLogic.ts       # ATR stop / trailing / time-stop / ladder checks
│   │   ├── atr.ts             # computeATR(), candlesFromPrices()
│   │   ├── retry.ts           # sell-failure backoff + abandonment
│   │   ├── positionStore.ts   # SpotPosition persistence
│   │   ├── priceHistory.ts    # rolling price samples (feeds ATR)
│   │   ├── humanUnits.ts      # raw↔human conversion, DISPLAY ONLY
│   │   └── tradeLog.ts        # → trades.jsonl / paper-trades.jsonl
│   └── perps/                 # PERPS TRACK
│       ├── driftClient.ts     # Drift connection + unhandledRejection guard
│       ├── positions.ts       # live account state via Drift's own SDK math
│       ├── risk.ts            # risk gate (PASS/SKIP, same shape as filters)
│       ├── orders.ts          # openPerpPosition(), closePerpPosition()
│       ├── sizing.ts          # USD ↔ on-chain precision
│       ├── marketRegistry.ts  # symbol ↔ market index
│       ├── tradeLog.ts        # → logs/perps-trades.jsonl
│       └── strategies/fundingArb/
│           ├── engine.ts      # FundingArbStrategy — start()/stop()/checkOnce()
│           ├── signals.ts     # pure entry/exit/rebalance/cost/margin signals
│           ├── marketData.ts  # live funding + basis reads
│           ├── history.ts     # persisted settlement history
│           └── types.ts
└── tests/                     # 18 suites, see §4
```

### Entry points

| Command | Runs | What it does |
| --- | --- | --- |
| `npm run dev` | `src/index.ts` | Spot sniper from source |
| `npm start` | `dist/src/index.js` | Spot sniper, compiled |
| `npm run perps` | `src/perpsIndex.ts` | Funding-arb runner from source |
| `npm run start:perps` | `dist/src/perpsIndex.js` | Same, compiled |
| `npm run build` | `tsc` | Compile to `dist/` |
| `npm run typecheck` | `tsc --noEmit` | Types only |
| `npm test` | `tests/run-all.ts` | Every suite, chained |
| `npm run verify:raydium-tx -- <sig>` | `scripts/verify-raydium-tx.ts` | See §7 |

### Where the flags live

All in **`config/default.json`**:

- `trading.enabled`, `trading.paperTrading` — spot gates
- `perps.enabled`, `perps.env` — perps gates
- `fundingArb.enabled` — strategy gate
- Interfaces and validation for all of it: **`src/config.ts`**
  (`TradingConfig`, `FiltersConfig`, `PerpsConfig`, `FundingArbConfig`,
  `LoggingConfig`)

Secrets in **`.env`** only: `RPC_URL`, `WS_URL` (optional),
`WALLET_PRIVATE_KEY` (base58; **not required while `paperTrading: true`**),
`LOG_LEVEL`.

### Data flow (spot)

```
PoolWatcher (logsSubscribe on Pump.fun + Raydium program IDs)
  → NewPoolEvent
  → collectTokenMetrics()            [src/data/tokenMetrics.ts]
  → evaluateFilters()                [src/filters/engine.ts]
  → DecisionLog.record()             → logs/decisions.jsonl   (ALWAYS)
  → if PASS and engine exists: SpotTradingEngine.onFilterPass()
      → probe quote → computeSpotPositionSizeSol() → fill
      → SpotPosition saved, monitored every trading.priceCheckIntervalMs
      → checkPosition() → reconcile → quote → exit checks → executeExit()
```

### Unit convention (critical, easy to break)

Every `priceSol` value in `src/trading/` means **SOL per RAW token unit**
(smallest on-chain unit), *not* per whole token. Internally consistent, so
ratios and differences are correct, but printed values look tiny.
`src/trading/humanUnits.ts` converts for **display and logging only** —
never feed a human-unit value back into trading math.

---

## 3. Strategy specs (as implemented)

### 3a. Meme-coin snipe / scalp (spot)

**Detection.** `PoolWatcher` subscribes to logs for the Pump.fun bonding-curve
program and Raydium AMM V4 (`src/watcher/programs.ts`), filtered by
`sources.watchPumpFun` / `sources.watchRaydium`. Includes an `onSlotChange`
heartbeat: no slot update for the stale threshold (default 30s) triggers an
automatic unsubscribe/resubscribe. Duplicate signatures are deduped by a
bounded in-memory set.

**Metrics collected** (`src/data/tokenMetrics.ts`, every RPC call wrapped in
a timeout of `polling.metricsFetchTimeoutMs`): `decimals`, `liquiditySol`,
`topHolderPercent`, `devWalletPercent`, `mintAuthorityRenounced`,
`freezeAuthorityRenounced`, `riskyTokenExtensions`, `creatorLpPercent`,
`lpCheckApplicable`, `uniqueWallets`, `transactionCount`, `stale`,
`warnings`. Collection slower than `polling.metricsMaxAgeMs` sets
`stale = true`.

**Filters** — ALL must pass (`src/filters/engine.ts`, thresholds in
`config.filters`). Any failure ⇒ SKIP with every failing reason listed:

| Config key | Default | Rule |
| --- | --- | --- |
| `minLiquiditySol` | `5` | Pool SOL ≥ 5 |
| `maxTopHolderPercent` | `20` | Largest holder ≤ 20% |
| `maxDevWalletPercent` | `10` | Creator wallet ≤ 10% |
| `requireMintAuthorityRenounced` | `true` | Dev cannot mint more supply |
| `requireFreezeAuthorityRenounced` | `true` | Dev cannot freeze your wallet |
| `rejectRiskyTokenExtensions` | `true` | No TransferHook etc. (Token-2022) |
| `maxCreatorLpPercent` | `1` | Creator's remaining LP ≤ 1% |
| `minUniqueWallets` | `20` | ≥ 20 distinct wallets |
| `minTransactionCount` | `30` | ≥ 30 transactions |
| `minUniqueWalletToTxRatio` | `0.15` | Anti-wash-trading ratio |
| — | — | `stale === true` ⇒ automatic SKIP |

Thresholds are **inclusive** (`>=` / `<=`) — an exactly-at-threshold value
passes. `lpCheckApplicable: false` (Pump.fun, where the check doesn't apply)
is NOT treated as unknown.

**Sizing** (`src/trading/sizing.ts`). Risk-based, from stop distance:

```
riskBasedSizeSol = (totalCapitalSol × riskPercentPerTrade/100)
                   ÷ (fractional distance from entry to stop)
positionSizeSol  = min(riskBasedSizeSol, totalCapitalSol × 1%)
```

`HARD_CAP_PERCENT_OF_CAPITAL = 1` is a **source constant, not config** — no
config value can loosen it. In practice this hard cap is what sizes most
trades. Entry stop before ATR data exists is `fallbackStopLossPercent`
(`-30`).

**Exits** (`src/trading/exitLogic.ts`), evaluated in this priority order,
**one action per cycle**, every `priceCheckIntervalMs` (5000):

1. **ATR stop-loss** — `checkAtrStopLoss()`. Stop starts at −30%; once real
   ATR exists it is `entry − (ATR × atrStopMultiplier 1.75)`, and the stop
   only ever **tightens** toward entry, never loosens back out.
2. **Trailing stop** — activates at `trailingStopActivateMultiple` (2×),
   then exits if price falls `trailingStopPercent` (30%) from the high.
3. **Time stop** — `timeStopHours` (48) with no ladder tier hit.
4. **Take-profit ladder** — `takeProfitLadder`: sell **50%** of remaining at
   **2×**, **25%** at **5×**, **25%** at **10×**. Tiers are sorted ascending
   internally and each fires at most once (`executedLadderTiers`).

**Sell-failure handling** (`src/trading/retry.ts`): exponential backoff
`sellFailureBackoffBaseMs (30s) × 2^(failures−1)`, capped at
`sellFailureBackoffMaxMs` (30 min). After `maxConsecutiveSellFailures` (5)
the position is marked `abandoned` — no further automatic attempts, logged
loudly, requires manual review.

**Reconciliation** (`SpotTradingEngine.reconcilePosition()`): every cycle,
compares tracked `remainingSizeTokens` against the wallet's real on-chain
balance. Corrects **downward**; removes the position if the wallet holds
none; **warns but never auto-corrects upward**; a transient RPC failure is
treated as "try again next cycle", not as a zero balance. Skipped entirely
in paper mode (nothing real to reconcile against).

**Paper trading** (Part 10): `SpotTradingEngine.simulateFill()` takes a
**real Jupiter quote** and returns the same `SwapResult` shape
`executeSwap()` does, but never builds, signs, or sends a transaction and
never touches a wallet. `simulateFill` vs `executeSwap` at the call site is
the *only* difference between modes. Paper state is written to separate
files — `logs/paper-positions.json`, `logs/paper-price-history.json`,
`logging.paperTradesFile` — and every record carries `isPaper`. Console
lines are prefixed `[PAPER]`; signatures are `PAPER-<ts>-<rand>`.

#### Deviations from the original spec

| Spec said | Implemented | Why |
| --- | --- | --- |
| Sell 50% at 2×, 80% at 4×, all at −30% (first message) | 50%/25%/25% at 2×/5×/10×, ATR-based stop with −30% fallback | Superseded by the later, more detailed strategy spec the owner provided |
| Risk 0.5–1% per trade | `riskPercentPerTrade: 0.75` **plus** a non-overridable 1% hard cap | A config-only limit could be loosened by a bad edit; the ceiling belongs in code |
| Earlier draft had `maxPercentOfCapitalPerTrade` config | Removed | It was always tighter than the hard cap, making the hard cap dead code and the risk formula almost never binding. Removing it made the one real ceiling actually the ceiling |
| "Separate minimally-funded wallet" | Not enforced in code | Operational instruction to the owner, not something the bot can verify. Still the recommendation before going live |

### 3b. Funding-rate arbitrage (Drift perps)

**The idea.** When funding is persistently positive, shorts are paid by
longs. Hold spot long + an equal-notional short perp: price exposure
cancels, you collect funding.

**Signals** (`src/perps/strategies/fundingArb/signals.ts`, all pure
functions, thresholds from `config.fundingArb`):

| Function | Rule | Config keys |
| --- | --- | --- |
| `shouldEnter()` | Funding ≥ `minFundingRateHourlyPercent` (0.01%) for `minConsecutiveSettlementsToEnter` (3) settlements | both |
| `shouldExitOnFundingFlip()` | Funding below threshold for `minConsecutiveSettlementsToExit` (3) | |
| `shouldExitOnBasis()` | Spot/perp basis exceeds `maxBasisPercent` (1.0%) | |
| `shouldRebalance()` | Legs drift apart by `rebalanceDriftPercent` (5%) | |
| `passesCostGate()` | Expected funding must beat `estimatedRoundTripCostBps` (10) | |
| `hasSufficientMarginBuffer()` | Account health ≥ `minMarginBufferPercent` (20%) | |

**Sizing / limits.** `notionalUsd` 100, `maxLeverage` 2 — which must be
≤ `perps.maxLeverage` (3), and `market` ("SOL-PERP") must be in
`perps.allowedMarkets`. Config validation enforces both relationships.
Every order additionally passes the shared risk gate in `src/perps/risk.ts`
(allowed market, max leverage, max position USD, max open positions, and —
if `requireStopLoss` — that a stop is attached) before anything touches the
chain.

**Cadence.** `checkIntervalMinutes` (5). Settlement history is persisted to
`logs/funding-arb-history.json`, deduped against repeated polls via
`amm.lastFundingRateTs`, so "N consecutive settlements" survives a restart.
Current phase (flat vs. holding) is **not** persisted — `checkOnce()`
re-derives it from Drift's live position data every cycle so it can never
drift out of sync with the chain.

#### Deviations from the original spec

| Spec said | Implemented | Why |
| --- | --- | --- |
| "Long spot + short perp" | **Does not buy the spot leg.** Reads an existing Drift spot balance; blocks with `"no spot leg detected"` if there is none | Auto-acquiring spot is a second execution venue and a second set of failure modes. Refusing is safer than accidentally shorting naked |
| Thresholds per 8-hour funding period (CEX convention) | Expressed **per hour** | Drift settles roughly hourly; the cadence is read live per market, not hardcoded |

---

## 4. Current state

### Built and pushed (Parts 1–10)

| # | Part | State |
| --- | --- | --- |
| 1 | RPC connection + config/logger scaffold | Built. Live check never succeeded here |
| 2 | Pool watcher (Pump.fun + Raydium) | Built. Raydium indices verified against official source |
| 3 | Token metrics collector | Built + fully unit-tested |
| 4 | Filter engine + PASS/SKIP logging | Built + fully unit-tested |
| 5–7 | Spot sniper: buy, exits, trade logging | Built. Decision logic unit-tested; execution path never run live |
| 8 | Drift perps plumbing | Built + risk engine unit-tested |
| 9 | Funding-rate-arb strategy + runner | Built + signals unit-tested |
| 10 | Paper-trading mode | Built + unit-tested |

### Test coverage — 239 offline assertions, 0 failing

| Suite | Command | Count |
| --- | --- | --- |
| Pool watcher | `test:watcher` | 17 |
| Token metrics | `test:metrics` | 32 |
| Filter engine | `test:filters` | 44 |
| Log rotation | `test:logger` | 5 |
| Perps risk engine | `test:perps-risk` | 31 |
| Funding-arb signals | `test:funding-arb-signals` | 35 |
| Spot sizing/ATR/exit logic | `test:trading-signals` | 26 |
| Spot engine gates | `test:trading-engine-gating` | 3 |
| Sell-failure retry/backoff | `test:trading-retry` | 14 |
| Position reconciliation | `test:trading-reconciliation` | 11 |
| Human-unit conversions | `test:trading-human-units` | 8 |
| Paper trading | `test:paper-trading` | 13 |
| **Total** | `npm test` | **239** |

Offline suites are deterministic: mocked `Connection`, mocked
`global.fetch`, or pure functions. Private methods are tested via an
`(x as any).method()` cast — the established pattern in `test-watcher.ts`
and `test-trading-reconciliation.ts`. **Never mutate `config/default.json`
from a test** — it gates real trading.

### Never run against a live network

All four live suites fail in the build sandbox, which has **zero** egress to
any Solana/Jupiter/Drift host (confirmed repeatedly: `403 Forbidden: Host not
in allowlist`, `ENOTFOUND`). They have only ever been verified to **fail
gracefully** — they have never succeeded:

- `npm run test:rpc` — Solana RPC connection
- `npm run test:trading-live` — one real Jupiter quote (read-only, no swap)
- `npm run test:perps-connection` — Drift connection + account read
- `npm run test:funding-arb-live` — one real evaluation cycle

**A first successful run on the owner's MacBook is genuinely new
information and should be reported as such.**

Also never executed against live data: the entire spot execution path
(`executeSwap`, real fills, real P&L), the ATR/trailing/time-stop logic
against real price movement, and any Drift order placement.

### Not built / deliberately absent

- No entry strategy for the raw perps track (Part 8 is plumbing; nothing
  decides *when* to open a discretionary perp position).
- No watcher for a stop-loss/take-profit trigger order actually filling on
  Drift — the orders are placed on-chain and Drift executes them, but
  nothing here logs the close automatically.
- No auto-acquire of the funding-arb spot leg (see §3b).
- No web UI, no Telegram interface, no copy-trading.

---

## 5. Known bugs and fixes

All five below were found in the third hardening pass and are **fixed,
tested, and pushed**. Documented here so a new session doesn't re-derive
them or reintroduce them.

### 5a. Infinite sell-retry loop — FIXED

A failed sell (rugged token, zero liquidity, RPC hiccup) retried on **every
monitoring cycle forever**, with no backoff and no stop condition. On a
genuinely dead token this meant hammering Jupiter indefinitely.

**Fix:** `src/trading/retry.ts` — `shouldAttemptSell()`, `nextAttemptInMs()`,
`shouldAbandonPosition()`. Exponential backoff from
`sellFailureBackoffBaseMs`, doubling per failure, capped at
`sellFailureBackoffMaxMs`. After `maxConsecutiveSellFailures` the position is
marked `abandoned` and skipped before any quote call. Covered by
`test:trading-retry` (14).

### 5b. Funding-arb strategy had no runner — FIXED

`FundingArbStrategy` was fully built and tested but **nothing could actually
run it** — only a test instantiated it, and that test runs one cycle and
exits.

**Fix:** `src/perpsIndex.ts` — a real entry point (`npm run perps` /
`npm run start:perps`), separate from the spot sniper's `src/index.ts`.
Connects once, then calls `strategy.start()` to run on its own schedule until
SIGINT. Safe with both enabled flags false: watches and logs, never orders.

### 5c. No position reconciliation — FIXED

Nothing ever checked the position store against the wallet's actual on-chain
balance. If the process died between a sell landing on-chain and the bot
recording it, `remainingSizeTokens` would be silently wrong forever, and
every later size/P&L calculation would compound the error.

**Fix:** `SpotTradingEngine.reconcilePosition()` — see §3a. Logs a
`reconciliation-mismatch` event (`corrected` or `removed`) to the trade log.
Covered by `test:trading-reconciliation` (11).

### 5d. Trade logs unreadable (raw units only) — FIXED

Logs recorded price/size per **raw token unit** only — internally correct but
unreadable (e.g. `1.2e-15` instead of `0.0000012`).

**Fix:** `decimals` now flows `collectTokenMetrics()` → `SpotPosition` →
`src/trading/humanUnits.ts`, added to every buy/sell record **alongside** the
raw values and **never** used in trading math. Covered by
`test:trading-human-units` (8).

*Found while writing that test:* `formatHuman(null, suffix)` returned `"?"`
and dropped the suffix. Fixed to `` `?${suffix}` `` before it shipped.

### 5e. `npm start` broken since commit #1 — FIXED

**`npm start` had never worked.** Two compounding causes:

1. `tsconfig.json`'s `rootDir: "."` means the build output is
   `dist/src/index.js`, but `package.json` pointed at `dist/index.js`.
2. `src/config.ts` resolved `config/default.json` via `__dirname`, which
   points at the wrong depth once compiled — and `config/` is never copied
   into `dist/` at all.

Never caught because **every test runs via `ts-node` against source, never
through a real build.**

**Fix:** `package.json`'s `main` / `start` / `start:perps` now point at
`dist/src/...`; `config.ts` resolves against `process.cwd()`, matching the
convention every other path in the repo already used. Verified end-to-end:
`npm run build && npm start` now boots and reaches the expected
network-blocked failure.

**Lesson worth keeping:** offline tests via `ts-node` will not catch
build/packaging bugs. Run `npm run build && npm start` after any change that
touches paths, entry points, or `tsconfig`.

---

## 6. Open work, in priority order

### Tier 1 — gates before real money (needs the owner; see §7)

1. **First live paper-trading run.** `trading.enabled: true`,
   `trading.paperTrading: true` (default), real Helius RPC in `.env`, run
   `npm run dev`. This is the immediate next action.
2. **Confirm the four live suites actually pass** on a networked machine:
   `test:rpc`, `test:trading-live`, `test:perps-connection`,
   `test:funding-arb-live`. First success is new information.
3. **Manual filter review against real decisions.** Read
   `logs/decisions.jsonl` after a real run. Are the thresholds sane? Which
   rule rejects the most? Does anything PASS that obviously shouldn't?
4. **Multi-day observation** before `paperTrading: false` is even discussed.

### Tier 2 — paper-trading mode — DONE (Part 10)

Previously the top open item. Built, tested (13 assertions), pushed. It is
now the *vehicle* for Tier 1 rather than a task.

### Tier 3 — gaps found in hardening — DONE

All four items (retry loop, funding-arb runner, reconciliation, decimals)
are fixed and tested — see §5. Nothing outstanding here.

### Tier 4 — later, deliberately not started

In rough value order, with the reasoning already worked out:

1. **Tune filters from real data.** The current thresholds are educated
   guesses, never validated against outcomes. The daily journal template in
   `docs/vault-starter/03-Journal/` exists to drive this: log top SKIP
   reasons per run, spot rules that never fire (dead weight) or reject
   everything (too tight).
2. **RugCheck API as an additional filter signal.** ~20 on-chain signals in
   one REST call (`api.rugcheck.xyz`, `X-API-KEY` header), including
   **bundler detection, insider-wallet networks, and sniper counts** — none
   of which the bot can currently compute. Trade-off already reasoned
   through in `docs/vault-starter/04-Research/Rug-Detection.md`: it adds
   latency and an external dependency, and since the bot fails closed, a
   RugCheck outage would skip everything. If added: keep the existing
   on-chain checks as ground truth, treat RugCheck as one more filter, and
   make it optional via a `config.filters` key.
3. **Fill-detection for Drift trigger orders** (log the close automatically).
4. **Execution-speed work** — only if real data shows entry timing, not
   filter quality, is the limiting factor. Current detection is WebSocket
   `logsSubscribe`, ~150–300 ms behind chain; end-to-end ~430–680 ms vs a
   production stack's ~50 ms (Yellowstone gRPC + pre-signed templates + Jito
   bundles). **The strategic conclusion already reached: don't compete on
   speed.** The filters require wallet counts and transaction counts that
   don't exist in the first 300 ms anyway, so this bot was never playing the
   first-block game. Its real edges are zero per-trade fees (competitors
   charge 0.9–1%, ~2% round trip), fully tunable filters, and mechanical
   exit discipline.
5. **MEV protection** (Jito bundles / priority fees) — currently a plain
   Jupiter swap, which can be front-run. Relevant only once real money is
   in play.

---

## 7. Blockers requiring the owner

Everything here needs live network access, real funds, or human judgment.
None of it can be completed from a sandboxed session.

### 7a. Anything touching the network

The build environment has **no egress to any Solana-related host**. Live
tests, real quotes, real orders, and the `verify:raydium-tx` script all fail
here by design. All of this must run on the owner's MacBook.

### 7b. Raydium account-index verification — RESOLVED, but here's the method

**Status: complete.** `RAYDIUM_INITIALIZE2_ACCOUNT_INDEX` in
`src/watcher/raydiumWatcher.ts` was verified on 2026-09-01 against Raydium's
own program source (`raydium-io/raydium-amm`, `program/src/instruction.rs`).
All eight indices match the account order the on-chain program expects:

| Field | Index | Program's account |
| --- | --- | --- |
| `ammId` | 4 | `amm_pool` |
| `ammAuthority` | 5 | `amm_authority` |
| `lpMint` | 7 | `amm_lp_mint` |
| `coinMint` | 8 | `amm_coin_mint` |
| `pcMint` | 9 | `amm_pc_mint` |
| `poolCoinTokenAccount` | 10 | `amm_coin_vault` |
| `poolPcTokenAccount` | 11 | `amm_pc_vault` |
| `userWallet` | 17 | `user_wallet` |

**To re-check against a live transaction** (only needed if Raydium ships a
new pool-creation instruction version):

```bash
npm run verify:raydium-tx -- <base58-transaction-signature>
```

Note the **space after `--`**. The script fetches the parsed transaction,
finds the Raydium AMM V4 instruction, prints every account with its index
next to what the code currently assumes each index means, and prints what
`extractRaydiumNewPool()` derives. Compare against Solscan's labelled view of
the same transaction.

**Finding a suitable signature is the hard part** — brand-new pools created
directly on classic Raydium AMM V4 are now rare (most launches start on
Pump.fun and migrate later). Practical route: DexScreener → a pool whose
header says "on Raydium" → the **EXP** link beside "Pair" → that pool
account's oldest transaction. Verifying from the program source, as done
above, is faster and equally authoritative.

### 7c. Decisions only the owner can make

- Setting `totalCapitalSol` to a real bankroll (currently a placeholder `10`).
- Funding a **separate, minimally-funded wallet** before live trading — the
  spec called for this and the bot cannot enforce it.
- Flipping `trading.paperTrading: false`. Should not happen until after
  multi-day paper results have been reviewed.
- Any `perps.env: "mainnet-beta"` switch — devnet testing first.
- Whether the filter thresholds match the owner's actual risk appetite.

### 7d. Housekeeping

A Helius API key was pasted into a chat transcript on 2026-09-01. It grants
RPC/quota access only — not funds — but **it should be regenerated** in the
Helius dashboard and the new value put in `.env` (never in any committed
file; the repo is public).

---

## 8. Decisions log

Choices already made, with reasoning. **Do not relitigate these without a
deliberate conversation.**

| Decision | Reasoning | Revisit if |
| --- | --- | --- |
| **Two independent gates for real money** (`trading.enabled` + `trading.paperTrading`) rather than one three-way `mode` setting | One flag was too easy to flip by accident. A three-way enum would also have changed the meaning of `trading.enabled`, which the whole safety posture is written around | It causes real confusion in practice |
| **1% hard cap in source, not config** (`HARD_CAP_PERCENT_OF_CAPITAL`) | The risk-based formula can produce large sizes when a stop is tight. A ceiling a bad config edit cannot loosen | Never, without an explicit conversation |
| **Removed `maxPercentOfCapitalPerTrade` config key** | It was always tighter than the hard cap, making the hard cap dead code and the risk formula almost never binding — the opposite of the intent | — |
| **Paper state in separate files** (`paper-positions.json`, `paper-price-history.json`, `paperTradesFile`) plus an `isPaper` field per record | Simulated activity must be structurally incapable of mixing with real history, even across restarts where the flag is toggled | — |
| **Raydium indices verified from program source, not a live transaction** | Direct-to-Raydium launches are now rare, making live examples slow to find. The program source is the authoritative definition anyway | Raydium ships a new pool-creation instruction |
| **Funding-arb does not buy the spot leg** | Auto-acquiring spot means a second venue and a second set of failure modes. Refusing to trade beats accidentally shorting naked | The owner explicitly asks for auto-acquire and accepts the complexity |
| **Funding thresholds per hour, not per 8h** | Drift settles roughly hourly; cadence is read live per market rather than hardcoded | — |
| **Jupiter via plain REST, not the `@jup-ag/api` SDK** | Two HTTP calls against a config-driven URL beats pinning to one client library's opinion of the endpoint, which has moved before | — |
| **Node's built-in `fetch`, not `node-fetch`** | One fewer dependency, and it correctly respects proxy env vars where `node-fetch` doesn't | — |
| **`describeFetchError()` walks the `.cause` chain** | Node's global fetch hides every network failure behind a generic `TypeError: fetch failed`; the real cause (a proxy 403) was three levels down and completely invisible until this was added | — |
| **Scoped `unhandledRejection` guard around the Drift client** | Drift's SDK runs background subscription tasks that throw *outside* any awaited promise; Node's default response kills the process, silently bypassing our try/catch. Reproduced, fixed, re-verified | — |
| **`null` ≠ `false` everywhere** | "Couldn't check" and "checked, it's bad" are different facts. Conflating them made a flaky RPC call look like a confirmed rug signal | — |
| **Paths resolve against `process.cwd()`, never `__dirname`** | `__dirname` points at the wrong depth once compiled, and `config/` is never copied into `dist/`. This was a real production bug | — |
| **Obsidian vault lives OUTSIDE the repo** | The GitHub repo is public; trade journals and P&L should not be. `vault/` and `.obsidian/` are gitignored as a backstop | — |
| **Don't compete on execution speed** | Competitors are ~10× faster on detection and submission. The filters need seconds of data to be meaningful, so this bot was never in the first-block race. Edges are zero fees, tunable filters, mechanical exits | Real data shows entry timing, not filter quality, is the binding constraint |

---

## Quick start for a new session

```bash
# 1. Orient
cat CLAUDE.md          # the rules
cat HANDOFF.md         # this file
cat config/default.json # every tunable

# 2. Verify the tree is healthy
npm run typecheck      # must be clean
npm test               # 239 offline assertions must pass;
                       # the 4 live suites fail without network access

# 3. Confirm the build path works (the bug in §5e lived here)
npm run build && npm start
```

**The single next action:** get a first live paper-trading run going on the
owner's MacBook — real Helius RPC in `.env`, `trading.enabled: true`,
`trading.paperTrading: true`, `npm run dev` — then read
`logs/decisions.jsonl` and `logs/paper-trades.jsonl` together and start
tuning filters from real outcomes.
