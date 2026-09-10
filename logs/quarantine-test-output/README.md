# Quarantined test output

These records were written into PRODUCTION logs by the test suite. They are
kept, not deleted, because they are evidence of how long the leak ran and of
what it wrote.

Nothing here is real bot activity. Every record carries a fixture identifier
that only exists in tests/.

| file | records | origin | fixture marker |
|---|---:|---|---|
| `trades.jsonl` | 156 | `logs/trades.jsonl` | `Mint111111111111111111111111111111111111111` |
| `decisions-rotated.jsonl` | 42 | `logs/decisions.2026-09-09T23-22-31-356Z.jsonl` | `MintAddress1111111111111111111111111111111` |

**Leak sites, since fixed:**

- `tests/test-trading-engine-gating.ts` and `tests/test-trading-reconciliation.ts`
  constructed `new SpotTradeLog()` with no path, which defaults to
  `config.logging.tradesFile`. 39 rejected-buy and 117 reconciliation-mismatch
  records, 2026-09-08 to 2026-09-10. The gating test carried a comment claiming
  the real trade log was "cleaned up like other tests"; it was not.
- `tests/test-filters.ts` constructed `new DecisionLog()`, which took **no path
  argument at all**, so it could only write to `logs/decisions.jsonl`. 78 fixture
  PASS/SKIP records across the live and rotated files.

**Still to clean:** 36 fixture records remain in the LIVE `logs/decisions.jsonl`.
They were left in place deliberately - the bot is running and appending to that
file, and rewriting it underneath a live writer would lose real records. They
come out at the next planned restart.
