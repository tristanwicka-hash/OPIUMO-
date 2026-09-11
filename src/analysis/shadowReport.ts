/**
 * Reads the shadow-filter log and answers one question: is the pass rate
 * limited by the THRESHOLDS or by the DATA?
 *
 * The two look identical from the pass rate alone, and they call for opposite
 * responses. Loosening a threshold when the metric was never fetched changes
 * nothing at all - the engine fails closed on unknown regardless of what the
 * threshold says, which is correct and is exactly why the distinction has to be
 * measured rather than reasoned about.
 *
 * The separation this module makes: among tokens where the loosest shadow set
 * reported NOTHING unchecked, what fraction passes? That subset has no data
 * problem left, so whatever fails there is genuinely a threshold.
 */
import fs from "fs";

export interface ShadowSetResult {
  setId: string;
  decision: "PASS" | "SKIP";
  reasons: string[];
  uncheckedFields: string[];
}

export interface ShadowRecord {
  /** Always "shadow-eval". The log is shared with other event types. */
  event?: string;
  ts: string;
  mint: string;
  liveDecision: "PASS" | "SKIP";
  shadows: ShadowSetResult[];
}

export interface SetSummary {
  setId: string;
  evaluated: number;
  passed: number;
  /** Failing rule -> count, values stripped so one rule is one row. */
  blockers: Record<string, number>;
  /** Of the complete-data subset, how many this set passed. */
  passedWithCompleteData: number;
}

export interface ShadowSummary {
  records: number;
  unparseable: number;
  liveDecisions: Record<string, number>;
  sets: SetSummary[];
  /** Tokens where the widest set reported no unchecked field at all. */
  completeDataTokens: number;
  /** The set used to judge completeness - the one with the fewest unchecked fields overall. */
  completenessJudgedBy: string | null;
  /**
   * True when every set reported exactly the same unchecked fields on every
   * record - which is what SHOULD happen, because whether a metric was fetched
   * does not depend on the threshold it would be compared against. False means
   * a shadow set is fetching something, which would break the zero-cost
   * guarantee, and the report says so loudly.
   */
  setsAgreeOnUnchecked: boolean;
}

/** Strips measured values so "too few transactions (4 < min 30)" groups as one rule. */
export function ruleOf(reason: string): string {
  return reason.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

export function loadShadowRecords(file: string): { records: ShadowRecord[]; unparseable: number } {
  const records: ShadowRecord[] = [];
  let unparseable = 0;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return { records, unparseable };
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      unparseable++;
      continue;
    }
    if (r?.event !== "shadow-eval" || !Array.isArray(r?.shadows)) continue;
    records.push(r as ShadowRecord);
  }
  return { records, unparseable };
}

export function summarise(records: ShadowRecord[], unparseable = 0): ShadowSummary {
  const liveDecisions: Record<string, number> = {};
  const bySet = new Map<string, SetSummary>();

  for (const r of records) {
    liveDecisions[r.liveDecision] = (liveDecisions[r.liveDecision] ?? 0) + 1;
    for (const s of r.shadows) {
      const cur =
        bySet.get(s.setId) ??
        { setId: s.setId, evaluated: 0, passed: 0, blockers: {}, passedWithCompleteData: 0 };
      cur.evaluated++;
      if (s.decision === "PASS") cur.passed++;
      for (const reason of s.reasons ?? []) {
        const rule = ruleOf(reason);
        cur.blockers[rule] = (cur.blockers[rule] ?? 0) + 1;
      }
      bySet.set(s.setId, cur);
    }
  }

  // Completeness is judged by whichever set left the fewest fields unchecked
  // across the run - the widest one. Picked from the data rather than named in
  // code, so adding a wider set does not silently make this measure the wrong
  // thing.
  let completenessJudgedBy: string | null = null;
  let fewest = Infinity;
  for (const [setId] of bySet) {
    let unchecked = 0;
    for (const r of records) {
      const s = r.shadows.find((x) => x.setId === setId);
      unchecked += (s?.uncheckedFields ?? []).length;
    }
    if (unchecked < fewest) {
      fewest = unchecked;
      completenessJudgedBy = setId;
    }
  }

  let completeDataTokens = 0;
  if (completenessJudgedBy !== null) {
    for (const r of records) {
      const judge = r.shadows.find((x) => x.setId === completenessJudgedBy);
      if (judge && (judge.uncheckedFields ?? []).length === 0) {
        completeDataTokens++;
        for (const s of r.shadows) {
          const cur = bySet.get(s.setId);
          if (cur && s.decision === "PASS") cur.passedWithCompleteData++;
        }
      }
    }
  }

  let setsAgreeOnUnchecked = true;
  for (const r of records) {
    const shapes = new Set(r.shadows.map((s) => [...(s.uncheckedFields ?? [])].sort().join("|")));
    if (shapes.size > 1) {
      setsAgreeOnUnchecked = false;
      break;
    }
  }

  return {
    records: records.length,
    unparseable,
    liveDecisions,
    sets: [...bySet.values()],
    completeDataTokens,
    completenessJudgedBy,
    setsAgreeOnUnchecked,
  };
}
