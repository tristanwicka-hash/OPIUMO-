# When to run the sniper — trading-hours research

2026-09-10. Written to answer: *don't run OPIUMO constantly during low-volume
hours, to save Helius credits.* That's a sound instinct. The research below is
weaker than the instinct deserves, and the reason why matters.

---

## The short version

**Nobody publishes a credible hourly volume distribution for Solana memecoins.**
Not Dune, not the analytics blogs, not the exchanges. What exists is either
anecdote with confident-sounding numbers attached, or real studies that measure
something else entirely.

**But you don't need them, because you have your own logs.** OPIUMO has been
detecting tokens and writing them to disk with timestamps for days. That is a
direct measurement of when *your* strategy sees opportunities, on *your* filters,
which is strictly better than any blog's aggregate. Compute the hourly
distribution from `logs/` before adopting anyone else's schedule.

That is the same lesson as the Helius credits question: three sessions inferred
an answer from error strings for fourteen hours, and the dashboard settled it in
ten seconds. **Read your own ground truth when you have it.**

---

## What the external sources actually say

### The one source with specific hours — treat with suspicion

[DegenSpaced blog](https://degenspaced.vercel.app/blog/best-time-to-trade-memecoins-solana):

- Best: **9am–12pm EST** (13:00–16:00 UTC), claiming "2.3x higher average volume
  per token" vs overnight
- Worst: **2am–6am EST** (06:00–10:00 UTC), "the dead zone," spreads wider "by an
  average of 40%"
- Weekend afternoons: 25–30% *lower* total volume, but individual token PnL
  claimed **15% higher**

**Its methodology is "200+ personal trades over three months."** No sample
breakdown, no controls, no statistical test. A 2.3x figure quoted to two
significant figures off 200 discretionary trades is a number wearing a lab coat.
Use it as a hypothesis, never as a setting.

### The credible study measures something else

[Chainplay](https://chainplay.gg/blog/lifespan-pump-fun-memecoins-analysis/)
analysed **968,819 tokens** over three months via Dune — a real sample with a
stated method:

- ~10,417 tokens launched per 24h; ~9,912 die per 24h (≈95% turnover)
- Average memecoin lifespan: **12 days**; 15% dead within one day, 31% within a week
- **98% fail to survive three months**

Useful, and sobering. But it contains **no hourly breakdown at all** — it can't
tell you when to run.

### The most honest source refuses to answer

[Coin Bureau](https://coinbureau.com/education/crypto-trading-hours) declines to
name peak hours, saying "there is no universal best time to trade crypto." It
offers **13:00–16:00 UTC** (Europe–US overlap) only as "worth testing," and notes
that weekend effects "vary by asset and exchange" and that assuming institutional
participation vanishes on weekends "should not be treated as permanent rules."

Its actual advice is to compare hourly volume yourself over a meaningful period.

---

## The trap in "trade when volume is highest"

Volume and *edge* are not the same thing, and for a sniper they may point in
opposite directions.

Peak hours are when every other sniper bot is also running. More volume means
more competition for the same early entries, faster front-running, and worse
fills. The one source that looked at both claims weekend PnL was **higher** while
volume was **lower** — the opposite of the naive conclusion, from the same data.

So there are two separate questions, and only one of them is about credits:

1. **When does OPIUMO see the most candidates?** → determines credit burn. Your
   logs answer this today.
2. **When does OPIUMO see the most candidates that turn out well?** → determines
   profit. **Only the outcome tracker can answer this, and it needs data first.**

Scheduling on question 1 alone is defensible as a *cost* measure. Presenting it
as a *strategy* improvement would be a guess.

---

## The credit arithmetic

The saving is purely mechanical — hours not running are hours not spending:

| Schedule | Hours/day | Credit use vs 24/7 |
|---|---|---|
| Always on | 24 | 100% |
| Skip 06:00–12:00 UTC (the claimed dead zone) | 18 | **75%** |
| 12:00–02:00 UTC | 14 | **58%** |
| 13:00–22:00 UTC (Europe–US overlap + US day) | 9 | **38%** |
| 13:00–16:00 UTC only (the narrow claim) | 3 | **13%** |

Against Helius's tiers (Free 1M/mo, Developer $49/mo 10M, extra credits $5/M),
an 18-hour schedule turns a 1.33M-credit month into 1M. A 9-hour schedule turns
2.6M into 1M. **Whether that changes which tier you need depends entirely on your
burn rate, which is still unmeasured.**

This is why instrumentation comes before both the schedule and the purchase. A
request counter and an hourly log line convert all of this from argument into
arithmetic.

---

## Recommended design

Not "pick the best hours" — **make the schedule a measured, reversible config
value rather than a belief baked into code.**

```jsonc
// config/default.json
"schedule": {
  "enabled": false,          // off until the hourly log justifies it
  "timezone": "UTC",         // never local time - DST silently shifts the window
  "activeWindows": [
    { "days": "mon-fri", "start": "12:00", "end": "02:00" },
    { "days": "sat-sun", "start": "14:00", "end": "00:00" }
  ],
  "outsideWindow": "idle"    // idle = detect nothing, spend nothing
}
```

Requirements worth pinning with tests:

- **UTC internally, always.** A local-time window silently shifts by an hour
  twice a year and nobody notices until the logs look strange.
- **Windows must handle crossing midnight** (`12:00`–`02:00` is 14 hours, not
  negative ten). This is the classic off-by-one in every scheduler ever written —
  test it explicitly.
- **`enabled: false` by default.** Turning it on is a decision made against the
  hourly histogram, not a default someone inherits.
- **Log every skipped cycle with its reason**, so "quiet night" and "scheduler
  turned me off" are never confused in the logs. Silence that looks like
  inactivity is exactly the masking defect the vault keeps finding.
- **The schedule must not touch filter logic.** It decides *whether* to look, not
  *what* passes. Keep the two independent or the outcome study becomes
  uninterpretable.

---

## Before spending money on Helius

Two honest observations, offered as facts rather than advice:

1. **The burn rate is unknown.** The 09-09 tuning cut request volume ~32% against
   an unmeasured baseline, and the allowance ran out anyway without warning. Any
   tier chosen now is a guess with the same information that produced the last
   guess.
2. **OPIUMO has never demonstrated an edge.** It is paper-only, currently stopped,
   and its filters have a 0% pass rate whose meaning is unknown until the outcome
   tracker shows what the *rejected* tokens did. Against that, $49/month is
   infrastructure spend on a strategy that has not yet been shown to work.

Neither of those says don't buy. Free tier's 1M credits plus a schedule may be
enough to gather the measurement, and the measurement is what makes the next
decision a calculation instead of a guess. That ordering — measure, then buy —
costs nothing to try first.
