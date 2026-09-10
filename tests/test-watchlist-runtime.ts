/**
 * Offline, deterministic, no network, no RNG.
 *
 * `policy.ts` is tested separately and covers the decision rules. This suite
 * covers the things only the runtime can get wrong, and every one of them is a
 * property that would be expensive to discover in production:
 *
 *   - the RPC budget is a hard ceiling, and overflow WAITS rather than vanishing
 *   - dead tokens are evicted so the set cannot grow without bound
 *   - the expensive evaluation is rare, which is the entire justification for
 *     watching thousands of tokens at all
 *   - the watchlist adds no new route to a buy
 *
 * The connection is a stub. Nothing here touches the network, and the log is
 * redirected to a temp file so fixture tokens can never reach the real one.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { Watchlist } from "../src/watchlist/watchlist";
import { NewPoolEvent } from "../src/watcher/types";

/**
 * Valid base58 addresses, built from bytes. An earlier version of this suite
 * used strings like "POOL0", which `new PublicKey()` rejects - so the runtime
 * never reached the stub and every RPC assertion silently measured nothing.
 */
const poolKey = (n: number): string => {
  const bytes = new Uint8Array(32);
  bytes[0] = n + 1;
  bytes[31] = 7;
  return new PublicKey(bytes).toBase58();
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchlist-"));
const T0 = Date.parse("2026-09-09T12:00:00.000Z");

/**
 * A stub `Connection` that answers `getBalance` from a scripted table and
 * counts every call, so a test can assert on exactly how much RPC was spent.
 */
function stubConnection(balancesByPool: Record<string, number[]>) {
  const calls: string[] = [];
  const cursor: Record<string, number> = {};
  return {
    calls,
    conn: {
      getBalance: async (pk: { toBase58(): string }) => {
        const key = pk.toBase58();
        calls.push(key);
        const series = balancesByPool[key] ?? [0];
        const i = Math.min(cursor[key] ?? 0, series.length - 1);
        cursor[key] = (cursor[key] ?? 0) + 1;
        return Math.round(series[i] * 1e9); // lamports
      },
    } as any,
  };
}

function evt(n: number): NewPoolEvent {
  return {
    source: "pumpfun",
    signature: `sig${n}`,
    slot: 1000 + n,
    mint: `MINT${n}`,
    poolAddress: poolKey(n),
    detectedAt: new Date(T0).toISOString(),
  } as NewPoolEvent;
}

const cfg = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  tickIntervalMs: 15_000,
  maxChecksPerTick: 12,
  maxWatched: 4000,
  deadBelowSol: 0.05,
  patienceChecks: 5,
  maxAgeMs: 21_600_000,
  promoteOnMultiple: 2.5,
  promoteOnAbsoluteSol: 3,
  maxFullChecksPerToken: 4,
  graduationSol: 85,
  nearMigrationFraction: 0.7,
  intervalFreshMs: 60_000,
  intervalWarmingMs: 30_000,
  intervalNearMigrationMs: 15_000,
  ...over,
});

const logPath = (n: string) => path.join(tmpDir, `${n}.jsonl`);
const readLog = (p: string) =>
  (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "").split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function main() {
  console.log("=== the RPC budget is a hard ceiling ===\n");
  {
    const pools: Record<string, number[]> = {};
    for (let i = 0; i < 30; i++) pools[poolKey(i)] = [0.01];
    const { conn, calls } = stubConnection(pools);
    const lp = logPath("budget");
    const wl = new Watchlist(conn, {}, cfg({ maxChecksPerTick: 5 }), {}, lp);

    for (let i = 0; i < 30; i++) wl.add(evt(i), 0.01, T0);
    check("all 30 are being watched", wl.stats().watching === 30, `${wl.stats().watching}`);

    // Everything is due an hour later, but only 5 checks are allowed.
    await wl.tick(T0 + 60_001);
    check("exactly maxChecksPerTick RPC calls were made, not one more", calls.length === 5, `${calls.length}`);

    const skips = readLog(lp).filter((r) => r.event === "skipped-budget");
    check("the overflow is recorded rather than silently dropped", skips.length > 0);
    check("...and says how many waited", skips.some((s) => s.skipped === 25), JSON.stringify(skips.map((s) => s.skipped)));
    check("skipped tokens are still watched, not discarded", wl.stats().watching === 30);

    await wl.tick(T0 + 60_002);
    check("the next tick picks up more of them", calls.length === 10, `${calls.length}`);
    wl.stop();
  }

  console.log("\n=== dead tokens are evicted, so the set cannot grow forever ===\n");
  {
    const pools: Record<string, number[]> = {};
    for (let i = 0; i < 6; i++) pools[poolKey(i)] = [0.002]; // the real median: dust, flat
    const { conn } = stubConnection(pools);
    const wl = new Watchlist(conn, {}, cfg({ maxChecksPerTick: 50 }), {}, logPath("evict"));
    for (let i = 0; i < 6; i++) wl.add(evt(i), 0.002, T0);

    let t = T0;
    for (let round = 0; round < 8; round++) {
      t += 60_001;
      await wl.tick(t);
    }
    check("flat dust tokens are all evicted", wl.stats().watching === 0, `${wl.stats().watching} still watched`);
    check("...and the eviction is counted", wl.stats().evicted === 6, `${wl.stats().evicted}`);
    wl.stop();
  }

  console.log("\n=== the expensive evaluation stays rare ===\n");
  {
    // 19 dust tokens and one real winner, using the observed 0.278 -> 4.348 path.
    const pools: Record<string, number[]> = {};
    for (let i = 0; i < 19; i++) pools[poolKey(i)] = [0.002];
    pools[poolKey(19)] = [0.278, 0.9, 2.1, 4.348];

    const { conn } = stubConnection(pools);
    let fullEvaluations = 0;
    const wl = new Watchlist(
      conn,
      {},
      cfg({ maxChecksPerTick: 50 }),
      {},
      logPath("rare")
    );
    // Count promotions from the log rather than stubbing the metrics call - the
    // full evaluation throws against a stub connection, which the runtime
    // catches, so the promotion record is the honest signal that it fired.
    for (let i = 0; i < 20; i++) wl.add(evt(i), i === 19 ? 0.278 : 0.002, T0);

    let t = T0;
    for (let round = 0; round < 4; round++) {
      t += 60_001;
      await wl.tick(t);
    }
    const promotions = readLog(logPath("rare")).filter((r) => r.event === "promoted");
    fullEvaluations = promotions.length;

    check("the winner was promoted to a full evaluation", promotions.some((p) => p.mint === "MINT19"), JSON.stringify(promotions.map((p) => p.mint)));
    check(
      "no dust token was ever promoted",
      promotions.every((p) => p.mint === "MINT19"),
      promotions.map((p) => p.mint).join(",")
    );
    check(
      `expensive evaluations stayed rare (${fullEvaluations} across 20 tokens)`,
      fullEvaluations <= 4,
      `${fullEvaluations}`
    );
    wl.stop();
  }

  console.log("\n=== a failed liquidity read is not a zero ===\n");
  {
    // getBalance throws, which is the transient-failure path.
    const conn = { getBalance: async () => { throw new Error("429 Too Many Requests"); } } as any;
    const wl = new Watchlist(conn, {}, cfg({ maxChecksPerTick: 10 }), {}, logPath("nulls"));
    wl.add(evt(1), null, T0);
    await wl.tick(T0 + 60_001);
    const checked = readLog(logPath("nulls")).filter((r) => r.event === "checked");
    check("a check was recorded", checked.length === 1);
    check(
      "with no baseline, growth is null rather than a fabricated number",
      checked[0].growth === null || checked[0].growth === undefined,
      JSON.stringify(checked[0])
    );
    wl.stop();
  }

  console.log("\n=== it adds no new route to a buy ===\n");
  {
    const pools = { [poolKey(1)]: [1, 5, 20] };
    const { conn } = stubConnection(pools);
    let onPassCalls = 0;
    const wl = new Watchlist(
      conn,
      { onPass: async () => { onPassCalls++; } },
      cfg({ maxChecksPerTick: 10 }),
      {},
      logPath("nobuy")
    );
    wl.add(evt(1), 1, T0);
    let t = T0;
    for (let i = 0; i < 3; i++) { t += 60_001; await wl.tick(t); }

    const log = readLog(logPath("nobuy"));
    check("the token was promoted", log.some((r) => r.event === "promoted"));
    check(
      "onPass never fired, because the full evaluation could not PASS against a stub",
      onPassCalls === 0,
      `${onPassCalls}`
    );
    check(
      "no 'pass' was recorded either - a promotion is not a pass",
      !log.some((r) => r.event === "pass"),
      "promotion means 'worth a closer look', never 'buy it'"
    );
    wl.stop();
  }

  console.log("\n=== disabled means disabled ===\n");
  {
    const { conn, calls } = stubConnection({ [poolKey(1)]: [1] });
    const lp = logPath("off");
    const wl = new Watchlist(conn, {}, cfg({ enabled: false }), {}, lp);
    wl.add(evt(1), 1, T0);
    await wl.tick(T0 + 60_001);
    check("nothing is watched", wl.stats().watching === 0);
    check("no RPC calls are made", calls.length === 0);
    wl.stop();
  }

  console.log("\n=== the watchlist ceiling is visible, not silent ===\n");
  {
    const { conn } = stubConnection({});
    const lp = logPath("cap");
    const wl = new Watchlist(conn, {}, cfg({ maxWatched: 3 }), {}, lp);
    for (let i = 0; i < 6; i++) wl.add(evt(i), 0.01, T0);
    check("stops at maxWatched", wl.stats().watching === 3, `${wl.stats().watching}`);
    const refusals = readLog(lp).filter((r) => r.event === "skipped-budget" && r.reason?.includes("watchlist full"));
    check("every refusal is recorded", refusals.length === 3, `${refusals.length}`);
    wl.stop();
  }

  console.log("\n=== tests never write to the production watchlist log ===\n");
  {
    const prod = "logs/watchlist.jsonl";
    const contents = fs.existsSync(prod) ? fs.readFileSync(prod, "utf8") : "";
    check(
      "no fixture mint reached logs/watchlist.jsonl",
      !contents.includes("MINT1") && !contents.includes(poolKey(1)),
      "the log override is not being applied"
    );
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
}

main();
