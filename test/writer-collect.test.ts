import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { CommandRunner } from "../src/client-adapters/types.js";
import { collectWriter, finishWriter, provisionWriter, recreateWriter, resetWriter, type WriterContext } from "../src/writer-lifecycle.js";
import { readWriterState, writerPaths, writeWriterState } from "../src/writer-state.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const commit = "b".repeat(40), tree = "c".repeat(40), imageId = "a".repeat(64);
const settings = { writers: 1, lifecycle: "persistent", profiles: ["code"], image: "node", network: "none", cache: "none", tags: "none", clean: "untracked" } as const;
const rawConfig = { executionProfiles: { code: { default: false, permissionProfile: "coding", provider: "example", model: "model", thinkingLevel: "off" } } };
async function fixture() {
  const home = await temporaryRoot("pi-writer-collect-");
  const paths = writerPaths(home, "repo-w1");
  const calls: { command: string; args: readonly string[]; options?: { inheritFds?: readonly number[] } }[] = [];
  let dirty = true, changed = false, badReset = false, empty = false, collision = false, baseSource = "refs/heads/main", heads = `${commit} refs/heads/feature\n`;
  const runner: CommandRunner = { async run(command, args, _signal, options) {
    calls.push({ command, args, ...(options ? { options } : {}) });
    let stdout = "";
    if (command === "git") {
      if (args.includes("symbolic-ref")) stdout = "refs/remotes/origin/main";
      if (args.includes("rev-parse")) stdout = args.includes("--symbolic-full-name") ? "refs/heads/main" : commit;
      if (args.includes("create")) {
        baseSource = args.at(-1)!;
        await writeFile(join(paths.bundles, "base.bundle"), "bundle");
      }
      if (args.includes("list-heads")) stdout = args.at(-1) === join(paths.bundles, "base.bundle") ? `${commit} ${baseSource}` : heads;
    } else if (args[0] === "image") stdout = imageId;
    else {
      const script = args[args.indexOf("-c") + 1]!;
      if (script.includes("clone --no-hardlinks")) {
        await mkdir(join(paths.clone, ".git/hooks"), { recursive: true });
        await writeFile(join(paths.clone, ".git/config"), "");
        dirty = false;
      } else if (script.includes("/tmp/scratch")) {
        if (empty) stdout = "nothing_to_collect\n";
        else await writeFile(join(paths.bundles, "collect.bundle"), "bundle");
        if (collision) stdout += "ref_name_refused\n";
      }
      else if (script.includes("stash clear")) { if (!badReset) dirty = false; }
      else stdout = `${commit}\n${(await readWriterState(home, "repo-w1"))!.base.ref} ${commit}\n${dirty ? (changed ? "e" : "d").repeat(40) : tree}\n${tree}\n${tree}\n`;
    }
    return { exitCode: 0, stdout, stderr: "" };
  } };
  const ctx: WriterContext = { home, checkout: join(home, "source"), releaseRoot: home, nodePath: process.execPath, runner, alias: "repo" };
  return { ctx, paths, calls, dirty: () => { dirty = true; }, changed: () => { changed = true; }, badReset: () => { badReset = true; }, empty: () => { empty = true; }, collision: () => { collision = true; }, heads: (value: string) => { heads = value; } };
}
async function provision(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig })).toMatchObject({ status: "ok" });
  f.dirty();
  const state = (await readWriterState(f.ctx.home, "repo-w1"))!;
  await writeWriterState(f.ctx.home, "repo-w1", { ...state, acceptance: { fingerprint: "fingerprint", verdict: "pass", network: "limited", at: "now" } });
}
it("inherits the lease in all provisioning, collect, reset and recreate Podman and host Git calls", async () => {
  const f = await fixture(); f.ctx.leaseFd = 42;
  await provision(f);
  expect((await collectWriter(f.ctx, "repo-w1")).status).toBe("ok");
  expect((await resetWriter(f.ctx, "repo-w1", { discard: true })).status).toBe("ok");
  expect((await recreateWriter(f.ctx, "repo-w1", { discard: true })).status).toBe("ok");
  expect(f.calls.length).toBeGreaterThan(10);
  for (const call of f.calls) expect(call.options).toEqual({ inheritFds: [42] });
});
it.each(["persistent", "ephemeral"] as const)("finish returns a %s fix writer to the supplied workspace default base", async (lifecycle) => {
  const f = await fixture(); await provision(f);
  const state = (await readWriterState(f.ctx.home, "repo-w1"))!;
  await writeWriterState(f.ctx.home, "repo-w1", { ...state, lifecycle, base: { ...state.base, ref: "refs/heads/fix" } });
  expect((await finishWriter(f.ctx, "repo-w1", { baseRef: "main" })).status).toBe("ok");
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.base.ref).toBe("refs/heads/main");
});
it("reset without --base keeps the writer's current base", async () => {
  const f = await fixture(); await provision(f);
  const state = (await readWriterState(f.ctx.home, "repo-w1"))!;
  await writeWriterState(f.ctx.home, "repo-w1", { ...state, base: { ...state.base, ref: "refs/heads/fix" } });
  expect((await resetWriter(f.ctx, "repo-w1", { discard: true })).status).toBe("ok");
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.base.ref).toBe("refs/heads/fix");
});
it("ignores worker tags in collection and its digest", async () => {
  const f = await fixture(); await provision(f); f.empty();
  await collectWriter(f.ctx, "repo-w1");
  const before = (await readWriterState(f.ctx.home, "repo-w1"))!.collected!.digest;
  await mkdir(join(f.paths.clone, ".git/refs/tags"), { recursive: true });
  await writeFile(join(f.paths.clone, ".git/refs/tags/worker"), commit);
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ code: "nothing_to_collect", refs: [] });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected!.digest).toBe(before);
  const scripts = f.calls.filter((c) => c.command === "podman").flatMap((c) => c.args).filter((a) => a.includes("for-each-ref"));
  expect(scripts.every((script) => !script.includes("refs/tags"))).toBe(true);
});
it("refuses hostile refs separately, fetches only safe namespaced refs and deletes the bundle", async () => {
  const f = await fixture(); await provision(f);
  f.heads(`${commit} refs/heads/--upload-pack=x\n${commit} refs/heads/a..b\n${commit} refs/heads/feature\n`);
  const result = await collectWriter(f.ctx, "repo-w1");
  expect(result).toMatchObject({ status: "failed", code: "writer_collect_incomplete", refs: ["refs/remotes/writer-repo-w1/feature"], refused: 2, findings: [{ code: "ref_name_refused" }, { code: "ref_name_refused" }] });
  const fetches = f.calls.filter((c) => c.command === "git" && c.args.includes("fetch"));
  expect(fetches).toHaveLength(1);
  expect(fetches[0]!.args).toContain("--end-of-options");
  expect(fetches[0]!.args).toContain("+refs/heads/feature:refs/remotes/writer-repo-w1/feature");
  expect(JSON.stringify(fetches)).not.toMatch(/upload-pack|a\.\.b/);
  const container = f.calls.find((c) => c.args.some((arg) => arg.includes("/tmp/scratch")))!;
  expect(container.args).toContain(`${f.paths.clone}:${f.paths.clone}:ro`);
  expect(container.args).toContain(`${f.paths.bundles}:/bundles:rw`);
  expect(container.args.some((arg) => arg.includes('commit-tree "$tree" -p HEAD'))).toBe(true);
  await expect(lstat(join(f.paths.bundles, "collect.bundle"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
});
it("incomplete collect revokes an earlier digest and blocks reset/recreate unless discarded", async () => {
  const f = await fixture(); await provision(f);
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok" });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeDefined();
  f.heads(`${commit} refs/heads/a..b\n${commit} refs/heads/feature\n`);
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "failed", code: "writer_collect_incomplete", refused: 1 });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
  expect(await resetWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ code: "writer_uncollected" });
  expect(await recreateWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ code: "writer_uncollected" });
  expect(await resetWriter(f.ctx, "repo-w1", { discard: true })).toMatchObject({ code: "writer_reset", status: "ok" });
});
it("reports incomplete rather than nothing_to_collect when every ref is refused", async () => {
  const f = await fixture(); await provision(f); f.heads(`${commit} refs/heads/a..b\n`);
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "failed", code: "writer_collect_incomplete", refs: [], refused: 1 });
});
it.each(["persistent", "ephemeral"] as const)("finish stops after an incomplete collect (%s)", async (lifecycle) => {
  const f = await fixture(); await provision(f);
  await writeWriterState(f.ctx.home, "repo-w1", { ...(await readWriterState(f.ctx.home, "repo-w1"))!, lifecycle });
  f.heads(`${commit} refs/heads/a..b\n`);
  const start = f.calls.length;
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ status: "failed", code: "writer_collect_incomplete" });
  expect(f.calls.slice(start).some((c) => c.args.some((a) => a.includes("stash clear") || a.includes("clone --no-hardlinks")))).toBe(false);
});
it.each(["verify", "list-heads", "fetch"])("reports host collect %s failures as writer_collect_failed", async (step) => {
  const f = await fixture(); await provision(f);
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "ok" });
  const original = f.ctx.runner;
  f.ctx.runner = { async run(command, args, signal) {
    if (command === "git" && args.includes(step)) return { exitCode: 1, stdout: "", stderr: "private diagnostic" };
    return original.run(command, args, signal);
  } };
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "failed", code: "writer_collect_failed" });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
  await expect(lstat(join(f.paths.bundles, "collect.bundle"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("preserves a real WIP-named branch and treats the skipped WIP export as refused", async () => {
  const f = await fixture(); await provision(f); f.collision();
  f.heads(`${commit} refs/heads/main-wip\n`);
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ status: "failed", code: "writer_collect_incomplete", refs: ["refs/remotes/writer-repo-w1/main-wip"], refused: 1, findings: [{ code: "ref_name_refused" }] });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
  const script = f.calls.find((c) => c.args.some((a) => a.includes("/tmp/scratch")))!.args.find((a) => a.includes("/tmp/scratch"))!;
  expect(script).toContain('show-ref --verify --quiet "refs/heads/$branch-wip"');
  expect(script).toMatch(/if .*show-ref[^\n]+; then\n\s+printf[^\n]+ref_name_refused[^\n]*\n\s+else\n\s+.*update-ref/);
});
it("refuses uncollected work, allows discard, preserves acceptance and clears collected", async () => {
  const f = await fixture(); await provision(f);
  expect(await resetWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ code: "writer_uncollected" });
  expect(await resetWriter(f.ctx, "repo-w1", { discard: true })).toMatchObject({ code: "writer_reset", status: "ok" });
  expect(await readWriterState(f.ctx.home, "repo-w1")).toMatchObject({ acceptance: { fingerprint: "fingerprint" } });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
  expect(await readFile(join(f.paths.agent, "auth.json"), "utf8")).toBe("{}\n");
  expect(JSON.parse(await readFile(join(f.paths.config, "writer-guard.json"), "utf8"))).toMatchObject({ baseRef: "refs/heads/main", baseCommit: commit });
  const reset = f.calls.find((c) => c.args.some((a) => a.includes("stash clear")))!;
  expect(reset.args).toContain(`${f.paths.clone}:${f.paths.clone}:rw`);
  expect(reset.args.slice(-5)).toEqual(["refs/remotes/origin/main", "main", commit, "", ""]);
  expect(reset.args.some((a) => a.includes("clean -fd") && !a.includes("clean -fdx"))).toBe(true);
});
it("removes ignored files on reset only when clean is all", async () => {
  const f = await fixture(); await provision(f);
  const state = (await readWriterState(f.ctx.home, "repo-w1"))!;
  await writeWriterState(f.ctx.home, "repo-w1", { ...state, clean: "all" });
  expect(await resetWriter(f.ctx, "repo-w1", { discard: true })).toMatchObject({ code: "writer_reset", status: "ok" });
  const reset = f.calls.find((c) => c.args.some((a) => a.includes("stash clear")))!;
  expect(reset.args.some((a) => a.includes("clean -ffdx"))).toBe(true);
});
it.each([false, true])("reset checks collected digest (changed=%s)", async (changed) => {
  const f = await fixture(); await provision(f); await collectWriter(f.ctx, "repo-w1");
  if (changed) f.changed();
  expect(await resetWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ code: changed ? "writer_uncollected" : "writer_reset" });
  if (!changed) expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
});
it("recreates on failed reset verification and keeps acceptance", async () => {
  const f = await fixture(); await provision(f); f.badReset();
  expect(await resetWriter(f.ctx, "repo-w1", { discard: true })).toMatchObject({ code: "writer_recreated", status: "ok" });
  expect(await readWriterState(f.ctx.home, "repo-w1")).toMatchObject({ acceptance: { fingerprint: "fingerprint" } });
});
it("ephemeral finish recreates without a reset", async () => {
  const f = await fixture(); await provision(f);
  await writeWriterState(f.ctx.home, "repo-w1", { ...(await readWriterState(f.ctx.home, "repo-w1"))!, lifecycle: "ephemeral" });
  expect(await finishWriter(f.ctx, "repo-w1")).toMatchObject({ code: "writer_recreated", status: "ok" });
  expect(f.calls.some((c) => c.args.some((a) => a.includes("stash clear")))).toBe(false);
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
});
it("records a digest even with nothing to collect, without host bundle or fetch commands", async () => {
  const f = await fixture(); await provision(f); f.empty();
  const start = f.calls.length;
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ code: "nothing_to_collect", refs: [], refused: 0 });
  expect(f.calls.slice(start).some((c) => c.command === "git")).toBe(false);
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected?.digest).toMatch(/^sha256:/);
});
it("checks clone redirects before any collect runner call", async () => {
  const f = await fixture(); await provision(f);
  await writeFile(join(f.paths.clone, ".git/commondir"), "elsewhere");
  const start = f.calls.length;
  expect(await collectWriter(f.ctx, "repo-w1")).toMatchObject({ code: "clone_verification_failed", status: "failed", refs: [] });
  expect(f.calls).toHaveLength(start);
});
it("allows baseline reset without collect or discard", async () => {
  const f = await fixture();
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig });
  expect(await resetWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ code: "writer_reset", status: "ok" });
});
it("recreation replaces agent contents while retaining wrapper and acceptance", async () => {
  const f = await fixture(); await provision(f); await collectWriter(f.ctx, "repo-w1");
  await writeFile(f.paths.wrapper, "wrapper");
  await writeFile(join(f.paths.agent, "stale"), "stale");
  expect(await recreateWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ code: "writer_recreated", status: "ok" });
  expect(await readFile(f.paths.wrapper, "utf8")).toBe("wrapper");
  await expect(lstat(join(f.paths.agent, "stale"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.acceptance?.fingerprint).toBe("fingerprint");
  expect((await readWriterState(f.ctx.home, "repo-w1"))!.collected).toBeUndefined();
});
it("recreate refuses uncollected work", async () => {
  const f = await fixture(); await provision(f);
  expect(await recreateWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ code: "writer_uncollected" });
});
it("recovers a non-empty root without state", async () => {
  const f = await fixture();
  await mkdir(f.paths.root, { recursive: true }); await writeFile(join(f.paths.root, "stale"), "stale");
  expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig })).toMatchObject({ status: "ok" });
  await expect(lstat(join(f.paths.root, "stale"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["HEAD", "refs/tags/v1", "v1", commit, "refs/heads/--bad"])("rejects non-branch base %s before mutation", async (baseRef) => {
  const f = await fixture();
  // v1 and a raw SHA resolve as non-head refs.
  const original = f.ctx.runner;
  f.ctx.runner = { async run(command, args, signal) {
    if (args.includes("--symbolic-full-name") && (baseRef === "v1" || baseRef === commit)) return { exitCode: 0, stdout: baseRef === "v1" ? "refs/tags/v1" : "", stderr: "" };
    return original.run(command, args, signal);
  } };
  expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig, baseRef })).toMatchObject({ code: "base_ref_invalid", status: "failed" });
  expect(f.calls.some((c) => c.command === "podman")).toBe(false);
  await expect(lstat(f.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
  await provision(f); const before = f.calls.length;
  expect(await resetWriter(f.ctx, "repo-w1", { discard: true, baseRef })).toMatchObject({ code: "base_ref_invalid" });
  expect(f.calls.slice(before).some((c) => c.command === "podman")).toBe(false);
});
it("refreshes the original remote source on reset and recreate without requiring a host local head", async () => {
  const f = await fixture();
  expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig, baseRef: "refs/remotes/upstream/topic" })).toMatchObject({ status: "ok" });
  const original = f.ctx.runner;
  f.ctx.runner = { async run(command, args, signal) {
    if (command === "git" && args.includes("rev-parse") && args.at(-1) === "refs/heads/topic^{commit}") return { exitCode: 1, stdout: "", stderr: "" };
    return original.run(command, args, signal);
  } };
  expect(await resetWriter(f.ctx, "repo-w1", { discard: true })).toMatchObject({ code: "writer_reset" });
  expect(await recreateWriter(f.ctx, "repo-w1", { discard: true })).toMatchObject({ code: "writer_recreated" });
});
it.each(["main", "refs/heads/main", "refs/remotes/origin/main"])("accepts branch base %s", async (baseRef) => {
  const f = await fixture();
  expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig, baseRef })).toMatchObject({ status: "ok" });
  expect(await resetWriter(f.ctx, "repo-w1", { discard: true, baseRef })).toMatchObject({ code: "writer_reset" });
});
