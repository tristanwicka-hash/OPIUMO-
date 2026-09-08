# Strategy: Funding rate arbitrage (Drift)

Code: `bot/src/perps/strategies/fundingArb/`.

## The idea
When the perpetual funding rate is persistently positive, shorts get paid by
longs. Hold spot (long) and an equal-size short perp: the price exposure
cancels out, and you collect funding. Market-neutral in theory.

## Important scope limits
- **This bot does not buy the spot leg for you.** It reads an existing Drift
  spot balance. No spot position = it refuses to short (won't go naked).
- Drift settles funding roughly **hourly**, not the 8h cadence common on
  centralized exchanges. Thresholds in config are per-hour to match.

## Where the risk actually is
- Not price direction - it's basis risk, funding flipping negative, and
  liquidation of the short leg if collateral gets thin.
- `perps.env` defaults to `devnet` (fake money). Do not switch to
  `mainnet-beta` before testing on devnet.

## Open questions
- How often is funding actually above the entry threshold, in practice?
- Does the round-trip cost estimate (10 bps) match reality?
