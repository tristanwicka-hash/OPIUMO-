# Research: latency and execution (2026-09)

How fast the competition actually is, and where our time goes.

## Detection paths, slowest to fastest

| Method | Typical lag | Notes |
|---|---|---|
| JSON-RPC WebSocket (`logsSubscribe`) | 150-300ms behind chain | **What we use today** |
| Yellowstone gRPC (Geyser plugin) | ~50-100ms faster than WS | Binary protobuf; server-side filtering |
| Jito ShredStream | Earliest available | Streams shreds direct from block leaders |

End-to-end, the "amateur" stack (WebSocket detect -> build -> send) runs
**430-680ms**. A production stack (gRPC + pre-signed transaction templates +
Jito bundles) runs **~50ms**.

Sources: [RPC Fast - competitive stack](https://rpcfast.com/blog/complete-stack-competitive-solana-sniper-bots),
[Dysnix - HFT infrastructure](https://dysnix.com/blog/solana-rpc-strategy-and-infrastructure-for-hft-bots)

## Submission

- **Priority fees** decide whether your transaction lands in a contested block.
- **Jito bundles** submit atomically and shield against MEV/sandwiching.
- Helius Sender submits to validators and Jito concurrently.

We currently do none of this - we send a standard Jupiter swap transaction.

## What this means for us

Being 400ms+ behind means we are structurally never the first buyer on a
hot launch. Two honest options:

1. **Accept it.** Don't compete on speed. Buy slightly later, on better
   information (more wallets, more transactions, clearer holder
   distribution) - which our filters already require anyway. Our filters
   arguably *need* a few seconds of data to be meaningful at all.
2. **Invest in speed.** Paid Geyser/gRPC endpoint, pre-signed templates,
   Jito bundles. Meaningful cost and complexity.

Option 1 is the current plan by default. Revisit only with real data showing
that entry timing (not filter quality) is what's costing us.
