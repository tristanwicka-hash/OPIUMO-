/**
 * The insider fingerprint: scoring one launch's trace, alert-only.
 *
 * ## What the on-chain research describes
 *
 * A deployer funds fresh wallets shortly before launching, in a hub-and-spoke
 * shape (one source, many new destinations). Those wallets buy in the launch
 * block or the first slots, and exit within about one to five minutes.
 *
 * ## The measurement that shaped this file
 *
 * On 2026-09-14, 40 real deployers were traced to full depth. **All 40 had sent
 * SOL to other wallets.** So "the deployer funds other wallets" is not a signal
 * at all - used alone it flags every launch on the chain. The median deployer in
 * that sample had over a thousand transfers.
 *
 * Every signal below is therefore CONJUNCTIVE and narrow: the wallets must be
 * FRESH, funded SHORTLY BEFORE the launch, must actually BUY in the first slots,
 * and must EXIT fast. Any one of those alone is common. It is the overlap - the
 * same wallets appearing in all four - that is rare, and the score counts the
 * overlap, never the parts.
 *
 * ## Alert-only
 *
 * There is no trading path here and no caller that could place an order. This
 * module returns a verdict and the evidence behind it. Nothing in it can buy.
 *
 * ## Unknown is never zero
 *
 * A trace that hit its call cap, or a wallet whose history could not be read, is
 * `null` - not a fresh wallet, not an old one. `confidence` reports how much of
 * the trace was actually readable, and a verdict computed over a mostly-unread
 * trace says so instead of scoring it as clean.
 */

/** How fresh a wallet must be, in prior transactions, to count as "made for this". */
export const FRESH_MAX_PRIOR_TXS = 5;
/** Funding this long before launch or less counts as pre-launch staging. */
export const FUNDING_WINDOW_MINUTES = 60;
/** Buying within this many slots of the launch counts as first-slot. */
export const FIRST_SLOT_WINDOW = 3;
/** Selling within this long of buying counts as a fast exit. */
export const FAST_EXIT_MINUTES = 5;
/** Below this many identified early buyers, no rate is reported at all. */
export const MIN_BUYERS_FOR_RATE = 3;

export interface TracedWallet {
  address: string;
  /** Prior transaction count at trace time. null = could not be read; NOT a fresh wallet. */
  priorTxs: number | null;
  /** Minutes before the launch that the deployer funded it. null = no funding seen from this deployer. */
  fundedMinutesBefore: number | null;
  /** Slots after the launch at which it first bought. null = never seen buying. */
  boughtAtSlotOffset: number | null;
  /** Minutes between its buy and its sell. null = no exit seen (still holding, or unreadable). */
  exitMinutes: number | null;
}

export interface Trace {
  mint: string;
  deployer: string | null;
  wallets: TracedWallet[];
  /** True when the trace stopped early (call cap, unreadable page). Its counts are floors. */
  truncated: boolean;
  /** Early buyers the trace identified but could not follow. Counted, never dropped. */
  unreadableWallets: number;
}

export type Verdict = "insider-shape" | "some-signals" | "nothing" | "cannot-say";

export interface Finding {
  label: string;
  /** Wallets meeting this signal. */
  count: number;
  /** Wallets it could be evaluated on. The denominator is always shown. */
  of: number;
  /** count/of, or null when `of` is below the floor or zero. Never 0 for "no data". */
  rate: number | null;
  note: string | null;
}

export interface Fingerprint {
  mint: string;
  verdict: Verdict;
  /** Wallets meeting ALL FOUR signals. This is the number that matters. */
  fullShape: number;
  findings: Finding[];
  /** Share of identified wallets that were actually readable. */
  confidence: { readable: number; total: number; ratio: number | null };
  /** Why the verdict is what it is, in plain words. */
  because: string[];
  /** Always present: what would make this reading wrong. */
  caveats: string[];
}

function rateOf(count: number, of: number, floor = MIN_BUYERS_FOR_RATE): number | null {
  return of >= floor && of > 0 ? count / of : null;
}

const isFresh = (w: TracedWallet) => w.priorTxs !== null && w.priorTxs <= FRESH_MAX_PRIOR_TXS;
const isStaged = (w: TracedWallet) => w.fundedMinutesBefore !== null && w.fundedMinutesBefore >= 0 && w.fundedMinutesBefore <= FUNDING_WINDOW_MINUTES;
const isFirstSlot = (w: TracedWallet) => w.boughtAtSlotOffset !== null && w.boughtAtSlotOffset <= FIRST_SLOT_WINDOW;
const isFastExit = (w: TracedWallet) => w.exitMinutes !== null && w.exitMinutes <= FAST_EXIT_MINUTES;

/** All four signals on the same wallet. The conjunction is the fingerprint; the parts are not. */
export function hasFullShape(w: TracedWallet): boolean {
  return isFresh(w) && isStaged(w) && isFirstSlot(w) && isFastExit(w);
}

export function fingerprint(trace: Trace): Fingerprint {
  const ws = trace.wallets;
  const readable = ws.filter((w) => w.priorTxs !== null).length;
  const total = ws.length + trace.unreadableWallets;
  const confidence = { readable, total, ratio: total > 0 ? readable / total : null };

  const findings: Finding[] = [
    { label: `Fresh wallets (<=${FRESH_MAX_PRIOR_TXS} prior txs)`, count: ws.filter(isFresh).length, of: readable,
      rate: rateOf(ws.filter(isFresh).length, readable), note: readable < ws.length ? `${ws.length - readable} wallet(s) unreadable - not counted either way` : null },
    { label: `Funded by the deployer within ${FUNDING_WINDOW_MINUTES} min of launch`, count: ws.filter(isStaged).length, of: ws.length,
      rate: rateOf(ws.filter(isStaged).length, ws.length), note: `On its own this is not a signal: all 40 deployers measured 2026-09-14 funded somebody.` },
    { label: `Bought within ${FIRST_SLOT_WINDOW} slots of launch`, count: ws.filter(isFirstSlot).length, of: ws.length,
      rate: rateOf(ws.filter(isFirstSlot).length, ws.length), note: null },
    { label: `Exited within ${FAST_EXIT_MINUTES} min`, count: ws.filter(isFastExit).length, of: ws.length,
      rate: rateOf(ws.filter(isFastExit).length, ws.length), note: null },
  ];

  const fullShape = ws.filter(hasFullShape).length;
  const because: string[] = [];
  const caveats: string[] = [];

  if (trace.truncated) caveats.push(`The trace stopped early, so every count here is a FLOOR - there may be more.`);
  if (trace.unreadableWallets > 0) caveats.push(`${trace.unreadableWallets} early buyer(s) were identified but could not be followed. They are neither clean nor dirty; they are unknown.`);
  caveats.push(`Fresh-and-fast is the shape of a sniper bot as well as an insider. This says the pattern is present, not who is behind it.`);

  let verdict: Verdict;
  // Too little readable to say anything. This is checked FIRST: a trace where
  // almost nothing could be read would otherwise score as "nothing" - a clean
  // bill of health issued on no evidence, which is the worst output here.
  if (ws.length === 0 && trace.unreadableWallets > 0) {
    verdict = "cannot-say";
    because.push(`No early buyer could be read for ${trace.mint}. ${trace.unreadableWallets} were identified and none could be followed.`);
  } else if (ws.length === 0) {
    verdict = "cannot-say";
    because.push(`No early buyers were identified at all, so there is nothing to score. That is a gap in the trace, not a clean launch.`);
  } else if (confidence.ratio !== null && confidence.ratio < 0.5) {
    verdict = "cannot-say";
    because.push(`Only ${readable} of ${total} wallet(s) were readable - under half. Any rate computed on that is a guess.`);
  } else if (fullShape >= 2) {
    verdict = "insider-shape";
    because.push(`${fullShape} wallet(s) were fresh, funded by the deployer before launch, bought in the first ${FIRST_SLOT_WINDOW} slots, AND exited within ${FAST_EXIT_MINUTES} minutes. All four on the same wallet, more than once.`);
  } else if (fullShape === 1) {
    verdict = "some-signals";
    because.push(`One wallet showed all four signals. One is a coincidence you can tell a story about; the pattern claim needs repetition.`);
  } else if (findings.some((f) => f.rate !== null && f.rate >= 0.5 && f.label.startsWith("Fresh"))) {
    verdict = "some-signals";
    because.push(`Fresh wallets dominate the early buyers, but no single wallet completed the whole shape - the funding, the first-slot buy and the fast exit did not line up on the same address.`);
  } else {
    verdict = "nothing";
    because.push(`No wallet completed the shape. Individual signals appear, as they do on most launches.`);
  }

  return { mint: trace.mint, verdict, fullShape, findings, confidence, because, caveats };
}
