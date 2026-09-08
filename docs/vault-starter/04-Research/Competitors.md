# Research: competitors (as of 2026-09)

What the established Solana trading bots do, and what it means for us.

## The field

| Bot | Shape | Known for |
|---|---|---|
| Axiom | Web app | All-in-one: snipes, perps, yield, analytics |
| Trojan | Telegram | Fast, feature-rich, mobile-first. ~0.9% fee/trade |
| Photon | Web | Fastest at landing transactions in the earliest block; sub-second |
| GMGN | Web | New-token feeds, copy trading, anti-MEV |
| BullX NEO | Web | Multi-chain with strong Solana support |
| Banana Gun | Telegram | Top-tier execution speed, multi-chain |
| BONKbot | Telegram | Simple "tap and trade", strong MEV protection. ~1% fee |
| Maestro | Telegram | Multi-window execution under load |

Sources: [Dysnix comparison](https://dysnix.com/blog/top-solana-sniper-bot),
[Solana Tracker](https://www.solanatracker.io/blog/best-solana-sniper-bots-2026),
[RPC Fast](https://rpcfast.com/blog/top-solana-sniper-bot)

## What they have that we don't

1. **Speed.** They use Yellowstone gRPC / Geyser streams and Jito bundles.
   We use WebSocket `logsSubscribe`, which is 150-300ms behind the chain.
   See [[Latency-and-Execution]].
2. **MEV protection.** Jito bundles stop your buy from being sandwiched.
   We send a plain Jupiter swap - it can be front-run.
3. **Richer rug detection.** They surface bundler detection, insider-wallet
   networks, sniper-wallet counts, and dev history. We check liquidity, top
   holder %, dev %, mint/freeze authority, creator LP %, wallet/tx ratio,
   and risky Token-2022 extensions.
4. **Copy trading.** Follow a known-profitable wallet automatically.
5. **A UI.** They're Telegram bots or web apps. We're a terminal program.

## What we have that they don't

1. **No per-trade fee.** They charge 0.9-1% per trade - roughly 2% round
   trip. Ours is free. On a 100-trade month that is a large edge.
2. **Filters we fully control and can tune from our own logged data.**
   Theirs are mostly fixed or coarse.
3. **A real paper-trading mode** running the exact live code path.
4. **Every decision logged with its reason.** We can actually audit why a
   token was skipped, which is how thresholds get tuned properly.

## Honest read

We will not win a pure speed race against Photon or Banana Gun - they're
roughly an order of magnitude faster on detection and submission. So
"be first to buy" is not our edge. Our plausible edges are **filter
discipline** (buying fewer, better tokens), **no fees**, and **exit
discipline** (the laddered/trailing/time-stop logic runs the same every
time, with no emotion).

## Ideas worth considering later
- [ ] Add RugCheck's API as an extra filter signal (20+ signals in one call,
      including bundler/insider/sniper detection) - see [[Rug-Detection]]
- [ ] Priority fees + Jito bundle submission for buys
- [ ] Yellowstone gRPC detection instead of WebSocket, if we ever want speed
