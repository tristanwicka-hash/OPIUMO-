/**
 * With detection off, the bot process must stay up. Offline.
 *
 * Every timer in src/index.ts and the modules it starts is unref'd, so the
 * detection websocket was the only thing holding Node's event loop open. With
 * watcher.enabled=false (APPROVALS 52) the bot exited 0 about 25 s after
 * starting and launchd restarted it - 1,452 runs on 2026-09-14, and outcome
 * checkpoints fired only when a later boot found them overdue.
 *
 * Two parts: the mechanism, shown with real child processes (so this test
 * fails if the premise is ever wrong), and the wiring in src/index.ts.
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " -- " + detail : ""}`); console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}
function section(t: string): void { console.log(`\n=== ${t} ===\n`); }

/** Runs `code` in a fresh node; resolves with whether it was still alive after `ms`. */
function aliveAfter(code: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
    let exited = false;
    child.on("exit", () => { exited = true; });
    setTimeout(() => { const alive = !exited; if (alive) child.kill("SIGKILL"); resolve(alive); }, ms);
  });
}

async function main(): Promise<void> {
  section("the mechanism: unref'd timers alone do not keep a process alive");

  // The bot's shape with detection off: a heartbeat, an outcome checkpoint, stats - all unref'd.
  const unrefOnly = `
    setInterval(() => {}, 5000).unref();
    setTimeout(() => {}, 3600000).unref();
    setInterval(() => {}, 30000).unref();`;
  check("a process holding only unref'd timers exits on its own", !(await aliveAfter(unrefOnly, 1500)));
  check("the same process plus one ref'd interval stays up", await aliveAfter(unrefOnly + "\nsetInterval(() => {}, 3600000);", 1500));
  check("and exits once that interval is cleared", !(await aliveAfter(unrefOnly + "\nconst k = setInterval(() => {}, 3600000); setTimeout(() => clearInterval(k), 200);", 1500)));

  section("the wiring in src/index.ts");

  const index = fs.readFileSync(path.join("src", "index.ts"), "utf-8");
  const offBranch = index.indexOf("if (config.watcher?.enabled === false) {");
  const elseBranch = index.indexOf("} else {", offBranch);
  const branch = offBranch > 0 && elseBranch > offBranch ? index.slice(offBranch, elseBranch) : "";
  check("the detection-off branch exists", branch.length > 0);
  check("it creates the keep-alive interval", /keepAlive = setInterval\(/.test(branch));
  check("and does NOT unref it (an unref'd keep-alive keeps nothing alive)", !/keepAlive[^;\n]*\.unref|keepAlive\.unref/.test(index));
  const sigint = index.slice(index.indexOf('process.on("SIGINT"'));
  check("SIGINT releases it, so a graceful stop still exits", /if \(keepAlive\) clearInterval\(keepAlive\)/.test(sigint));
  check("SIGINT still ends with process.exit(0)", /process\.exit\(0\)/.test(sigint));

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:\n  " + failures.join("\n  ")); process.exit(1); }
}

main();
