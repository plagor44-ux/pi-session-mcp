import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { MemoryOwnershipStore, type OwnershipRecord } from "../src/setup-ownership.js";
import { buildWakeEntry, FileSetupHookInstaller, localHookNeededByOthers, WAKE_HOOK_ALIAS } from "../src/setup-hooks.js";
import { changeWriterMode, runWriterOperation, type WriterSetupDependencies } from "../src/setup-writers.js";
import { readWriterState, writeWriterState, writerPaths, type WriterState } from "../src/writer-state.js";
import * as lifecycle from "../src/writer-lifecycle.js";
import * as acceptance from "../src/writer-acceptance.js";

afterAll(removeTemporaryRoots);

const state = (alias: string, index: number): WriterState => ({ schemaVersion: 1, alias, index, phase: "not_ready", lifecycle: "persistent", profiles: ["code"], providers: [{ provider: "example", model: "model" }], network: "pasta", cache: "none", tags: "none", imageId: "a".repeat(64), base: { ref: "refs/heads/main", commit: "b".repeat(40) } });
const txid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Writers in a temporary home; the operator's project is a directory of its own and the only place a hook is written. */
async function fixture(options: { delivery: boolean; aliases?: readonly string[] }) {
  const root = await temporaryRoot("setup-writers-hook-");
  const home = join(root, "home");
  const aliases = options.aliases ?? ["x"];
  const projects = Object.fromEntries(aliases.map((alias) => [alias, join(root, `project-${alias}`)]));
  for (const project of Object.values(projects)) await mkdir(project, { recursive: true });
  await mkdir(home);
  const configPath = join(root, "config.json");
  const events = options.delivery ? { events: { delivery: "spool" } } : {};
  await writeFile(configPath, JSON.stringify({ ...events, workspaces: projects, executionProfiles: {
    review: { default: true, permissionProfile: "read-only", provider: "example", model: "model", thinkingLevel: "off" },
    code: { default: false, permissionProfile: "coding", provider: "example", model: "model", thinkingLevel: "off" },
  } }));
  const ownership = new MemoryOwnershipStore();
  const registered = new Set<string>();
  const life = { ...lifecycle,
    provisionWriter: vi.fn(async (ctx: lifecycle.WriterContext, input: { index: number }) => {
      const name = `${ctx.alias}-w${input.index}`, paths = writerPaths(home, name);
      await writeWriterState(home, name, state(ctx.alias, input.index));
      await mkdir(paths.config, { recursive: true });
      await writeFile(join(paths.config, "pi-session-mcp.json"), JSON.stringify(events));
      await writeFile(paths.wrapper, "wrapper");
      return { status: "ok" as const, code: "writer_provisioned" };
    }),
    inspectWork: vi.fn(async () => ({ baseline: true, digest: "digest", branches: [], dirty: false })),
    removeWriter: vi.fn(async () => ({ status: "ok" as const, code: "writer_removed" })),
    // These writers carry only the delivery field as their configuration; the settings check has its own tests.
    writerSettingsDrift: vi.fn(async () => undefined),
  } satisfies typeof lifecycle;
  const accept = { ...acceptance, acceptWriter: vi.fn(async (_ctx: lifecycle.WriterContext, name: string): Promise<lifecycle.WriterOutcome> => {
    const alias = name.slice(0, name.lastIndexOf("-w")); const index = Number(name.slice(name.lastIndexOf("-w") + 2));
    await writeWriterState(home, name, { ...state(alias, index), phase: "ready" }); return { status: "ok" as const, code: "writer_accepted" };
  }), acceptanceCurrent: vi.fn(async (_ctx: lifecycle.WriterContext, name: string) => ((await readWriterState(home, name))?.phase === "ready" ? "current" : "stale") as "current" | "stale" | "unknown") };
  const adapter = {
    inspect: vi.fn(async (intent: { client: string; name: string }) => registered.has(intent.client + intent.name) ? "equivalent" as const : "absent" as const),
    add: vi.fn(async (intent: { client: string; name: string }) => { registered.add(intent.client + intent.name); }),
    remove: vi.fn(async (intent: { client: string; name: string }) => { registered.delete(intent.client + intent.name); }),
  };
  const releaseRoot = join(root, "release");
  await mkdir(join(releaseRoot, "dist"), { recursive: true }); await writeFile(join(releaseRoot, "dist", "wake-main.js"), "// wake\n");
  const deps: WriterSetupDependencies = { configPath, home, releaseRoot, runner: { run: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }) }, platform: "linux", lifecycle: life, acceptance: accept, ownership, adapter, doctor: async () => ({ schemaVersion: 1, ok: true, exitCode: 0, checks: [] }), containerRuntime: async () => true, lock: vi.fn(async () => ({ release: async () => {} })) };
  const entry = buildWakeEntry({ packageRoot: releaseRoot });
  const settings = (alias = "x") => join(projects[alias]!, ".claude", "settings.local.json");
  const request = (alias = "x", writers = 1, extra: { apply?: boolean; codex?: boolean } = {}) => ({ alias, mode: "container" as const, container: { profiles: ["code"], writers }, apply: extra.apply ?? true, acceptHostWrites: false, ...(extra.codex ? { codex: true } : {}) });
  const codes = (output: { findings: readonly { code: string }[] }) => output.findings.map((finding) => finding.code).filter((code) => code.startsWith("hook_") || code.startsWith("settings_"));
  const remove = (name: string, extra: Partial<WriterSetupDependencies> = {}) => runWriterOperation(name, "remove", { apply: true, discard: false }, { ...deps, ...extra });
  return { root, home, projects, configPath, ownership, registered, deps, entry, settings, request, codes, remove, adapter, life };
}

describe("writer registrations and the wake hook", () => {
  it("installs the hook in the project's local settings after the registration, and only once for two writers", async () => {
    const f = await fixture({ delivery: true });
    const output = await changeWriterMode(f.configPath, f.request("x", 2), f.deps);
    expect(output.exitCode).toBe(0);
    expect(f.codes(output)).toEqual(["hook_added", "hook_already_equivalent"]);
    // The hook comes after its writer's registration.
    expect(output.findings.map((finding) => finding.code).filter((code) => code === "writer_registered" || code.startsWith("hook_")).slice(0, 2)).toEqual(["writer_registered", "hook_added"]);
    expect(JSON.parse(await readFile(f.settings(), "utf8"))).toEqual({ hooks: { PostToolUse: [f.entry] } });
    const again = await changeWriterMode(f.configPath, f.request("x", 2), f.deps);
    expect(f.codes(again)).toEqual(["hook_already_equivalent", "hook_already_equivalent"]);
  });
  it("reports nothing and writes nothing when delivery is off", async () => {
    const f = await fixture({ delivery: false });
    const output = await changeWriterMode(f.configPath, f.request("x", 2), f.deps);
    expect(output.exitCode).toBe(0);
    expect(f.codes(output)).toEqual([]);
    await expect(stat(join(f.projects.x!, ".claude"))).rejects.toThrow();
  });
  it("adds no hook for Codex writer registrations", async () => {
    const f = await fixture({ delivery: true });
    const output = await changeWriterMode(f.configPath, f.request("x", 1, { codex: true }), f.deps);
    expect(f.adapter.add.mock.calls.map(([intent]) => intent.client)).toEqual(["claude-code", "codex"]);
    expect(f.codes(output)).toEqual(["hook_added"]);
  });
  it("plans the hook in a dry-run without writing", async () => {
    const f = await fixture({ delivery: true });
    const output = await changeWriterMode(f.configPath, f.request("x", 1, { apply: false }), f.deps);
    expect(f.codes(output)).toEqual(["hook_add_planned"]);
    await expect(stat(join(f.projects.x!, ".claude"))).rejects.toThrow();
  });
  it("does not install over a divergent entry and fails the run", async () => {
    const f = await fixture({ delivery: true });
    const foreign = { hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "/usr/bin/node /else/dist/wake-main.js" }] }] } };
    await mkdir(join(f.projects.x!, ".claude"));
    await writeFile(f.settings(), `${JSON.stringify(foreign, null, 2)}\n`);
    const output = await changeWriterMode(f.configPath, f.request("x", 1), f.deps);
    expect(f.codes(output)).toEqual(["hook_divergent"]);
    expect(output.exitCode).toBe(1);
    expect(JSON.parse(await readFile(f.settings(), "utf8"))).toEqual(foreign);
  });
  it("keeps the shared entry while another writer needs it and removes it with the last one", async () => {
    const f = await fixture({ delivery: true });
    await changeWriterMode(f.configPath, f.request("x", 2), f.deps);
    const first = await f.remove("x-w1");
    expect(first.findings.map((finding) => finding.code)).toEqual(["writer_removed", "hook_kept_shared"]);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(await readFile(f.settings(), "utf8")).hooks.PostToolUse).toEqual([f.entry]);
    const last = await f.remove("x-w2");
    expect(last.findings.map((finding) => finding.code)).toEqual(["writer_removed", "hook_removed"]);
    expect(await readFile(f.settings(), "utf8")).toBe("{}\n");
    // Nothing left to do on a repeat.
    expect((await f.remove("x-w2")).findings.map((finding) => finding.code)).toEqual(["writer_removed"]);
  });
  it("keeps the entry while an owned host registration in local scope has delivery enabled", async () => {
    const f = await fixture({ delivery: true });
    await changeWriterMode(f.configPath, f.request("x", 1), f.deps);
    await f.ownership.put({ target: { client: "claude-code", scope: "local", alias: "pi-session-mcp" }, fingerprint: "a".repeat(64), previous: "absent", phase: "owned", transactionId: txid(1) });
    expect((await f.remove("x-w1")).findings.map((finding) => finding.code)).toEqual(["writer_removed", "hook_kept_shared"]);
    expect(JSON.parse(await readFile(f.settings(), "utf8")).hooks.PostToolUse).toEqual([f.entry]);
  });
  it("keeps the entries of different projects apart", async () => {
    const f = await fixture({ delivery: true, aliases: ["x", "y"] });
    await changeWriterMode(f.configPath, f.request("x", 1), f.deps);
    await changeWriterMode(f.configPath, f.request("y", 1), f.deps);
    expect((await f.remove("x-w1")).findings.map((finding) => finding.code)).toEqual(["writer_removed", "hook_removed"]);
    expect(await readFile(f.settings("x"), "utf8")).toBe("{}\n");
    expect(JSON.parse(await readFile(f.settings("y"), "utf8")).hooks.PostToolUse).toEqual([f.entry]);
  });
  it("reports a hook that cannot be edited but still removes the writer", async () => {
    const f = await fixture({ delivery: true });
    await changeWriterMode(f.configPath, f.request("x", 1), f.deps);
    await writeFile(f.settings(), "{broken");
    const output = await f.remove("x-w1");
    expect(output.exitCode).toBe(1);
    expect(output.findings.map((finding) => [finding.status, finding.code])).toEqual([["ok", "writer_removed"], ["failed", "settings_unparseable"]]);
    expect(f.life.removeWriter).toHaveBeenCalledTimes(1);
    expect(await readFile(f.settings(), "utf8")).toBe("{broken");
    // A divergent entry is reported the same way.
    const g = await fixture({ delivery: true });
    await changeWriterMode(g.configPath, g.request("x", 1), g.deps);
    const edited = { ...g.entry, hooks: [{ ...g.entry.hooks[0], timeout: 5 }] };
    await writeFile(g.settings(), JSON.stringify({ hooks: { PostToolUse: [edited] } }));
    const divergent = await g.remove("x-w1");
    expect(divergent.findings.map((finding) => [finding.status, finding.code])).toEqual([["ok", "writer_removed"], ["divergent", "hook_divergent"]]);
    expect(g.life.removeWriter).toHaveBeenCalledTimes(1);
  });
  it("verifies the hook with the registration", async () => {
    const f = await fixture({ delivery: true });
    await changeWriterMode(f.configPath, f.request("x", 1), f.deps);
    const verify = vi.fn(async () => ({ status: "verified" as const, initialize: true, toolsList: true, capabilitiesGet: true, tools: [] }));
    const run = () => runWriterOperation("x-w1", "verify", { apply: true, discard: false }, { ...f.deps, launch: vi.fn(), verify });
    const ok = await run();
    expect(ok.findings.map((finding) => finding.code)).toEqual(["mcp_verified", "hook_verified"]);
    expect(ok.exitCode).toBe(0);
    await writeFile(f.settings(), "{}\n");
    const missing = await run();
    expect(missing).toMatchObject({ exitCode: 1 });
    expect(missing.findings[0]?.code).toBe("hook_missing");
  });
  it("verifies without a hook finding when delivery is off", async () => {
    const f = await fixture({ delivery: false });
    await changeWriterMode(f.configPath, f.request("x", 1), f.deps);
    const verify = vi.fn(async () => ({ status: "verified" as const, initialize: true, toolsList: true, capabilitiesGet: true, tools: [] }));
    const output = await runWriterOperation("x-w1", "verify", { apply: true, discard: false }, { ...f.deps, launch: vi.fn(), verify });
    expect(output.findings.map((finding) => finding.code)).toEqual(["mcp_verified"]);
  });
  it("removes the owned hook when the writer's delivery was switched off and reconcile runs again", async () => {
    const f = await fixture({ delivery: true });
    await changeWriterMode(f.configPath, f.request("x", 1), f.deps);
    await writeFile(join(writerPaths(f.home, "x-w1").config, "pi-session-mcp.json"), "{}");
    const output = await changeWriterMode(f.configPath, f.request("x", 1), f.deps);
    expect(f.codes(output)).toEqual(["hook_removed"]);
    expect(await readFile(f.settings(), "utf8")).toBe("{}\n");
  });
});

describe("localHookNeededByOthers", () => {
  const record = (alias: string, phase: "owned" | "pending" = "owned"): OwnershipRecord => ({ target: { client: "claude-code", scope: "local", alias }, fingerprint: "a".repeat(64), previous: "absent", phase, transactionId: txid(7) });
  async function world(hostDelivery: boolean) {
    const f = await fixture({ delivery: hostDelivery, aliases: ["x", "y"] });
    const writer = async (alias: string, index: number, delivery: boolean, phase: "owned" | "pending" = "owned") => {
      const name = `${alias}-w${index}`, paths = writerPaths(f.home, name);
      await writeWriterState(f.home, name, state(alias, index)); await mkdir(paths.config, { recursive: true });
      await writeFile(join(paths.config, "pi-session-mcp.json"), JSON.stringify(delivery ? { events: { delivery: "spool" } } : {}));
      await f.ownership.put(record(`pi-coding-${name}`, phase));
      return name;
    };
    const ask = (project: string, except: "host" | { writer: string }) => localHookNeededByOthers({ ownership: f.ownership, home: f.home, cwd: project, configPath: f.configPath, except });
    return { f, writer, ask };
  }
  it("is false when nothing else is registered", async () => {
    const { f, ask } = await world(true);
    expect(await ask(f.projects.x!, "host")).toBe(false);
    expect(await ask(f.projects.x!, { writer: "x-w1" })).toBe(false);
  });
  it("counts an owned writer of the same project whose delivery is enabled, and not the excluded one", async () => {
    const { f, writer, ask } = await world(false);
    const name = await writer("x", 1, true);
    expect(await ask(f.projects.x!, "host")).toBe(true);
    expect(await ask(f.projects.x!, { writer: name })).toBe(false);
    expect(await ask(f.projects.y!, "host")).toBe(false);
  });
  it("ignores a writer without delivery or with a pending registration", async () => {
    const { f, writer, ask } = await world(false);
    await writer("x", 1, false); await writer("x", 2, true, "pending");
    expect(await ask(f.projects.x!, "host")).toBe(false);
  });
  it("counts the owned host registration only while the host configuration enables delivery", async () => {
    const on = await world(true);
    await on.f.ownership.put(record("pi-session-mcp"));
    expect(await on.ask(on.f.projects.x!, { writer: "x-w1" })).toBe(true);
    expect(await on.ask(on.f.projects.x!, "host")).toBe(false);
    const off = await world(false);
    await off.f.ownership.put(record("pi-session-mcp"));
    expect(await off.ask(off.f.projects.x!, { writer: "x-w1" })).toBe(false);
  });
  it("answers true when it cannot tell", async () => {
    const { f, writer, ask } = await world(false);
    await writer("x", 1, true);
    // A writer whose alias is no longer configured.
    await writeWriterState(f.home, "gone-w1", state("gone", 1));
    const gone = writerPaths(f.home, "gone-w1"); await mkdir(gone.config, { recursive: true });
    await writeFile(join(gone.config, "pi-session-mcp.json"), JSON.stringify({ events: { delivery: "spool" } }));
    await f.ownership.put(record("pi-coding-gone-w1"));
    expect(await ask(f.projects.y!, "host")).toBe(true);
    expect(await localHookNeededByOthers({ ownership: f.ownership, home: f.home, cwd: f.projects.y!, configPath: join(f.root, "missing.json"), except: "host" })).toBe(true);
    expect(await localHookNeededByOthers({ ownership: f.ownership, home: f.home, cwd: join(f.root, "no-such-dir"), configPath: f.configPath, except: "host" })).toBe(true);
  });
});

describe("host registration removal and writers that need the entry", () => {
  it("keeps the shared entry on host removal while an owned writer in the project needs it", async () => {
    const f = await fixture({ delivery: true });
    await changeWriterMode(f.configPath, f.request("x", 1), f.deps);
    const roots = { packageRoot: f.deps.releaseRoot, configPath: f.configPath, home: f.home, cwd: f.projects.x!, env: {}, delivery: async () => false };
    const hooks = new FileSetupHookInstaller(roots);
    const target = { client: "claude-code", scope: "local", alias: "pi-session-mcp" };
    // Delivery turned off for the host registration, writer still needs the entry.
    const kept = await hooks.run("apply", target, f.ownership);
    expect(kept).toEqual([{ target: { ...target, alias: WAKE_HOOK_ALIAS }, status: "unchanged", code: "hook_kept_shared" }]);
    expect((await hooks.run("remove", target, f.ownership))[0]?.code).toBe("hook_kept_shared");
    expect(JSON.parse(await readFile(f.settings(), "utf8")).hooks.PostToolUse).toEqual([f.entry]);
    // The writer's own removal is then the last registration and takes the entry along; the host has nothing left.
    expect(f.codes(await f.remove("x-w1"))).toEqual(["hook_removed"]);
    expect(await hooks.run("remove", target, f.ownership)).toEqual([]);
  });
});
