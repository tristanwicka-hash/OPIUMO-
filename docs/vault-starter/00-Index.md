# OPIUMO - Index

Front door for the whole project. Everything links from here.

## The bot
- Repo: `~/Desktop/opiumo/bot` (branch `claude/solana-token-trading-bot-xpqxv0`)
- Working agreement for Claude: `bot/CLAUDE.md`
- Full technical detail: `bot/README.md`

## Project
- [[Decisions]] - what was decided, when, and why
- [[Config-Reference]] - every setting and the reasoning behind its value

## Strategies
- [[Meme-Snipe-Scalp]] - the spot sniper
- [[Funding-Rate-Arb]] - the Drift perps strategy

## Running it
- [[03-Journal/_Daily-Template|Daily journal template]]
- Logs live in `bot/logs/` - `decisions.jsonl`, `paper-trades.jsonl`, `trades.jsonl`

## Research
- [[Competitors]] - what other Solana bots do
- [[Latency-and-Execution]] - how fast the pros are, and why

## Sessions
- [[05-Sessions/_Handoff-Template|Handoff template]]

## Current state (update this line as it changes)
Parts 1-10 built. All 239 offline tests pass. Live/network paths have never
successfully run. Next: first paper-trading run against live Solana data.
