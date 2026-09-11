/**
 * The metrics-collection pipeline as an explicit graph.
 *
 * This is the body of `collectTokenMetrics` (src/data/tokenMetrics.ts) with
 * its control flow lifted into named nodes and edges. Every node here is the
 * code that was already there; what changed is that the routing is declared
 * below in EDGES rather than spread across if/else. Behaviour is pinned by
 * tests/test-eval-goldens.ts: the same twelve mocked scenarios must produce
 * the same TokenMetrics, field for field, as the pre-graph collector did.
 *
 * Read EDGES first. That is the point of the file.
 *
 *   venueRoute ─raydium─> cheapChecksRaydium ─┐
 *              └default─> cheapChecksPumpfun ─┴> lpStatus > cheapGate
 *   cheapGate ─any cheap rule fails─> holderSkipped ─────────────────> stage1Assess
 *             └default─> holderRoute ─young & DAS allowed─> holderDas ─> bundleGate
 *                                    └default─> holderLargestAccounts
 *   holderLargestAccounts ─failed & DAS allowed─> holderDasFallback ─> bundleGate
 *                         ─failed─> holderNone ─> bundleGate
 *                         └default─> bundleGate
 *   bundleGate ─detection on─> bundleCheck ─> stage1Assess
 *              └default─> bundleDisabled ─> stage1Assess
 *   stage1Assess ─cheap rules fail & not forced─> activitySkipped ─> finalize
 *                └default─> activityData ─> finalize
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { GraphSpec } from "./graph";
import { NewPoolEvent } from "../watcher/types";
import { FiltersConfig, PollingConfig } from "../config";
import { evaluateStage1Reasons } from "../filters/engine";
import { fetchHolderDataViaDas, fetchHolderDataViaLargestAccounts, holderRoute as pickHolderRoute } from "../data/holderData";
import { readLpStatus, detectBundle, LpBurnStatus } from "../data/rugChecks";
import {
  TokenMetrics, getRenounceStatus, getCreatorLpPercent, getPumpFunLiquiditySol, getRaydiumLiquiditySol, getWalletActivity, withTimeout,
} from "../data/tokenMetrics";

export interface MetricsState {
  // ---- inputs, never changed by a node --------------------------------------
  connection: Connection;
  event: NewPoolEvent;
  mint: PublicKey;
  polling: PollingConfig;
  filters: FiltersConfig;
  holderCfg: { allowDas: boolean; dasAgeThresholdMs: number };
  rugCfg: { bundleDetection: boolean; maxLaunchSlotSignatures: number };
  forceActivityMetrics: boolean;
  startedAt: number;
  log: { debug: (m: string) => void; warn: (m: string) => void };
  // ---- accumulated ------------------------------------------------------------
  warnings: string[];
  decimals: number | null;
  supplyRaw: bigint;
  liquiditySol: number | null;
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
  riskyTokenExtensions: string[] | null;
  creatorLpPercent: number | null;
  lpCheckApplicable: boolean;
  lpBurnStatus: LpBurnStatus;
  lpBurned: boolean | null;
  cheapReasons: string[];
  topHolderPercent: number | null;
  devWalletPercent: number | null;
  holderSource: string;
  holderCredits: number;
  /** Set by holderLargestAccounts when the 1-credit path threw; read by its edges. */
  holderFailure: string | null;
  /** The holder subgraph shares ONE deadline, so its total budget equals the old single timeout. */
  holderDeadlineMs: number;
  launchSlotBuyers: number | null;
  launchSlotTxs: number | null;
  bundleSource: "fetched" | "unknown" | "not-fetched" | "skipped-cheap-fail" | "disabled";
  bundleCredits: number;
  stage1ElapsedMs: number;
  stage1Reasons: string[];
  activitySkippedEarly: boolean;
  uniqueWallets: number | null;
  transactionCount: number | null;
  stage2ElapsedMs: number | null;
  result: TokenMetrics | null;
}

const timeout = <T>(s: MetricsState, p: Promise<T>, label: string) => withTimeout(p, s.polling.metricsFetchTimeoutMs, label);
/** Remaining share of the holder deadline. Label kept as "holder data" so the timeout message is the one the old code produced. */
const holderTimeout = <T>(s: MetricsState, p: Promise<T>) => withTimeout(p, Math.max(1, s.holderDeadlineMs - Date.now()), "holder data");

// ---- nodes -------------------------------------------------------------------------

async function renounceWave(s: MetricsState): Promise<Partial<MetricsState>> {
  try {
    const renounce = await timeout(s, getRenounceStatus(s.connection, s.mint), "renounce status");
    return {
      mintAuthorityRenounced: renounce.mintAuthorityRenounced, freezeAuthorityRenounced: renounce.freezeAuthorityRenounced,
      riskyTokenExtensions: renounce.riskyTokenExtensions, decimals: renounce.decimals, supplyRaw: renounce.supplyRaw,
    };
  } catch (err: any) {
    // stays null ("unknown"), NOT false/empty ("confirmed clean") - the filter engine tells those apart.
    return { warnings: [`renounce status: ${err?.message || err}`] };
  }
}

async function pumpfunLiquidity(s: MetricsState): Promise<Partial<MetricsState>> {
  const e = s.event;
  try {
    if (e.poolAddress) {
      return { liquiditySol: await timeout(s, getPumpFunLiquiditySol(s.connection, new PublicKey(e.poolAddress)), "pumpfun liquidity") };
    }
    return { warnings: ["no pool address available - cannot compute liquiditySol"] };
  } catch (err: any) {
    return { warnings: [`liquiditySol: ${err?.message || err}`] };
  }
}

async function raydiumLiquidity(s: MetricsState): Promise<Partial<MetricsState>> {
  const e = s.event;
  try {
    if (!e.raydiumPcMint) return { warnings: ["no pcMint captured - cannot determine which vault is the SOL side"] };
    const liquiditySol = await timeout(
      s,
      getRaydiumLiquiditySol(s.connection, e.mint, e.raydiumPcMint,
        e.raydiumCoinVault ? new PublicKey(e.raydiumCoinVault) : undefined,
        e.raydiumPcVault ? new PublicKey(e.raydiumPcVault) : undefined),
      "raydium liquidity"
    );
    return { liquiditySol };
  } catch (err: any) {
    return { warnings: [`liquiditySol: ${err?.message || err}`] };
  }
}

async function raydiumCreatorLp(s: MetricsState): Promise<Partial<MetricsState>> {
  const e = s.event;
  try {
    if (!e.raydiumLpMint || !e.creator) return { warnings: ["no lpMint or creator captured - cannot compute creatorLpPercent"] };
    const creatorLpPercent = await timeout(s, getCreatorLpPercent(s.connection, new PublicKey(e.raydiumLpMint), new PublicKey(e.creator)), "creator LP %");
    return { creatorLpPercent };
  } catch (err: any) {
    return { warnings: [`creatorLpPercent: ${err?.message || err}`] };
  }
}

/** Merges concurrent partial results. Warnings are appended in the order the original awaited them: renounce, liquidity, LP. */
function mergeWave(s: MetricsState, parts: Partial<MetricsState>[]): Partial<MetricsState> {
  const out: Partial<MetricsState> = {};
  const warnings = [...s.warnings];
  for (const p of parts) {
    const { warnings: w, ...rest } = p;
    Object.assign(out, rest);
    if (w) warnings.push(...w);
  }
  out.warnings = warnings;
  return out;
}

/**
 * STAGE 1 - the cheap metrics (~4 RPC calls), run concurrently, exactly as
 * before: renounce status and liquidity in one wave (plus creator LP on Raydium).
 */
const cheapChecksPumpfun = async (s: MetricsState): Promise<Partial<MetricsState>> =>
  mergeWave(s, await Promise.all([renounceWave(s), pumpfunLiquidity(s)]));

const cheapChecksRaydium = async (s: MetricsState): Promise<Partial<MetricsState>> =>
  mergeWave(s, await Promise.all([renounceWave(s), raydiumLiquidity(s), raydiumCreatorLp(s)]));

/** Rug check 3. Free for Pump.fun (not applicable, recorded as such); one getAccountInfo on the LP mint for Raydium. */
async function lpStatus(s: MetricsState): Promise<Partial<MetricsState>> {
  const lp = await readLpStatus(s.connection, s.event);
  return { lpBurnStatus: lp.status, lpBurned: lp.lpBurned, warnings: lp.status === "unknown" ? [...s.warnings, `lp: ${lp.note}`] : s.warnings };
}

/** Same rules the real filter runs, minus the holder rules we have not paid for yet. */
function cheapGate(s: MetricsState): Partial<MetricsState> {
  const cheapMetrics = {
    mint: s.mint.toBase58(), fetchedAt: new Date().toISOString(), decimals: s.decimals, liquiditySol: s.liquiditySol,
    topHolderPercent: null, devWalletPercent: null, mintAuthorityRenounced: s.mintAuthorityRenounced,
    freezeAuthorityRenounced: s.freezeAuthorityRenounced, uniqueWallets: null, transactionCount: null,
    riskyTokenExtensions: s.riskyTokenExtensions, creatorLpPercent: s.creatorLpPercent, stale: false, warnings: [],
  } as unknown as TokenMetrics;
  return { cheapReasons: evaluateStage1Reasons(cheapMetrics, s.filters, { includeHolderRules: false }) };
}

function holderSkipped(s: MetricsState): Partial<MetricsState> {
  return {
    holderSource: "skipped-cheap-fail",
    bundleSource: "skipped-cheap-fail",
    warnings: [...s.warnings, `holder data not fetched - token already failed a cheaper check (${s.cheapReasons[0]}). Reported unchecked, not assumed.`],
  };
}

const excludeSet = (e: NewPoolEvent) => new Set<string>([e.poolAddress, e.pumpfunAssociatedBondingCurve, e.raydiumCoinVault, e.raydiumPcVault].filter(Boolean) as string[]);
const holderParams = (s: MetricsState) => ({ mint: s.mint, supplyRaw: s.supplyRaw, creator: s.event.creator ? new PublicKey(s.event.creator) : null, excludeAddresses: excludeSet(s.event) });

/** Decides the route only; the deadline starts here so the whole holder subgraph shares one budget. */
function holderRoute(s: MetricsState): Partial<MetricsState> {
  return { holderDeadlineMs: Date.now() + s.polling.metricsFetchTimeoutMs, holderFailure: null };
}
export const tokenAgeMs = (s: MetricsState) => { const d = Date.parse(s.event.detectedAt); return Number.isNaN(d) ? 0 : Date.now() - d; };
export const holderGoesToDas = (s: MetricsState) => pickHolderRoute(tokenAgeMs(s), s.holderCfg.dasAgeThresholdMs, s.holderCfg.allowDas) === "das";

function applyHolder(s: MetricsState, h: { topHolderPercent: number | null; devWalletPercent: number | null; source: string; creditsSpent: number; error: string | null }): Partial<MetricsState> {
  return {
    topHolderPercent: h.topHolderPercent, devWalletPercent: h.devWalletPercent, holderSource: h.source, holderCredits: h.creditsSpent,
    warnings: h.error ? [...s.warnings, `holderData: ${h.error}`] : s.warnings,
  };
}
const holderErrored = (s: MetricsState, err: any): Partial<MetricsState> => ({ warnings: [...s.warnings, `holderData: ${err?.message || err}`], holderSource: "error" });

async function holderDas(s: MetricsState): Promise<Partial<MetricsState>> {
  try {
    const p = holderParams(s);
    return applyHolder(s, await holderTimeout(s, fetchHolderDataViaDas(s.connection, p.mint, p.supplyRaw, p.creator, p.excludeAddresses)));
  } catch (err: any) { return holderErrored(s, err); }
}

async function holderLargestAccounts(s: MetricsState): Promise<Partial<MetricsState>> {
  try {
    return applyHolder(s, await holderTimeout(s, fetchHolderDataViaLargestAccounts(s.connection, holderParams(s))));
  } catch (err: any) {
    // A timeout is terminal (the old single call would have timed out too); an RPC failure routes to the fallback edges.
    if (/did not complete within/.test(String(err?.message))) return holderErrored(s, err);
    return { holderFailure: err?.message ?? String(err) };
  }
}

async function holderDasFallback(s: MetricsState): Promise<Partial<MetricsState>> {
  try {
    const p = holderParams(s);
    const das = await holderTimeout(s, fetchHolderDataViaDas(s.connection, p.mint, p.supplyRaw, p.creator, p.excludeAddresses));
    return applyHolder(s, { ...das, creditsSpent: das.creditsSpent + 1 });
  } catch (err: any) { return holderErrored(s, err); }
}

function holderNone(s: MetricsState): Partial<MetricsState> {
  return applyHolder(s, { topHolderPercent: null, devWalletPercent: null, source: "none", creditsSpent: 1, error: `largest-accounts failed (${s.holderFailure}) and DAS is disabled` });
}

const bundleGate = (): Partial<MetricsState> => ({});

/** Rug check 4. Same gate as the holder call: only a token that passed every cheap check pays for it. */
async function bundleCheck(s: MetricsState): Promise<Partial<MetricsState>> {
  const bundle = await timeout(s, detectBundle(s.connection, s.event, { maxSignatures: s.rugCfg.maxLaunchSlotSignatures }), "bundle detection")
    .catch((err: any) => ({ launchSlotBuyers: null, launchSlotTxs: null, windowExceeded: false, source: "unknown" as const, creditsSpent: 0, note: `bundle detection: ${err?.message || err}` }));
  return {
    launchSlotBuyers: bundle.launchSlotBuyers, launchSlotTxs: bundle.launchSlotTxs, bundleSource: bundle.source, bundleCredits: bundle.creditsSpent,
    warnings: bundle.source !== "fetched" ? [...s.warnings, `bundle: ${bundle.note}`] : s.warnings,
  };
}
const bundleDisabled = (): Partial<MetricsState> => ({ bundleSource: "disabled" });

/** STAGE 2 GATE - is this token still capable of passing? Same code the real filter runs. */
function stage1Assess(s: MetricsState): Partial<MetricsState> {
  const stage1Reasons = evaluateStage1Reasons(
    {
      liquiditySol: s.liquiditySol, topHolderPercent: s.topHolderPercent, devWalletPercent: s.devWalletPercent,
      mintAuthorityRenounced: s.mintAuthorityRenounced, freezeAuthorityRenounced: s.freezeAuthorityRenounced,
      riskyTokenExtensions: s.riskyTokenExtensions, creatorLpPercent: s.creatorLpPercent, lpCheckApplicable: s.lpCheckApplicable,
    } as TokenMetrics,
    s.filters
  );
  return { stage1ElapsedMs: Date.now() - s.startedAt, stage1Reasons, activitySkippedEarly: stage1Reasons.length > 0 && !s.forceActivityMetrics };
}

function activitySkipped(s: MetricsState): Partial<MetricsState> {
  s.log.debug(`${s.event.mint}: skipping activity metrics (~${s.polling.walletActivitySampleSize + 1} RPC calls) - already failing on: ${s.stage1Reasons.join("; ")}`);
  return {};
}

async function activityData(s: MetricsState): Promise<Partial<MetricsState>> {
  const stage2StartedAt = Date.now();
  let out: Partial<MetricsState> = {};
  try {
    const activityAddress = s.event.poolAddress ? new PublicKey(s.event.poolAddress) : s.mint;
    const activity = await timeout(s, getWalletActivity(s.connection, activityAddress, s.polling.walletActivitySampleSize), "wallet activity");
    out = { uniqueWallets: activity.uniqueWallets, transactionCount: activity.transactionCount };
  } catch (err: any) {
    out = { warnings: [...s.warnings, `walletActivity: ${err?.message || err}`] };
  }
  return { ...out, stage2ElapsedMs: Date.now() - stage2StartedAt };
}

function finalize(s: MetricsState): Partial<MetricsState> {
  const totalElapsedMs = Date.now() - s.startedAt;
  const stale = totalElapsedMs > s.polling.metricsMaxAgeMs;
  const warnings = [...s.warnings];
  if (stale) warnings.push(`metrics took ${totalElapsedMs}ms to collect (> metricsMaxAgeMs ${s.polling.metricsMaxAgeMs}ms) - data may be stale`);
  if (warnings.length > 0) s.log.warn(`Partial/stale metrics for ${s.event.mint}: ${warnings.join("; ")}`);
  const result: TokenMetrics = {
    mint: s.event.mint, fetchedAt: new Date().toISOString(), decimals: s.decimals, liquiditySol: s.liquiditySol,
    topHolderPercent: s.topHolderPercent, devWalletPercent: s.devWalletPercent,
    mintAuthorityRenounced: s.mintAuthorityRenounced, freezeAuthorityRenounced: s.freezeAuthorityRenounced,
    riskyTokenExtensions: s.riskyTokenExtensions, holderSource: s.holderSource, holderCreditsSpent: s.holderCredits,
    lpBurnStatus: s.lpBurnStatus, lpBurned: s.lpBurned, launchSlotBuyers: s.launchSlotBuyers, launchSlotTxs: s.launchSlotTxs,
    bundleSource: s.bundleSource, bundleCreditsSpent: s.bundleCredits, creatorLpPercent: s.creatorLpPercent,
    lpCheckApplicable: s.lpCheckApplicable, uniqueWallets: s.uniqueWallets, transactionCount: s.transactionCount,
    stale, activitySkippedEarly: s.activitySkippedEarly, stage1ElapsedMs: s.stage1ElapsedMs, stage2ElapsedMs: s.stage2ElapsedMs,
    totalElapsedMs, warnings,
  };
  return { result, warnings };
}

/** The starting state. Everything a node reads is here; nothing is read from the outside during the run. */
export function initialMetricsState(input: {
  connection: Connection; event: NewPoolEvent; polling: PollingConfig; filters: FiltersConfig;
  holderCfg: MetricsState["holderCfg"]; rugCfg: MetricsState["rugCfg"]; forceActivityMetrics: boolean;
  log: MetricsState["log"];
}): MetricsState {
  return {
    ...input, mint: new PublicKey(input.event.mint), startedAt: Date.now(),
    warnings: [], decimals: null, supplyRaw: 0n, liquiditySol: null,
    mintAuthorityRenounced: null, freezeAuthorityRenounced: null, riskyTokenExtensions: null,
    creatorLpPercent: null, lpCheckApplicable: false, lpBurnStatus: "unknown", lpBurned: null, cheapReasons: [],
    topHolderPercent: null, devWalletPercent: null, holderSource: "not-fetched", holderCredits: 0, holderFailure: null, holderDeadlineMs: 0,
    launchSlotBuyers: null, launchSlotTxs: null, bundleSource: "skipped-cheap-fail", bundleCredits: 0,
    stage1ElapsedMs: 0, stage1Reasons: [], activitySkippedEarly: false, uniqueWallets: null, transactionCount: null, stage2ElapsedMs: null,
    result: null,
  };
}

// ---- the graph ---------------------------------------------------------------------

export const METRICS_GRAPH: GraphSpec<MetricsState> = {
  name: "metrics",
  start: "venueRoute",
  nodes: {
    venueRoute: (s) => ({ lpCheckApplicable: s.event.source === "raydium" }),
    cheapChecksPumpfun, cheapChecksRaydium, lpStatus, cheapGate,
    holderSkipped, holderRoute, holderDas, holderLargestAccounts, holderDasFallback, holderNone,
    bundleGate, bundleCheck, bundleDisabled,
    stage1Assess, activitySkipped, activityData, finalize,
  },
  edges: {
    venueRoute: [
      { to: "cheapChecksRaydium", when: (s) => s.event.source === "raydium", label: "source = raydium" },
      { to: "cheapChecksPumpfun", label: "default: pump.fun" },
    ],
    cheapChecksPumpfun: [{ to: "lpStatus", label: "cheap wave done" }],
    cheapChecksRaydium: [{ to: "lpStatus", label: "cheap wave done" }],
    lpStatus: [{ to: "cheapGate", label: "lp status read" }],
    cheapGate: [
      { to: "holderSkipped", when: (s) => s.cheapReasons.length > 0, label: "a cheap rule already fails" },
      { to: "holderRoute", label: "default: still capable of passing" },
    ],
    holderSkipped: [{ to: "stage1Assess", label: "nothing else fetched" }],
    holderRoute: [
      { to: "holderDas", when: holderGoesToDas, label: "token younger than dasAgeThreshold and DAS allowed (10 credits)" },
      { to: "holderLargestAccounts", label: "default: largest-accounts (1-credit path)" },
    ],
    holderDas: [{ to: "bundleGate", label: "holder data via DAS" }],
    holderLargestAccounts: [
      { to: "holderDasFallback", when: (s) => s.holderFailure !== null && s.holderCfg.allowDas, label: "largest-accounts failed and DAS allowed" },
      { to: "holderNone", when: (s) => s.holderFailure !== null, label: "largest-accounts failed and DAS disabled" },
      { to: "bundleGate", label: "default: holder data read" },
    ],
    holderDasFallback: [{ to: "bundleGate", label: "holder data via DAS fallback" }],
    holderNone: [{ to: "bundleGate", label: "holder data unknown" }],
    bundleGate: [
      { to: "bundleCheck", when: (s) => s.rugCfg.bundleDetection, label: "rugChecks.bundleDetection on" },
      { to: "bundleDisabled", label: "default: bundle detection off" },
    ],
    bundleCheck: [{ to: "stage1Assess", label: "bundle read" }],
    bundleDisabled: [{ to: "stage1Assess", label: "recorded disabled" }],
    stage1Assess: [
      { to: "activitySkipped", when: (s) => s.activitySkippedEarly, label: "stage-1 rule fails and activity not forced" },
      { to: "activityData", label: "default: fetch wallet activity (~21 credits)" },
    ],
    activitySkipped: [{ to: "finalize", label: "activity skipped" }],
    activityData: [{ to: "finalize", label: "activity read" }],
    finalize: [],
  },
  terminals: ["finalize"],
};
