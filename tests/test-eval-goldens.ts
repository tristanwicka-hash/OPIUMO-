/**
 * The evaluation pipeline reproduces its golden outputs.
 *
 *   npx ts-node tests/test-eval-goldens.ts             compare against tests/fixtures/eval-goldens.json
 *   CAPTURE_GOLDENS=1 npx ts-node tests/test-eval-goldens.ts   (re)write the goldens from the CURRENT code
 *
 * The goldens were captured from the pre-graph collectTokenMetrics on
 * 2026-09-11. A refactor that changes any field of any scenario fails here;
 * that is the point - same inputs, same metrics, or the refactor is wrong.
 */
import fs from "fs";
import { collectTokenMetrics } from "../src/data/tokenMetrics";
import { evaluateFilters } from "../src/filters/engine";
import { loadConfig } from "../src/config";
import { SCENARIOS, stable } from "./eval-golden-scenarios";

const FILE = "tests/fixtures/eval-goldens.json";
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); } else { fail++; console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}

(async () => {
  const filters = loadConfig().filters;
  const out: Record<string, { metrics: Record<string, unknown>; decision: string; reasons: string[] }> = {};
  for (const s of SCENARIOS) {
    const m = await collectTokenMetrics(s.connection, s.event, s.polling, undefined, s.options);
    const r = evaluateFilters(s.event, m, filters);
    out[s.name] = { metrics: stable(m), decision: r.decision, reasons: r.reasons };
  }
  if (process.env.CAPTURE_GOLDENS === "1") {
    fs.mkdirSync("tests/fixtures", { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + "\n");
    console.log(`captured ${Object.keys(out).length} golden scenario(s) -> ${FILE}`);
    process.exit(0);
  }
  if (!fs.existsSync(FILE)) { console.log(`FAIL: ${FILE} missing - run with CAPTURE_GOLDENS=1 on the KNOWN-GOOD code first`); process.exit(1); }
  const golden = JSON.parse(fs.readFileSync(FILE, "utf-8"));
  check("every scenario has a golden", SCENARIOS.every((s) => s.name in golden));
  check("no golden is orphaned", Object.keys(golden).every((k) => SCENARIOS.some((s) => s.name === k)));
  for (const s of SCENARIOS) {
    const g = golden[s.name]; const a = out[s.name];
    if (!g) continue;
    const same = JSON.stringify(a) === JSON.stringify(g);
    let detail = "";
    if (!same) {
      for (const k of new Set([...Object.keys(g.metrics), ...Object.keys(a.metrics)])) {
        if (JSON.stringify(g.metrics[k]) !== JSON.stringify(a.metrics[k])) detail += ` ${k}: ${JSON.stringify(g.metrics[k])} -> ${JSON.stringify(a.metrics[k])};`;
      }
      if (g.decision !== a.decision) detail += ` decision ${g.decision} -> ${a.decision};`;
      if (JSON.stringify(g.reasons) !== JSON.stringify(a.reasons)) detail += ` reasons changed;`;
    }
    check(`${s.name} — identical metrics, decision and reasons`, same, detail);
  }
  console.log(`\nTotal: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
