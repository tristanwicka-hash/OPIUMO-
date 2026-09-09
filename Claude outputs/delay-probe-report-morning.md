# Delay-probe report

Generated: 2026-09-09T16:30:18.872Z
Source:    `logs/delay-probe.jsonl`
Thresholds evaluated: minUniqueWallets=20, minTransactionCount=30, maxTopHolderPercent=20

## Coverage

- 3269 lines read (1156 coverage lines, 2113 observations)
- 707 distinct mints observed

## Pass rate by delay

The number that actually answers the question: how much older does a token need to be
before the filters are even evaluable, and how many pass once they are.

| Delay | Would-pass rate | Evaluable / OK / scheduled |
|---|---|---|
| 30s ⚠️ | 0.3% | 308 / 707 / 707 |
| 120s ⚠️ | 0.8% | 244 / 705 / 705 |
| 300s ⚠️ | 0.0% | 248 / 701 / 701 |

⚠️ = fewer than half of scheduled jobs produced a usable reading at that delay. See the detail section below before trusting that row's pass rate.

## Detail by delay

### 30s after detection

Scheduled 707 -> 707 completed, 0 errored, 0 dropped (queue full).

> ⚠️ **Only 308/707 jobs at this delay produced a usable reading (44%) - the pass rate below is built from a small, possibly unrepresentative slice, not most of what was scheduled. Check topFailureReasons before reading a low pass rate as a finding about the strategy rather than about data collection.**

**Would-pass rate at current thresholds: 0.3%** (1/308 evaluable observations - the rest were missing at least one of the three filtered metrics).

| Metric | n | null | min | median | p90 | max |
|---|---|---|---|---|---|---|
| Unique wallets | 340 | 367 | 0.0 | 2.0 | 4.0 | 40.0 |
| Transaction count | 340 | 367 | 1.0 | 4.0 | 19.0 | 61.0 |
| Top holder % | 606 | 101 | 0.0% | 3.2% | 50.3% | 96.2% |
| Liquidity (SOL) | 633 | 74 | 0.0 | 0.1 | 5.8 | 62.3 |
| Queue wait (ms) | 707 | 0 | 0.0 | 0.0 | 17629.0 | 57507.0 |
| Collection time (ms) | 707 | 0 | 319.0 | 17500.0 | 25605.0 | 35933.0 |

**Why data was missing, most common first:**

- 367x — metrics took Nms to collect (> metricsMaxAgeMs Nms) - data may be stale
- 310x — walletActivity: wallet activity timed out after Nms
- 57x — walletActivity: 429 Too Many Requests: Too Many Requests
- 50x — liquiditySol: failed to get balance of account <account>: Error: 429 Too Many Requests: Too Many Requests
- 47x — renounce status: failed to get info about account <account>: Error: 429 Too Many Requests: Too Many Requests
- 25x — devWalletPercent: 429 Too Many Requests: Too Many Requests

### 120s after detection

Scheduled 705 -> 705 completed, 0 errored, 0 dropped (queue full).

> ⚠️ **Only 244/705 jobs at this delay produced a usable reading (35%) - the pass rate below is built from a small, possibly unrepresentative slice, not most of what was scheduled. Check topFailureReasons before reading a low pass rate as a finding about the strategy rather than about data collection.**

**Would-pass rate at current thresholds: 0.8%** (2/244 evaluable observations - the rest were missing at least one of the three filtered metrics).

| Metric | n | null | min | median | p90 | max |
|---|---|---|---|---|---|---|
| Unique wallets | 294 | 411 | 0.0 | 2.0 | 4.0 | 28.0 |
| Transaction count | 294 | 411 | 1.0 | 4.0 | 17.0 | 48.0 |
| Top holder % | 579 | 126 | 0.0% | 2.1% | 50.6% | 96.3% |
| Liquidity (SOL) | 621 | 84 | 0.0 | 0.0 | 1.5 | 80.4 |
| Queue wait (ms) | 705 | 0 | 0.0 | 0.0 | 23050.0 | 63104.0 |
| Collection time (ms) | 705 | 0 | 236.0 | 20135.0 | 27761.0 | 35821.0 |

**Why data was missing, most common first:**

- 411x — metrics took Nms to collect (> metricsMaxAgeMs Nms) - data may be stale
- 350x — walletActivity: wallet activity timed out after Nms
- 61x — walletActivity: 429 Too Many Requests: Too Many Requests
- 56x — liquiditySol: failed to get balance of account <account>: Error: 429 Too Many Requests: Too Many Requests
- 49x — renounce status: failed to get info about account <account>: Error: 429 Too Many Requests: Too Many Requests
- 28x — devWalletPercent: 429 Too Many Requests: Too Many Requests

### 300s after detection

Scheduled 701 -> 701 completed, 0 errored, 0 dropped (queue full).

> ⚠️ **Only 248/701 jobs at this delay produced a usable reading (35%) - the pass rate below is built from a small, possibly unrepresentative slice, not most of what was scheduled. Check topFailureReasons before reading a low pass rate as a finding about the strategy rather than about data collection.**

**Would-pass rate at current thresholds: 0.0%** (0/248 evaluable observations - the rest were missing at least one of the three filtered metrics).

| Metric | n | null | min | median | p90 | max |
|---|---|---|---|---|---|---|
| Unique wallets | 284 | 417 | 0.0 | 2.0 | 4.0 | 18.0 |
| Transaction count | 284 | 417 | 1.0 | 5.0 | 17.0 | 52.0 |
| Top holder % | 593 | 108 | 0.0% | 0.5% | 50.5% | 98.8% |
| Liquidity (SOL) | 632 | 69 | 0.0 | 0.0 | 1.1 | 46.5 |
| Queue wait (ms) | 701 | 0 | 0.0 | 0.0 | 19702.0 | 67040.0 |
| Collection time (ms) | 701 | 0 | 323.0 | 20170.0 | 27727.0 | 35951.0 |

**Why data was missing, most common first:**

- 417x — metrics took Nms to collect (> metricsMaxAgeMs Nms) - data may be stale
- 357x — walletActivity: wallet activity timed out after Nms
- 60x — walletActivity: 429 Too Many Requests: Too Many Requests
- 46x — liquiditySol: failed to get balance of account <account>: Error: 429 Too Many Requests: Too Many Requests
- 46x — renounce status: failed to get info about account <account>: Error: 429 Too Many Requests: Too Many Requests
- 26x — topHolderPercent: 429 Too Many Requests: Too Many Requests

> Picking a delay: look for where the pass rate stops climbing and the metric medians stop moving much between buckets - that's the point where waiting longer buys accuracy that isn't there yet, not the point where waiting less makes the filters stop being self-contradictory. Also weigh entry price against it: every extra second is more of the move already gone (see Strategy-and-Roadmap.md).

