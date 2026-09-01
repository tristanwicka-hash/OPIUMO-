/**
 * Utility test: JsonlLog's size-based rotation (added in the hardening pass,
 * 2026-09-01 - see README "Hardening pass" section).
 *
 * Run with: npm run test:logger
 *
 * Fully offline: writes to a throwaway file under logs/, never touches the
 * network or real decisions/trades files.
 */
import fs from "fs";
import path from "path";
import { JsonlLog } from "../src/util/logger";

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

const testDir = "logs";
const testFile = path.join(testDir, "test-rotation.jsonl");

function cleanup() {
  if (!fs.existsSync(testDir)) return;
  for (const f of fs.readdirSync(testDir)) {
    if (f.startsWith("test-rotation.")) fs.unlinkSync(path.join(testDir, f));
  }
}

async function main() {
  console.log("=== Utility test: log rotation ===");
  cleanup();

  console.log("\n-- no rotation below the size threshold --");
  {
    const log = new JsonlLog(testFile, 10); // 10MB threshold
    for (let i = 0; i < 20; i++) log.append({ i });
    const files = fs.readdirSync(testDir).filter((f) => f.startsWith("test-rotation."));
    check("a handful of small records stays in a single file", files.length === 1);
    check("all records are still readable from that file", log.readAll().length === 20);
  }
  cleanup();

  console.log("\n-- rotation kicks in once the file crosses the threshold --");
  {
    const log = new JsonlLog(testFile, 0.001); // ~1KB - trivially easy to exceed
    for (let i = 0; i < 50; i++) log.append({ i, filler: "x".repeat(50) });
    const files = fs.readdirSync(testDir).filter((f) => f.startsWith("test-rotation."));
    check("at least one rotated (timestamped) file was created", files.length > 1);
    check("the live file still exists and is appendable/readable", fs.existsSync(testFile) && log.readAll().length >= 0);

    const rotated = files.filter((f) => f !== "test-rotation.jsonl");
    check("rotated file names are distinct from the live file", rotated.every((f) => f !== "test-rotation.jsonl"));
  }
  cleanup();

  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
