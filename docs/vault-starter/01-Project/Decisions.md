# Decisions

Append-only log. Newest at the top. One entry per real decision - what was
chosen, what was rejected, and *why*. This is the note that stops us
re-litigating the same question in three months.

Format:

```
## YYYY-MM-DD - Short title
**Decision:** what we're doing
**Why:** the reasoning
**Rejected:** what we chose not to do, and why not
**Revisit if:** the condition that would change this
```

---

## 2026-09-01 - Paper trading gated behind a second flag
**Decision:** `trading.paperTrading` defaults `true`; real money needs BOTH
`trading.enabled: true` AND `paperTrading: false`.
**Why:** one flag was too easy to flip by accident. Two independent switches
means no single mistake can put real SOL at risk.
**Rejected:** a single three-way `mode: off | paper | live` setting - it
would have changed the meaning of the existing `trading.enabled` flag that
the non-negotiables are written around.
**Revisit if:** the two-flag setup ever causes real confusion in practice.

## 2026-09-01 - Raydium account indices verified from source, not a live tx
**Decision:** confirmed `RAYDIUM_INITIALIZE2_ACCOUNT_INDEX` against
Raydium's own program source (`raydium-io/raydium-amm`,
`program/src/instruction.rs`) rather than decoding a live transaction.
**Why:** brand-new pools launching directly on classic Raydium AMM V4 are
now rare (most launch on Pump.fun first), so finding a live example was
slow. The program source is the authoritative definition anyway.
**Revisit if:** Raydium ships a new pool-creation instruction version.

## 2026-09-01 - Hard 1% position size cap, non-overridable
**Decision:** `src/trading/sizing.ts` enforces a 1%-of-capital ceiling that
no config value can loosen.
**Why:** the risk-based sizing formula can produce large sizes when a stop
is very tight. A ceiling in code, not config, means a bad config edit can't
blow up the account.
**Revisit if:** never, without a deliberate conversation about it.
