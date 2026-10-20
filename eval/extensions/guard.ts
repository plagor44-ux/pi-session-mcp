import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, hash, snapshot } from "../profiles/files.js";

/** Hashes only. File contents never enter a snapshot. */
export interface GuardSnapshot { files: Record<string, string /* sha256 or "absent" */> }

const ABSENT = "absent";
const CLAUDE_KEY = ".claude.json#mcpServers.pi-*";
// The whole file: pi-* entries can also be written as dotted keys or inline tables, which no section extraction would catch.
const CODEX_KEY = ".codex/config.toml";
const NPM_KEY = ".pi/agent/npm";
const FILE_KEYS = [".config/pi-session-mcp/pi-session-mcp.json", ".pi/agent/settings.json", ".pi/agent/mcp.json"];

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR";

async function readOptional(path: string): Promise<Buffer | null> {
  try { return await readFile(path); } catch (error) { if (isMissing(error)) return null; throw error; }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

function claudeEntries(raw: Buffer): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch { return `unparsable:${hash(raw)}`; }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  const entries = servers && typeof servers === "object" ? Object.entries(servers).filter(([name]) => name.startsWith("pi-")) : [];
  return digest(canonical(Object.fromEntries(entries)));
}

export async function guardSnapshot(home: string): Promise<GuardSnapshot> {
  const files: Record<string, string> = {};
  for (const key of FILE_KEYS) {
    const raw = await readOptional(join(home, key));
    files[key] = raw === null ? ABSENT : hash(raw);
  }
  try {
    files[NPM_KEY] = digest(await snapshot(join(home, NPM_KEY)));
  } catch (error) {
    if (!isMissing(error)) throw error;
    files[NPM_KEY] = ABSENT;
  }
  const claude = await readOptional(join(home, ".claude.json"));
  files[CLAUDE_KEY] = claude === null ? ABSENT : claudeEntries(claude);
  const codex = await readOptional(join(home, ".codex", "config.toml"));
  files[CODEX_KEY] = codex === null ? ABSENT : hash(codex);
  return { files };
}

/** Keys whose value differs, including keys present on one side only, sorted. */
export function guardDiff(before: GuardSnapshot, after: GuardSnapshot): string[] {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter((k) => before.files[k] !== after.files[k]).sort();
}
