import { z } from "zod";

// Synthetic report data, deliberately public; never a live transcript store.
export const readReceipt = { claims: [
  { id: "api-data-flow", paths: ["src/api/records.ts", "src/services/records.ts", "src/data/record-store.ts"], symbols: ["handle", "getRecord", "recordStore.findById"] },
  { id: "stale-doc", paths: ["README.md", "src/api/records.ts"], document_status: 200, source_status: 404 },
] };
export const repair = "export function parseLimit(v){const n=Number(v);return Number.isFinite(n)&&n>=0?n:20;}\n";
const check = z.object({ id: z.enum(["baseline", "repaired", "read-source"]), exit_code: z.number().int() }).strict();
export const reportSchema = z.object({
  status: z.enum(["done", "failed", "blocked"]), changes: z.array(z.enum(["contract.mjs"])),
  checks: z.array(check).min(1), blockers: z.array(z.enum(["provider-unavailable", "verification-missing"])),
  risks: z.array(z.enum(["no-os-isolation", "source-doc-conflict"])).min(1),
  evidence: z.array(z.enum(["checks/baseline", "checks/repaired", "checks/read-source"])).min(1),
  receipt: z.unknown(), detail: z.string().optional(),
}).strict();
export function compactReport(text: string): string {
  const { detail: _detail, ...core } = reportSchema.parse(JSON.parse(text));
  return JSON.stringify(core);
}
export function makeReport(task: "read" | "code", compact = false): string {
  const text = JSON.stringify({ status: "done", changes: task === "code" ? ["contract.mjs"] : [],
    checks: task === "code" ? [{ id: "baseline", exit_code: 1 }, { id: "repaired", exit_code: 0 }] : [{ id: "read-source", exit_code: 0 }],
    blockers: [], risks: [task === "code" ? "no-os-isolation" : "source-doc-conflict"],
    evidence: task === "code" ? ["checks/baseline", "checks/repaired"] : ["checks/read-source"],
    receipt: task === "read" ? readReceipt : {},
    detail: "Synthetic repeated source/log explanation. ".repeat(256),
  });
  return compact ? compactReport(text) : text;
}
/** A size/form gate, not a truth or secrecy guarantee. Independent oracles remain required. */
export function reportAccepted(text: string, truncated: boolean, task: "read" | "code"): boolean {
  if (truncated || Buffer.byteLength(text) > 4096) return false;
  try {
    const r = reportSchema.parse(JSON.parse(text));
    const ids = r.checks.map(c => c.id);
    return r.status === "done" && r.blockers.length === 0 &&
      (task === "code" ? r.changes.join() === "contract.mjs" && r.checks.length === 2 &&
        ids.join() === "baseline,repaired" && r.checks[0]!.exit_code === 1 && r.checks[1]!.exit_code === 0 &&
        r.evidence.join() === "checks/baseline,checks/repaired" && r.risks.includes("no-os-isolation") :
        r.changes.length === 0 && r.checks.length === 1 && ids[0] === "read-source" && r.checks[0]!.exit_code === 0 &&
        r.evidence.join() === "checks/read-source" && r.risks.includes("source-doc-conflict"));
  } catch { return false; }
}
