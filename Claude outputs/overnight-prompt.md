# Overnight autonomous work order — paste this whole thing into your local Claude Code session

Tristan is asleep. Work through the tracks below in priority order, with zero
back-and-forth. Nobody is here to answer a question, approve a plan, or catch
a mistake before it happens — so the rule is: when genuinely unsure, don't
guess and don't wait either. Write it to `OVERNIGHT-LOG.md` (create it if it
doesn't exist yet) under a `## Questions for Tristan` heading, make the
safest assumption that lets you keep moving, and say clearly in the log which
assumption you made and why. Keep working after that — never just stop and
sit idle.

## Absolute rules — these override every task below, no exceptions

1. **No real money moves, anywhere, tonight.** Never flip `trading.enabled`,
   `perps.enabled`, or `fundingArb.enabled` to `true` in OPIUMO. Never submit
   a live (non-paper) order through Alpaca or any broker/exchange API. If a
   task seems to require it to "finish," it doesn't — build and paper-test
   the code, then stop short of flipping the switch, and say so in the log.
2. **No real social posting, no new accounts, no OAuth/API-key setup
   tonight.** Tristan said explicitly: connecting real accounts happens
   tomorrow, with him present. Every content-bot piece tonight writes to
   local review files (drafts, queues) and calls a *mock* posting client
   that logs "would have posted X to Y" instead of hitting a real API. Do
   not create Instagram/TikTok/X/YouTube developer apps, do not request
   OAuth tokens, do not sign up for anything.
3. **Never expand an existing "safe by design" restriction without saying so
   loudly.** Example: the OptionsBot is currently buy-only by deliberate
   design (see `claude/Options-Trading-Research.md` in the Cowork project —
   read it before touching that repo). If you build a defined-risk-selling
   module (credit spreads/iron condors), it ships **disabled by default**,
   behind its own explicit config flag, exactly like OPIUMO's
   `trading.enabled` pattern — never make it the active path tonight.
4. **Never commit or log a real secret.** No API keys, tokens, or `.env`
   contents in any file that gets committed, printed, or written to a log.
5. **Git hygiene:** commit early and often with clear messages (small,
   working, tested increments — never one giant dump). For repos that
   already have a remote and an established push pattern (OPIUMO), pushing
   to the existing working branch overnight is fine — that's already how
   Tristan works. For anything you create fresh tonight (new repos), commit
   locally as you go but do **not** create a GitHub remote or push anywhere
   — that's a decision for tomorrow. Never force-push, never rewrite
   history, never touch `main` (OPIUMO has no `main` — everything is on
   `claude/solana-token-trading-bot-xpqxv0`).
6. **Every code change gets typechecked/built and its relevant tests run
   before you consider it done** — follow each repo's own `CLAUDE.md` if one
   exists (OPIUMO has one — read it first, it's the working agreement for
   that repo and it's strict about this). Never claim something works
   without having actually run it.
7. **Stay in your lane per repo.** Don't fix unrelated things you notice
   while working — note them in the log instead, the way OPIUMO's own
   `CLAUDE.md` already asks for ("don't silently widen scope").

## Before starting anything: orient yourself

- Read `~/Documents/TristansVault/OPIUMO-/CLAUDE.md` in full.
- If the Cowork project's docs are reachable from here (check for a synced
  `Tristans Vault` or similar), skim `Strategy-and-Roadmap.md`,
  `OPIUMO-Handoff.md`, `Content-Bot-Research.md`, `RapNews-Research.md`, and
  `Options-Trading-Research.md` — they carry real context (decisions already
  made, bugs already fixed, research already done) that should not be
  redone or contradicted by accident. If you can't find them, proceed on
  what's below and note the gap in the log.
- Create `OVERNIGHT-LOG.md` at the top of whichever repo you're in (or one
  shared file if working across repos — your call, just be consistent) and
  timestamp every major milestone as you go, not just at the end. Assume
  Tristan wakes up and reads only this file first.

---

## Track 1 — OPIUMO (highest priority, most context already exists)

Repo: `~/Documents/TristansVault/OPIUMO-`, branch
`claude/solana-token-trading-bot-xpqxv0`. Read `claude/Strategy-and-Roadmap.md`
and `claude/OPIUMO-Handoff.md` from the Cowork project first — they were just
updated today (2026-09-09) with the real current state. In short: Bugs 2/3 and
the sell-side priority fee are done; the delay-probe measurement tool and its
report (`npm run report:delay-probe`) are done and were just run against real
data tonight.

**What the real data just showed, and why it matters here:** the first real
`logs/delay-probe.jsonl` run (435 observations) came back with a 0.0% pass
rate at all three delays (30s/120s/300s) — but investigation showed this is
NOT a strategy finding. 66% of "ok" observations had a null
`uniqueWalletCount` despite `ok:true`, dominated by `walletActivity: wallet
activity timed out after 20000ms` and explicit `429 Too Many Requests`
errors. `queueWaitMs` medians ran 10-31 minutes and climbed across the
session — `delayProbe.maxConcurrentProbes: 2` cannot keep up once each job
takes ~20s to fail, so the internal queue backed up badly. Only 29% of all
observations (128/435) produced a fully usable reading. The report tool
itself now surfaces all of this automatically (`reliabilityWarning`,
`topFailureReasons`, `queueWaitMs`/`collectionMs` stats per bucket) — this
was just shipped in commit `cef740d`-equivalent (already applied directly to
the working tree, not yet committed as of whenever this prompt was written —
check `git status`/`git log` to see whether it's committed; if not, commit it
first with a clear message before doing anything else).

**Tonight's task order:**

1. **Confirm the above is committed** (see note). Run
   `npm run typecheck && npm test` and confirm the offline suites are still
   green (should be ~495 offline assertions) before touching anything else.
2. **Reduce the RPC load, config-only first.** In `config/default.json`,
   lower `delayProbe.sampleRate` substantially (try `0.08`–`0.1`, down from
   `0.3`) so scheduled probe jobs drop well below what
   `maxConcurrentProbes: 2` can actually service before each job's 20s
   timeout window. This is the cheapest, safest first move and needs no
   code change — just verify the JSON is still valid and the app still
   builds/starts.
3. **If Tristan's Mac stays awake and online tonight** (it may not — that's
   fine either way, don't wait on it): run the bot in paper mode
   (`npm start`, already `trading.enabled: false`/`paperTrading: true` —
   verify this before starting, never flip it) for as long as possible to
   collect a second, cleaner `logs/delay-probe.jsonl` run at the lower
   sample rate. Periodically run `npm run report:delay-probe` and log
   whether the null/timeout/429 rate actually drops. If it does NOT drop
   meaningfully even at the lower sample rate, that's an important finding
   too — log it clearly, it would suggest the live pipeline alone (not the
   probe) is already near the Helius free-tier ceiling, which reopens the
   "don't upgrade Helius yet" call from `Strategy-and-Roadmap.md` for
   Tristan to reconsider tomorrow. Don't decide that for him — just surface
   the evidence.
4. **Wire delayed evaluation into the live decision path — the actual top
   roadmap item.** Once there's a real `logs/delay-probe.jsonl` run with a
   meaningfully better data-quality picture (say, evaluable rate clearly
   above 50% at one of the delays), pick a delay from that data using the
   guidance already written in `scripts/analyze-delay-probe.ts`'s own output
   (look for where pass rate stops climbing and metric medians stop moving).
   Then change the live pipeline so a detected token is evaluated at t+N
   instead of t+0 — reusing `collectTokenMetrics`/the two-stage gate as they
   exist now, just delayed. Make the delay a config value
   (`config/default.json`), not a hardcoded constant. Write real tests
   (offline, following the existing `tests/` conventions — mocked
   `Connection`, no live network) proving: a token is NOT evaluated before
   its configured delay, IS evaluated at/after it, and the existing
   stage-1/stage-2 gate logic is otherwise unchanged. **If the data isn't
   good enough to defensibly pick a delay** (e.g., even the improved run
   still has a low evaluable rate), do NOT guess a number — log that
   clearly as a blocker for this specific step, move on to the rest of the
   track, and come back to it if time allows with whatever data exists by
   then.
5. **Re-run clean** (if a live run happened tonight) and log whether the
   filters actually discriminate now that Bugs 2/3 are fixed and evaluation
   is delayed.
6. **Re-tune thresholds** only if step 5 produced enough real data to
   justify it — `minUniqueWallets`/`minTransactionCount`/
   `maxTopHolderPercent` were never validated against real data at any age
   before tonight.
7. **Stretch goal if time remains:** event-driven exits (subscribe to logs
   for held tokens, react to a large dev-wallet transfer or large sell
   rather than polling) — see `Strategy-and-Roadmap.md` for why this is the
   one place exit speed genuinely pays. Full offline tests, same rigor as
   everything else.

---

## Track 2 — Rap career content system (build the engine, not the accounts)

No repo exists yet. Create one at
`~/Documents/TristansVault/RapCareerContentBot/` (or a better name if you
have one — just be consistent and put it in `OVERNIGHT-LOG.md`). Read
`Content-Bot-Research.md` and `RapNews-Research.md` from the Cowork project
first — platform feasibility, format research (Shade-Room-style
screenshot/text-card + caption), and the auto-post/flag-for-review risk
split are all already researched. Don't redo that research; build against it.

**The architecture question Tristan raised** ("one bot or two, maybe separate
accounts") **has a clean answer that doesn't require deciding tonight:**
build ONE shared engine with two independent **content strategies** plugged
into it:
- **Strategy A — his own artist promotion**: trend research → original
  content ideas/captions/scripts for his own music (per
  `Content-Bot-Research.md`).
- **Strategy B — RapNews**: hip-hop news monitoring → drafted posts in the
  Shade-Room-style format, run through the auto-post/flag classifier (per
  `RapNews-Research.md`).

Both strategies sit behind the same **posting abstraction** — an interface
like `PostingClient` with methods per platform (Instagram, TikTok, X,
YouTube), each implementation swappable. Tonight, implement ONLY a
`MockPostingClient` that writes "would have posted: {platform, account,
content, timestamp}" to a local JSONL queue instead of calling any real API.
This means the decision of "one account posting both streams" vs "two
separate accounts, two client instances" becomes a **config choice** made
tomorrow when real accounts exist, not an architecture decision baked in
tonight. Don't build real `InstagramPostingClient`/`TikTokPostingClient`/etc.
implementations tonight — that needs real API credentials, which is
explicitly tomorrow's work.

**Tonight's task order:**

1. Scaffold the repo: `package.json`, TypeScript config, `git init`, a
   `CLAUDE.md` for this new repo modeled on OPIUMO's (non-negotiables,
   testing conventions, "one piece at a time") so future sessions — including
   tomorrow's — have the same guardrails OPIUMO has. Explicitly write into
   it: "no real posting until Tristan wires up real accounts" as a
   standing rule, the same way OPIUMO's `CLAUDE.md` states its trading-safety
   non-negotiables.
2. Build the `PostingClient` interface + `MockPostingClient`, with tests.
3. Build Strategy A (own-content ideas) and Strategy B (RapNews drafts) as
   separate modules sharing the posting abstraction. For RapNews, actually
   implement the auto-post/flag classifier from the research doc (safe:
   drops/tours/charts/official statements; always flag: arrests, court
   cases, deaths, allegations, single-source claims, anything involving a
   minor) as real, tested logic — this is the highest-value, most concrete
   piece of tonight's work in this track.
4. If you have live web search/fetch access from this session, pull a real
   batch of current hip-hop news (same way it was done manually earlier
   today) and generate a real draft batch through the full pipeline,
   written to `drafts/REVIEW-<date>.md` in the Shade-Room-style
   screenshot/text-card + caption format, clearly split into
   auto-post-safe vs flagged-for-review, exactly like the manual batch from
   earlier today. If no live search access exists in this environment,
   build the pipeline against a small set of fixture/sample stories instead
   and say so clearly in the log — don't fabricate fake news as if it were
   real.
5. **Do not queue anything for real posting.** Everything lands in
   `drafts/REVIEW-<date>.md` for Tristan to read tomorrow, same as before.
6. Stretch goal: a simple CLI (`npm run generate-drafts`) that re-runs the
   whole pipeline on demand, so tomorrow's session (with him present) can
   generate a fresh batch easily once accounts exist.

---

## Track 3 — Options strategy research/selection ("continuously research and
match the best-fitting strategy to current market conditions")

**First: locate the existing OptionsBot repo before building anything new.**
`Options-Trading-Research.md` in the Cowork project references "the
OptionsBot's Day 1 scaffold" as already shipped, buy-only, on Alpaca's paper
API — but its repo path isn't recorded anywhere accessible to the cloud
session that wrote this prompt. Check likely locations
(`~/Documents/TristansVault/`, sibling folders near OPIUMO-, anything with
"option" in the name). **If you find it: read its own CLAUDE.md/README and
existing code before changing anything, and follow its established
conventions rather than this track's assumptions below.** If you genuinely
cannot find it after a real search, log that clearly and build a new minimal
scaffold instead, in a clearly-named new folder — do not guess at
conventions from a repo you can't see.

**Scope for tonight, once the repo situation is sorted:**

1. **Paper only, buy-only stays the active default** — this is not a task to
   flip the bot into selling spreads live, or at all, tonight. Per
   `Options-Trading-Research.md`: buying is a legitimate, safer starting
   point, and expanding to defined-risk selling (credit spreads/iron
   condors) is "a deliberate next decision, not an automatic one" that needs
   real backtesting first. Build toward that deliberately, don't shortcut it.
2. **Build a market-regime classifier**: using whatever market data the
   existing Alpaca integration already provides (or Alpaca's API directly if
   starting fresh), compute a small set of well-defined, explainable signals
   — implied-volatility percentile (or a reasonable proxy if IV data isn't
   directly available), recent realized volatility, and trend direction/
   strength over a few lookback windows. Log the actual numbers, not just a
   label — "why" has to be inspectable later, not a black box.
3. **Build a strategy-scoring module**: given the regime classifier's output,
   score a fixed menu of strategies (long call, long put, covered call,
   cash-secured put, and — built but disabled by default per the absolute
   rules above — credit spread/iron condor) against **quantifiable rules**,
   not vibes: specific IV-percentile thresholds, specific delta ranges for
   strike selection, specific days-to-expiry windows. Write the actual rule
   for each strategy as code and as a comment explaining the reasoning, so
   Tristan (not a licensed advisor, and neither are you — this is mechanical
   rule-following, not investment advice) can read and adjust the rules
   himself later.
4. **Backtest before anything touches paper execution.** Per
   `Options-Trading-Research.md`'s own summary of Alpaca's guidance: rules →
   clean data → signal generation → backtest → risk management → paper
   validation, in that order. Do not skip to paper execution of new logic
   without a backtest first, even though paper trading itself is safe — the
   point is not risking simulated capital on unvalidated rules, it's proving
   the rules do what they're supposed to before they run at all.
5. Everything here should read like the same "fail closed, log every
   decision, distinguish null-from-unknown vs a real zero" discipline
   already established in OPIUMO's codebase — that's the house style now,
   carry it over rather than reinventing conventions.
6. **Never let this track touch the live/real half of any broker account.**
   If at any point real credentials or a live-trading toggle would be
   needed to "finish" a task, stop short of that specific action, build
   everything up to it, and log exactly what's left for Tristan.

---

## Priority if the night runs out before everything does

1. Track 1 steps 1-4 (OPIUMO: confirm commit, lower sample rate, collect
   cleaner data if possible, wire delayed evaluation if the data supports
   it) — this has the most existing context and the clearest payoff.
2. Track 2 steps 1-4 (content engine + RapNews classifier + a real draft
   batch) — concrete, low-risk, immediately reviewable tomorrow.
3. Track 3 — start with locating/reading the existing OptionsBot repo and
   the regime classifier; the scoring module and backtest can continue
   tomorrow with Tristan if they don't finish.

## Before you're "done" (or before you run out of time)

Write a top-level `## Morning Summary` section at the very top of
`OVERNIGHT-LOG.md` (or the shared log) — written for someone reading it once,
half-asleep, over coffee: what actually got built and verified (not just
attempted), what's still open, what needs Tristan's input today, and
anything that looked wrong or risky enough that it should be checked before
trusting it. Be honest if something didn't work — a clear "this failed and
here's why" is more useful than silence. Goodnight.
