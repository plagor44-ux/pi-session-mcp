import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writersRoot } from "./writer-state.js";

export const REFRESH_THRESHOLD_MINUTES = 2;
export const REFRESH_INTERVAL_MS = 60_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedEntries(host: unknown, providers: readonly string[]): [string, Record<string, unknown>][] {
  if (!record(host)) return [];
  return [...new Set(providers)].flatMap((provider) => {
    if (provider === "cursor" || !Object.hasOwn(host, provider)) return [];
    const entry = host[provider];
    return record(entry) ? [[provider, entry] as [string, Record<string, unknown>]] : [];
  });
}

export function selectBoundaryCredentials(host: unknown, providers: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(selectedEntries(host, providers).flatMap(([provider, entry]) => {
    if (entry.type === "oauth") return [[provider, { ...entry, refresh: "" }]];
    if (entry.type === "api_key") return [[provider, { ...entry }]];
    return [];
  }));
}

async function writeAtomic(directory: string, name: string, value: Record<string, unknown>): Promise<void> {
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, join(directory, name));
  } finally {
    if (created) await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}

export async function writeBoundaryCredentials(agentDir: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeAtomic(agentDir, "auth.json", value);
}

export function expiresWithin(host: unknown, providers: readonly string[], minutes: number, now: number): boolean {
  return selectedEntries(host, providers).some(([, entry]) => {
    if (entry.type !== "oauth") return false;
    if (typeof entry.expires !== "number" || !Number.isFinite(entry.expires)) return true;
    const expiryMs = entry.expires > 1e12 ? entry.expires : entry.expires * 1000;
    return expiryMs - now <= minutes * 60_000;
  });
}

export async function ensureWarmupConfig(
  home: string,
  providers: readonly { provider: string; model: string }[],
): Promise<string | undefined> {
  let host: unknown;
  try { host = JSON.parse(await readFile(join(home, ".pi", "agent", "auth.json"), "utf8")) as unknown; }
  catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return undefined;
    throw new Error("writer_credentials_unreadable");
  }
  const oauth = new Map(selectedEntries(host, providers.map(({ provider }) => provider)).filter(([, entry]) => entry.type === "oauth"));
  const selected = providers.filter(({ provider }) => oauth.has(provider));
  if (selected.length === 0) return undefined;
  const directory = join(writersRoot(home), ".warmup");
  const empty = join(directory, "empty");
  await mkdir(empty, { recursive: true, mode: 0o700 });
  const executionProfiles = Object.fromEntries(selected.map(({ provider, model }, index) => [provider, {
    provider, model, permissionProfile: "read-only", thinkingLevel: "off", default: index === 0,
  }]));
  await writeAtomic(directory, "config.json", { workspaces: { warmup: empty }, executionProfiles });
  return join(directory, "config.json");
}

/** Use Pi's locked host store via session creation; never write host credentials ourselves. */
export async function refreshHostLogin(input: {
  nodePath: string;
  releaseRoot: string;
  warmupConfig: string;
  timeoutMs: number;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = spawn(input.nodePath, [join(input.releaseRoot, "dist", "main.js")], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, PI_SESSION_MCP_CONFIG: input.warmupConfig },
    });
    let failed = false;
    let expected = 1;
    let buffer = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (failed) return;
      failed = true;
      server.kill("SIGTERM");
      killTimer = setTimeout(() => { server.kill("SIGKILL"); }, 2_000);
    };
    const timer = setTimeout(fail, input.timeoutMs);
    const send = (message: unknown) => { server.stdin.write(`${JSON.stringify(message)}\n`); };
    server.stdin.on("error", fail);
    server.on("error", () => { clearTimeout(timer); clearTimeout(killTimer); reject(new Error("writer_auth_warmup_failed")); });
    server.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (!failed && expected === 4 && code === 0) resolve();
      else reject(new Error("writer_auth_warmup_failed"));
    });
    server.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 1_048_576) { fail(); return; }
      for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: unknown;
        try { message = JSON.parse(line) as unknown; } catch { continue; }
        if (!record(message) || message.id !== expected) continue;
        if (message.error !== undefined || (record(message.result) && message.result.isError === true)) { fail(); return; }
        if (expected === 1) {
          expected = 2;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pi_session_start", arguments: { workspace: "warmup" } } });
        } else if (expected === 2) {
          const result = message.result;
          const content = record(result) ? result.structuredContent : undefined;
          const session = record(content) ? content.session : undefined;
          if (!record(session) || typeof session.id !== "string" || session.id.length === 0) { fail(); return; }
          expected = 3;
          send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pi_session_close", arguments: { sessionId: session.id } } });
        } else if (expected === 3) {
          expected = 4;
          server.stdin.end();
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-writer-auth-warmup", version: "1" },
    } });
  });
}
