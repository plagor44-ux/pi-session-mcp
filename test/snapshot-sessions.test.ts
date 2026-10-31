import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSnapshotGuard } from "../src/snapshot-guard.js";
import { ensureSnapshotRoot, lockSnapshotExclusive, snapshotPaths, trustedGit, writeSnapshotState } from "../src/review-snapshot.js";
import { SessionRegistry, type TurnTerminalNotice } from "../src/session-registry.js";
import { createServer } from "../src/server.js";
import { isTrustedSystemBinary } from "../src/setup-platform.js";
import type { ConfiguredExecutionProfile } from "../src/execution-profile.js";
import { FakeAdapter } from "./fake-adapter.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const binary = ["/usr/bin/git", "/bin/git"].find((path) => isTrustedSystemBinary(path));
const realGit = it.skipIf(!binary || process.platform !== "linux");
const profile = { alias: "safe", permissionProfile: "read-only" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const };
async function fixture() {
  const home = await temporaryRoot("snapshot-session-"); const repo = join(home, "repo"); await mkdir(repo);
  const global = join(home, "global"); await writeFile(global, "");
  const env = { HOME: home, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  const git = (...args: string[]) => execFileSync(binary!, ["-C", repo, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init"); git("config", "user.name", "test"); git("config", "user.email", "test@example.invalid");
  await writeFile(join(repo, "file"), "clean"); await writeFile(join(repo, ".gitignore"), "*.log\n"); git("add", "."); git("commit", "-m", "initial");
  const head = git("rev-parse", "HEAD"); const tree = git("rev-parse", "HEAD^{tree}");
  const paths = snapshotPaths(home, "review"); await ensureSnapshotRoot(paths); git("worktree", "add", "--detach", paths.worktree, head);
  await writeSnapshotState(paths, { v: 1, source: "repo", base: head, head, tree, at: "now" });
  const modes = new Map([["review", { mode: "snapshot" as const, snapshot: { source: "repo" } }]]);
  const workspaces = new Map([["review", paths.worktree]]); const adapter = new FakeAdapter(); const notices: TurnTerminalNotice[] = [];
  const registry = new SessionRegistry(adapter, workspaces, { snapshotGuard: createSnapshotGuard({ home, workspaceModes: modes, git: trustedGit({ env }) }), onTurnTerminal: (notice) => notices.push(notice) });
  return { paths, modes, workspaces, adapter, registry, notices, binding: { base: head, head, tree } };
}
async function terminal(registry: SessionRegistry, session: string, turn: string) {
  for (let i = 0; i < 200; i++) { const view = registry.getTurn(session, turn); if (view.state !== "running") return view; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("turn did not settle");
}
async function unlocked(paths: ReturnType<typeof snapshotPaths>) { const lock = await lockSnapshotExclusive(paths); await lock.release(); }
realGit("holds the lease through start, publishes binding, and releases on close", async () => {
  const f = await fixture(); const session = await f.registry.start("review", profile);
  expect(session.snapshot).toEqual(f.binding); expect(f.registry.get(session.id).snapshot).toEqual(f.binding); expect(f.registry.list()[0]?.snapshot).toEqual(f.binding);
  await expect(lockSnapshotExclusive(f.paths)).rejects.toMatchObject({ code: "snapshot_busy" });
  await f.registry.close(session.id); await unlocked(f.paths);
});
realGit("releases on failed creation and shutdown", async () => {
  const f = await fixture(); f.adapter.plans.push({ creationError: new Error("private") });
  await expect(f.registry.start("review", profile)).rejects.toThrow(); await unlocked(f.paths);
  await f.registry.start("review", profile); await f.registry.shutdown(); await unlocked(f.paths);
});
for (const file of ["file", "ignored.log"]) realGit(`taints on ${file} before admitting a turn`, async () => {
  const f = await fixture(); const s = await f.registry.start("review", profile); await writeFile(join(f.paths.worktree, file), "modified");
  await expect(f.registry.prompt(s.id, "review")).rejects.toMatchObject({ code: "snapshot_modified" });
  if (file === "file") await writeFile(join(f.paths.worktree, file), "clean"); else await rm(join(f.paths.worktree, file));
  await expect(f.registry.prompt(s.id, "again")).rejects.toMatchObject({ code: "snapshot_modified" });
  expect(f.adapter.handles[0]!.preflight).toBeUndefined(); await f.registry.close(s.id);
});
realGit("downgrades a completed turn after modification and notifies its final state", async () => {
  const f = await fixture(); const s = await f.registry.start("review", profile); const p = await f.registry.prompt(s.id, "review");
  await writeFile(join(f.paths.worktree, "file"), "modified"); f.adapter.handles[0]!.complete();
  expect(await terminal(f.registry, s.id, p.turn.turnId)).toMatchObject({ state: "failed", error: { code: "turn_failed" } });
  expect(f.notices).toMatchObject([{ state: "failed", via: "registry" }]);
  await expect(f.registry.prompt(s.id, "again")).rejects.toMatchObject({ code: "snapshot_modified" }); await f.registry.close(s.id);
});
for (const outcome of ["failed", "aborted"] as const) realGit(`keeps a ${outcome} turn terminal after modification`, async () => {
  const f = await fixture(); const s = await f.registry.start("review", profile); const p = await f.registry.prompt(s.id, "review");
  await writeFile(join(f.paths.worktree, "file"), "modified"); if (outcome === "failed") f.adapter.handles[0]!.fail(); else await f.registry.abort(s.id);
  expect((await terminal(f.registry, s.id, p.turn.turnId)).state).toBe(outcome); expect(f.notices[0]?.state).toBe(outcome); await f.registry.close(s.id);
});
realGit("retains a lease when dispose rejects", async () => {
  const f = await fixture(); const s = await f.registry.start("review", profile); f.adapter.handles[0]!.disposeError = new Error("dispose failed");
  await f.registry.close(s.id); await expect(lockSnapshotExclusive(f.paths)).rejects.toMatchObject({ code: "snapshot_busy" });
});
realGit("releases the lease when selection verification fails", async () => {
  const f = await fixture();
  const adapter = new FakeAdapter(); const original = adapter.create.bind(adapter);
  adapter.create = async (input) => { const handle = await original(input); Object.assign(handle.appliedSelection, { model: "wrong" }); return handle; };
  const guard = createSnapshotGuard({ home: f.paths.root.split("/.local/")[0]!, workspaceModes: f.modes, git: trustedGit({ env: { HOME: f.paths.root.split("/.local/")[0]!, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }) });
  const registry = new SessionRegistry(adapter, f.workspaces, { snapshotGuard: guard });
  await expect(registry.start("review", profile)).rejects.toThrow(); await unlocked(f.paths);
});
it("bounds admission and post-turn verification and taints the session", async () => {
  let verify = 0; let hangAt = 1;
  const guard = { isSnapshot: () => true, acquire: async () => ({ binding: { base: "a", head: "b", tree: "c" }, verify: () => ++verify >= hangAt ? new Promise<void>(() => {}) : Promise.resolve(), release: async () => {} }) };
  const adapter = new FakeAdapter(); const registry = new SessionRegistry(adapter, new Map([["review", "/tmp"]]), { snapshotGuard: guard, snapshotVerifyDeadlineMs: 10 });
  const first = await registry.start("review", profile);
  await expect(registry.prompt(first.id, "test")).rejects.toMatchObject({ code: "snapshot_unavailable" });
  await expect(registry.prompt(first.id, "again")).rejects.toMatchObject({ code: "snapshot_modified" }); await registry.close(first.id);
  verify = 0; hangAt = 2; const second = await registry.start("review", profile); const turn = await registry.prompt(second.id, "test"); adapter.handles[1]!.complete();
  expect((await terminal(registry, second.id, turn.turn.turnId)).state).toBe("failed");
  await expect(registry.prompt(second.id, "again")).rejects.toMatchObject({ code: "snapshot_modified" }); await registry.close(second.id);
});
it("waits for bounded snapshot verification after a successful adapter abort", async () => {
  vi.useFakeTimers();
  let verifyCount = 0;
  const guard = { isSnapshot: () => true, acquire: async () => ({ binding: { base: "a", head: "b", tree: "c" }, verify: async () => { if (++verifyCount === 2) await new Promise<void>((resolve) => setTimeout(resolve, 50)); }, release: async () => {} }) };
  const adapter = new FakeAdapter(); const notices: TurnTerminalNotice[] = [];
  const registry = new SessionRegistry(adapter, new Map([["review", "/tmp"]]), { snapshotGuard: guard, abortDeadlineMs: 20, snapshotVerifyDeadlineMs: 100, onTurnTerminal: (notice) => notices.push(notice) });
  try {
    const session = await registry.start("review", profile); const { turn } = await registry.prompt(session.id, "test");
    const aborting = expect(registry.abort(session.id)).resolves.toMatchObject({ id: session.id, state: "idle" });
    await Promise.all([aborting, vi.advanceTimersByTimeAsync(50)]);
    expect(registry.getTurn(session.id, turn.turnId).state).toBe("aborted");
    expect(notices).toMatchObject([{ turnId: turn.turnId, state: "aborted", via: "registry" }]);
    expect(notices).toHaveLength(1);
  } finally { vi.useRealTimers(); await registry.shutdown(); }
});
it("returns abort_timeout at the abort deadline when the adapter abort never resolves", async () => {
  vi.useFakeTimers();
  const adapter = new FakeAdapter();
  const registry = new SessionRegistry(adapter, new Map([["review", "/tmp"]]), { abortDeadlineMs: 20, closeCleanupDeadlineMs: 10 });
  try {
    const session = await registry.start("review", profile); const { turn } = await registry.prompt(session.id, "test");
    adapter.handles[0]!.abortGate = new Promise<void>(() => {});
    const aborting = expect(registry.abort(session.id)).rejects.toMatchObject({ code: "abort_timeout" });
    await vi.advanceTimersByTimeAsync(20);
    await aborting;
    expect(adapter.handles[0]!.aborted).toBe(1);
    expect(registry.getTurn(session.id, turn.turnId).state).toBe("running");
  } finally { vi.useRealTimers(); await registry.shutdown(); }
});
for (const action of ["abort", "close"] as const) it(`${action} during post-turn verification publishes one terminal notice`, async () => {
  let verifyCount = 0; let release!: () => void; let entered!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
  const guard = { isSnapshot: () => true, acquire: async () => ({ binding: { base: "a", head: "b", tree: "c" }, verify: async () => { if (++verifyCount === 2) { entered(); await pending; } }, release: async () => {} }) };
  const adapter = new FakeAdapter(); const notices: TurnTerminalNotice[] = [];
  const registry = new SessionRegistry(adapter, new Map([["review", "/tmp"]]), { snapshotGuard: guard, onTurnTerminal: (notice) => notices.push(notice) });
  const s = await registry.start("review", profile); const turn = await registry.prompt(s.id, "test"); adapter.handles[0]!.complete(); await started;
  const operation = action === "abort" ? registry.abort(s.id) : registry.close(s.id);
  if (action === "close") await operation;
  release(); await operation; await new Promise((resolve) => setTimeout(resolve, 10));
  expect(notices).toHaveLength(1);
  if (action === "close") expect(notices[0]).toMatchObject({ state: "aborted", via: "close" });
  else expect(registry.getTurn(s.id, turn.turn.turnId).state).not.toBe("running");
});
realGit("exposes binding and snapshot capability through tools and rejects unsafe profiles", async () => {
  const f = await fixture();
  const base = { ...profile, default: true };
  const profiles = new Map<string, ConfiguredExecutionProfile>([["safe", base], ["code", { ...base, alias: "code", default: false, permissionProfile: "coding" }], ["ext", { ...base, alias: "ext", extensions: [{ spec: "npm:ext@1.0.0", name: "ext", version: "1.0.0" }] }], ["grant", { ...base, alias: "grant", grantedExtensionTools: ["tool"] }], ["mcp", { ...base, alias: "mcp", mcpServers: { ext: { command: "/bin/true", tools: {} } } }]]);
  const server = createServer(f.registry, f.workspaces, profiles, "safe", { fingerprint: `sha256:${"0".repeat(64)}`, reloadPolicy: "restart-required" }, f.modes);
  const [ct, st] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "test", version: "1" }); await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    for (const [alias, code] of [["code", "workspace_mode_forbids_coding"], ["ext", "snapshot_profile_unsupported"], ["grant", "snapshot_profile_unsupported"], ["mcp", "snapshot_profile_unsupported"]]) {
      const result = await client.callTool({ name: "pi_session_start", arguments: { workspace: "review", executionProfile: alias } }); expect(result.structuredContent).toMatchObject({ error: { code } });
    }
    expect((await client.callTool({ name: "pi_session_start", arguments: { workspace: "review", base: "main" } })).structuredContent).toMatchObject({ error: { code: "base_not_applicable" } });
    expect(f.adapter.createInputs).toHaveLength(0); await unlocked(f.paths);
    const started = await client.callTool({ name: "pi_session_start", arguments: { workspace: "review" } }); expect(started.structuredContent).toMatchObject({ session: { snapshot: f.binding } });
    const id = (started.structuredContent as { session: { id: string } }).session.id;
    expect((await client.callTool({ name: "pi_session_get", arguments: { sessionId: id } })).structuredContent).toMatchObject({ session: { snapshot: f.binding } });
    expect((await client.callTool({ name: "pi_session_list", arguments: {} })).structuredContent).toMatchObject({ sessions: [{ snapshot: f.binding }] });
    const tools = (await client.listTools()).tools; const schema = z.fromJSONSchema(tools.find((tool) => tool.name === "pi_session_start")!.outputSchema! as Parameters<typeof z.fromJSONSchema>[0]);
    expect(schema.safeParse(started.structuredContent).success).toBe(true);
    const malformed = structuredClone(started.structuredContent) as { session: { snapshot: { head: string } } }; malformed.session.snapshot.head = "bad"; expect(schema.safeParse(malformed).success).toBe(false);
    expect((await client.callTool({ name: "pi_capabilities_get", arguments: {} })).structuredContent).toMatchObject({ workspaces: [{ alias: "review", mode: "snapshot" }] });
  } finally { await f.registry.shutdown(); await client.close(); await server.close(); }
});
