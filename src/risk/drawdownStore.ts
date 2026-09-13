/**
 * Reading and writing the drawdown state to disk.
 *
 * Deliberately NOT in drawdownGuard.ts. That module is pure - no clock, no
 * filesystem, no config - which is what makes every one of its branches
 * testable without a temp directory. Persistence is the one thing it cannot do
 * and stay that way, so it lives here.
 *
 * ## The property that matters
 *
 * A halt must survive a restart. If the state cannot be read, the guard must
 * NOT start from zero - a corrupt or truncated state file would then clear a
 * halt, which is exactly the "restart to reset the kill switch" failure the
 * guard exists to prevent. So an unreadable file is a REFUSAL, not a fresh
 * start, and the caller decides whether to run without the guard or not at all.
 */
import * as fs from "fs";
import * as path from "path";
import { DrawdownState, emptyState } from "./drawdownGuard";

export const DRAWDOWN_STATE_FILE = path.join("logs", "drawdown-state.json");

export type LoadResult =
  | { ok: true; state: DrawdownState; fresh: boolean }
  | { ok: false; reason: string };

export function loadDrawdownState(file = DRAWDOWN_STATE_FILE, at = new Date()): LoadResult {
  if (!fs.existsSync(file)) {
    // A missing file genuinely is a fresh start: nothing has ever been
    // recorded, so there is no halt to lose. That is different from a file
    // that exists and cannot be read.
    return { ok: true, state: emptyState(at), fresh: true };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err: any) {
    return { ok: false, reason: `drawdown state at ${file} exists but could not be read (${err?.message ?? err}). Refusing to start from zero: that would clear any halt it holds.` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `drawdown state at ${file} is not valid JSON (${raw.length} bytes). Refusing to start from zero: a truncated file must not clear a halt.` };
  }
  if (parsed?.version !== 1 || typeof parsed.day !== "string" || typeof parsed.totalPnl !== "number") {
    return { ok: false, reason: `drawdown state at ${file} is not a version-1 state (got version ${JSON.stringify(parsed?.version)}). Refusing to guess at it.` };
  }
  return { ok: true, state: parsed as DrawdownState, fresh: false };
}

/** Atomic: a half-written state file is the corruption case above. */
export function saveDrawdownState(state: DrawdownState, file = DRAWDOWN_STATE_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
