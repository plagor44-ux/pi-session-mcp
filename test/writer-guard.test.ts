import { execFileSync } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWriterGuard, type GitProbe } from "../src/writer-guard.js";
import { SessionRegistry } from "../src/session-registry.js";
import { createServer } from "../src/server.js";
import { FakeAdapter } from "./fake-adapter.js";

const coding = { alias: "coding", permissionProfile: "coding" as const, provider: "fake-provider", model: "fake-model", thinkingLevel: "off" as const };
const readonly = { ...coding, alias: "safe", permissionProfile: "read-only" as const };
const commit = "a".repeat(40), ref = "refs/heads/main";
let dir: string, path: string, adapter: FakeAdapter, registry: SessionRegistry;
let snapshot: Awaited<ReturnType<GitProbe>>;
let probe: GitProbe;
let workspaces: Map<string, string>;
async function baseline(baseCommit = commit) { await writeFile(path, JSON.stringify({ schemaVersion: 1, workspace: "repo", baseRef: ref, baseCommit })); }
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "writer-guard-")); path = join(dir, "guard.json"); await baseline();
  snapshot = { head: commit, branches: [{ ref, commit }], dirty: false, stash: false };
  probe = vi.fn(async () => snapshot); workspaces = new Map([["repo", dir], ["other", dir]]);
  adapter = new FakeAdapter(); vi.spyOn(adapter, "create");
  registry = new SessionRegistry(adapter, workspaces, { writerGuard: createWriterGuard(path, workspaces, probe) });
});
afterEach(async () => { await registry.shutdown(); await rm(dir, { recursive: true, force: true }); });
it("preserves unguarded behavior", async () => {
  const unguarded = new SessionRegistry(adapter, workspaces);
  await unguarded.start("repo", coding); await unguarded.start("repo", coding); await unguarded.shutdown();
});
it.each(["dirty", "branch", "stash", "head", "branchCommit"])("refuses %s before adapter creation", async (kind) => {
  if (kind === "dirty") snapshot.dirty = true;
  if (kind === "branch") snapshot.branches.push({ ref: "refs/heads/extra", commit });
  if (kind === "stash") snapshot.stash = true;
  if (kind === "head") snapshot.head = "b".repeat(40);
  if (kind === "branchCommit") snapshot.branches[0]!.commit = "b".repeat(40);
  await expect(registry.start("repo", coding)).rejects.toMatchObject({ code: "writer_uncollected" });
  expect(adapter.create).not.toHaveBeenCalled();
});
it("refuses a second coding start until the open session closes", async () => {
  const first = await registry.start("repo", coding);
  await expect(registry.start("repo", coding)).rejects.toMatchObject({ code: "writer_busy" });
  expect(adapter.create).toHaveBeenCalledTimes(1);
  await registry.close(first.id); await registry.start("repo", coding);
});
it("serializes simultaneous coding admissions", async () => {
  const results = await Promise.allSettled([registry.start("repo", coding), registry.start("repo", coding)]);
  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(adapter.create).toHaveBeenCalledTimes(1);
});
it("allows read-only sessions on dirty clones and ignores them in the coding count", async () => {
  snapshot.dirty = true; await registry.start("repo", readonly); expect(probe).not.toHaveBeenCalled();
  snapshot.dirty = false; await registry.start("repo", coding);
});
it("lets other configured workspaces pass, even with open coding sessions", async () => {
  snapshot.dirty = true; await registry.start("other", coding); await registry.start("other", coding);
  expect(probe).not.toHaveBeenCalled();
});
it("sees an atomically replaced baseline without a new registry", async () => {
  const next = "b".repeat(64); snapshot.head = next; snapshot.branches = [{ ref, commit: next }];
  await expect(registry.start("repo", coding)).rejects.toMatchObject({ code: "writer_uncollected" });
  await writeFile(path + ".new", JSON.stringify({ schemaVersion: 1, workspace: "repo", baseRef: ref, baseCommit: next }));
  await rename(path + ".new", path); await registry.start("repo", coding);
});
it.each(["{", "{}", '{"schemaVersion":2}', JSON.stringify({ schemaVersion: 1, workspace: "repo", baseRef: "main", baseCommit: commit })])("fails closed for invalid guard %s", async (text) => {
  await writeFile(path, text); await expect(registry.start("repo", coding)).rejects.toMatchObject({ code: "writer_uncollected" });
  expect(adapter.create).not.toHaveBeenCalled();
});
it("fails closed for missing guards and failed git probes", async () => {
  await rm(path); await expect(registry.start("repo", coding)).rejects.toMatchObject({ code: "writer_uncollected" });
  await baseline(); vi.mocked(probe).mockRejectedValue(new Error("secret path"));
  await expect(registry.start("repo", coding)).rejects.toMatchObject({ code: "writer_uncollected" });
});
it.each(["writer_busy", "writer_uncollected"])("maps %s to a sanitized MCP domain error", async (code) => {
  if (code === "writer_busy") await registry.start("repo", coding); else snapshot.dirty = true;
  const server = createServer(registry, workspaces, new Map([["coding", { ...coding, default: true }]]), "coding", { fingerprint: `sha256:${"a".repeat(64)}`, reloadPolicy: "restart-required" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); const client = new Client({ name: "test", version: "1" }); await client.connect(clientTransport);
  try { expect((await client.callTool({ name: "pi_session_start", arguments: { workspace: "repo" } })).structuredContent).toMatchObject({ ok: false, error: { code } }); }
  finally { await client.close(); await server.close(); }
});
it("probes a real local repository, including branch targets, untracked files and stash", async () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base");
  const head = git("rev-parse", "HEAD");
  // Keep the server-owned guard outside the worktree status.
  await writeFile(join(dir, ".git", "info", "exclude"), "guard.json\n"); await baseline(head);
  const guard = createWriterGuard(path, workspaces); await guard.check("repo", 0);
  git("branch", "extra"); await expect(guard.check("repo", 0)).rejects.toMatchObject({ code: "writer_uncollected" }); git("branch", "-D", "extra");
  await writeFile(join(dir, "untracked"), "dirty"); await expect(guard.check("repo", 0)).rejects.toMatchObject({ code: "writer_uncollected" });
  git("stash", "push", "-u"); await expect(guard.check("repo", 0)).rejects.toMatchObject({ code: "writer_uncollected" });
  git("stash", "clear"); await guard.check("repo", 0);
});
