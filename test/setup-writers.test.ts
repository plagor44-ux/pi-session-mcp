import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { MemoryOwnershipStore } from "../src/setup-ownership.js";
import { acceptanceFingerprint, readWriterState, writeWriterState, writerPaths, type WriterState } from "../src/writer-state.js";
import { wrapperDigest } from "../src/writer-wrapper.js";
import { PACKAGE_VERSION } from "../src/package-metadata.js";
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
    provisionWriter: vi.fn(async (_ctx, input) => {
      calls.push(`provision${input.index}`);
      const paths = writerPaths(home, `x-w${input.index}`);
      await writeWriterState(home, `x-w${input.index}`, state(input.index)); await writeFile(paths.wrapper, "wrapper");
      // The real rendered configuration, so the settings check of reconcile compares against what provisioning wrote.
      await mkdir(paths.config, { recursive: true });
      await writeFile(join(paths.config, "pi-session-mcp.json"), JSON.stringify(lifecycle.renderContainedConfig("x", paths.clone, input.rawConfig, input.settings.profiles, input.overrideDirectory)));
      return { status: "ok" as const, code: "writer_provisioned" };
    }),
    inspectWork: vi.fn(async () => ({ baseline: true, digest: "digest", branches: [], dirty: false })),
    removeWriter: vi.fn(async (_ctx, name) => { calls.push(`remove:${name}`); return { status: "ok" as const, code: "writer_removed" }; }),
    finishWriter: vi.fn(async (): Promise<lifecycle.WriterOutcome> => { calls.push("collect", "reset"); return { status: "ok" as const, code: "writer_reset" }; }),
    collectWriter: vi.fn(async (): Promise<lifecycle.CollectOutcome> => ({ status: "ok" as const, code: "writer_collected", refs: [], refused: 0, findings: [] })),
    resetWriter: vi.fn(async (): Promise<lifecycle.WriterOutcome> => ({ status: "ok" as const, code: "writer_reset" })),
    recreateWriter: vi.fn(async (): Promise<lifecycle.WriterOutcome> => ({ status: "ok" as const, code: "writer_recreated" })),
    writerSettingsDrift: vi.fn(lifecycle.writerSettingsDrift),
  } satisfies typeof lifecycle;
  const accept = { ...acceptance, acceptWriter: vi.fn(async (_ctx: lifecycle.WriterContext, name: string): Promise<lifecycle.WriterOutcome> => { calls.push(`accept:${name}`); const index = Number(name.slice(-1)); await writeWriterState(home, name, { ...state(index), phase: "ready" }); return { status: "ok" as const, code: "writer_accepted" }; }),
    acceptanceCurrent: vi.fn(async (_ctx: lifecycle.WriterContext, name: string) => ((await readWriterState(home, name))?.phase === "ready" ? "current" : "stale") as "current" | "stale" | "unknown") };
  const adapter = {
    inspect: vi.fn(async (intent: { client: string; name: string }) => registered.has(intent.client + intent.name) ? "equivalent" as const : "absent" as const),
    add: vi.fn(async (intent: { client: string; name: string }) => { calls.push(`register:${intent.client}:${intent.name}`); registered.add(intent.client + intent.name); }),
    remove: vi.fn(async (intent: { client: string; name: string }) => { calls.push(`unregister:${intent.client}:${intent.name}`); registered.delete(intent.client + intent.name); }),
  };
  // Podman as the settings check asks it: usable, a full image ID resolves to itself, the built-in node image to the state's ID.
  const runner = { run: vi.fn(async (_command: string, args: readonly string[]) => ({ exitCode: 0, stdout: podmanAnswer(args), stderr: "" })) };
  const deps: WriterSetupDependencies = { configPath, home, releaseRoot: home, platform: "linux", runner, lifecycle: life, acceptance: accept, ownership, adapter, doctor: async () => ({ schemaVersion: 1, ok: true, exitCode: 0, checks: [] }), containerRuntime: async () => true, lock: vi.fn(async () => ({ release: async () => {} })) };
  return { home, configPath, calls, life, accept, deps, adapter, runner };
}
const podmanImage = (ref: string): string => /^[0-9a-f]{64}$/.test(ref) ? ref : state(1).imageId;
const podmanAnswer = (args: readonly string[]): string => args[0] === "info" ? "true" : args[0] === "version" ? "5.4.0" : args[0] === "image" ? podmanImage(args.at(-1)!) : "";
const mode = { alias: "x", mode: "container" as const, container: { profiles: ["code"], writers: 2 }, apply: true, acceptHostWrites: false };
describe("writer setup reconciliation", () => {
  it.each(["linux", "darwin"] as const)("sanitizes invalid aliases on %s", async (platform) => {
    const f = await fixture();
    const output = await changeWriterMode(f.configPath, { ...mode, alias: "../x" }, { ...f.deps, platform });
    expect(output.exitCode).toBe(1);
    expect(JSON.stringify(output)).not.toContain("../x");
    expect(output.findings[0]?.target.alias).toBe("invalid");
  });
  it.each(["read-only", "host"] as const)("applies %s on macOS without writer work", async (selected) => {
    const f = await fixture();
    const output = await changeWriterMode(f.configPath, { alias: "x", mode: selected, apply: true, acceptHostWrites: selected === "host" }, { ...f.deps, platform: "darwin" });
    expect(output.findings.some((finding) => finding.code === "mode_applied")).toBe(true);
    expect(JSON.parse(await readFile(executionModesPath(f.configPath), "utf8")).workspaces.x.mode).toBe(selected);
    expect(f.deps.lock).not.toHaveBeenCalled();
    expect(f.life.inspectWork).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
  it("requires an explicit choice when the macOS automatic probe fails", async () => {
    const f = await fixture();
    const output = await changeWriterMode(f.configPath, { alias: "x", apply: false, acceptHostWrites: false }, { ...f.deps, platform: "darwin", containerRuntime: async () => false });
    expect(output.findings[0]?.code).toBe("mode_choice_required");
    expect(f.deps.lock).not.toHaveBeenCalled();
  });
  it("refuses a requested or automatically proposed container on macOS", async () => {
    const f = await fixture();
    for (const selected of ["container", undefined] as const) {
      const output = await changeWriterMode(f.configPath, { alias: "x", container: mode.container, apply: true, acceptHostWrites: false, ...(selected ? { mode: selected } : {}) }, { ...f.deps, platform: "darwin" });
      expect(output.findings[0]?.code).toBe("platform_unsupported");
    }
  });
  it.each(["host", "read-only", "container", undefined] as const)("refuses changing a current container to %s on macOS", async (selected) => {
    const f = await fixture();
    await writeFile(executionModesPath(f.configPath), JSON.stringify({ schemaVersion: 1, workspaces: { x: { mode: "container", profiles: ["code"] } } }));
    const output = await changeWriterMode(f.configPath, { alias: "x", container: mode.container, apply: true, acceptHostWrites: true, ...(selected ? { mode: selected } : {}) }, { ...f.deps, platform: "darwin" });
    expect(output.findings[0]?.code).toBe("platform_unsupported");
    expect(f.deps.lock).not.toHaveBeenCalled();
  });
  it("refuses non-container changes with leftover writer state on macOS", async () => {
    const f = await fixture();
    await writeWriterState(f.home, "x-w16", state(16));
    const output = await changeWriterMode(f.configPath, { alias: "x", mode: "read-only", apply: true, acceptHostWrites: false }, { ...f.deps, platform: "darwin" });
    expect(output.findings[0]?.code).toBe("platform_unsupported");
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
  it("hands the host configuration's event delivery field to writer provisioning", async () => {
    const f = await fixture();
    const host = JSON.parse(await readFile(f.configPath, "utf8")) as object;
    await writeFile(f.configPath, JSON.stringify({ ...host, events: { delivery: "spool" } }));
    await changeWriterMode(f.configPath, mode, f.deps);
    expect(f.life.provisionWriter).toHaveBeenCalledTimes(2);
    for (const [, input] of f.life.provisionWriter.mock.calls) {
      expect(input.rawConfig).toMatchObject({ events: { delivery: "spool" } });
      // The host configuration's override directory, so provisioning can refuse overridden skills (#135).
      expect(input.overrideDirectory).toBe(join(f.home, "skills"));
    }
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
  it("reports settings drift instead of keeping a ready writer whose coding profile model changed (#134)", async () => {
    const f = await fixture();
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    f.calls.length = 0;
    f.accept.acceptWriter.mockClear(); f.adapter.add.mockClear();
    const host = JSON.parse(await readFile(f.configPath, "utf8")) as { executionProfiles: { code: { model: string } } };
    host.executionProfiles.code.model = "changed-model";
    await writeFile(f.configPath, JSON.stringify(host));
    const output = await changeWriterMode(f.configPath, mode, f.deps);
    expect(output.findings).toContainEqual(expect.objectContaining({ status: "failed", code: "writer_settings_changed", target: expect.objectContaining({ alias: "x-w1" }) }));
    expect(output.exitCode).not.toBe(0);
    expect(f.accept.acceptWriter).not.toHaveBeenCalled();
    expect(output.findings).not.toContainEqual(expect.objectContaining({ code: "writer_registered", target: expect.objectContaining({ alias: "x-w1" }) }));
    // The existing registrations stay: nothing is added and nothing removed for a held writer.
    expect(f.adapter.add).not.toHaveBeenCalled();
    expect(f.adapter.remove).not.toHaveBeenCalled();
  });
  it("checks only writers it did not provision in the same run (#134)", async () => {
    const f = await fixture();
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    expect(f.life.writerSettingsDrift).not.toHaveBeenCalled();
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    expect(f.life.writerSettingsDrift.mock.calls.map(([, input]) => input.index)).toEqual([1, 2]);
  });
  type Host = { executionProfiles: Record<string, Record<string, unknown>>; skillCatalog?: Record<string, string>; events?: unknown };
  const editHost = async (configPath: string, edit: (host: Host) => Host) => writeFile(configPath, JSON.stringify(edit(JSON.parse(await readFile(configPath, "utf8")) as Host)));
  it.each([
    ["thinking level", (host: Host) => ({ ...host, executionProfiles: { ...host.executionProfiles, code: { ...host.executionProfiles.code, thinkingLevel: "high" } } }), mode],
    ["image", (host: Host) => host, { ...mode, container: { ...mode.container, image: "c".repeat(64) } }],
    ["network", (host: Host) => host, { ...mode, container: { ...mode.container, network: "none" as const } }],
    ["event delivery", (host: Host) => ({ ...host, events: { delivery: "spool" } }), mode],
    ["profile list", (host: Host) => ({ ...host, executionProfiles: { ...host.executionProfiles, other: { ...host.executionProfiles.code, model: "second" } } }), { ...mode, container: { ...mode.container, profiles: ["code", "other"] } }],
  ])("reports a changed %s of a ready writer without accepting or registering it (#134)", async (_label, edit, next) => {
    const f = await fixture();
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    f.calls.length = 0;
    await editHost(f.configPath, edit);
    const output = await changeWriterMode(f.configPath, next, f.deps);
    expect(output.exitCode).not.toBe(0);
    expect(output.findings.filter((finding) => finding.code === "writer_settings_changed").map((finding) => finding.target.alias)).toEqual(["x-w1", "x-w2"]);
    expect(f.calls).toEqual([]);
    expect(output.findings.some((finding) => finding.code === "writer_registered")).toBe(false);
  });
  it("does not count a changed key order of the host profiles as a settings change (#134)", async () => {
    const f = await fixture();
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    f.calls.length = 0;
    await editHost(f.configPath, (host) => ({ ...host, executionProfiles: { ...host.executionProfiles, code: Object.fromEntries(Object.entries(host.executionProfiles.code!).reverse()) } }));
    const output = await changeWriterMode(f.configPath, mode, f.deps);
    expect(output.exitCode).toBe(0);
    expect(f.calls).toEqual([]);
    expect(output.findings.filter((finding) => finding.code === "writer_registered").map((finding) => finding.status)).toEqual(["unchanged", "unchanged"]);
    // An explicit delivery "off" means the same as no events field.
    await editHost(f.configPath, (host) => ({ ...host, events: { delivery: "off" } }));
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    expect(f.calls).toEqual([]);
  });
  it.each([
    ["Podman cannot be asked", "podman_unavailable", (_args: readonly string[]) => ({ exitCode: 125, stdout: "", stderr: "" })],
    ["the image cannot be resolved locally", "image_unavailable", (args: readonly string[]) => args[0] === "image" ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 0, stdout: podmanAnswer(args), stderr: "" }],
  ])("leaves a ready writer as it is when %s, and never pulls (#134)", async (_label, code, answer) => {
    const f = await fixture();
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    f.calls.length = 0; f.runner.run.mockClear();
    f.runner.run.mockImplementation(async (_command, args) => answer(args));
    const output = await changeWriterMode(f.configPath, mode, f.deps);
    expect(output.exitCode).not.toBe(0);
    expect(output.findings.filter((finding) => finding.code === code).map((finding) => finding.status)).toEqual(["failed", "failed"]);
    expect(f.calls).toEqual([]);
    expect((await readWriterState(f.home, "x-w1"))?.phase).toBe("ready");
    expect(f.runner.run.mock.calls.some(([, args]) => args[0] === "pull")).toBe(false);
  });
  it("reports an override created after provisioning for a writer whose coding profile selects that skill (#134, #135)", async () => {
    const f = await fixture();
    await editHost(f.configPath, (host) => ({ ...host, skillCatalog: { impl: "builtin:pi-session-implementation" }, executionProfiles: { ...host.executionProfiles, code: { ...host.executionProfiles.code, skills: ["impl"] } } }));
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    f.calls.length = 0;
    await mkdir(join(f.home, "skills", "pi-session-implementation"), { recursive: true });
    await writeFile(join(f.home, "skills", "pi-session-implementation", "SKILL.md"), "---\nname: pi-session-implementation\ndescription: Operator copy.\n---\n");
    const output = await changeWriterMode(f.configPath, mode, f.deps);
    expect(output.findings.filter((finding) => finding.code === "container_profile_unsupported").map((finding) => finding.target.alias)).toEqual(["x-w1", "x-w2"]);
    expect(f.calls).toEqual([]);
  });
  it("shows the settings change in the dry run without changing anything (#134)", async () => {
    const f = await fixture();
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    f.calls.length = 0;
    await editHost(f.configPath, (host) => ({ ...host, executionProfiles: { ...host.executionProfiles, code: { ...host.executionProfiles.code, model: "changed-model" } } }));
    const before = await readFile(writerPaths(f.home, "x-w1").state, "utf8");
    const output = await changeWriterMode(f.configPath, { ...mode, apply: false }, f.deps);
    expect(output.exitCode).not.toBe(0);
    expect(output.findings.filter((finding) => finding.code === "writer_settings_changed").map((finding) => finding.target.alias)).toEqual(["x-w1", "x-w2"]);
    expect(output.findings.some((finding) => finding.code === "writer_planned")).toBe(false);
    expect(f.calls).toEqual([]);
    expect(await readFile(writerPaths(f.home, "x-w1").state, "utf8")).toBe(before);
  });
  it("shows in the dry run that a new writer's profile would be refused, as apply would (#135)", async () => {
    const f = await fixture();
    await editHost(f.configPath, (host) => ({ ...host, skillCatalog: { impl: "builtin:no-such-shipped-skill" }, executionProfiles: { ...host.executionProfiles, code: { ...host.executionProfiles.code, skills: ["impl"] } } }));
    const output = await changeWriterMode(f.configPath, { ...mode, apply: false }, f.deps);
    expect(output.exitCode).not.toBe(0);
    expect(output.findings.filter((finding) => finding.code === "container_profile_unsupported").map((finding) => finding.target.alias)).toEqual(["x-w1", "x-w2"]);
    expect(f.calls).toEqual([]);
  });
  it("accepts a ready writer again when its acceptance is no longer current, as after a package upgrade (#130)", async () => {
    const f = await fixture();
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    f.calls.length = 0;
    // Both writers stay ready, but the recorded acceptance of x-w1 no longer matches the binding.
    f.accept.acceptanceCurrent.mockImplementation(async (_ctx, name) => name === "x-w1" ? "stale" : "current");
    const output = await changeWriterMode(f.configPath, mode, f.deps);
    expect(output.exitCode).toBe(0);
    expect(f.calls).toEqual(["accept:x-w1"]);
    expect(output.findings).toContainEqual(expect.objectContaining({ code: "writer_accepted", target: expect.objectContaining({ alias: "x-w1" }) }));
    expect(output.findings.filter((finding) => finding.code === "writer_registered").map((finding) => finding.status)).toEqual(["unchanged", "unchanged"]);
  });
  it("leaves a ready writer as it is when Podman cannot be asked, and reports it", async () => {
    const f = await fixture();
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    f.calls.length = 0;
    f.accept.acceptanceCurrent.mockImplementation(async (_ctx, name) => name === "x-w1" ? "unknown" : "current");
    const output = await changeWriterMode(f.configPath, mode, f.deps);
    expect(output.exitCode).not.toBe(0);
    expect(f.calls).toEqual([]);
    expect(output.findings).toContainEqual(expect.objectContaining({ status: "failed", code: "podman_unavailable", target: expect.objectContaining({ alias: "x-w1" }) }));
    expect((await readWriterState(f.home, "x-w1"))?.phase).toBe("ready");
    expect(output.findings.filter((finding) => finding.code === "writer_registered").map((finding) => finding.target.alias)).toEqual(["x-w2"]);
  });
  it("accepts a ready writer again after a package upgrade, judged by the real predicate", async () => {
    const f = await fixture();
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    f.calls.length = 0;
    const runner = { run: vi.fn(async (_command: string, args: readonly string[]) => ({ exitCode: 0, stdout: args[0] === "info" ? "true" : args[0] === "image" ? podmanImage(args.at(-1)!) : "5.4.0", stderr: "" })) };
    const upgraded = (version: string) => acceptanceFingerprint({ wrapperDigest: wrapperDigest("wrapper"), packageVersion: version, imageId: state(1).imageId, podmanVersion: "5.4.0", network: "pasta", cache: "none" });
    for (const index of [1, 2]) await writeWriterState(f.home, `x-w${index}`, { ...state(index), phase: "ready", acceptance: { fingerprint: upgraded(index === 1 ? "0.0.0" : PACKAGE_VERSION), verdict: "pass", network: "limited", at: "then" } });
    const output = await changeWriterMode(f.configPath, mode, { ...f.deps, runner, acceptance: { ...f.accept, acceptanceCurrent: acceptance.acceptanceCurrent } });
    expect(output.exitCode).toBe(0);
    expect(f.calls).toEqual(["accept:x-w1"]);
  });
  it("does not register a writer again when its re-acceptance fails, and keeps the existing registration", async () => {
    const f = await fixture();
    expect((await changeWriterMode(f.configPath, mode, f.deps)).exitCode).toBe(0);
    f.accept.acceptanceCurrent.mockImplementation(async (_ctx, name) => name === "x-w1" ? "stale" : "current");
    f.accept.acceptWriter.mockImplementation(async (_ctx, name) => { await writeWriterState(f.home, name, { ...state(1), phase: "not_ready" }); return { status: "failed", code: "acceptance_harness_failed" }; });
    const output = await changeWriterMode(f.configPath, mode, f.deps);
    expect(output.exitCode).not.toBe(0);
    expect(output.findings).toContainEqual(expect.objectContaining({ status: "failed", code: "acceptance_harness_failed", target: expect.objectContaining({ alias: "x-w1" }) }));
    expect(output.findings.filter((finding) => finding.code === "writer_registered").map((finding) => finding.target.alias)).toEqual(["x-w2"]);
    expect(f.adapter.remove).not.toHaveBeenCalled();
  });
  it("reports the existing global lock code without running mutations", async () => {
    const f = await fixture();
    const lock = vi.fn(async () => { throw new OverrideLockError("override_lock_busy"); });
    const output = await runWriterOperation("x-w1", "finish", { apply: true, discard: false }, { ...f.deps, lock });
    expect(output.findings[0]?.code).toBe("override_lock_busy");
    expect(f.calls).toEqual([]);
    expect(lock).toHaveBeenCalledWith(join(f.home, ".local", "state", "pi-session-mcp", "writers"), {});
  });
  it.each(["repository", "writer"])("names and sanitizes every blocking Doctor check for a %s step", async (step) => {
    const f = await fixture();
    const doctor: WriterSetupDependencies["doctor"] = async () => ({ schemaVersion: 1, ok: false, exitCode: 2, checks: [
      { id: "workspace_missing", severity: "error", subject: "other" },
      { id: "extension_version_mismatch", severity: "error", subject: "safe:fixture-ext" },
      { id: "build_missing", severity: "error", subject: "/secret/path" },
      { id: "config_invalid", severity: "error", subject: "configuration" },
      { id: "writer_not_ready", severity: "error", subject: "x-w1" },
      { id: "extension_unpinned", severity: "warning", subject: "other" },
    ] });
    const deps = { ...f.deps, doctor };
    const output = step === "repository" ? await changeWriterMode(f.configPath, mode, deps)
      : await runWriterOperation("x-w1", "finish", { apply: true, discard: false }, deps);
    expect(output.exitCode).toBe(1);
    expect(output.findings.map((finding) => finding.code)).toEqual(["doctor_failed", "workspace_missing", "extension_version_mismatch", "build_missing", "config_invalid"]);
    expect(output.findings.slice(1)).toEqual([
      { status: "failed", code: "workspace_missing", target: { client: "doctor", scope: "check", alias: "other" } },
      { status: "failed", code: "extension_version_mismatch", target: { client: "doctor", scope: "check", alias: "safe" } },
      { status: "failed", code: "build_missing", target: { client: "doctor", scope: "check", alias: "invalid" } },
      { status: "failed", code: "config_invalid", target: { client: "doctor", scope: "check", alias: "invalid" } },
    ]);
    expect(JSON.stringify(output)).not.toContain("/secret/path");
    expect(f.calls).toEqual([]);
  });

  it("reports the blocking checks once when the gate blocks after the modes file was written", async () => {
    const f = await fixture();
    const doctor = vi.fn<NonNullable<WriterSetupDependencies["doctor"]>>(async () => ({ schemaVersion: 1, ok: true, exitCode: 0, checks: [] }));
    doctor.mockResolvedValueOnce({ schemaVersion: 1, ok: true, exitCode: 0, checks: [] });
    doctor.mockResolvedValue({ schemaVersion: 1, ok: false, exitCode: 2, checks: [
      { id: "writer_dirty", severity: "error", subject: "other-w2" },
      { id: "extension_version_mismatch", severity: "error", subject: "review:fixture-ext" },
    ] });
    const output = await changeWriterMode(f.configPath, mode, { ...f.deps, doctor });
    expect(doctor).toHaveBeenCalledTimes(2);
    expect(output.exitCode).toBe(1);
    expect(output.findings.filter((finding) => finding.code === "doctor_failed")).toHaveLength(1);
    expect(output.findings.filter((finding) => finding.target.client === "doctor")).toEqual([
      { status: "failed", code: "writer_dirty", target: { client: "doctor", scope: "check", alias: "other" } },
      { status: "failed", code: "extension_version_mismatch", target: { client: "doctor", scope: "check", alias: "review" } },
    ]);
    expect(f.calls).toEqual([]);
  });

  it.each(["repository", "writer"])("does not block a %s step on its own writer subject", async (step) => {
    const f = await fixture();
    const doctor: WriterSetupDependencies["doctor"] = async () => ({ schemaVersion: 1, ok: false, exitCode: 2, checks: [{ id: "writer_not_ready", severity: "error", subject: "x-w1" }] });
    const deps = { ...f.deps, doctor };
    const output = step === "repository" ? await changeWriterMode(f.configPath, mode, deps)
      : await runWriterOperation("x-w1", "finish", { apply: true, discard: false }, deps);
    expect(output.exitCode).toBe(0);
    expect(output.findings.some((finding) => finding.code === "doctor_failed")).toBe(false);
  });

  it.each(["repository", "writer"])("does not block a %s step on a refused profile of its own repository (#141)", async (step) => {
    const f = await fixture();
    const doctor: WriterSetupDependencies["doctor"] = async () => ({ schemaVersion: 1, ok: false, exitCode: 2, checks: [{ id: "container_profile_refused", severity: "error", subject: "x:code" }] });
    const deps = { ...f.deps, doctor };
    const output = step === "repository" ? await changeWriterMode(f.configPath, mode, deps)
      : await runWriterOperation("x-w1", "finish", { apply: true, discard: false }, deps);
    expect(output.findings.some((finding) => finding.code === "doctor_failed")).toBe(false);
  });

  it("blocks on a refused profile of another repository and on other checks with a matching prefix", async () => {
    const f = await fixture();
    for (const check of [
      { id: "container_profile_refused" as const, severity: "error" as const, subject: "other:code" },
      { id: "extension_version_mismatch" as const, severity: "error" as const, subject: "x:fixture-ext" },
    ]) {
      f.calls.length = 0;
      const doctor: WriterSetupDependencies["doctor"] = async () => ({ schemaVersion: 1, ok: false, exitCode: 2, checks: [check] });
      const output = await runWriterOperation("x-w1", "finish", { apply: true, discard: false }, { ...f.deps, doctor });
      expect(output.findings[0]?.code).toBe("doctor_failed");
      expect(f.calls).toEqual([]);
    }
  });

  it.each(["repository", "writer"])("does not block a %s step on another repository's writers that are not ready after an upgrade (#148)", async (step) => {
    const f = await fixture();
    const doctor: WriterSetupDependencies["doctor"] = async () => ({ schemaVersion: 1, ok: false, exitCode: 2, checks: [
      { id: "writer_not_ready", severity: "error", subject: "x-w1" },
      { id: "writer_not_ready", severity: "error", subject: "other-w1" },
      { id: "writer_not_ready", severity: "error", subject: "other-w2" },
    ] });
    const deps = { ...f.deps, doctor };
    const output = step === "repository" ? await changeWriterMode(f.configPath, mode, deps)
      : await runWriterOperation("x-w1", "finish", { apply: true, discard: false }, deps);
    expect(output.findings.some((finding) => finding.code === "doctor_failed")).toBe(false);
  });

  it("still blocks on other error checks with writer subjects and on a malformed writer subject", async () => {
    const f = await fixture();
    for (const check of [
      { id: "writer_dirty" as const, severity: "error" as const, subject: "other-w1" },
      { id: "writer_not_ready" as const, severity: "error" as const, subject: "not a writer" },
    ]) {
      f.calls.length = 0;
      const doctor: WriterSetupDependencies["doctor"] = async () => ({ schemaVersion: 1, ok: false, exitCode: 2, checks: [check] });
      const output = await runWriterOperation("x-w1", "finish", { apply: true, discard: false }, { ...f.deps, doctor });
      expect(output.findings[0]?.code).toBe("doctor_failed");
      expect(f.calls).toEqual([]);
    }
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
  it.each(["reset", "recreate", "finish"] as const)("asks for the writer's servers to reconnect after an applied %s", async (operation) => {
    const f = await fixture();
    const output = await runWriterOperation("x-w1", operation, { apply: true, discard: false }, f.deps);
    expect(output.exitCode).toBe(0);
    expect(output.findings).toContainEqual({ target: { client: "writer", scope: "x", alias: "x-w1" }, status: "ok", code: "writer_reconnect_required" });
  });
  it("does not ask for a reconnect after a failed reset, a dry run or a collect", async () => {
    const f = await fixture();
    f.life.resetWriter.mockResolvedValueOnce({ status: "failed", code: "writer_reset_failed" });
    const failed = await runWriterOperation("x-w1", "reset", { apply: true, discard: false }, f.deps);
    expect(failed.findings.some((finding) => finding.code === "writer_reconnect_required")).toBe(false);
    const dry = await runWriterOperation("x-w1", "reset", { apply: false, discard: false }, f.deps);
    expect(dry.findings.some((finding) => finding.code === "writer_reconnect_required")).toBe(false);
    const collected = await runWriterOperation("x-w1", "collect", { apply: true, discard: false }, f.deps);
    expect(collected.findings.some((finding) => finding.code === "writer_reconnect_required")).toBe(false);
    f.life.finishWriter.mockResolvedValueOnce({ status: "failed", code: "writer_collect_incomplete" });
    const unfinished = await runWriterOperation("x-w1", "finish", { apply: true, discard: false }, f.deps);
    expect(unfinished.exitCode).toBe(1);
    expect(unfinished.findings.some((finding) => finding.code === "writer_reconnect_required")).toBe(false);
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
