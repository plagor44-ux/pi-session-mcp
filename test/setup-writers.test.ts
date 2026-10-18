import { afterAll, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { MemoryOwnershipStore } from "../src/setup-ownership.js";
import { writeWriterState, writerPaths, type WriterState } from "../src/writer-state.js";
import * as lifecycle from "../src/writer-lifecycle.js";
import * as acceptance from "../src/writer-acceptance.js";
import { changeWriterMode, type WriterSetupDependencies } from "../src/setup-writers.js";
import { OverrideLockError } from "../src/override-lock.js";
import { executionModesPath } from "../src/execution-modes.js";
afterAll(removeTemporaryRoots);
import { parseSetupArgs } from "../src/setup-cli.js";
import { runWriterOperation } from "../src/setup-writers.js";

const state = (index: number): WriterState => ({ schemaVersion: 1, alias: "x", index, phase: "not_ready", lifecycle: "persistent", profiles: ["code"], providers: [{ provider: "example", model: "model" }], network: "pasta", cache: "none", imageId: "a".repeat(64), base: { ref: "refs/heads/main", commit: "b".repeat(40) } });
async function fixture() {
  const home = await temporaryRoot("setup-writers-");
  const configPath = join(home, "config.json");
  await writeFile(configPath, JSON.stringify({ workspaces: { x: home }, executionProfiles: {
    review: { default: true, permissionProfile: "read-only", provider: "example", model: "model", thinkingLevel: "off" },
    code: { default: false, permissionProfile: "coding", provider: "example", model: "model", thinkingLevel: "off" },
  } }));
  const calls: string[] = [];
  const ownership = new MemoryOwnershipStore();
  const registered = new Set<string>();
  const life = { ...lifecycle,
    provisionWriter: vi.fn(async (_ctx, input) => { calls.push(`provision${input.index}`); await writeWriterState(home, `x-w${input.index}`, state(input.index)); await writeFile(writerPaths(home, `x-w${input.index}`).wrapper, "wrapper"); return { status: "ok" as const, code: "writer_provisioned" }; }),
    inspectWork: vi.fn(async () => ({ baseline: true, digest: "digest", branches: [], dirty: false })),
    removeWriter: vi.fn(async (_ctx, name) => { calls.push(`remove:${name}`); return { status: "ok" as const, code: "writer_removed" }; }),
    finishWriter: vi.fn(async () => { calls.push("collect", "reset"); return { status: "ok" as const, code: "writer_reset" }; }),
  } satisfies typeof lifecycle;
  const accept = { ...acceptance, acceptWriter: vi.fn(async (_ctx: lifecycle.WriterContext, name: string): Promise<lifecycle.WriterOutcome> => { calls.push(`accept:${name}`); const index = Number(name.slice(-1)); await writeWriterState(home, name, { ...state(index), phase: "ready" }); return { status: "ok" as const, code: "writer_accepted" }; }) };
  const adapter = {
    inspect: vi.fn(async (intent: { client: string; name: string }) => registered.has(intent.client + intent.name) ? "equivalent" as const : "absent" as const),
    add: vi.fn(async (intent: { client: string; name: string }) => { calls.push(`register:${intent.client}:${intent.name}`); registered.add(intent.client + intent.name); }),
    remove: vi.fn(async (intent: { client: string; name: string }) => { calls.push(`unregister:${intent.client}:${intent.name}`); registered.delete(intent.client + intent.name); }),
  };
  const deps: WriterSetupDependencies = { configPath, home, releaseRoot: home, platform: "linux", lifecycle: life, acceptance: accept, ownership, adapter, doctor: async () => ({ schemaVersion: 1, ok: true, exitCode: 0, checks: [] }), containerRuntime: async () => true, lock: vi.fn(async () => ({ release: async () => {} })) };
  return { home, configPath, calls, life, accept, deps, adapter };
}
const mode = { alias: "x", mode: "container" as const, container: { profiles: ["code"], writers: 2 }, apply: true, acceptHostWrites: false };
describe("writer setup reconciliation", () => {
  it.each(["linux", "darwin"] as const)("sanitizes invalid aliases on %s", async (platform) => {
    const f = await fixture();
    const output = await changeWriterMode(f.configPath, { ...mode, alias: "../x" }, { ...f.deps, platform });
    expect(output.exitCode).toBe(1);
    expect(JSON.stringify(output)).not.toContain("../x");
    expect(output.findings[0]?.target.alias).toBe("invalid");
  });
  it("preserves an applied mode when reconciliation throws", async () => {
    const f = await fixture();
    f.life.provisionWriter.mockRejectedValueOnce(new Error("/SECRET"));
    const output = await changeWriterMode(f.configPath, mode, f.deps);
    expect(output.exitCode).toBe(1);
    expect(output.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "mode_applied", status: "ok" }),
      { target: { client: "writer", scope: "x", alias: "x-w1" }, status: "failed", code: "writer_reconcile_failed" },
    ]));
    expect(JSON.stringify(output)).not.toContain("SECRET");
    expect(JSON.parse(await readFile(executionModesPath(f.configPath), "utf8")).workspaces.x.mode).toBe("container");
  });
  it("does not remove when the API caller requests a dry run", async () => {
    const f = await fixture();
    const output = await runWriterOperation("x-w1", "remove", { apply: false, discard: true }, f.deps);
    expect(output.findings[0]?.code).toBe("writer_remove_planned");
    expect(f.deps.lock).not.toHaveBeenCalled();
    expect(f.life.removeWriter).not.toHaveBeenCalled();
  });
  it("provisions, accepts and registers two writers in order with one restart notice", async () => {
    const f = await fixture();
    const output = await changeWriterMode(f.configPath, mode, f.deps);
    expect(output.exitCode).toBe(0);
    expect(f.calls).toEqual(["provision1", "provision2", "accept:x-w1", "accept:x-w2", "register:claude-code:pi-coding-x-w1", "register:claude-code:pi-coding-x-w2"]);
    expect(output.findings.filter((finding) => finding.code === "controllers_restart_required")).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain("/");
  });
  it("registers Codex on request and does not reprovision ready writers", async () => {
    const f = await fixture();
    expect((await changeWriterMode(f.configPath, { ...mode, codex: true }, f.deps)).exitCode).toBe(0);
    expect(f.calls).toContain("register:codex:pi-coding-x-w1");
    f.calls.length = 0;
    const output = await changeWriterMode(f.configPath, { ...mode, codex: true }, f.deps);
    expect(output.exitCode).toBe(0);
    expect(f.calls).toEqual([]);
    expect(output.findings.some((finding) => finding.code === "controllers_restart_required")).toBe(false);
  });
  it("reports the existing global lock code without running mutations", async () => {
    const f = await fixture();
    const lock = vi.fn(async () => { throw new OverrideLockError("override_lock_busy"); });
    const output = await runWriterOperation("x-w1", "finish", { apply: true, discard: false }, { ...f.deps, lock });
    expect(output.findings[0]?.code).toBe("override_lock_busy");
    expect(f.calls).toEqual([]);
    expect(lock).toHaveBeenCalledWith(join(f.home, ".local", "state", "pi-session-mcp", "writers"), {});
  });
  it("bypasses Doctor errors only for its own alias and writers", async () => {
    const f = await fixture();
    const doctor = vi.fn(async () => ({ schemaVersion: 1 as const, ok: false, exitCode: 2 as const, checks: [{ id: "workspace_missing" as const, severity: "error" as const, subject: "x" }] }));
    expect((await runWriterOperation("x-w1", "finish", { apply: true, discard: false }, { ...f.deps, doctor })).exitCode).toBe(0);
    doctor.mockResolvedValue({ schemaVersion: 1, ok: false, exitCode: 2, checks: [{ id: "workspace_missing", severity: "error", subject: "other" }] });
    f.calls.length = 0;
    expect((await runWriterOperation("x-w1", "finish", { apply: true, discard: false }, { ...f.deps, doctor })).findings[0]?.code).toBe("doctor_failed");
    expect(f.calls).toEqual([]);
  });
  it("dry runs do not mutate or acquire locks", async () => {
    const f = await fixture();
    const output = await changeWriterMode(f.configPath, { ...mode, apply: false }, f.deps);
    expect(output.findings.filter((finding) => finding.code === "writer_planned")).toHaveLength(2);
    expect(f.calls).toEqual([]);
    expect(f.deps.lock).not.toHaveBeenCalled();
    await expect(readFile(executionModesPath(f.configPath))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses uncollected surplus before writing the modes file", async () => {
    const f = await fixture();
    await changeWriterMode(f.configPath, mode, f.deps);
    const before = await readFile(executionModesPath(f.configPath), "utf8");
    f.life.inspectWork.mockResolvedValue({ baseline: false, digest: "uncollected", branches: [], dirty: true });
    const output = await changeWriterMode(f.configPath, { ...mode, container: { ...mode.container, writers: 1 } }, f.deps);
    expect(output.findings[0]?.code).toBe("writer_uncollected");
    expect(await readFile(executionModesPath(f.configPath), "utf8")).toBe(before);
    expect(f.life.removeWriter).not.toHaveBeenCalled();
  });
  it("removes clean writers and owned registrations when leaving container mode", async () => {
    const f = await fixture();
    await changeWriterMode(f.configPath, mode, f.deps); f.calls.length = 0;
    const output = await changeWriterMode(f.configPath, { alias: "x", mode: "read-only", apply: true, acceptHostWrites: false }, f.deps);
    expect(output.exitCode).toBe(0);
    expect(output.findings.find((finding) => finding.code === "controllers_restart_required")?.target).toEqual({ client: "modes", scope: "workspace", alias: "x" });
    expect(f.calls).toEqual(["unregister:claude-code:pi-coding-x-w1", "remove:x-w1", "unregister:claude-code:pi-coding-x-w2", "remove:x-w2"]);
  });
  it("keeps a writer not ready if the control is missing", async () => {
    const f = await fixture();
    f.accept.acceptWriter.mockResolvedValue({ status: "failed", code: "isolation_control_required" });
    const output = await changeWriterMode(f.configPath, mode, f.deps);
    expect(output.findings.some((finding) => finding.code === "isolation_control_required")).toBe(true);
    expect(f.adapter.add).not.toHaveBeenCalled();
  });
  it("uses the lifecycle finish operation and refuses destructive uncollected work", async () => {
    const f = await fixture();
    expect((await runWriterOperation("x-w1", "finish", { apply: true, discard: false }, f.deps)).exitCode).toBe(0);
    expect(f.calls).toEqual(["collect", "reset"]);
    await writeWriterState(f.home, "x-w1", state(1));
    f.life.inspectWork.mockResolvedValue({ baseline: false, digest: "uncollected", branches: [], dirty: true });
    expect((await runWriterOperation("x-w1", "remove", { apply: true, discard: false }, f.deps)).findings[0]?.code).toBe("writer_uncollected");
    expect(f.life.removeWriter).not.toHaveBeenCalled();
  });
  it.each(["divergent", "unsupported", "equivalent"] as const)("checks unowned present Codex registrations (%s)", async (codexState) => {
    const f = await fixture();
    const adapter = { ...f.adapter, inspect: vi.fn(async (intent: { client: string }) => intent.client === "codex" ? codexState : "equivalent" as const) };
    const launch = vi.fn();
    const verify = vi.fn(async () => ({ status: "verified" as const, initialize: true, toolsList: true, capabilitiesGet: true, tools: [] }));
    const output = await runWriterOperation("x-w1", "verify", { apply: true, discard: false }, { ...f.deps, adapter, launch, verify });
    expect(output.exitCode).toBe(codexState === "equivalent" ? 0 : 1);
    expect(verify).toHaveBeenCalledTimes(codexState === "equivalent" ? 1 : 0);
  });
  it.each([undefined, "/runtime"])("passes only the minimal wrapper environment (runtime=%s)", async (runtime) => {
    const f = await fixture();
    vi.stubEnv("HOME", f.home); vi.stubEnv("PATH", "/bin"); vi.stubEnv("SECRET_SENTINEL", "secret"); vi.stubEnv("XDG_RUNTIME_DIR", runtime);
    try {
      f.adapter.inspect.mockResolvedValue("equivalent");
      const launch = vi.fn();
      const verify = vi.fn(async () => ({ status: "verified" as const, initialize: true, toolsList: true, capabilitiesGet: true, tools: [] }));
      expect((await runWriterOperation("x-w1", "verify", { apply: true, discard: false }, { ...f.deps, launch, verify })).exitCode).toBe(0);
      expect(launch).toHaveBeenCalledWith([writerPaths(f.home, "x-w1").wrapper], { HOME: f.home, PATH: "/bin", PI_WRITER_NO_CREDENTIAL_REFRESH: "1", ...(runtime === undefined ? {} : { XDG_RUNTIME_DIR: runtime }) });
    } finally { vi.unstubAllEnvs(); }
  });
  it("verifies only relevant Doctor errors and launches with no credential refresh", async () => {
    const f = await fixture();
    f.adapter.inspect.mockResolvedValue("equivalent");
    const launch = vi.fn();
    const verify = vi.fn(async () => ({ status: "verified" as const, initialize: true, toolsList: true, capabilitiesGet: true, tools: [] }));
    const doctor = vi.fn(async () => ({ schemaVersion: 1 as const, ok: false, exitCode: 2 as const, checks: [{ id: "writer_not_ready" as const, severity: "error" as const, subject: "other-w1" }] }));
    const output = await runWriterOperation("x-w1", "verify", { apply: true, discard: false }, { ...f.deps, launch, verify, doctor });
    expect(output.exitCode).toBe(0);
    expect(launch).toHaveBeenCalledWith([writerPaths(f.home, "x-w1").wrapper], expect.objectContaining({ PI_WRITER_NO_CREDENTIAL_REFRESH: "1" }));
    expect(f.calls).toEqual([]);
  });
});

describe("writer setup arguments", () => {
  it.each([
    ["--writer", "x-w1", "--collect", "--discard"],
    ["--writer", "x-w1", "--collect", "--target", "codex:user:pi-session-mcp"],
    ["--writer", "x-w1", "--collect", "--base", "main"],
    ["--writer", "../secret", "--verify"],
  ])("rejects invalid combinations %j", (...args) => expect(() => parseSetupArgs(args)).toThrow());
  it("parses finish apply", () => expect(parseSetupArgs(["--writer", "x-w1", "--finish", "--apply"]).writer).toEqual({ name: "x-w1", operation: "finish", apply: true, discard: false }));
  it("rejects macOS before reading configuration", async () => {
    const output = await runWriterOperation("x-w1", "collect", { apply: false, discard: false }, { configPath: "/secret", releaseRoot: "/secret", platform: "darwin" });
    expect(output.findings[0]?.code).toBe("platform_unsupported");
    expect(JSON.stringify(output)).not.toContain("/");
  });
});
