/**
 * Delay-probe scheduling. Fully offline: no network, no config mutation, no
 * real DelayProbe instance (that would load config and open a log file).
 *
 * The properties that matter are that measurement (a) never blocks or affects
 * the live decision path, (b) stays bounded, and (c) actually collects the
 * activity metrics it exists to measure. The first two are tested here against
 * the same WorkQueue the real probe uses; the third is enforced by the
 * forceActivityMetrics flag and covered in test-two-stage-metrics.ts.
 *
 * Run with: npm run test:delay-probe
 */
import { WorkQueue } from "../src/util/workQueue";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    pass++;
  } else {
    console.error(`  FAIL: ${name}`);
    fail++;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The scheduling core, mirroring DelayProbe.schedule(): one timer per
 * configured delay, each pushing onto a bounded queue when it fires. Extracted
 * here with injectable timings so the behaviour is testable in milliseconds
 * instead of minutes.
 */
function scheduleProbes<T>(
  item: T,
  delaysMs: number[],
  queue: WorkQueue<{ item: T; delayMs: number }>,
  timers: Set<NodeJS.Timeout>,
): void {
  for (const delayMs of delaysMs) {
    const t = setTimeout(() => {
      timers.delete(t);
      queue.push({ item, delayMs });
    }, delayMs);
    timers.add(t);
  }
}

async function main() {
  console.log("=== Delay-probe scheduling (offline) ===");

  // ---------------------------------------------------------------
  console.log("\n-- one observation per configured delay, in ascending order --");
  {
    const fired: number[] = [];
    const timers = new Set<NodeJS.Timeout>();
    const q = new WorkQueue<{ item: string; delayMs: number }>({
      maxConcurrent: 1,
      maxQueued: 50,
      worker: async ({ delayMs }) => {
        fired.push(delayMs);
      },
    });
    scheduleProbes("MINT_A", [20, 60, 100], q, timers);
    await sleep(200);
    await q.drain();

    check("all three observations fired", fired.length === 3);
    check("they fired in ascending age order", JSON.stringify(fired) === JSON.stringify([20, 60, 100]));
    check("no timers left pending afterwards", timers.size === 0);
  }

  // ---------------------------------------------------------------
  console.log("\n-- the delay list is data, so changing it changes the observations --");
  {
    for (const delays of [[10], [10, 20], [10, 20, 30, 40]]) {
      const fired: number[] = [];
      const timers = new Set<NodeJS.Timeout>();
      const q = new WorkQueue<{ item: string; delayMs: number }>({
        maxConcurrent: 1,
        maxQueued: 50,
        worker: async ({ delayMs }) => {
          fired.push(delayMs);
        },
      });
      scheduleProbes("M", delays, q, timers);
      await sleep(120);
      await q.drain();
      check(`a ${delays.length}-entry delay list produces ${delays.length} observations`, fired.length === delays.length);
    }
  }

  // ---------------------------------------------------------------
  console.log("\n-- probe work stays bounded (no return to unbounded parallel RPC) --");
  {
    let concurrent = 0;
    let peak = 0;
    const timers = new Set<NodeJS.Timeout>();
    const q = new WorkQueue<{ item: string; delayMs: number }>({
      maxConcurrent: 1,
      maxQueued: 500,
      worker: async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await sleep(5);
        concurrent--;
      },
    });
    // 30 tokens x 3 observations, all coming due at once - the worst case.
    for (let i = 0; i < 30; i++) scheduleProbes(`M${i}`, [10, 10, 10], q, timers);
    await sleep(60);
    await q.drain();

    check("90 simultaneous observations never exceeded maxConcurrent=1", peak === 1);
    check("all 90 still completed", q.stats().totalCompleted === 90);
  }

  // ---------------------------------------------------------------
  console.log("\n-- a failing probe cannot disturb anything else --");
  {
    const done: string[] = [];
    const errors: unknown[] = [];
    const timers = new Set<NodeJS.Timeout>();
    const q = new WorkQueue<{ item: string; delayMs: number }>({
      maxConcurrent: 1,
      maxQueued: 50,
      onError: (_j, e) => errors.push(e),
      worker: async ({ item }) => {
        if (item === "BAD") throw new Error("rpc exploded");
        done.push(item);
      },
    });
    scheduleProbes("BAD", [10], q, timers);
    scheduleProbes("GOOD", [10], q, timers);
    await sleep(80);
    await q.drain();

    check("the failure was captured, not left unhandled", errors.length === 1);
    check("the healthy observation still completed", done.includes("GOOD"));
    check("the queue drained cleanly", q.stats().running === 0);
  }

  // ---------------------------------------------------------------
  console.log("\n-- stop() cancels pending observations (clean shutdown) --");
  {
    const fired: number[] = [];
    const timers = new Set<NodeJS.Timeout>();
    const q = new WorkQueue<{ item: string; delayMs: number }>({
      maxConcurrent: 1,
      maxQueued: 50,
      worker: async ({ delayMs }) => {
        fired.push(delayMs);
      },
    });
    scheduleProbes("MINT_B", [15, 500, 900], q, timers);
    await sleep(50);
    // The 15ms one has fired; cancel the rest, as DelayProbe.stop() does.
    for (const t of timers) clearTimeout(t);
    timers.clear();
    await sleep(80);
    await q.drain();

    check("only the already-due observation ran", fired.length === 1);
    check("the long-dated ones were cancelled", !fired.includes(500) && !fired.includes(900));
    check("no timers survive shutdown", timers.size === 0);
  }

  // ---------------------------------------------------------------
  console.log("\n-- an overloaded probe queue drops measurements, never detections --");
  {
    const timers = new Set<NodeJS.Timeout>();
    const dropped: number[] = [];
    const q = new WorkQueue<{ item: string; delayMs: number }>({
      maxConcurrent: 1,
      maxQueued: 3,
      onDrop: ({ delayMs }) => dropped.push(delayMs),
      worker: async () => {
        await sleep(5);
      },
    });
    for (let i = 0; i < 20; i++) q.push({ item: `M${i}`, delayMs: 10 });
    await q.drain();

    check("the backlog cap shed excess measurements", dropped.length > 0);
    check("every drop was reported", dropped.length === q.stats().totalDropped);
    check("nothing was lost silently", q.stats().totalAccepted === 20);
  }

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
