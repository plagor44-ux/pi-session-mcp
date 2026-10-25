import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createWriterRegistrationAdapter, registerWriter, unregisterWriter, type WriterRegistrationIntent } from "../src/client-adapters/writer-registration.js";
import { DurableOwnershipStore, MemoryOwnershipStore, isRecord, type OwnershipAccess } from "../src/setup-ownership.js";
import { wrapperDigest } from "../src/writer-wrapper.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
async function fixture(client: WriterRegistrationIntent["client"] = "claude-code") {
  const projectDir = await temporaryRoot("writer-registration-");
  const intent: WriterRegistrationIntent = { client, name: "pi-coding-demo-w1", wrapperPath: join(projectDir, "wrapper.sh"), projectDir };
  await writeFile(intent.wrapperPath, "#!/bin/sh\nexit 0\n");
  const ownership = new MemoryOwnershipStore();
  let state = "absent";
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    if (args[1] === "add") { state = "equivalent"; return { exitCode: 0, stdout: "", stderr: "" }; }
    if (args[1] === "remove") { state = "absent"; return { exitCode: 0, stdout: "", stderr: "" }; }
    if (state === "absent") return { exitCode: 1, stdout: "", stderr: client === "codex" ? `Error: No MCP server named '${intent.name}' found.` : `No MCP server named "${intent.name}".` };
    return { exitCode: 0, stderr: "", stdout: client === "codex" ? JSON.stringify({ name: intent.name, enabled: true, transport: { type: "stdio", command: intent.wrapperPath, args: [], env: {}, env_vars: [], cwd: null } }) : `${intent.name}:\n  Scope: Local config\n  Type: stdio\n  Command: ${state === "command" ? "/other" : intent.wrapperPath}\n  Args: ${state === "args" ? "--extra" : ""}\n${state === "env" ? "  Environment:\n    TOKEN=value\n" : ""}` };
  });
  return { intent, ownership, run, adapter: createWriterRegistrationAdapter({ run }), setState: (value: string) => { state = value; } };
}

describe("writer registrations", () => {
  it("adds an absent Claude local registration with exact argv and cwd, then owns it", async () => {
    const f = await fixture();
    await registerWriter(f.ownership, f.adapter, f.intent);
    expect(f.run).toHaveBeenCalledWith("claude", ["mcp", "get", f.intent.name], undefined, { cwd: f.intent.projectDir });
    expect(f.run).toHaveBeenCalledWith("claude", ["mcp", "add", f.intent.name, "-s", "local", "--", f.intent.wrapperPath], undefined, { cwd: f.intent.projectDir });
    const record = await f.ownership.get({ client: "claude-code", scope: "local", alias: f.intent.name });
    expect(record?.phase).toBe("owned");
    expect(record?.fingerprint).toBe(createHash("sha256").update(JSON.stringify({ wrapper: f.intent.wrapperPath, digest: wrapperDigest("#!/bin/sh\nexit 0\n") })).digest("hex"));
    expect(isRecord(record)).toBe(true);
    await unregisterWriter(f.ownership, f.adapter, f.intent);
    expect(f.run).toHaveBeenCalledWith("claude", ["mcp", "remove", f.intent.name, "-s", "local"], undefined, { cwd: f.intent.projectDir });
    expect(await f.ownership.get(record!.target)).toBeUndefined();
  });
  it.each([false, true])("sanitizes missing wrapper reads (owned=%s)", async (owned) => {
    const f = await fixture();
    if (owned) await registerWriter(f.ownership, f.adapter, f.intent);
    await rm(f.intent.wrapperPath);
    const code = owned ? "ownership_diverged" : "release_binding_mismatch";
    await expect(registerWriter(f.ownership, f.adapter, f.intent)).rejects.toMatchObject({ message: code, code });
    if (owned) await expect(unregisterWriter(f.ownership, f.adapter, f.intent)).rejects.toMatchObject({ message: code, code });
  });
  it("codes a wrapper read failure after pending ownership is written", async () => {
    const f = await fixture();
    const original = f.adapter.add;
    vi.spyOn(f.adapter, "add").mockImplementation(async (...args) => { await original(...args); await rm(f.intent.wrapperPath); });
    await expect(registerWriter(f.ownership, f.adapter, f.intent)).rejects.toMatchObject({ message: "ownership_diverged", code: "ownership_diverged" });
  });
  it("leaves an equivalent unowned registration unchanged", async () => {
    const f = await fixture(); f.setState("equivalent");
    await registerWriter(f.ownership, f.adapter, f.intent);
    expect(f.run.mock.calls.every(([, args]) => args[1] === "get")).toBe(true);
    await expect(unregisterWriter(f.ownership, f.adapter, f.intent)).rejects.toThrow("ownership_unavailable");
  });
  it.each(["env", "command", "args"])("refuses a divergent %s registration", async (state) => {
    const f = await fixture(); f.setState(state);
    expect(await f.adapter.inspect(f.intent)).toBe("divergent");
    await expect(registerWriter(f.ownership, f.adapter, f.intent)).rejects.toThrow("divergence_requires_replacement");
    expect(f.run.mock.calls.every(([, args]) => args[1] === "get")).toBe(true);
  });
  it("recovers pending ownership without adding again", async () => {
    const f = await fixture();
    await registerWriter(f.ownership, f.adapter, f.intent);
    const target = { client: f.intent.client, scope: "local", alias: f.intent.name };
    const owned = (await f.ownership.get(target))!;
    await f.ownership.put({ ...owned, phase: "pending", transactionId: randomUUID() });
    f.run.mockClear();
    await registerWriter(f.ownership, f.adapter, f.intent);
    expect((await f.ownership.get(target))?.phase).toBe("owned");
    expect(f.run.mock.calls.every(([, args]) => args[1] === "get")).toBe(true);
  });
  it("preserves pending records after a failed mutation and recovers on retry", async () => {
    const f = await fixture();
    const add = vi.spyOn(f.adapter, "add").mockRejectedValueOnce(new Error("failed"));
    await expect(registerWriter(f.ownership, f.adapter, f.intent)).rejects.toThrow("failed");
    const target = { client: f.intent.client, scope: "local", alias: f.intent.name };
    expect((await f.ownership.get(target))?.phase).toBe("pending");
    await registerWriter(f.ownership, f.adapter, f.intent);
    expect(add).toHaveBeenCalledTimes(2);
    expect((await f.ownership.get(target))?.phase).toBe("owned");
  });
  it("refuses changed wrapper content and externally removed owned registrations", async () => {
    const f = await fixture();
    await registerWriter(f.ownership, f.adapter, f.intent);
    f.setState("absent");
    await expect(registerWriter(f.ownership, f.adapter, f.intent)).rejects.toThrow("ownership_diverged");
    f.setState("equivalent");
    await writeFile(f.intent.wrapperPath, "changed");
    await expect(registerWriter(f.ownership, f.adapter, f.intent)).rejects.toThrow("release_binding_mismatch");
    await expect(unregisterWriter(f.ownership, f.adapter, f.intent)).rejects.toThrow("ownership_diverged");
  });
  it("passes the transaction mutation runner and abort signal to mutations", async () => {
    const f = await fixture();
    const signal = new AbortController().signal;
    const mutationRunner = { run: f.run };
    const access: OwnershipAccess = { get: f.ownership.get.bind(f.ownership), put: f.ownership.put.bind(f.ownership), delete: f.ownership.delete.bind(f.ownership), mutationRunner, signal: () => signal };
    const ownership = { ...access, transaction: async <T>(operation: (value: OwnershipAccess) => Promise<T>) => operation(access) };
    const add = vi.spyOn(f.adapter, "add");
    const remove = vi.spyOn(f.adapter, "remove");
    await registerWriter(ownership, f.adapter, f.intent);
    expect(add).toHaveBeenCalledWith(f.intent, { runner: mutationRunner, signal });
    await unregisterWriter(ownership, f.adapter, f.intent);
    expect(remove).toHaveBeenCalledWith(f.intent, { runner: mutationRunner, signal });
  });
  it("durably round-trips writer records while rejecting unsupported writer scopes", async () => {
    const f = await fixture();
    await registerWriter(f.ownership, f.adapter, f.intent);
    const target = { client: f.intent.client, scope: "local", alias: f.intent.name };
    const record = (await f.ownership.get(target))!;
    const store = new DurableOwnershipStore(join(f.intent.projectDir, "ownership.json"));
    await store.put(record);
    expect(await store.get(target)).toEqual(record);
    expect(isRecord({ ...record, target: { ...target, scope: "user" } })).toBe(false);
    expect(isRecord({ ...record, target: { ...target, alias: "pi-coding-invalid" } })).toBe(false);
  });
  it("fails closed on unknown client output", async () => {
    const f = await fixture();
    const adapter = createWriterRegistrationAdapter({ run: async () => ({ exitCode: 1, stdout: "", stderr: "unknown client failure" }) });
    expect(await adapter.inspect(f.intent)).toBe("unsupported");
    await expect(registerWriter(f.ownership, adapter, f.intent)).rejects.toThrow("client_unsupported");
  });
  it.each([
    { command: "/other" }, { args: ["extra"] }, { env: { TOKEN: "value" } }, { env_vars: ["TOKEN"] }, { cwd: "/other" },
  ])("refuses divergent Codex transport %j", async (change) => {
    const f = await fixture("codex");
    const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ name: f.intent.name, enabled: true, transport: { type: "stdio", command: f.intent.wrapperPath, args: [], env: {}, env_vars: [], cwd: null, ...change } }) }));
    const adapter = createWriterRegistrationAdapter({ run });
    expect(await adapter.inspect(f.intent)).toBe("divergent");
    await expect(registerWriter(f.ownership, adapter, f.intent)).rejects.toThrow("divergence_requires_replacement");
  });
  it("uses Codex user scope without cwd", async () => {
    const f = await fixture("codex");
    await registerWriter(f.ownership, f.adapter, f.intent);
    expect(f.run).toHaveBeenCalledWith("codex", ["mcp", "add", f.intent.name, "--", f.intent.wrapperPath], undefined, undefined);
    await unregisterWriter(f.ownership, f.adapter, f.intent);
    expect(f.run).toHaveBeenCalledWith("codex", ["mcp", "remove", f.intent.name], undefined, undefined);
  });
});

describe("Claude Code 'Did you mean' absent message", () => {
  const hint = (suggestion: string) => `Did you mean ${suggestion}? Run \`claude mcp list\` to see all.`;
  async function stateFor(stderr: (name: string) => string) {
    const f = await fixture();
    const run = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: stderr(f.intent.name) }));
    return createWriterRegistrationAdapter({ run }).inspect(f.intent);
  }
  it("treats the bounded suggestion suffix as absent and lets a further writer register", async () => {
    expect(await stateFor((name) => `No MCP server named "${name}". ${hint('"pi-coding-demo-w0"')}`)).toBe("absent");
    const f = await fixture();
    let registered = false;
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[1] === "add") { registered = true; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (!registered) return { exitCode: 1, stdout: "", stderr: `No MCP server named "${f.intent.name}". ${hint('"pi-coding-demo-w0"')}\n` };
      return { exitCode: 0, stderr: "", stdout: `${f.intent.name}:\n  Scope: Local config\n  Type: stdio\n  Command: ${f.intent.wrapperPath}\n  Args:\n` };
    });
    await registerWriter(f.ownership, createWriterRegistrationAdapter({ run }), f.intent);
    expect((await f.ownership.get({ client: "claude-code", scope: "local", alias: f.intent.name }))?.phase).toBe("owned");
  });
  it.each([
    ["an unquoted suggestion", hint("pi-coding-demo-w0")],
    ["a suggestion with an embedded quote", hint('"pi-coding"-demo-w0"')],
    ["a suggestion with a newline", 'Did you mean "pi-coding\ndemo-w0"? Run `claude mcp list` to see all.'],
    ["an empty suggestion", hint('""')],
    ["trailing text", hint('"pi-coding-demo-w0"') + " Extra."],
    ["a second line", hint('"pi-coding-demo-w0"') + "\nmore"],
    ["another hint", 'Did you mean "pi-coding-demo-w0"? Run `rm -rf` to see all.'],
  ])("keeps %s unsupported and fails registration closed", async (_label, suffix) => {
    expect(await stateFor((name) => `No MCP server named "${name}". ${suffix}`)).toBe("unsupported");
  });
  it("does not apply the suffix to Codex, whose absent message is unchanged", async () => {
    const f = await fixture("codex");
    const run = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: `Error: No MCP server named '${f.intent.name}' found. ${hint('"x"')}` }));
    expect(await createWriterRegistrationAdapter({ run }).inspect(f.intent)).toBe("unsupported");
  });
});
