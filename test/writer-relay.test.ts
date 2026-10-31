import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ChildStdioTransport } from "../src/child-stdio-transport.js";
import { RoutingPiSessionAdapter, WriterRelayAdapter } from "../src/writer-relay.js";
import { writerPaths } from "../src/writer-state.js";
import type { WorkspaceModeEntry } from "../src/execution-modes.js";
import type { ConfiguredExecutionProfile } from "../src/execution-profile.js";
import type { PiSessionHandle } from "../src/pi-adapter.js";
import { temporaryRoot, removeTemporaryRoots } from "./temporary-roots.js";

const profile = { alias: "code", default: true, permissionProfile: "coding" as const, provider: "p", model: "m", thinkingLevel: "off" as const };
const input = { cwd: "/unused", workspace: "repo", executionProfile: profile };
const modes = (writers = 1, base: string | undefined = "main") => new Map<string, WorkspaceModeEntry>([["repo", { mode: "container", container: { writers, base, lifecycle: "persistent", profiles: ["code"], image: "image", network: "none", cache: "none", tags: "none", clean: "untracked" } }]]);
const handles: PiSessionHandle[] = [];
afterAll(async () => { await Promise.all(handles.map(handle => handle.dispose())); await removeTemporaryRoots(); });
beforeAll(() => { execFileSync("npm", ["run", "build"], { stdio: "pipe" }); }, 30000);
async function setup(scenarios: Record<string, unknown>[] = [{}], extra: { now?: () => number; executionProfile?: ConfiguredExecutionProfile } = {}) {
  const { executionProfile = profile, ...adapterExtra } = extra;
  const home = await temporaryRoot("pi-relay-");
  for (let i = 0; i < scenarios.length; i++) {
    const name = `repo-w${i + 1}`, paths = writerPaths(home, name);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.state, JSON.stringify({ alias: "repo", index: i + 1, phase: "ready", launch: "relay", acceptance: { verdict: "pass", fingerprint: "x", at: "0", network: "limited" }, base: { ref: "refs/heads/main", commit: "a".repeat(40) } }));
    await writeFile(join(paths.root, "scenario.json"), JSON.stringify({ log: join(paths.root, "calls"), ...scenarios[i], home, name }));
  }
  const closed: string[] = [];
  const options: ConstructorParameters<typeof WriterRelayAdapter>[0] = { home, workspaceModes: modes(scenarios.length), executionProfiles: new Map([["code", executionProfile]]), pollIntervalMs: 5, ...adapterExtra, spawn: { spawn(wrapper, env) {
    const transport = new ChildStdioTransport(process.execPath, env, [resolve("test/fixtures/fake-writer-server.mjs"), join(wrapper, "..", "scenario.json")]);
    const close = transport.close.bind(transport);
    transport.close = async () => {
      closed.push(wrapper); await close();
      if (scenarios[0]?.hangTransportClose) await new Promise(() => undefined);
    };
    return transport;
  } } };
  const adapter = new WriterRelayAdapter(options);
  return { adapter, home, closed, options, async start(base?: string) { const handle = await adapter.create({ ...input, ...(base ? { base } : {}) }); handles.push(handle); return handle; } };
}
async function calls(home: string, index: number): Promise<string[]> {
  try { return (await readFile(join(writerPaths(home, `repo-w${index}`).root, "calls"), "utf8")).trim().split("\n").filter(Boolean); }
  catch { return []; }
}
const skill = (alias: string) => ({ alias, path: `/skills/${alias}/SKILL.md` });
const extension = { spec: "npm:x@1.0.0", name: "x", version: "1.0.0" };
async function change(home: string, index: number, values: Record<string, unknown>) {
  const path = writerPaths(home, `repo-w${index}`).state;
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), ...values }));
}
// The relay is Linux-only, like the writer lease and container fence it relies on.
describe.skipIf(process.platform !== "linux")("writer relay", () => {
  it("starts on the first ready relay writer at the default base and reports placement", async () => {
    const s = await setup(); const handle = await s.start();
    expect(handle.placement).toEqual({ writer: "repo-w1", base: { ref: "refs/heads/main", commit: "a".repeat(40) } });
    expect(handle.appliedSelection).toEqual({ provider: "p", model: "m", thinkingLevel: "off" });
    expect(await handle.prompt("hello", () => undefined)).toEqual({ status: "completed", assistantText: "done", truncated: false, completion: "stop" });
  });
  it("preserves an output-limit completion", async () => {
    const handle = await (await setup([{ completion: "output_limit" }])).start();
    expect(await handle.prompt("hello", () => undefined)).toEqual({ status: "completed", assistantText: "done", truncated: false, completion: "output_limit" });
  });
  it.each([{ missingCompletion: true }, { completion: "unknown" }])("loses a writer with invalid completion: %j", async (scenario) => {
    const handle = await (await setup([scenario])).start();
    expect(await handle.prompt("hello", () => undefined)).toEqual({ status: "failed" });
    expect(handle.isLost?.()).toBe(true);
  });
  it("base selects only writers on that branch; none matches → none_at_base", async () => {
    const s = await setup([{}, {}]); await change(s.home, 2, { base: { ref: "refs/heads/dev", commit: "b".repeat(40) } });
    expect((await s.start("dev")).placement?.writer).toBe("repo-w2");
    await expect(s.start("missing")).rejects.toMatchObject({ reason: "none_at_base" });
  });
  it("skips legacy and not-ready writers; none left → none_ready", async () => {
    const s = await setup([{}, {}]); await change(s.home, 1, { launch: "legacy" }); await change(s.home, 2, { phase: "not_ready" });
    await expect(s.start()).rejects.toMatchObject({ reason: "none_ready" });
  });
  it("busy, uncollected and drifted writers are counted; none admitted → none_admitted with counts", async () => {
    const s = await setup([{ refuse: "writer_busy" }, { uncollected: true }, { drift: true }]);
    await expect(s.start()).rejects.toMatchObject({ reason: "none_admitted", counts: { busy: 1, notAtBaseline: 1, settingsChanged: 1 } });
    expect(s.closed).toHaveLength(3);
  });
  it("a host skill selection the writer does not report is refused before the inner start", async () => {
    const s = await setup([{ profile: { skills: [] } }], { executionProfile: { ...profile, skills: [skill("pi-session-implementation")] } });
    await expect(s.start()).rejects.toMatchObject({ reason: "none_admitted", counts: { busy: 0, notAtBaseline: 0, settingsChanged: 1 } });
    expect(await calls(s.home, 1)).not.toContain("pi_session_start");
  });
  it("matching skills in a different order are admitted", async () => {
    const s = await setup([{ profile: { skills: ["b", "a"] } }], { executionProfile: { ...profile, skills: [skill("a"), skill("b")] } });
    expect((await s.start()).placement?.writer).toBe("repo-w1");
    expect(await calls(s.home, 1)).toContain("pi_session_start");
  });
  it.each([
    { name: "added", host: ["a"], inner: ["a", "b"] },
    { name: "removed", host: ["a"], inner: [] },
    { name: "different", host: ["a"], inner: ["b"] },
    { name: "duplicated inner", host: ["a", "b"], inner: ["a", "a"] },
  ])("$name skills are refused before the inner start", async ({ host, inner }) => {
    const s = await setup([{ profile: { skills: inner } }], { executionProfile: { ...profile, skills: host.map(skill) } });
    await expect(s.start()).rejects.toMatchObject({ reason: "none_admitted", counts: { busy: 0, notAtBaseline: 0, settingsChanged: 1 } });
    expect(await calls(s.home, 1)).not.toContain("pi_session_start");
  });
  it("extensions drift is refused before the inner start", async () => {
    const s = await setup([{ profile: { extensions: [] } }], { executionProfile: { ...profile, extensions: [extension] } });
    await expect(s.start()).rejects.toMatchObject({ reason: "none_admitted", counts: { settingsChanged: 1 } });
    expect(await calls(s.home, 1)).not.toContain("pi_session_start");
  });
  it("grantedExtensionTools drift is refused before the inner start", async () => {
    const s = await setup([{ profile: { grantedExtensionTools: [] } }], { executionProfile: { ...profile, grantedExtensionTools: ["x_tool"] } });
    await expect(s.start()).rejects.toMatchObject({ reason: "none_admitted", counts: { settingsChanged: 1 } });
    expect(await calls(s.home, 1)).not.toContain("pi_session_start");
  });
  it("shell drift is refused before the inner start", async () => {
    const s = await setup([{ profile: { shell: "none" } }], { executionProfile: { ...profile, shell: "sandboxed" } });
    await expect(s.start()).rejects.toMatchObject({ reason: "none_admitted", counts: { settingsChanged: 1 } });
    expect(await calls(s.home, 1)).not.toContain("pi_session_start");
  });
  it.each([
    { field: "permissionProfile", host: { permissionProfile: "read-only" as const }, inner: { permissionProfile: "coding" } },
    { field: "thinkingLevel", host: { thinkingLevel: "low" as const }, inner: { thinkingLevel: "off" } },
  ])("$field drift is refused before the inner start", async ({ host, inner }) => {
    const s = await setup([{ profile: inner }], { executionProfile: { ...profile, ...host } });
    await expect(s.start()).rejects.toMatchObject({ reason: "none_admitted", counts: { settingsChanged: 1 } });
    expect(await calls(s.home, 1)).not.toContain("pi_session_start");
  });
  it("inner capabilities missing the profile alias are refused with settingsChanged", async () => {
    const s = await setup([{ missingProfile: true }]);
    await expect(s.start()).rejects.toMatchObject({ reason: "none_admitted", counts: { settingsChanged: 1 } });
    expect(await calls(s.home, 1)).not.toContain("pi_session_start");
  });
  it("a host profile missing from the local configuration is refused with settingsChanged", async () => {
    const s = await setup([{}]);
    const adapter = new WriterRelayAdapter({ ...s.options, executionProfiles: new Map() });
    await expect(adapter.create(input)).rejects.toMatchObject({ reason: "none_admitted", counts: { settingsChanged: 1 } });
    expect(await calls(s.home, 1)).not.toContain("pi_session_start");
  });
  it.skipIf(process.platform !== "linux")("two relay adapters racing for one writer: one session, one writer_unavailable with busy 1", async () => {
    const s = await setup([{ lease: true }]);
    const second = new WriterRelayAdapter(s.options);
    const results = await Promise.allSettled([s.start(), second.create(input).then(handle => { handles.push(handle); return handle; })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "writer_unavailable", reason: "none_admitted", counts: { busy: 1 } } });
  });
  it("abort racing an inner completion settles completed", async () => {
    const s = await setup([{ completeDuringAbort: true, polls: 1000 }]); const handle = await s.start();
    let accepted!: () => void; const ready = new Promise<void>(resolve => { accepted = resolve; });
    const turn = handle.prompt("hello", () => accepted()); await ready; await handle.abort();
    expect(await turn).toMatchObject({ status: "completed", assistantText: "done", completion: "stop" });
  });
  it("writer state base changed after the inner start → inner close, next candidate", async () => {
    const s = await setup([{}, {}]); const paths = writerPaths(s.home, "repo-w1"); const log = join(paths.root, "calls");
    await writeFile(join(paths.root, "scenario.json"), JSON.stringify({ moveState: paths.state, log }));
    expect((await s.start()).placement?.writer).toBe("repo-w2");
    expect(await readFile(log, "utf8")).toContain("pi_session_close");
  });
  it.each([{ oversized: true }, { invalid: true }])("oversized assistantText or a schema-invalid turn fails the turn and marks the session lost (%j)", async scenario => {
    const s = await setup([scenario]); const handle = await s.start();
    expect(await handle.prompt("hello", () => undefined)).toEqual({ status: "failed" }); expect(handle.isLost?.()).toBe(true);
  });
  it("child exit while idle marks the session lost; prompt fails with writer_session_lost", async () => {
    const s = await setup([{ exitIdle: true }]); const handle = await s.start();
    await vi.waitFor(() => expect(handle.isLost?.()).toBe(true));
    await expect(handle.prompt("hello", () => undefined)).rejects.toMatchObject({ code: "writer_session_lost" });
  });
  it("activity advances only when inner updatedAt changes", async () => {
    const s = await setup([{ activity: true, polls: 5 }]); const handle = await s.start(); const activity = vi.fn();
    await handle.prompt("hello", () => undefined, activity); expect(activity).toHaveBeenCalledTimes(2);
  });
  it("start budget exhausted → none_admitted, all spawned transports closed", async () => {
    let tick = 0;
    const s = await setup([{}], { now: () => (tick++ < 3 ? 0 : 60001) });
    await expect(s.start()).rejects.toMatchObject({ reason: "none_admitted" }); expect(s.closed.length).toBeGreaterThan(0);
  });
  it("prompt rejection fails preflight without losing an idle session", async () => {
    const s = await setup([{ promptError: true }]); const handle = await s.start(); const preflight = vi.fn();
    expect(await handle.prompt("hello", preflight)).toEqual({ status: "failed" });
    expect(preflight).toHaveBeenCalledWith(false); expect(handle.isLost?.()).toBe(false);
  });
  it("child exit mid-turn fails the running turn and loses the session", async () => {
    const s = await setup([{ exitMidTurn: true, polls: 1000 }]); const handle = await s.start();
    expect(await handle.prompt("hello", () => undefined)).toEqual({ status: "failed" }); expect(handle.isLost?.()).toBe(true);
  });
  it("uncertain prompt timeout aborts the inner session and fails the turn", async () => {
    const s = await setup([{ slowPrompt: 50000 }]); const handle = await s.start(); const preflight = vi.fn();
    vi.useFakeTimers();
    try {
      const turn = handle.prompt("hello", preflight);
      await vi.advanceTimersByTimeAsync(10001);
      expect(await turn).toEqual({ status: "failed" }); expect(preflight).toHaveBeenCalledWith(false);
      expect(handle.isLost?.()).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("one cleanup deadline covers both close RPC and a hanging transport close", async () => {
    const s = await setup([{ slowClose: 50000, hangTransportClose: true }]); const handle = await s.start();
    vi.useFakeTimers();
    try {
      const disposal = handle.dispose();
      await vi.advanceTimersByTimeAsync(10000);
      await disposal; expect(s.closed).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it("missing default base is none_at_base", async () => {
    const s = await setup(); const entry = s.options.workspaceModes.get("repo")!;
    const { base: _base, ...container } = entry.container!;
    const adapter = new WriterRelayAdapter({ ...s.options, workspaceModes: new Map([["repo", { ...entry, container }]]) });
    await expect(adapter.create(input)).rejects.toMatchObject({ reason: "none_at_base" });
  });
  it("fenced and not-ready refusals are skipped without incrementing busy", async () => {
    const s = await setup([{ refuse: "writer_fenced" }, { refuse: "writer_not_ready" }]);
    await expect(s.start()).rejects.toMatchObject({ reason: "none_admitted", counts: { busy: 0, notAtBaseline: 0, settingsChanged: 0 } });
  });
  it("routing: read-only profile on a container workspace and any profile on a host workspace use the host adapter", async () => {
    const host = { create: vi.fn().mockResolvedValue({}) }, relay = { create: vi.fn().mockResolvedValue({}) };
    const routing = new RoutingPiSessionAdapter(host, relay, new Map([...modes(), ["host", { mode: "host" as const }]]));
    await routing.create({ ...input, executionProfile: { ...profile, permissionProfile: "read-only" } });
    await routing.create({ ...input, workspace: "host" }); await routing.create(input);
    expect(host.create).toHaveBeenCalledTimes(2); expect(relay.create).toHaveBeenCalledTimes(1);
  });
});
