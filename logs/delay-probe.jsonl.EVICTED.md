# delay-probe.jsonl — EVICTED by iCloud Drive, data status UNKNOWN

`logs/delay-probe.jsonl` was replaced by an iCloud placeholder
(`.delay-probe.jsonl.icloud`, 169 bytes) while the vault lived under
`~/Documents` (iCloud Drive, "Optimize Mac Storage"). The placeholder recorded
the real file as **2,982,320 bytes**. The vault moved to `~/Projects` on
2026-09-12; the placeholder came with it and the bytes did not, so the file is
not on this machine. It may still exist in iCloud (iCloud.com → Drive, or
Recently Deleted) — retrieving it is Tristan's call.

What is known about its contents comes only from the reports written while it
existed (`reports/delay-probe-2026-09-09T*.md`, ~4,100 observations across the
30 s / 120 s / 300 s / 1800 s / 7200 s ladder) and the comment on
`delayProbe` in `config/default.json`. Any per-observation question about that
period is **UNKNOWN**, not zero. The probe is disabled (`delayProbe.enabled:
false`), so nothing has been written to this path since 2026-09-09 23:20 UTC
and nothing is being lost now. `npm run report:delay-probe` reports the file
as missing rather than empty.
