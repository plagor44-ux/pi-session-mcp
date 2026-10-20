import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runOutputSchema } from "./classify.js";
import { macMatches, sha256Hex } from "./output-mac.js";
import type { AuditAddresses } from "./network.js";
import type { RunOutput } from "./run-one.js";
import { parseStraceLog, type TraceFindings } from "./trace.js";

/** Parses a strace log; null when it is missing or has no line, which means nothing can be audited. */
export async function auditLog(path: string, roots: string[], initialCwd: string, addresses: AuditAddresses): Promise<TraceFindings | null> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return null; }
  const first = /^(?:\[pid\s+(\d+)\]|(\d+))\s/m.exec(text);
  if (!first) return null;
  return parseStraceLog(text, {
    rootPid: Number(first[1] ?? first[2]), initialCwd, allowedWriteRoots: roots,
    providerAddresses: addresses.providerAddresses, dnsAddresses: addresses.dnsAddresses,
  });
}

export interface VerifiedOutput {
  /** The parsed output, only when it verified. */
  output: RunOutput | null;
  /** The assistant text whose hash matched the signed output. */
  text: string | null;
  /** The file exists but did not verify (schema, run id, MAC or text hash): the worker may have forged it (R35). */
  tampered: boolean;
}

const TEXT_REF = /^[A-Za-z0-9._-]{1,140}$/;

/**
 * Reads `run-output.json` and verifies it against the per-run key before any value is used: schema, run id, HMAC, and the SHA-256 of the
 * referenced assistant text. An absent file is "no output", not tampering.
 */
export async function readVerifiedOutput(scopeRoot: string, privateDir: string, runId: string, key: Uint8Array): Promise<VerifiedOutput> {
  const forged: VerifiedOutput = { output: null, text: null, tampered: true };
  let raw: string;
  try { raw = await readFile(join(scopeRoot, "run-output.json"), "utf8"); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { output: null, text: null, tampered: false } : forged;
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return forged; }
  const parsed = runOutputSchema.safeParse(json);
  if (!parsed.success || typeof json !== "object" || json === null || !macMatches(json as Record<string, unknown>, key)) return forged;
  const output = parsed.data as RunOutput;
  if (output.runId !== runId) return forged;
  if (output.assistantTextRef === null) return output.assistantTextSha256 === null ? { output, text: null, tampered: false } : forged;
  if (!TEXT_REF.test(output.assistantTextRef) || output.assistantTextSha256 === null) return forged;
  let bytes: Buffer;
  try { bytes = await readFile(join(privateDir, output.assistantTextRef)); } catch { return forged; }
  if (sha256Hex(bytes) !== output.assistantTextSha256) return forged;
  return { output, text: bytes.toString("utf8"), tampered: false };
}
