/** The README's graph section must be what the code renders. A diagram that drifts from the edges it claims to show is worse than none. */
import fs from "fs";
import { readmeSection, GRAPHS } from "../scripts/graph-render";
import { validateGraph } from "../src/graph/graph";
let pass = 0, fail = 0;
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  PASS: ${n}`); } else { fail++; console.log(`  FAIL: ${n}${d ? " -- " + d : ""}`); } };
const readme = fs.readFileSync("README.md", "utf-8");
const section = readmeSection();
check("README contains the generated graph section verbatim", readme.includes(section), "run `npm run graph:render` and commit README.md");
check("docs/GRAPHS.md exists and matches", fs.existsSync("docs/GRAPHS.md") && fs.readFileSync("docs/GRAPHS.md", "utf-8").includes(section.split("\n").slice(5, -1).join("\n")));
for (const g of GRAPHS) check(`${g.title} validates`, validateGraph(g.graph).ok);
const total = GRAPHS.reduce((a, g) => a + validateGraph(g.graph).conditionalEdges, 0);
check("the README states the total conditional-edge count", readme.includes(`${total} conditional**`), String(total));
console.log(`  CONDITIONAL EDGES, all three graphs: ${total}`);
console.log(`\nTotal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
