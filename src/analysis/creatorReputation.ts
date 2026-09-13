/**
 * Creator wallet reputation: does who launched a coin predict how it ends?
 *
 * Every Pump.fun coin is launched by a wallet. If a wallet has drained its
 * previous launches, that is knowable at t=0 - unlike every metric APPROVALS
 * 38 found wanting, which only exists after the token has already moved. That
 * is the whole reason this signal is worth testing: it is the only candidate
 * that is available BEFORE the entry decision.
 *
 * PURE. No network, no clock, no config. It turns records into a store and a
 * store into a verdict; the fetching and the spending live in scripts/.
 *
 * ## What we had, and what we did not
 *
 * The watcher already resolves the creator at detection time (the launch
 * transaction's fee payer - see pumpfunWatcher). It was never written to the
 * decision log, so **the history could not be backfilled for free**: the
 * address was in memory and thrown away. Two consequences, both acted on:
 * the creator is now recorded on every decision row (zero extra calls,
 * it is already in hand), and a bounded backfill can recover history from the
 * launch signatures the log already stores, at exactly one getTransaction per
 * mint. Nothing here assumes either has happened.
 */

/** What became of one launch, judged from the liquidity readings after it. */
export type LaunchFate = "drained" | "flat" | "ran" | "unknown";

export interface LaunchRecord {
  mint: string;
  creator: string;
  /** ISO time of the launch/detection. */
  at: string;
  fate: LaunchFate;
  /** SOL in the curve at the first reading. */
  entrySol: number | null;
  /** The peak multiple of entry reached at any later reading. Null when unknown. */
  peakMultiple: number | null;
}

export interface FateThresholds {
  /** Fell to this fraction of entry (or below) => drained. */
  drainedAtOrBelow: number;
  /** Reached this multiple of entry (or above) at any reading => ran. */
  ranAtOrAbove: number;
  /** Only readings within this many minutes of the launch count for "drained in minutes". */
  drainWindowMinutes: number;
}

export const DEFAULT_FATES: FateThresholds = { drainedAtOrBelow: 0.25, ranAtOrAbove: 2, drainWindowMinutes: 10 };

/** Below this many observations in a group, no rate is reported. Same floor as every other OPIUMO report. */
export const MIN_PER_GROUP = 30;

export interface Reading { tMs: number; sol: number }

/**
 * Classify one launch from its liquidity readings.
 *
 * "ran" wins over "drained": a token that went to 3x and then to zero is not
 * the same animal as one that never moved, and calling it drained would hide
 * the only outcome anybody wants.
 */
export function classifyFate(entrySol: number | null, launchMs: number, readings: Reading[], t: FateThresholds = DEFAULT_FATES): { fate: LaunchFate; peakMultiple: number | null } {
  if (entrySol === null || !(entrySol > 0) || readings.length === 0) return { fate: "unknown", peakMultiple: null };
  const later = readings.filter((r) => r.tMs >= launchMs).sort((a, b) => a.tMs - b.tMs);
  if (later.length === 0) return { fate: "unknown", peakMultiple: null };
  const peak = Math.max(...later.map((r) => r.sol)) / entrySol;
  if (peak >= t.ranAtOrAbove) return { fate: "ran", peakMultiple: peak };
  const windowEnd = launchMs + t.drainWindowMinutes * 60_000;
  const inWindow = later.filter((r) => r.tMs <= windowEnd);
  if (inWindow.some((r) => r.sol <= entrySol * t.drainedAtOrBelow)) return { fate: "drained", peakMultiple: peak };
  return { fate: "flat", peakMultiple: peak };
}

export interface CreatorStats {
  creator: string;
  launches: number;
  drained: number;
  flat: number;
  ran: number;
  unknown: number;
  /** Drained as a share of launches with a KNOWN fate. Null when there are none. */
  drainRate: number | null;
  firstSeen: string;
  lastSeen: string;
}

export function buildStore(records: LaunchRecord[]): Map<string, CreatorStats> {
  const out = new Map<string, CreatorStats>();
  for (const r of records) {
    if (!r.creator) continue;
    const s = out.get(r.creator) ?? { creator: r.creator, launches: 0, drained: 0, flat: 0, ran: 0, unknown: 0, drainRate: null, firstSeen: r.at, lastSeen: r.at };
    s.launches++;
    s[r.fate]++;
    if (r.at < s.firstSeen) s.firstSeen = r.at;
    if (r.at > s.lastSeen) s.lastSeen = r.at;
    out.set(r.creator, s);
  }
  for (const s of out.values()) {
    const known = s.drained + s.flat + s.ran;
    s.drainRate = known > 0 ? s.drained / known : null;
  }
  return out;
}

/**
 * What the store knew about this creator BEFORE this launch.
 *
 * Point-in-time on purpose: scoring a launch with a reputation that includes
 * that launch's own outcome is how a backtest invents an edge it will never
 * have live. Only strictly-earlier launches count.
 */
export function priorStats(records: LaunchRecord[], creator: string, beforeIso: string): { priorLaunches: number; priorDrained: number; priorKnown: number; priorDrainRate: number | null } {
  let priorLaunches = 0, priorDrained = 0, priorKnown = 0;
  for (const r of records) {
    if (r.creator !== creator || r.at >= beforeIso) continue;
    priorLaunches++;
    if (r.fate === "drained") { priorDrained++; priorKnown++; }
    else if (r.fate === "flat" || r.fate === "ran") priorKnown++;
  }
  return { priorLaunches, priorDrained, priorKnown, priorDrainRate: priorKnown > 0 ? priorDrained / priorKnown : null };
}

export interface Group {
  label: string;
  n: number;
  ran: number;
  drained: number;
  flat: number;
  /** Null below MIN_PER_GROUP - a rate on nine tokens is not a rate. */
  ranRate: number | null;
  drainedRate: number | null;
  /** Why a rate is missing, when it is. */
  note: string | null;
}

export function summariseGroup(label: string, rows: { fate: LaunchFate }[]): Group {
  const known = rows.filter((r) => r.fate !== "unknown");
  const ran = known.filter((r) => r.fate === "ran").length;
  const drained = known.filter((r) => r.fate === "drained").length;
  const flat = known.filter((r) => r.fate === "flat").length;
  const enough = known.length >= MIN_PER_GROUP;
  return {
    label, n: known.length, ran, drained, flat,
    ranRate: enough ? ran / known.length : null,
    drainedRate: enough ? drained / known.length : null,
    note: enough ? null : `INSUFFICIENT: ${known.length} launch(es) with a known fate, floor is ${MIN_PER_GROUP}`,
  };
}

/** The filter under test: refuse a launch whose creator has drained at least `maxPriorDrained` of their previous launches. */
export interface CreatorFilterConfig { enabled: boolean; minPriorLaunches: number; maxPriorDrainRate: number }
export const DEFAULT_CREATOR_FILTER: CreatorFilterConfig = { enabled: false, minPriorLaunches: 2, maxPriorDrainRate: 0.5 };

export function wouldRefuse(prior: { priorLaunches: number; priorDrainRate: number | null }, cfg: CreatorFilterConfig): { refuse: boolean; reason: string } {
  if (!cfg.enabled) return { refuse: false, reason: "creator reputation filter is disabled" };
  if (prior.priorLaunches < cfg.minPriorLaunches) return { refuse: false, reason: `only ${prior.priorLaunches} prior launch(es) by this creator - not enough history to judge, so it passes` };
  if (prior.priorDrainRate === null) return { refuse: false, reason: "no prior launch has a known fate - unknown is not a reason to refuse" };
  if (prior.priorDrainRate > cfg.maxPriorDrainRate) return { refuse: true, reason: `creator drained ${(prior.priorDrainRate * 100).toFixed(0)}% of ${prior.priorLaunches} prior launch(es), over the ${(cfg.maxPriorDrainRate * 100).toFixed(0)}% limit` };
  return { refuse: false, reason: `creator drained ${(prior.priorDrainRate * 100).toFixed(0)}% of ${prior.priorLaunches} prior launch(es), within the limit` };
}
