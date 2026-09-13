/**
 * npm run cost:feed -- [--seconds 60]
 *
 * What does it cost just to KNOW a token launched?
 *
 * The RPC meter counts HTTP calls. It does not see the websocket, and Helius
 * bills "2 credits per 0.1 MB (uncompressed)" of streamed data
 * (helius.dev/docs/billing/credits). So the meter cannot answer this question
 * and never could - the number it reports is a floor, not a total.
 *
 * This measures both candidate launch feeds side by side over the same window:
 *
 *   A. what the bot does now - Helius logsSubscribe on the Pump.fun and
 *      Raydium programs, which streams EVERY transaction touching either
 *      program, then spends 1 getParsedTransaction per create to learn the mint.
 *   B. PumpPortal's free subscribeNewToken, which delivers mint, deployer,
 *      launch signature and bonding-curve key already parsed, and is not
 *      Helius, so it costs no credits at all.
 *
 * Read-only. Opens two websockets, spends no RPC calls, places nothing.
 */
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import "dotenv/config";

/** Helius's published rate: 2 credits per 0.1 MB uncompressed. */
export function streamCredits(bytes: number): number {
  return (bytes / 100_000) * 2;
}

/** Extrapolate a measured window to a day. Separate from the I/O so it is testable. */
export function perDay(value: number, windowSeconds: number): number {
  if (windowSeconds <= 0) throw new Error("windowSeconds must be > 0");
  return (value / windowSeconds) * 86_400;
}

const PUMPFUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`--${name} needs a number`);
  return v;
}

async function measureHelius(seconds: number) {
  const url = (process.env.RPC_URL || "").replace(/^http/, "ws");
  if (!url.startsWith("ws")) return null;   // absent, not zero
  return new Promise<{ bytes: number; msgs: number; creates: number }>((resolve) => {
    const ws = new WebSocket(url);
    let bytes = 0, msgs = 0, creates = 0;
    ws.on("open", () => {
      for (const [i, pid] of [PUMPFUN, RAYDIUM].entries())
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "logsSubscribe",
          params: [{ mentions: [pid] }, { commitment: "confirmed" }] }));
    });
    ws.on("message", (raw: Buffer) => {
      bytes += raw.length; msgs++;
      try {
        const logs = JSON.parse(raw.toString())?.params?.result?.value?.logs;
        if (Array.isArray(logs) && logs.some((l: string) => l.includes("Instruction: Create"))) creates++;
      } catch { /* a frame we cannot parse still cost its bytes, which is the point */ }
    });
    ws.on("error", () => resolve({ bytes, msgs, creates }));
    setTimeout(() => { ws.close(); resolve({ bytes, msgs, creates }); }, seconds * 1000);
  });
}

async function measurePumpPortal(seconds: number) {
  return new Promise<{ bytes: number; launches: number; fields: string[] | null; refused: string | null }>((resolve) => {
    const ws = new WebSocket("wss://pumpportal.fun/api/data");   // deliberately NO api key
    let bytes = 0, launches = 0, fields: string[] | null = null, refused: string | null = null;
    ws.on("open", () => ws.send(JSON.stringify({ method: "subscribeNewToken" })));
    ws.on("message", (raw: Buffer) => {
      bytes += raw.length;
      let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m?.message && !m.mint) { if (!/success/i.test(m.message)) refused = m.message; return; }
      if (m?.mint) { launches++; if (!fields) fields = Object.keys(m); }
    });
    ws.on("error", (e: Error) => { refused = e.message; resolve({ bytes, launches, fields, refused }); });
    setTimeout(() => { ws.close(); resolve({ bytes, launches, fields, refused }); }, seconds * 1000);
  });
}

async function main() {
  const seconds = arg("seconds", 60);
  console.log(`\n=== what the launch feed costs — ${seconds}s window ===\n`);

  const [helius, pp] = await Promise.all([measureHelius(seconds), measurePumpPortal(seconds)]);

  console.log("  A. Helius logsSubscribe (what the bot does now)");
  if (!helius) {
    console.log("     RPC_URL not set — UNKNOWN, not zero. Cannot measure.\n");
  } else {
    const mbDay = perDay(helius.bytes, seconds) / 1e6;
    const streamDay = perDay(streamCredits(helius.bytes), seconds);
    const resolveDay = perDay(helius.creates, seconds);   // 1 getParsedTransaction each
    console.log(`     streamed        ${(helius.bytes / 1e6).toFixed(2)} MB in ${seconds}s  ->  ${mbDay.toFixed(0)} MB/day`);
    console.log(`     stream credits  ${Math.round(streamDay).toLocaleString()}/day   (2 per 0.1 MB — INVISIBLE to logs/rpc-meter.jsonl)`);
    console.log(`     create logs     ${helius.creates} -> ${Math.round(resolveDay).toLocaleString()}/day, each needing 1 getParsedTransaction to learn the mint`);
    console.log(`     resolve credits ${Math.round(resolveDay).toLocaleString()}/day`);
    console.log(`     TOTAL           ${Math.round(streamDay + resolveDay).toLocaleString()} credits/day`);
  }

  console.log("\n  B. PumpPortal subscribeNewToken, no api key (not Helius)");
  if (pp.refused) {
    console.log(`     refused: ${pp.refused}`);
  } else {
    console.log(`     launches        ${pp.launches} -> ${Math.round(perDay(pp.launches, seconds)).toLocaleString()}/day`);
    console.log(`     streamed        ${(pp.bytes / 1024).toFixed(1)} KB -> ${(perDay(pp.bytes, seconds) / 1e6).toFixed(1)} MB/day`);
    console.log(`     HELIUS CREDITS  0`);
    console.log(`     gives you       ${(pp.fields || []).join(", ") || "nothing"}`);
  }

  const out = {
    at: new Date().toISOString(), seconds,
    helius: helius && {
      bytes: helius.bytes, msgs: helius.msgs, createLogs: helius.creates,
      mbPerDay: perDay(helius.bytes, seconds) / 1e6,
      streamCreditsPerDay: perDay(streamCredits(helius.bytes), seconds),
      resolveCreditsPerDay: perDay(helius.creates, seconds),
    },
    pumpportal: { bytes: pp.bytes, launches: pp.launches, launchesPerDay: perDay(pp.launches, seconds), fields: pp.fields, refused: pp.refused, heliusCreditsPerDay: 0 },
  };
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(path.join("reports", "feed-cost.json"), JSON.stringify(out, null, 2));
  console.log(`\n  -> reports/feed-cost.json\n`);
}

if (require.main === module) main();
