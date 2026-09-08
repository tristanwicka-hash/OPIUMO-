# Research: rug detection

## What we check today (all on-chain, computed ourselves)
- Liquidity in SOL
- Top holder %
- Dev/creator wallet %
- Mint authority renounced (can they print more supply?)
- Freeze authority renounced (can they stop you selling?)
- Creator's remaining LP % (can they pull liquidity?)
- Unique wallets, transaction count, and the ratio between them (wash trading)
- Risky Token-2022 extensions (e.g. TransferHook, which can block transfers)

## What RugCheck's API adds
A 1-10 risk score plus 20+ signals in a single REST call, including things
we do **not** currently detect:
- **Bundlers** - supply bought in one bundle at launch by coordinated wallets
- **Insider networks** - wallets linked to the deployer
- **Sniper counts** - how many bots already got in
- Liquidity lock status

Public API at `api.rugcheck.xyz`, key via `X-API-KEY` header.
Sources: [RugCheck](https://rugcheck.xyz/),
[Solana Tracker writeup](https://www.solanatracker.io/resources/check-solana-token-rug-risk-api)

## Trade-off to think about before adding it
Adding an external API call adds latency and a dependency that can fail. Our
current design fails closed - if a check can't complete, we SKIP. That's the
right behaviour, but if RugCheck is slow or down we'd skip everything.

If we add it: treat it as **one more filter among many**, keep our own
on-chain checks (they're the ground truth), and make the whole thing
optional via `config.filters` so it can be turned off in one edit.
