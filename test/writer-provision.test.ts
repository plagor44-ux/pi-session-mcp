import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/client-adapters/types.js";
import { loadConfig } from "../src/config.js";
import { ensureWriterEventsDirectory } from "../src/writer-boundary.js";
import { containedBuiltinSkills, containedProfileRefused, inspectWork, provisionWriter, recreateWriter, removeWriter, renderContainedConfig, resetWriter, writerSettingsDrift, type WriterContext } from "../src/writer-lifecycle.js";
import { readWriterState, writerEventDeliveryEnabled, writerPaths, writeWriterState } from "../src/writer-state.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const commit = "b".repeat(40), tree = "c".repeat(40), imageId = "a".repeat(64);
const profile = { default: false, permissionProfile: "coding", provider: "example", model: "model", thinkingLevel: "high" };
const rawConfig = { workspaces: { repo: "/host" }, executionProfiles: { code: profile, other: { ...profile, model: "second" } } };
const settings = { writers: 1, lifecycle: "persistent", profiles: ["code", "other"], image: "node", network: "none", cache: "none" } as const;
async function fixture(remote = "git@github.com:o/r.git") {
  const home = await temporaryRoot("pi-writer-provision-");
  const paths = writerPaths(home, "repo-w1");
  const calls: { command: string; args: readonly string[]; signal: AbortSignal | undefined }[] = [];
  const phases: string[] = [];
  let dirty = false, unavailable = false, workOutput: string | undefined;
  const runner: CommandRunner = { async run(command, args, signal) {
    calls.push({ command, args, signal });
    let stdout = "";
    if (command === "git") {
      expect(args.slice(0, 4)).toEqual(["-c", "core.hooksPath=/dev/null", "-C", join(home, "source")]);
      if (args.includes("symbolic-ref")) stdout = "refs/remotes/origin/main\n";
      if (args.includes("rev-parse")) stdout = `${commit}\n`;
      if (args.includes("get-url")) stdout = remote;
      if (args.includes("bundle")) await writeFile(join(paths.bundles, "base.bundle"), "bundle", { mode: 0o600 });
    } else if (args[0] === "info") stdout = "true";
    else if (args[0] === "version") stdout = "5.4.0";
    else if (args[0] === "image") {
      if (unavailable) return { exitCode: 1, stdout: "", stderr: "" };
      stdout = imageId;
    } else if (args[0] === "run") {
      if (args.some((arg) => arg.includes("clone --no-hardlinks"))) {
        phases.push((await readWriterState(home, "repo-w1"))!.phase);
        await mkdir(join(paths.clone, ".git/hooks"), { recursive: true });
        await writeFile(join(paths.clone, ".git/config"), "");
      } else stdout = workOutput ?? `${commit}\nrefs/heads/main ${commit}\n${dirty ? "d".repeat(40) : tree}\n${tree}\n${tree}\n`;
    }
    return { exitCode: 0, stdout, stderr: "" };
  } };
  const ctx: WriterContext = { home, releaseRoot: "/release", nodePath: process.execPath, runner, checkout: join(home, "source"), alias: "repo" };
  return { ctx, paths, calls, phases, dirty: () => { dirty = true; }, unavailable: () => { unavailable = true; }, work: (output: string) => { workOutput = output; } };
}
it("provisions privately from the checkout bundle with ordered state and provider deduplication", async () => {
  const f = await fixture();
  expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig })).toEqual({ code: "writer_provisioned", status: "ok" });
  expect(f.phases).toEqual(["provisioning"]);
  const state = (await readWriterState(f.ctx.home, "repo-w1"))!;
  expect(state.phase).toBe("not_ready");
  expect(state.base).toEqual({ ref: "refs/heads/main", commit });
  const cloneCall = f.calls.find((call) => call.args.some((arg) => arg.includes("clone --no-hardlinks")))!;
  expect(cloneCall.args.slice(-5)).toEqual([f.paths.clone, "main", commit, "git@github.com:o/r.git", "refs/remotes/origin/main"]);
  expect(cloneCall.args.some((arg) => arg.includes('fetch --no-tags /bundles/base.bundle "$5"'))).toBe(true);
  expect(state.providers).toEqual([{ provider: "example", model: "model" }]);
  expect(JSON.parse(await readFile(join(f.paths.config, "writer-guard.json"), "utf8"))).toMatchObject({ baseCommit: commit });
  for (const path of [f.paths.root, f.paths.config, f.paths.agent, f.paths.clone, f.paths.bundles]) expect((await lstat(path)).mode & 0o777).toBe(0o700);
  for (const path of [f.paths.state, join(f.paths.agent, "auth.json"), ...["pi-session-mcp.json", "execution-modes.json", "writer-guard.json"].map((name) => join(f.paths.config, name)), join(f.paths.bundles, "base.bundle")]) expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect((await lstat(f.paths.wrapper)).mode & 0o777).toBe(0o700);
  expect(await readFile(f.paths.wrapper, "utf8")).toContain("dist/writer-launch.js");
  expect(f.calls.filter((call) => call.command === "podman" && call.args[0] === "run").every((call) => call.signal !== undefined)).toBe(true);
  expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig })).toEqual({ code: "writer_unchanged", status: "unchanged" });
});
it("refuses URL userinfo before writing, but allows scp syntax", async () => {
  const f = await fixture("https://user:tok@host/x.git");
  expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig })).toMatchObject({ code: "remote_url_refused", status: "failed" });
  await expect(lstat(f.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects unsupported raw profiles, missing profiles and non-builtin catalog skills", () => {
  for (const extra of [{ extensions: [] }, { mcpServers: {} }, { skills: ["local"] }, { skills: ["missing"] }]) {
    expect(() => renderContainedConfig("repo", "/clone", { executionProfiles: { code: { ...profile, ...extra } }, skillCatalog: { local: "./x/SKILL.md" } }, ["code"])).toThrow("container_profile_unsupported");
  }
  for (const raw of [null, {}, { executionProfiles: {} }]) expect(() => renderContainedConfig("repo", "/clone", raw, ["missing"])).toThrow("container_profile_unsupported");
});
it("shares profile acceptance between the predicate and contained rendering", () => {
  for (const [selected, refused] of [[profile, false], [{ ...profile, extensions: [] }, true]] as const) {
    const raw = { executionProfiles: { code: selected } };
    const before = JSON.stringify(raw);
    const availableBuiltinSkills = containedBuiltinSkills(raw);
    expect(containedProfileRefused(raw, "code", availableBuiltinSkills)).toBe(refused);
    if (refused) expect(() => renderContainedConfig("repo", "/clone", raw, ["code"])).toThrow("container_profile_unsupported");
    else expect(renderContainedConfig("repo", "/clone", raw, ["code"]).executionProfiles.code).toEqual(selected);
    expect(JSON.stringify(raw)).toBe(before);
  }
});
it("refuses a builtin skill no writer can resolve, while a shipped one stays accepted (#135)", () => {
  const unknown = { executionProfiles: { code: { ...profile, skills: ["lib"] } }, skillCatalog: { lib: "builtin:no-such-shipped-skill" } };
  expect(() => renderContainedConfig("repo", "/clone", unknown, ["code"])).toThrow("container_profile_unsupported");
  const shipped = { ...unknown, skillCatalog: { lib: "builtin:pi-session-implementation" } };
  expect(() => renderContainedConfig("repo", "/clone", shipped, ["code"])).not.toThrow();
});
it("refuses a builtin skill the operator overrides, because no override reaches the writer (#135)", async () => {
  const overrides = await temporaryRoot("pi-writer-overrides-");
  const override = async (name: string) => {
    await mkdir(join(overrides, name), { recursive: true });
    await writeFile(join(overrides, name, "SKILL.md"), `---\nname: ${name}\ndescription: Operator copy.\n---\n`);
  };
  const raw = { executionProfiles: { code: { ...profile, skills: ["impl"] } }, skillCatalog: { impl: "builtin:pi-session-implementation", review: "builtin:pi-session-review" } };
  // An override of a skill that no selected coding profile chooses changes nothing.
  await override("pi-session-review");
  expect(renderContainedConfig("repo", "/clone", raw, ["code"], overrides).skillCatalog).toEqual({ impl: "builtin:pi-session-implementation" });
  await override("pi-session-implementation");
  expect(() => renderContainedConfig("repo", "/clone", raw, ["code"], overrides)).toThrow("container_profile_unsupported");
});
it("renders verbatim selected raw profiles and a loadable synthetic read-only default", async () => {
  const selected = { ...profile, skills: ["impl"] };
  const raw = { ...rawConfig, executionProfiles: { code: selected, unused: { ...profile, extensions: [] } }, skillCatalog: { impl: "builtin:pi-session-implementation", unused: "./x/SKILL.md" } };
  const before = JSON.stringify(raw);
  const config = renderContainedConfig("repo", "/clone", raw, ["code"]);
  expect(config.workspaces).toEqual({ repo: "/clone" });
  expect(config.skillCatalog).toEqual({ impl: "builtin:pi-session-implementation" });
  expect(config.executionProfiles).toEqual({ code: selected, "boundary-read-only": { default: true, permissionProfile: "read-only", provider: "example", model: "model", thinkingLevel: "high" } });
  expect(JSON.stringify(raw)).toBe(before);
  const directory = await temporaryRoot("pi-contained-config-");
  const path = join(directory, "pi-session-mcp.json");
  await writeFile(path, JSON.stringify(config));
  await writeFile(join(directory, "execution-modes.json"), JSON.stringify({ schemaVersion: 1, workspaces: { repo: { mode: "host", acceptHostWrites: true } } }));
  const loaded = await loadConfig(path);
  expect(loaded.defaultExecutionProfile).toBe("boundary-read-only");
  expect(loaded.executionProfiles.get("code")).toMatchObject({ default: false, permissionProfile: "coding", skills: [{ alias: "impl" }] });
  expect(loaded.executionProfiles.get("boundary-read-only")?.skills).toBeUndefined();
  expect([...loaded.workspaces]).toEqual([["repo", "/clone"]]);
  expect(loaded.workspaceModes.get("repo")?.mode).toBe("host");
});
it("recreates interrupted and invalid state without preserving stale files", async () => {
  const f = await fixture();
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig });
  await writeWriterState(f.ctx.home, "repo-w1", { ...(await readWriterState(f.ctx.home, "repo-w1"))!, phase: "provisioning" });
  await writeFile(join(f.paths.root, "stale"), "stale");
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig });
  await expect(lstat(join(f.paths.root, "stale"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(f.paths.state, "invalid");
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig });
  expect(f.phases).toEqual(["provisioning", "provisioning", "provisioning"]);
});
it("never deletes an unreadable writer", async () => {
  const f = await fixture();
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig });
  await writeFile(join(f.paths.root, "keep"), "keep");
  const mock = vi.spyOn(fsPromises, "open").mockRejectedValueOnce(Object.assign(new Error("private"), { code: "EACCES" }));
  syncBuiltinESMExports();
  try { expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig })).toEqual({ code: "writer_state_unreadable", status: "failed" }); } finally { mock.mockRestore(); syncBuiltinESMExports(); }
  expect(await readFile(join(f.paths.root, "keep"), "utf8")).toBe("keep");
  expect(f.phases).toEqual(["provisioning"]);
});
it("a missing local image writes nothing", async () => {
  const f = await fixture(); f.unavailable();
  expect(await provisionWriter(f.ctx, { index: 1, settings: { ...settings, image: imageId }, rawConfig })).toMatchObject({ code: "image_unavailable", status: "failed" });
  await expect(lstat(f.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([
  ["extra branch", `${commit}\nrefs/heads/main ${commit}\nrefs/heads/feature ${commit}\n${tree}\n${tree}\n${tree}\n`],
  ["stash", `${commit}\nrefs/heads/main ${commit}\nrefs/stash ${commit}\n${tree}\n${tree}\n${tree}\n`],
  ["moved HEAD", `${"e".repeat(40)}\nrefs/heads/main ${"e".repeat(40)}\n${tree}\n${tree}\n${tree}\n`],
])("does not treat %s as baseline", async (_label, output) => {
  const f = await fixture(); await provisionWriter(f.ctx, { index: 1, settings, rawConfig });
  f.work(output);
  expect(await inspectWork(f.ctx, "repo-w1")).toMatchObject({ baseline: false, dirty: false });
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ code: "writer_uncollected" });
  expect(await removeWriter(f.ctx, "repo-w1", { discard: true })).toMatchObject({ code: "writer_removed" });
});
it("inspects work and refuses removal unless baseline, collected or discarded", async () => {
  const f = await fixture(); await provisionWriter(f.ctx, { index: 1, settings, rawConfig });
  expect(await inspectWork(f.ctx, "repo-w1")).toMatchObject({ baseline: true, dirty: false, branches: [{ name: "refs/heads/main", commit }] });
  f.dirty();
  expect(await inspectWork(f.ctx, "repo-w1")).toMatchObject({ baseline: false, dirty: true });
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ code: "writer_uncollected", status: "failed" });
  const work = await inspectWork(f.ctx, "repo-w1");
  await writeWriterState(f.ctx.home, "repo-w1", { ...(await readWriterState(f.ctx.home, "repo-w1"))!, collected: { digest: work.digest, at: new Date().toISOString() } });
  expect(await removeWriter(f.ctx, "repo-w1", { discard: false })).toMatchObject({ status: "ok" });
  await expect(lstat(f.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
});

it("propagates the event delivery field into the contained configuration and lets the loader accept it", async () => {
  expect(renderContainedConfig("repo", "/clone", rawConfig, ["code"])).not.toHaveProperty("events");
  const config = renderContainedConfig("repo", "/clone", { ...rawConfig, events: { delivery: "spool" } }, ["code"]);
  expect(config.events).toEqual({ delivery: "spool" });
  for (const events of [{ delivery: "on" }, { delivery: "spool", extra: 1 }, "spool", null]) {
    expect(() => renderContainedConfig("repo", "/clone", { ...rawConfig, events }, ["code"])).toThrow("container_profile_unsupported");
  }
  // An explicit "off" is carried over and does not enable the boundary mount.
  expect(renderContainedConfig("repo", "/clone", { ...rawConfig, events: { delivery: "off" } }, ["code"]).events).toEqual({ delivery: "off" });
  const f = await fixture();
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig: { ...rawConfig, events: { delivery: "spool" } } });
  expect(JSON.parse(await readFile(join(f.paths.config, "pi-session-mcp.json"), "utf8"))).toMatchObject({ events: { delivery: "spool" } });
  expect(await writerEventDeliveryEnabled(f.paths.config)).toBe(true);
  const plain = await fixture();
  await provisionWriter(plain.ctx, { index: 1, settings, rawConfig });
  expect(await writerEventDeliveryEnabled(plain.paths.config)).toBe(false);
});
it("reports a delivery change on a provisioned writer as a settings change", async () => {
  const f = await fixture(), withEvents = { ...rawConfig, events: { delivery: "spool" } };
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig });
  expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig: withEvents })).toEqual({ code: "writer_settings_changed", status: "failed" });
  const g = await fixture();
  await provisionWriter(g.ctx, { index: 1, settings, rawConfig: withEvents });
  expect(await provisionWriter(g.ctx, { index: 1, settings, rawConfig: withEvents })).toEqual({ code: "writer_unchanged", status: "unchanged" });
  expect(await provisionWriter(g.ctx, { index: 1, settings, rawConfig })).toEqual({ code: "writer_settings_changed", status: "failed" });
});
it("checks a provisioned writer against the settings and configuration it would be provisioned from now (#134)", async () => {
  const f = await fixture();
  expect(await writerSettingsDrift(f.ctx, { index: 1, settings, rawConfig })).toBeUndefined();
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig });
  expect(await writerSettingsDrift(f.ctx, { index: 1, settings, rawConfig })).toBeUndefined();
  const reordered = { ...rawConfig, executionProfiles: { other: { ...profile, model: "second" }, code: Object.fromEntries(Object.entries(profile).reverse()) } };
  expect(await writerSettingsDrift(f.ctx, { index: 1, settings, rawConfig: reordered })).toBeUndefined();
  // The second profile shares its provider with the first, so only the rendered configuration shows this change.
  const changed = { ...rawConfig, executionProfiles: { ...rawConfig.executionProfiles, other: { ...profile, model: "second", thinkingLevel: "low" } } };
  expect(await writerSettingsDrift(f.ctx, { index: 1, settings, rawConfig: changed })).toEqual({ code: "writer_settings_changed", status: "failed" });
  expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig: changed })).toEqual({ code: "writer_settings_changed", status: "failed" });
  expect(await writerSettingsDrift(f.ctx, { index: 1, settings: { ...settings, cache: "go" }, rawConfig })).toEqual({ code: "writer_settings_changed", status: "failed" });
  f.unavailable(); f.calls.length = 0;
  expect(await writerSettingsDrift(f.ctx, { index: 1, settings, rawConfig })).toEqual({ code: "image_unavailable", status: "failed" });
  expect(f.calls.some((call) => call.args[0] === "pull")).toBe(false);
  const down: CommandRunner = { run: async () => ({ exitCode: 125, stdout: "", stderr: "" }) };
  expect(await writerSettingsDrift({ ...f.ctx, runner: down }, { index: 1, settings, rawConfig })).toEqual({ code: "podman_unavailable", status: "failed" });
});
it("never matches a writer whose stored configuration is missing or a link (#134)", async () => {
  const f = await fixture(), stored = join(f.paths.config, "pi-session-mcp.json");
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig });
  const copy = join(f.paths.root, "copy.json");
  await writeFile(copy, await readFile(stored, "utf8"));
  await fsPromises.rm(stored);
  expect(await writerSettingsDrift(f.ctx, { index: 1, settings, rawConfig })).toEqual({ code: "writer_settings_changed", status: "failed" });
  await symlink(copy, stored);
  expect(await writerSettingsDrift(f.ctx, { index: 1, settings, rawConfig })).toEqual({ code: "writer_settings_changed", status: "failed" });
});
it("removes the writer's spool directory together with its state directory and nothing else", async () => {
  const f = await fixture(), other = writerPaths(f.ctx.home, "repo-w2");
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig });
  await mkdir(join(f.paths.events, "inst-0123456789abcdef"), { recursive: true });
  await writeFile(join(f.paths.events, "inst-0123456789abcdef", "00000001-turn_terminal.json"), "{}");
  await mkdir(join(other.events), { recursive: true }); await writeFile(join(other.events, "keep"), "keep");
  expect(await removeWriter(f.ctx, "repo-w1", { discard: true })).toEqual({ code: "writer_removed", status: "ok" });
  await expect(lstat(f.paths.events)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(f.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(other.events, "keep"), "utf8")).toBe("keep");
});
it("never follows a symlinked spool directory when removing", async () => {
  const f = await fixture(), outside = await temporaryRoot("pi-writer-outside-");
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig });
  await writeFile(join(outside, "keep"), "keep");
  await symlink(outside, f.paths.events);
  expect(await removeWriter(f.ctx, "repo-w1", { discard: true })).toMatchObject({ code: "writer_removed" });
  expect(await readFile(join(outside, "keep"), "utf8")).toBe("keep");
});

const withSpool = { ...rawConfig, events: { delivery: "spool" } };
const rootNames = async (root: string) => (await readdir(root)).sort();
it("creates the private spool directory at provisioning when delivery is on, so launch does not change the writer root", async () => {
  const f = await fixture();
  expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig: withSpool })).toEqual({ code: "writer_provisioned", status: "ok" });
  const stat = await lstat(f.paths.events);
  expect(stat.isDirectory()).toBe(true);
  expect(stat.mode & 0o777).toBe(0o700);
  expect(stat.uid).toBe(process.getuid!());
  const before = await rootNames(f.paths.root);
  expect(before).toContain("events");
  // The launch-time step needs /proc/self/fd; writers are Linux-only.
  if (process.platform !== "linux") return;
  // The launch-time step (acceptance harness digests the writer root around it) finds the directory and adds no name.
  expect(await ensureWriterEventsDirectory(f.ctx.home, "repo-w1", process.getuid!())).toBe(f.paths.events);
  expect(await rootNames(f.paths.root)).toEqual(before);
  expect((await lstat(f.paths.events)).mode & 0o777).toBe(0o700);
});
it("does not create the spool directory when delivery is off or disabled, matching the absent boundary mount", async () => {
  for (const raw of [rawConfig, { ...rawConfig, events: { delivery: "off" } }]) {
    const f = await fixture();
    await provisionWriter(f.ctx, { index: 1, settings, rawConfig: raw });
    await expect(lstat(f.paths.events)).rejects.toMatchObject({ code: "ENOENT" });
  }
});
it("recreates the spool directory when an interrupted provisioning restarts", async () => {
  const f = await fixture();
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig: withSpool });
  await writeWriterState(f.ctx.home, "repo-w1", { ...(await readWriterState(f.ctx.home, "repo-w1"))!, phase: "provisioning" });
  await writeFile(join(f.paths.events, "stale"), "stale");
  expect(await provisionWriter(f.ctx, { index: 1, settings, rawConfig: withSpool })).toMatchObject({ code: "writer_provisioned" });
  expect(await readdir(f.paths.events)).toEqual([]);
  expect((await lstat(f.paths.events)).mode & 0o777).toBe(0o700);
});
it("keeps the spool directory stable across reset and recreate", async () => {
  const f = await fixture();
  await provisionWriter(f.ctx, { index: 1, settings, rawConfig: withSpool });
  const before = await rootNames(f.paths.root), inode = (await lstat(f.paths.events)).ino;
  expect(await resetWriter(f.ctx, "repo-w1", { discard: true })).toMatchObject({ code: "writer_reset" });
  expect(await rootNames(f.paths.root)).toEqual(before);
  expect(await recreateWriter(f.ctx, "repo-w1", { discard: true })).toMatchObject({ code: "writer_recreated" });
  expect(await rootNames(f.paths.root)).toEqual(before);
  expect((await lstat(f.paths.events)).ino).toBe(inode);
});
