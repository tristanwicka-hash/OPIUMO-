/**
 * Offline tests for the outcome tracker's state handling - no network, no RNG.
 *
 * These exist because the tracker originally shipped with only its *analysis*
 * tested, and two real bugs got through that gap: a pending cap far below
 * steady-state demand, and a full-map synchronous rewrite on every detection.
 * Neither is visible in a unit test of the maths, and neither shows up in the
 * first half hour of running - they only appear once pending state accumulates.
 * So the properties asserted here are about state growth and write behaviour,
 * not about arithmetic.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Connection } from "@solana/web3.js";
import { OutcomeTracker } from "../src/data/outcomeTracker";
import { NewPoolEvent } from "../src/watcher/types";

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opiumo-outcome-"));
// Never touches the network: no checkpoint in these tests is ever due while the
// test runs, so runCheck() (the only thing that calls the RPC) is never reached.
const connection = new Connection("http://127.0.0.1:1/never-used");

function evt(mint: string): NewPoolEvent {
  return {
    source: "pumpfun",
    signature: "5".repeat(88),
    slot: 123456,
    mint,
    poolAddress: "P".repeat(44),
    creator: "C".repeat(44),
    pumpfunAssociatedBondingCurve: "A".repeat(44),
    detectedAt: new Date().toISOString(),
  } as NewPoolEvent;
}

function makeTracker(over: Record<string, unknown> = {}, name = "state") {
  const statePath = path.join(tmpDir, `${name}-${Math.random().toString(36).slice(2)}.json`);
  const tracker = new OutcomeTracker(connection, {
    enabled: true,
    checkpointsSeconds: [3600, 21600, 86400],
    maxConcurrentChecks: 1,
    maxQueuedChecks: 10,
    maxPendingCheckpoints: 60000,
    sampleRate: 1,
    pendingStateFile: statePath,
    lateToleranceMs: 3_600_000,
    persistDebounceMs: 50,
    ...over,
  } as any);
  return { tracker, statePath };
}

const readState = (p: string): any[] => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("=== Persisted state is trimmed, not the whole event ===\n");
  {
    const { tracker, statePath } = makeTracker({}, "trim");
    tracker.schedule(evt("MINT_TRIM"), 1.5);
    tracker.stop(); // flushes synchronously

    const state = readState(statePath);
    check("one entry per checkpoint", state.length === 3, `got ${state.length}`);
    const keys = Object.keys(state[0].event).sort();
    check(
      "only the five fields a balance read needs are stored",
      JSON.stringify(keys) === JSON.stringify(["detectedAt", "mint", "poolAddress", "signature", "source"]),
      keys.join(",")
    );
    check("creator is NOT persisted", !("creator" in state[0].event));
    check("slot is NOT persisted", !("slot" in state[0].event));
    check("associated bonding curve is NOT persisted", !("pumpfunAssociatedBondingCurve" in state[0].event));
    check("baseline is carried through", state[0].baselineLiquiditySol === 1.5);
    check("dueAtMs is absolute, not relative", state[0].dueAtMs > Date.now());
  }

  console.log("\n=== Writes are debounced, not one per detection ===\n");
  {
    const { tracker, statePath } = makeTracker({ persistDebounceMs: 200 }, "debounce");

    // 50 detections in a tight loop. Before the fix this was 50 synchronous
    // rewrites of the entire map; now it must collapse into one deferred write.
    for (let i = 0; i < 50; i++) tracker.schedule(evt(`MINT_D${i}`), 0.1);

    check("nothing written yet - the write is deferred, not immediate", !fs.existsSync(statePath));
    await sleep(350);
    const state = readState(statePath);
    check("one write lands after the debounce window", state.length === 150, `got ${state.length}`);
    check("...and it contains every scheduled checkpoint", new Set(state.map((s: any) => s.event.mint)).size === 50);
    tracker.stop();
  }

  console.log("\n=== stop() flushes synchronously rather than losing the pending write ===\n");
  {
    const { tracker, statePath } = makeTracker({ persistDebounceMs: 60_000 }, "flush");
    tracker.schedule(evt("MINT_FLUSH"), 2);
    check("debounce is long enough that nothing has been written", !fs.existsSync(statePath));
    tracker.stop();
    check("stop() wrote it anyway - shutdown is exactly when a deferred write would be lost", readState(statePath).length === 3);
  }

  console.log("\n=== The pending cap refuses new work rather than growing without bound ===\n");
  {
    const { tracker } = makeTracker({ maxPendingCheckpoints: 6, persistDebounceMs: 10 }, "cap");
    for (let i = 0; i < 10; i++) tracker.schedule(evt(`MINT_C${i}`), 1);
    const s = tracker.stats();
    check("stops at the cap", s.pendingCheckpoints <= 6, `pending=${s.pendingCheckpoints}`);
    check("scheduled count reflects only what was accepted", s.scheduled === 6, `scheduled=${s.scheduled}`);
    tracker.stop();
  }

  console.log("\n=== Restore: old full-event state files still load (backward compatible) ===\n");
  {
    const statePath = path.join(tmpDir, "legacy.json");
    // Exactly the shape the first shipped version wrote: a whole NewPoolEvent.
    fs.writeFileSync(
      statePath,
      JSON.stringify([
        {
          event: evt("MINT_LEGACY"),
          checkpointSeconds: 86400,
          dueAtMs: Date.now() + 60_000,
          baselineLiquiditySol: 0.5,
        },
      ])
    );
    const tracker = new OutcomeTracker(connection, {
      enabled: true,
      checkpointsSeconds: [86400],
      maxConcurrentChecks: 1,
      maxQueuedChecks: 10,
      maxPendingCheckpoints: 60000,
      sampleRate: 1,
      pendingStateFile: statePath,
      lateToleranceMs: 3_600_000,
      persistDebounceMs: 10,
    } as any);
    tracker.restorePending();
    check("a legacy entry is restored, not discarded", tracker.stats().pendingCheckpoints === 1);
    check("it counts as replayed", tracker.stats().replayedAfterRestart === 1);
    tracker.stop();
  }

  console.log("\n=== Restore: badly overdue checkpoints are recorded as missed, not taken late ===\n");
  {
    const statePath = path.join(tmpDir, "overdue.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify([
        {
          event: { source: "pumpfun", signature: "s", mint: "MINT_OVERDUE", poolAddress: "P", detectedAt: new Date().toISOString() },
          checkpointSeconds: 86400,
          // Two hours past due against a one-hour tolerance.
          dueAtMs: Date.now() - 7_200_000,
          baselineLiquiditySol: 0.5,
        },
      ])
    );
    const tracker = new OutcomeTracker(connection, {
      enabled: true,
      checkpointsSeconds: [86400],
      maxConcurrentChecks: 1,
      maxQueuedChecks: 10,
      maxPendingCheckpoints: 60000,
      sampleRate: 1,
      pendingStateFile: statePath,
      lateToleranceMs: 3_600_000,
      persistDebounceMs: 10,
    } as any);
    tracker.restorePending();
    const s = tracker.stats();
    check("the overdue checkpoint is NOT scheduled", s.pendingCheckpoints === 0, `pending=${s.pendingCheckpoints}`);
    check("it is counted as missed", s.missed === 1, `missed=${s.missed}`);
    tracker.stop();
  }

  console.log("\n=== A corrupt state file degrades to empty rather than stopping the bot ===\n");
  {
    const statePath = path.join(tmpDir, "corrupt.json");
    fs.writeFileSync(statePath, "{ this is not json");
    const tracker = new OutcomeTracker(connection, {
      enabled: true,
      checkpointsSeconds: [3600],
      maxConcurrentChecks: 1,
      maxQueuedChecks: 10,
      maxPendingCheckpoints: 60000,
      sampleRate: 1,
      pendingStateFile: statePath,
      lateToleranceMs: 3_600_000,
      persistDebounceMs: 10,
    } as any);
    let threw = false;
    try {
      tracker.restorePending();
    } catch {
      threw = true;
    }
    check("restore does not throw - losing pending state is a data gap, failing to boot is an outage", !threw);
    check("it starts with nothing pending", tracker.stats().pendingCheckpoints === 0);
    tracker.stop();
  }

  console.log("\n=== disabled means disabled - no state file, no scheduling ===\n");
  {
    const statePath = path.join(tmpDir, "disabled.json");
    const tracker = new OutcomeTracker(connection, {
      enabled: false,
      checkpointsSeconds: [3600],
      maxConcurrentChecks: 1,
      maxQueuedChecks: 10,
      maxPendingCheckpoints: 60000,
      sampleRate: 1,
      pendingStateFile: statePath,
      lateToleranceMs: 3_600_000,
      persistDebounceMs: 10,
    } as any);
    tracker.schedule(evt("MINT_OFF"), 1);
    tracker.stop();
    check("nothing scheduled", tracker.stats().pendingCheckpoints === 0);
    check("no state file created", !fs.existsSync(statePath));
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
}

main();
