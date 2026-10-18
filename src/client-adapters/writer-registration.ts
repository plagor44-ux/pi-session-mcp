import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { safeRunner } from "./command.js";
import type { ClientName, CommandExecution, CommandRunner, RegistrationState } from "./types.js";
import type { OwnershipAccess, OwnershipRecord, OwnershipStore } from "../setup-ownership.js";
import { WRITER_NAME_PATTERN, wrapperDigest } from "../writer-state.js";

export interface WriterRegistrationIntent {
  readonly client: ClientName;
  readonly name: string;
  readonly wrapperPath: string;
  readonly projectDir: string;
}
export interface WriterRegistrationAdapter {
  inspect(intent: WriterRegistrationIntent): Promise<RegistrationState>;
  add(intent: WriterRegistrationIntent, execution?: CommandExecution): Promise<void>;
  remove(intent: WriterRegistrationIntent, execution?: CommandExecution): Promise<void>;
}

function validate(intent: WriterRegistrationIntent): void {
  if (!["claude-code", "codex"].includes(intent.client) || !intent.name.startsWith("pi-coding-") ||
    !WRITER_NAME_PATTERN.test(intent.name.slice("pi-coding-".length)) || !isAbsolute(intent.wrapperPath) ||
    !isAbsolute(intent.projectDir) || intent.projectDir.length > 4_096 || /[\0\r\n]/.test(intent.wrapperPath + intent.projectDir)) {
    throw new Error("writer_registration_invalid");
  }
}
function claudeState(text: string, intent: WriterRegistrationIntent): RegistrationState {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== `${intent.name}:`) return "unsupported";
  const field = (name: string): string | undefined => new RegExp(`^\\s*${name}\\s*:[ \\t]*(.*)$`, "im").exec(text)?.[1]?.trim();
  const scope = field("scope");
  const type = field("type");
  const command = field("command");
  if (!scope || !type || !command) return "unsupported";
  // Any nonempty inline environment or indented environment entry is divergent.
  const environment = /(?:^|\n)[ \t]*environment[ \t]*:[ \t]*(\S[^\n]*)/i.test(text) ||
    /(?:^|\n)[ \t]*environment[ \t]*:[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]{4,}\S/i.test(text);
  return /^local config\b/i.test(scope) && type === "stdio" && command === intent.wrapperPath &&
    !field("args?") && !environment ? "equivalent" : "divergent";
}
function codexState(text: string, intent: WriterRegistrationIntent): RegistrationState {
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || !value.transport || typeof value.transport !== "object") return "unsupported";
    const t = value.transport as Record<string, unknown>;
    const emptyEnvironment = t.env === null || (typeof t.env === "object" && !Array.isArray(t.env) && Object.keys(t.env as object).length === 0);
    return value.name === intent.name && value.enabled === true && t.type === "stdio" && t.command === intent.wrapperPath &&
      Array.isArray(t.args) && t.args.length === 0 && emptyEnvironment && Array.isArray(t.env_vars) && t.env_vars.length === 0 &&
      t.cwd === null ? "equivalent" : "divergent";
  } catch { return "unsupported"; }
}

export function createWriterRegistrationAdapter(input: CommandRunner): WriterRegistrationAdapter {
  const runner = safeRunner(input.run);
  const options = (intent: WriterRegistrationIntent): { cwd: string } | undefined => intent.client === "claude-code" ? { cwd: intent.projectDir } : undefined;
  return {
    async inspect(intent) {
      validate(intent);
      const claude = intent.client === "claude-code";
      const result = await runner.run(claude ? "claude" : "codex", ["mcp", "get", intent.name, ...(claude ? [] : ["--json"])], undefined, options(intent));
      if (result.exitCode === 0) return claude ? claudeState(result.stdout, intent) : codexState(result.stdout, intent);
      // Interpolate only a validated, regex-escaped registration name.
      const name = intent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const absent = claude
        ? new RegExp(`^No MCP server named "${name}"\\.(?:(?:\\s+Configured servers:.*)|(?:\\s+Run \u0060claude mcp add\u0060 to add one\\.))?\\s*$`, "i")
        : new RegExp(`^Error: No MCP server named '${name}' found\\.\\s*$`, "i");
      return absent.test(result.stderr.trim()) ? "absent" : "unsupported";
    },
    async add(intent, execution) {
      validate(intent);
      const claude = intent.client === "claude-code";
      const result = await (execution?.runner ?? runner).run(claude ? "claude" : "codex", ["mcp", "add", intent.name, ...(claude ? ["-s", "local"] : []), "--", intent.wrapperPath], execution?.signal, options(intent));
      if (result.exitCode !== 0) throw new Error("client_registration_failed");
    },
    async remove(intent, execution) {
      validate(intent);
      const claude = intent.client === "claude-code";
      const result = await (execution?.runner ?? runner).run(claude ? "claude" : "codex", ["mcp", "remove", intent.name, ...(claude ? ["-s", "local"] : [])], execution?.signal, options(intent));
      if (result.exitCode !== 0) throw new Error("client_removal_failed");
    },
  };
}

async function fingerprint(intent: WriterRegistrationIntent, owned = false): Promise<string> {
  let text: string;
  try { text = await readFile(intent.wrapperPath, "utf8"); }
  catch { throw Object.assign(new Error(owned ? "ownership_diverged" : "release_binding_mismatch"), { code: owned ? "ownership_diverged" : "release_binding_mismatch" }); }
  return createHash("sha256").update(JSON.stringify({ wrapper: intent.wrapperPath, digest: wrapperDigest(text) })).digest("hex");
}
const targetFor = (intent: WriterRegistrationIntent) => ({ client: intent.client, scope: intent.client === "codex" ? "user" : "local", alias: intent.name });
function execution(access: OwnershipAccess): CommandExecution {
  const signal = access.signal?.();
  return { ...(signal ? { signal } : {}), ...(access.mutationRunner ? { runner: access.mutationRunner } : {}) };
}

export async function registerWriter(ownership: OwnershipStore, adapter: WriterRegistrationAdapter, intent: WriterRegistrationIntent): Promise<void> {
  validate(intent);
  await ownership.transaction(async (access) => {
    access.assertHealthy?.();
    const target = targetFor(intent);
    const owned = await access.get(target);
    const expected = await fingerprint(intent, !!owned);
    const current = await adapter.inspect(intent);
    access.assertHealthy?.();
    if (owned && owned.fingerprint !== expected) throw new Error("release_binding_mismatch");
    if (current === "absent" && owned?.phase === "owned") throw new Error("ownership_diverged");
    if (current === "equivalent") {
      if (await fingerprint(intent, !!owned) !== expected) throw new Error("registration_fingerprint_mismatch");
      access.assertHealthy?.();
      if (owned?.phase === "pending") {
        await access.put({ ...owned, phase: "owned" });
        access.assertHealthy?.();
      }
      return;
    }
    if (current !== "absent") throw new Error(current === "divergent" ? "divergence_requires_replacement" : "client_unsupported");
    const pending: OwnershipRecord = { target, fingerprint: expected, previous: "absent", phase: "pending", transactionId: randomUUID() };
    access.assertHealthy?.();
    await access.put(pending);
    access.assertHealthy?.();
    await adapter.add(intent, execution(access));
    access.assertHealthy?.();
    const after = await adapter.inspect(intent);
    access.assertHealthy?.();
    if (after !== "equivalent" || await fingerprint(intent, true) !== expected) throw new Error("post_apply_mismatch");
    await access.put({ ...pending, phase: "owned" });
    access.assertHealthy?.();
  });
}

export async function unregisterWriter(ownership: OwnershipStore, adapter: WriterRegistrationAdapter, intent: WriterRegistrationIntent): Promise<void> {
  validate(intent);
  await ownership.transaction(async (access) => {
    access.assertHealthy?.();
    const target = targetFor(intent);
    const owned = await access.get(target);
    if (!owned) throw new Error("ownership_unavailable");
    const current = await adapter.inspect(intent);
    access.assertHealthy?.();
    if (!["equivalent", "absent"].includes(current) || (current === "equivalent" && await fingerprint(intent, true) !== owned.fingerprint)) throw new Error("ownership_diverged");
    if (current === "equivalent") {
      await adapter.remove(intent, execution(access));
      access.assertHealthy?.();
      const after = await adapter.inspect(intent);
      access.assertHealthy?.();
      if (after !== "absent") throw new Error("post_remove_mismatch");
    }
    access.assertHealthy?.();
    await access.delete(target);
    access.assertHealthy?.();
  });
}
