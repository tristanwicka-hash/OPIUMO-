import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { loadConfig } from "../config";
import { Logger } from "../util/logger";
import { withTimeout } from "../data/tokenMetrics";

const logger = new Logger("jupiter", loadConfig().logging.level);

export const SOL_MINT = "So11111111111111111111111111111111111111112"; // wrapped SOL

/**
 * Thin REST client for Jupiter's public Swap API - deliberately NOT the
 * @jup-ag/api SDK, to keep this to a couple of plain HTTP calls against a
 * config-driven URL (config.jupiter.*) rather than pinning to one client
 * library's opinion of the endpoint. Uses Node's built-in global fetch
 * (stable since Node 18) rather than the node-fetch package - one fewer
 * dependency, and it correctly respects proxy environment variables where
 * node-fetch doesn't. Could not be verified live from this sandbox (no
 * network egress here) - the response shapes below are typed loosely/
 * defensively for exactly that reason. Run npm run test:trading-live
 * yourself before trusting this against a real endpoint.
 */

/**
 * Node's global fetch wraps every network-level failure (DNS, TLS, proxy rejection, connection
 * refused, ...) in a generic `TypeError: fetch failed` with the actual reason several levels
 * down its `.cause` chain - walks that chain so errors are debuggable instead of just "fetch
 * failed" (confirmed while testing: this sandbox's real failure, a proxy 403, was completely
 * hidden behind that generic message until this fix).
 */
function describeFetchError(err: any): string {
  const parts: string[] = [];
  let current = err;
  while (current) {
    if (current.message) parts.push(current.message);
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(" -> ") : String(err);
}

async function fetchWithDescriptiveErrors(url: string, init: RequestInit | undefined, timeoutMs: number, label: string): Promise<Response> {
  try {
    return await withTimeout(fetch(url, init), timeoutMs, label);
  } catch (err: any) {
    throw new Error(`${label} network error: ${describeFetchError(err)}`);
  }
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  // The full response has many more fields (route plan, etc) - passed through
  // as-is to /swap, which is all that actually matters; we don't parse them.
  [key: string]: unknown;
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps: number
): Promise<JupiterQuote> {
  const config = loadConfig();
  const url = `${config.jupiter.quoteApiUrl}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;

  const res = await fetchWithDescriptiveErrors(url, undefined, config.jupiter.requestTimeoutMs, "Jupiter quote");
  if (!res.ok) {
    throw new Error(`Jupiter quote failed: ${res.status} ${res.statusText} - ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as JupiterQuote;
}

async function getSwapTransactionBase64(quote: JupiterQuote, userPublicKey: string): Promise<string> {
  const config = loadConfig();
  const res = await fetchWithDescriptiveErrors(
    config.jupiter.swapApiUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    },
    config.jupiter.requestTimeoutMs,
    "Jupiter swap tx build"
  );
  if (!res.ok) {
    throw new Error(`Jupiter swap tx build failed: ${res.status} ${res.statusText} - ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { swapTransaction?: string };
  if (!body.swapTransaction) throw new Error("Jupiter swap response missing swapTransaction");
  return body.swapTransaction;
}

export interface SwapResult {
  signature: string;
  inAmountRaw: string;
  outAmountRaw: string;
  priceImpactPct: number;
}

/**
 * Quotes, builds, signs, sends, and confirms one swap. Used for BOTH buys
 * (SOL -> token) and sells (token -> SOL) - direction is just which mint
 * you pass as input vs output, there's no separate "buy" vs "sell" concept
 * at this layer (src/trading/engine.ts is where that distinction lives).
 */
export async function executeSwap(
  connection: Connection,
  wallet: Keypair,
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps: number
): Promise<SwapResult> {
  const quote = await getQuote(inputMint, outputMint, amountRaw, slippageBps);
  logger.info(
    `Quote: ${amountRaw} ${inputMint.slice(0, 4)}.. -> ${quote.outAmount} ${outputMint.slice(0, 4)}.. ` +
      `(price impact ${quote.priceImpactPct}%)`
  );

  const swapTxBase64 = await getSwapTransactionBase64(quote, wallet.publicKey.toBase58());
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, "base64"));
  tx.sign([wallet]);

  const config = loadConfig();
  const signature = await withTimeout(
    connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }),
    config.jupiter.requestTimeoutMs,
    "send swap transaction"
  );

  const latestBlockhash = await connection.getLatestBlockhash();
  const confirmation = await withTimeout(
    connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed"),
    config.jupiter.requestTimeoutMs,
    "confirm swap transaction"
  );
  if (confirmation.value.err) {
    throw new Error(`Swap transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  logger.info(`Swap confirmed: ${signature}`);
  return {
    signature,
    inAmountRaw: quote.inAmount,
    outAmountRaw: quote.outAmount,
    priceImpactPct: Number(quote.priceImpactPct) || 0,
  };
}
