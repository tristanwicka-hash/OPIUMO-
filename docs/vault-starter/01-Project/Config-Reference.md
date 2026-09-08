# Config reference

Every setting in `bot/config/default.json`, what it does in plain language,
and **why it's set where it is**. The JSON file has the values; this note
has the reasoning. Update this note whenever you change a value.

## trading

| Setting | Value | What it means | Why this value |
|---|---|---|---|
| `enabled` | `false` | Master switch for the spot sniper | Off until filters are verified by hand |
| `paperTrading` | `true` | Simulated fills, real prices | Second safety net; real money needs this `false` too |
| `totalCapitalSol` | `10` | Your bankroll, used for sizing | Set this to your real number before going live |
| `riskPercentPerTrade` | `0.75` | % of capital risked per trade | Middle of the 0.5-1% spec range |
| `maxOpenPositions` | `5` | Concurrent positions cap | |
| `maxSlippageBps` | `300` | 3% max slippage | New tokens move fast; too tight = failed fills |
| `takeProfitLadder` | 2x/5x/10x | Sell 50%, then 25%, then 25% | Take money off the table while letting a runner run |
| `atrStopMultiplier` | `1.75` | Stop distance in ATR units | |
| `fallbackStopLossPercent` | `-30` | Stop used before ATR data exists | A brand-new token has no price history yet |
| `trailingStopActivateMultiple` | `2` | Trailing stop turns on at 2x | |
| `trailingStopPercent` | `30` | Give back at most 30% from the high | |
| `timeStopHours` | `48` | Exit a position that goes nowhere | Frees capital and attention |

## filters

| Setting | Value | Why |
|---|---|---|
| `minLiquiditySol` | `5` | Below this you can't exit without destroying the price |
| `maxTopHolderPercent` | `20` | One wallet above this can dump on you alone |
| `maxDevWalletPercent` | `10` | Dev holding a big bag is the classic rug setup |
| `requireMintAuthorityRenounced` | `true` | Otherwise they can mint infinite supply |
| `requireFreezeAuthorityRenounced` | `true` | Otherwise they can freeze your tokens so you can't sell |
| `minUniqueWallets` | `20` | Fewer than this = probably not real interest |
| `minTransactionCount` | `30` | |
| `minUniqueWalletToTxRatio` | `0.15` | Lots of trades from few wallets = wash trading |
| `maxCreatorLpPercent` | `1` | Creator still holding LP can pull liquidity |

**Note:** these are starting points, not tuned numbers. Tune them from real
PASS/SKIP data in `logs/decisions.jsonl` - see [[03-Journal/_Daily-Template]].
