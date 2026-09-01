import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Decodes a base58-encoded secret key (the format Phantom/Solflare export,
 * and what WALLET_PRIVATE_KEY in .env holds) into a Keypair. Shared by
 * anything that needs to sign transactions (perps orders now; spot auto-buy
 * later, if built).
 */
export function loadWalletFromBase58(secretKeyBase58: string): Keypair {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(secretKeyBase58);
  } catch (err: any) {
    throw new Error(`WALLET_PRIVATE_KEY is not valid base58: ${err?.message || err}`);
  }
  if (decoded.length !== 64) {
    throw new Error(
      `WALLET_PRIVATE_KEY decoded to ${decoded.length} bytes, expected 64 (a Solana secret key). ` +
        "Make sure you exported the full secret key, not just the public address."
    );
  }
  return Keypair.fromSecretKey(decoded);
}
