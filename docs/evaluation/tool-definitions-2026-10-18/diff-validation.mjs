// usage: node diff-validation.mjs <baseline.json> <candidate.json>  (outputs of compare-validation.mjs)
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2).map(f => JSON.parse(readFileSync(f, "utf8")));
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const stripPattern = s => JSON.parse(JSON.stringify(s, (k, v) => k === "pattern" && typeof v === "string" && v.startsWith("^([0-9a-fA-F]{8}") ? undefined : v));
const count = t => { let n = 0; JSON.stringify(t.map(x => x.inputSchema), (k, v) => { if (k === "pattern") n++; return v; }); return n; };
console.log(JSON.stringify({
  cases: a.results.length, responsesIdentical: eq(a.results, b.results), knownReadsIdentical: eq(a.known, b.known),
  sideEffects: [a.sideEffects, b.sideEffects],
  outputSchemasAndAnnotationsIdentical: eq(a.toolsList.map(t => [t.name, t.outputSchema, t.annotations]), b.toolsList.map(t => [t.name, t.outputSchema, t.annotations])),
  inputSchemasIdenticalExceptUuidPattern: eq(a.toolsList.map(t => stripPattern(t.inputSchema)), b.toolsList.map(t => t.inputSchema)),
  patternsInInputSchemas: [count(a.toolsList), count(b.toolsList)],
}, null, 1));
