# CLAUDE.md - working agreement for this repo

Read this before doing anything. It is loaded automatically into every
Claude Code session, so it holds the rules that never change. `README.md`
holds the detail (what each part does, what's tested, what isn't).

## What this project is

OPIUMO: a Solana new-token filter/sniper bot for Pump.fun and Raydium
launches, plus a separate perpetuals track on Drift Protocol. TypeScript,
Node, CLI only - no web UI. Built incrementally in 10 parts; see the Status
table in README.md.

## Who you're working with

The owner is **new to coding and to crypto infrastructure**. Explain things
in plain language. Define jargon the first time you use it. When something
fails, say what failed and what it means in practice, not just the stack
trace. Never assume familiarity with git, npm, Solana concepts, or shell
conventions.

## Non-negotiables - never change these without asking first

1. **No auto-execution until the filter logic has been manually verified.**
   `trading.enabled`, `perps.enabled`, and `fundingArb.enabled` all default
   to `false`. `trading.paperTrading` defaults to `true`. Real money is only
   ever at risk when BOTH `trading.enabled: true` AND
   `trading.paperTrading: false`. Never flip any of these as a side effect
   of another change.
2. **All tunables live in `config/default.json`.** Never hardcode a
   threshold, size, interval, or URL in source. Secrets live in `.env` only
   (never committed - this repo is PUBLIC).
3. **Every decision is logged** to the console AND to `logs/*.jsonl` in real
   time, with the reason attached. A decision that isn't logged didn't
   happen.

## How to work here

- **One piece at a time.** Build it, test it, show the result, then move on.
  Never dump a large amount of code in a single step.
- **Every change gets `npm run typecheck` plus the relevant test suite run
  before you call it done.** Show the actual output.
- **Fail closed.** Unknown or unverifiable data is always treated as a
  failing condition, never silently passed. A failed RPC call must never be
  reported the same way as a confirmed negative finding - `null` ("couldn't
  check") and `false` ("checked, it's bad") are different and are worded
  differently everywhere.
- **Be honest about verification.** Distinguish "I ran this and it passed"
  from "this typechecks but has never executed against real data." Never
  claim something works if it hasn't actually been run.
- **Don't silently widen scope.** If you spot an unrelated problem, say so
  and ask, rather than fixing it inside an unrelated change.

## Commands

```bash
npm run dev          # run the spot sniper from source
npm run perps        # run the perps/funding-arb track from source
npm test             # every test suite
npm run typecheck    # types only, no build
npm run build        # compile to dist/  (entry points are dist/src/*.js)
```

Individual suites: `test:rpc`, `test:watcher`, `test:metrics`,
`test:filters`, `test:logger`, `test:perps-risk`, `test:perps-connection`,
`test:funding-arb-signals`, `test:funding-arb-live`, `test:trading-signals`,
`test:trading-engine-gating`, `test:trading-retry`,
`test:trading-reconciliation`, `test:trading-human-units`,
`test:trading-live`, `test:paper-trading`.

## Testing conventions

- **Offline suites** are pure/deterministic (mocked `Connection`, mocked
  `global.fetch`, or pure functions). They must always pass. 239 assertions
  as of Part 10.
- **Live suites** (`test:rpc`, `test:trading-live`, `test:perps-connection`,
  `test:funding-arb-live`) need real network access to Solana/Jupiter/Drift.
  They were written in a sandbox with **zero** network access to those
  hosts, so they have only ever been verified to *fail gracefully* - they
  have never actually succeeded. Treat a first successful run on a real
  machine as new information worth reporting.
- Private methods are tested via an `(x as any).method()` cast - the
  established pattern in `test-watcher.ts` and `test-trading-reconciliation.ts`.
- **Never mutate `config/default.json` from a test.** It gates real trading.
  If a test would need a different config, scope it out and say so instead.

## Repo facts

- Remote: `https://github.com/tristanwicka-hash/OPIUMO-` (**public**)
- Working branch: `claude/solana-token-trading-bot-xpqxv0`. **There is no
  `main` branch** - all work lives on that branch.
- `tsconfig.json` uses `rootDir: "."` so `tests/` can import `../src/...`.
  That means the build output is `dist/src/index.js`, NOT `dist/index.js`.
  Paths to files on disk resolve against `process.cwd()`, never `__dirname`.

## Unit convention (important, easy to get wrong)

Every `priceSol` value in `src/trading/` means **SOL per RAW token unit**
(the smallest on-chain unit), not per whole token. It is internally
consistent, so ratios and differences are correct, but printed values look
tiny. `src/trading/humanUnits.ts` converts to human-readable values **for
display and logging only** - never feed a human-unit value back into the
trading math.

## Project notes / knowledge vault

Longer-form context - strategy reasoning, tuning decisions, trade journal,
competitor research, session handoffs - lives in an Obsidian vault kept
**outside this repo**, as a **sibling directory** of it, so it is never
committed to a public repo. The expected layout, wherever the repo is
checked out:

```
opiumo/                 <- any parent directory
├── OPIUMO-/            <- this repo
└── Vault/              <- the Obsidian vault (private, never committed)
```

So from the repo root the vault is `../Vault`. If it is present in the
workspace, read `../Vault/00-Index.md` when you need background on *why* a
threshold or design choice is the way it is.

If `../Vault` does not resolve, look in the parent directory for a sibling
whose name contains "Vault" or "vault" (case-insensitive) before concluding
there is no vault - the folder has been named both ways. Starter templates
for the vault are in `docs/vault-starter/`.
