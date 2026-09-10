/**
 * Exit-code contract shared by every suite and by the runner.
 *
 * ## Why this file exists
 *
 * Perps Drift and Funding-arb live both SKIP when WALLET_PRIVATE_KEY is unset,
 * and both used `process.exit(1)`. The runner could not tell that from a real
 * failure, so it counted both as failures and the banner explained them away as
 * "needs live network access" - which was not even the right reason. The
 * consequence: a genuine regression in either suite would have produced
 * BYTE-IDENTICAL output to a healthy run. The suite was unfalsifiable.
 *
 * So a skip gets its own code. 0 = passed, 2 = deliberately skipped, anything
 * else = failed. A suite that crashes still exits 1 (or a signal code), so the
 * default for an unexpected outcome remains "failed", not "skipped".
 */
import fs from "fs";

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
/** Deliberately not run - a precondition (credentials, a file, a service) is absent. */
export const EXIT_SKIP = 2;

/**
 * Where a skipping suite writes its reason so the runner can report it by name.
 *
 * The runner spawns suites with stdio "inherit" so their output streams live,
 * which means it cannot also capture that output to parse a reason out of it.
 * Rather than give that up (or re-derive the reason from the suite name, which
 * would be the runner guessing), the runner names a file and the suite writes
 * the exact reason into it.
 */
export const SKIP_REPORT_ENV = "OPIUMO_SKIP_REPORT";

/** Prints a skip reason, records it for the runner, and exits with EXIT_SKIP. */
export function skip(reason: string): never {
  console.error(`SKIPPED: ${reason}`);
  const target = process.env[SKIP_REPORT_ENV];
  if (target) {
    try {
      fs.writeFileSync(target, reason);
    } catch {
      // The reason is already on stderr; failing to record it must not turn a
      // skip into a crash.
    }
  }
  process.exit(EXIT_SKIP);
}
