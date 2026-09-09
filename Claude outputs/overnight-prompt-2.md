# Overnight work order — 2026-09-09 (second run)

You're a local Claude Code session working on Tristan's Mac, continuing from last night's work across the OPIUMO, RapNews/ContentBot, and OptionsBot repos, all siblings under `~/Documents/TristansVault/`. This is a new no-approval-needed overnight session — work through the tracks below on your own judgment, in priority order, and write a summary at the end. Tristan will read your summary in the morning; he cannot answer questions while you're running, so if something is genuinely ambiguous, make the safest reasonable choice, note the assumption in your summary, and keep going rather than stopping.

## Absolute rules — never violate these, no matter what

1. **Never flip a live-trading flag.** `trading.enabled`, `perps.enabled`, `fundingArb.enabled` in OPIUMO's `config/default.json` stay `false`. `paperTrading` stays `true`. Never submit a real (non-paper, non-simulated) order to Alpaca, a DEX, or any broker. OptionsBot's Alpaca calls are paper-only — its existing `.env` has real Alpaca *paper* credentials; that's fine to use for paper trades and for pulling historical/reference data, never for anything that could touch a live account.
2. **Never create a real social media account, complete an OAuth flow, or post anything to a real Instagram/TikTok/X/YouTube account.** Every posting client stays mocked or stubbed. If you build something new that would eventually post somewhere real, build it behind a clean interface (matching the existing `PostingClient`/`MockPostingClient` pattern in RapNews) with only the mock wired up.
3. **Never commit a secret, or put one directly in source.** Config values live in `.env` (gitignored) or config files with the value left blank. Don't sign up for any new paid service or API on Tristan's behalf — that requires his own account and payment method. If a usable API key already sits in an existing `.env` for something unrelated, it's fine to reuse it for testing at small scale; don't go looking for ways to spend money that isn't already set up.
4. **Never silently widen an existing safety restriction.** OptionsBot's hard refusal on sell/put-write/multi-contract orders stays exactly as strict as it is now. If backtesting surfaces a case for eventually supporting credit spreads, write it up — don't build it live.
5. **Normal git hygiene.** No force-push, no history rewrite. Any brand-new repo you create tonight stays local-only — do not create a GitHub remote or push anywhere. Existing repos keep whatever remote they already have; just don't push if you're not sure it's wanted.
6. **Log everything, the same discipline as always.** Every real finding, bug, or decision goes in `~/Documents/TristansVault/OVERNIGHT-LOG.md` (the shared log, not inside any repo) as you go, not reconstructed at the end.

## Before starting

Read, in this order: `~/Documents/TristansVault/OVERNIGHT-LOG.md` (last night's log), each repo's own `CLAUDE.md` if present, and `~/Documents/TristansVault/Tristans Vault/04-Research/Strategy-and-Roadmap.md`, `OPIUMO-Handoff.md`, `Viral-Content-Bot-Research.md`, and `Options-Trading-Research.md` (synced there tonight from the Cowork project — if any of those four aren't there, note it in your summary rather than guessing at their contents). These hold the actual research and decisions behind everything below — don't re-derive them from scratch.

---

## Track 1 — OPIUMO: restart the bot so it actually collects the data it's supposed to

**The problem:** `config/default.json` has `delayProbe.delaysSeconds: [30, 120, 300, 1800, 7200]`, but the currently-running bot process was almost certainly started before that config change landed, and Node reads config once at startup — so it's been running for 13+ hours producing zero observations at the 1800s/7200s delays no matter how long it's left alone.

1. **Check what's actually running:** `pgrep -fl "node dist/src/index.js"` (or equivalent). If you find more than one matching process, that's the stale-duplicate-process theory from last night's log confirmed — note it in the log, and kill all of them (paper-only bot, no risk in stopping it).
2. **Confirm the config on disk** has the 5-value `delaysSeconds` array and `sampleRate: 0.08` before restarting.
3. **Restart cleanly:** stop whatever's running (`Ctrl+C` / `kill`, not `kill -9` unless it won't stop), `npm run build`, then `npm start` (or however it's normally launched) so it picks up the current config fresh. Confirm via the first few `probe-stats` lines in `logs/delay-probe.jsonl` that `sampleRate` reads `0.08` — that's your signal the fresh config actually loaded.
4. **Let it run for the rest of the session.** Don't stop it again unless something's actively broken. The goal is real observations at 1800s and 7200s by morning.
5. **Before finishing, run `npm run report:delay-probe`** on the accumulated data and paste the output (or a summary of the 1800s/7200s buckets specifically, if they exist) into your summary. Don't hand-interpret it beyond what the report actually says — if there's not enough data yet at the longer delays, say so plainly rather than drawing a conclusion from a handful of observations.

Nothing else in OPIUMO needs touching tonight unless you find something broken.

---

## Track 2 — Scaffold the Viral Content Bot (new, third repo)

A general-audience YouTube Shorts channel, unrelated to Tristan's music, meant to eventually make money on its own. Full research is in `Viral-Content-Bot-Research.md` — read it before building anything, it has real numbers on monetization thresholds, RPM, cost tiers, and (important) why fully-automated clip/compilation content is riskier than AI-narrated original content (YouTube's reused-content policy enforces channel-wide demonetization against templated compilations). Build toward **AI-narrated original content**, not clip compilation.

1. **New repo:** `~/Documents/TristansVault/ViralContentBot/` — `git init`, standard `.gitignore` (node_modules, .env, dist, logs, media output), a `CLAUDE.md` matching the style of the other three repos' (plain-language, non-negotiables, repo facts), a `README.md`.
2. **Pipeline architecture, each stage behind a clean interface with a mock/stub implementation** (same pattern as `PostingClient`/`MockPostingClient` in RapNews) so the whole thing is testable without any real account or paid API:
   - `ScriptGenerator` — takes a niche/topic, returns a short narration script. Check `.env`/existing config across the other repos for a usable Anthropic (or other LLM) API key first; if one exists, it's fine to wire up a real implementation behind the interface for small-scale testing. If none exists, build `MockScriptGenerator` (fixture-based, deterministic) and leave the real implementation as a clearly-marked stub — don't sign up for a new API key.
   - `VoiceSynthesizer` — takes a script, returns an audio file. Same pattern: check for an existing usable key first; otherwise stub it, and for actually testing the assembly pipeline end-to-end, it's fine to use whatever built-in local TTS the Mac has (e.g. the `say` command) purely as a placeholder voice for pipeline testing — clearly labeled as a placeholder, not the real voice.
   - `VisualsProvider` — takes a script/topic, returns background visuals (stock clip, AI image, or simple generated background). Stub with locally-generated placeholder visuals (solid color/gradient frames, or simple text-on-background) so assembly can be tested without any stock-footage account.
   - `VideoAssembler` — this one should be **real, not mocked**, since it's pure local processing (ffmpeg or similar, check what's installed) with no external account needed: combine narration audio + visuals + burned-in captions into an actual short-form video file. Test this end-to-end using the placeholder audio/visuals above — a real, playable (if placeholder-quality) video file coming out the other end is the actual proof the pipeline works.
   - `UploadClient` / `MockUploadClient` — same mock-first pattern as `PostingClient`. No real YouTube account exists yet; the mock just records "would have uploaded" the same way RapNews's mock posting client does.
3. **A CLI** (`npm run generate`, matching RapNews's pattern) that runs script → voice → visuals → assembly → (mock) upload end-to-end for a given topic, and writes the resulting video file + a metadata record to a `drafts/` or `output/` folder.
4. **Tests** for every stage, offline/deterministic where the stage is mocked, and at least one real end-to-end run producing an actual video file from the placeholder pipeline.
5. **Do not** create a YouTube channel, Google Cloud project, or any AI-tool subscription. Do not spend real money. This is scaffold-and-prove-the-pipeline work, not go-live work.

---

## Track 3 — OptionsBot: add real backtesting

The market-regime classifier and strategy scoring built last night are the "signal generation" piece of the 8-step framework in `Options-Trading-Research.md`. **Backtesting is the missing piece** — right now nothing validates the scoring rules against historical data before they'd ever run in paper mode.

1. **Pull historical data via the existing Alpaca paper credentials** (already in `OptionsBot/.env`, real paper account, no new signup needed) — historical price/options data endpoints don't require anything beyond what's already configured, and don't touch live trading.
2. **Build a backtest runner:** feed historical data through the existing market-regime classifier and strategy-scoring logic exactly as they'd run live, and record what the strategy *would* have done at each point, without placing any order (paper or otherwise) — pure historical replay.
3. **Compute the metrics `Paper-Trading-Evaluation-Framework.md` and `Options-Trading-Research.md` both call for:** expectancy (not just win rate — the research is explicit that win rate alone is close to useless, especially for anything with a "frequent small wins, rare big loss" shape), a rough Sharpe/risk-adjusted number, and max drawdown. Don't trust or report a conclusion from a small sample — say plainly how many historical signals the backtest actually covered.
4. **Keep buy-only enforcement completely untouched.** The backtest can *simulate* what a defined-risk credit-spread strategy would have done, purely as historical analysis/research (no real or paper order involved either way) — but the live/paper trading code path stays exactly as restricted as it is now. If the backtest data makes a case for eventually building toward credit spreads, write that up as a finding, not as code that runs.
5. **Tests** for the backtest runner itself (deterministic, against a small synthetic historical fixture) so its numbers are trustworthy rather than just "ran once and looked at output."

---

## Priority if the night runs out

1. Track 1 (OPIUMO restart) — takes 10 minutes, then just needs to keep running in the background while you work on the others. Do this first so it has the whole night to collect data.
2. Track 2 (Viral Content Bot scaffold) — the newest, most valuable unblocked work.
3. Track 3 (OptionsBot backtesting) — valuable, but lower urgency since nothing is time-sensitive about it the way OPIUMO's data collection is.

## Before you're done

Update `~/Documents/TristansVault/OVERNIGHT-LOG.md` with a Morning Summary section: what got built and verified (with real command output, not just "tests pass"), what's still open, and anything that needs Tristan's actual input (a decision, a credential, a judgment call). Be honest about what's untested vs. verified — that distinction matters more than making the summary sound complete.
