# Strategy: Meme coin snipe / scalp

The spot sniper. Code: `bot/src/trading/`, `bot/src/filters/`.

## The idea
Detect a token within seconds of its pool being created, run it through
hard safety filters, and if it passes, take a small risk-capped position.
Sell in tiers as it runs; cut fast if it doesn't.

## Entry
A token must pass **every** filter in `config.filters` - see
[[Config-Reference]]. Any single failure means SKIP, with the reason
logged. Unknown data (a failed RPC call) counts as a failure, never a pass.

## Sizing
Risk-based, not a flat SOL amount: position size comes from the distance to
the stop-loss, so a wider stop means a smaller position. A hard 1%-of-capital
ceiling is enforced in code and cannot be loosened by config.

## Exit (priority order, one action per cycle)
1. ATR stop-loss (or the -30% fallback before ATR data exists)
2. Trailing stop (activates at 2x, gives back at most 30% from the high)
3. Time stop (48h with no ladder tier hit)
4. Take-profit ladder: 50% at 2x, 25% at 5x, 25% at 10x

## Open questions to answer with real data
- Are the filters too tight? (How many PASSes per day? If zero, too tight.)
- Are they too loose? (What % of PASSes would have rugged?)
- Is 2x the right first ladder rung, or does most of the move happen before it?
- Does the 48h time stop ever actually fire, or do positions resolve sooner?

Track these in [[03-Journal/_Daily-Template]].
