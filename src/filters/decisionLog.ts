import { loadConfig } from "../config";
import { Logger, JsonlLog } from "../util/logger";
import { FilterResult, formatDecisionLine } from "./engine";

/**
 * Writes every PASS/SKIP decision to both the console (so you can watch it
 * live) and logs/decisions.jsonl (so you can grep/replay/tune thresholds
 * later without re-running the bot). This is the file to stare at while you
 * do the "manually verify the filter logic is accurate" step from the
 * README non-negotiables - it never buys anything, it only records what it
 * would have done.
 */
export class DecisionLog {
  private logger: Logger;
  private jsonl: JsonlLog;

  constructor() {
    const config = loadConfig();
    this.logger = new Logger("filters", config.logging.level);
    this.jsonl = new JsonlLog(config.logging.decisionsFile);
  }

  record(result: FilterResult): void {
    this.logger.info(formatDecisionLine(result));
    this.jsonl.append({
      decision: result.decision,
      source: result.source,
      mint: result.mint,
      signature: result.signature,
      reasons: result.reasons,
      metrics: result.metrics,
      evaluatedAt: result.evaluatedAt,
    });
  }

  /** For tests/tuning: replay everything logged so far. */
  readAll() {
    return this.jsonl.readAll();
  }
}
