import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, utimes, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "../src/client-adapters/types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "../src/client-adapters/command.js";
import { BOUNDARY_GIT, BoundaryError, EVENTS_CLEANUP_MAX_ENTRIES, EventsDirectoryError, IMAGE_PULL_TIMEOUT_MS, NODE_IMAGE_REF, ensureWriterEventsDirectory, isSafeRefName, podmanInfo, resolveImage, serveArgs, throwawayArgs, verifyCloneLayout } from "../src/writer-boundary.js";
import { writerPaths, type WriterState } from "../src/writer-state.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const paths = writerPaths("/home/example", "repo-w1");
const imageId = "a".repeat(64);
const state: WriterState = {
  schemaVersion: 1, alias: "repo", index: 1, phase: "ready", lifecycle: "persistent",
  profiles: ["code"], providers: [], network: "pasta", cache: "none", imageId,
  base: { ref: "refs/heads/main", commit: "b".repeat(40) },
};
const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const failed: CommandResult = { exitCode: 1, stdout: "", stderr: "SECRET_SENTINEL" };
function runner(...results: CommandResult[]) {
  return { run: vi.fn<CommandRunner["run"]>().mockImplementation(async () => results.shift() ?? failed) };
}

it("builds the restricted serving boundary with explicit environment and Git protection", () => {
  const args = serveArgs(paths, state, ["node", "/opt/pi-session-mcp/dist/main.js"], "/release");
  for (const value of ["--pull=never", "--read-only", "--cap-drop=all", "--userns=keep-id", "--security-opt=no-new-privileges", "--network=pasta",
    `${paths.clone}:${paths.clone}:rw`, `${paths.clone}/.git/hooks:${paths.clone}/.git/hooks:ro`, `${paths.clone}/.git/config:${paths.clone}/.git/config:ro`,
    "/release:/opt/pi-session-mcp:ro", `${paths.config}:/pi/config:ro`, `${paths.agent}:/pi/agent:rw`,
    "/tmp:rw,nosuid,nodev,size=512m", "/pi/home:rw,nosuid,nodev,mode=0700,size=64m,U",
    "HOME=/pi/home", "PI_SESSION_MCP_CONFIG=/pi/config/pi-session-mcp.json", "PI_CODING_AGENT_DIR=/pi/agent", "PI_SESSION_MCP_WRITER_GUARD=/pi/config/writer-guard.json"]) expect(args).toContain(value);
  expect(args).not.toContain("--env-host");
  expect(args).not.toContain("--privileged");
  args.forEach((arg, index) => { if (arg === "-e") expect(args[index + 1]).toContain("="); });
  expect(args.slice(-3)).toEqual([imageId, "node", "/opt/pi-session-mcp/dist/main.js"]);
  expect(args).not.toContain(`${paths.go}:/pi/go:rw`);
  const go = serveArgs(paths, { ...state, cache: "go", network: "none" }, [], "/release");
  for (const value of [`${paths.go}:/pi/go:rw`, "GOPATH=/pi/go", "GOCACHE=/pi/go/cache", "GOTOOLCHAIN=local", "--network=none"]) expect(go).toContain(value);
});

const baseArgs = (): string[] => [
  "run", "-i", "--rm", "--pull=never", "--userns=keep-id", "--read-only",
  "--cap-drop=all", "--security-opt=no-new-privileges", "--network=pasta",
  "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
  "--tmpfs", "/pi/home:rw,nosuid,nodev,mode=0700,size=64m,U",
  "-v", `${paths.clone}:${paths.clone}:rw`,
  "-v", `${paths.clone}/.git/hooks:${paths.clone}/.git/hooks:ro`,
  "-v", `${paths.clone}/.git/config:${paths.clone}/.git/config:ro`,
  "-v", "/release:/opt/pi-session-mcp:ro",
  "-v", `${paths.config}:/pi/config:ro`,
  "-v", `${paths.agent}:/pi/agent:rw`,
  "--workdir", paths.clone,
  "-e", "HOME=/pi/home",
  "-e", "PI_SESSION_MCP_CONFIG=/pi/config/pi-session-mcp.json",
  "-e", "PI_CODING_AGENT_DIR=/pi/agent",
  "-e", "PI_SESSION_MCP_WRITER_GUARD=/pi/config/writer-guard.json",
];
const serve = ["node", "/opt/pi-session-mcp/dist/main.js"];

it("keeps the serving arguments exactly as they were without event delivery", () => {
  expect(serveArgs(paths, state, serve, "/release")).toEqual([...baseArgs(), imageId, ...serve]);
  expect(serveArgs(paths, state, serve, "/release", undefined)).toEqual(serveArgs(paths, state, serve, "/release"));
});

it("adds exactly one dedicated spool mount and its environment variable when delivery is enabled", () => {
  const dir = "/run/user/1000/pi-session-mcp/events/writer-repo-w1";
  const args = serveArgs(paths, state, serve, "/release", dir);
  const without = serveArgs(paths, state, serve, "/release");
  expect(args).toEqual([...baseArgs(), "-v", `${dir}:/pi/events:rw`, "-e", "PI_SESSION_MCP_EVENTS_DIR=/pi/events", imageId, ...serve]);
  // Nothing else moves: removing the two additions restores the original arguments.
  const at = args.indexOf(`${dir}:/pi/events:rw`);
  expect([...args.slice(0, at - 1), ...args.slice(at + 3)]).toEqual(without);
  expect(args.filter((arg) => arg.includes(":/pi/events"))).toHaveLength(1);
  const go = serveArgs(paths, { ...state, cache: "go" }, serve, "/release", dir);
  expect(go).toEqual([...baseArgs(), "-v", `${dir}:/pi/events:rw`, "-e", "PI_SESSION_MCP_EVENTS_DIR=/pi/events",
    "-v", `${paths.go}:/pi/go:rw`, "-e", "GOPATH=/pi/go", "-e", "GOCACHE=/pi/go/cache", "-e", "GOTOOLCHAIN=local", imageId, ...serve]);
});

const uid = process.getuid!();
/** A fake home whose writer state directory exists (as setup creates it); `own` is the writer's spool directory. */
async function fixture(mode = 0o700) {
  const home = await temporaryRoot("pi-writer-home-");
  const writer = writerPaths(home, "repo-w1");
  await mkdir(writer.root, { recursive: true });
  await chmod(writer.root, mode);
  return { home, writer, own: writer.events };
}
const ensure = ensureWriterEventsDirectory;

it("creates the private spool directory inside the writer state directory and accepts it again", async () => {
  const { home, writer, own } = await fixture();
  expect(own).toBe(join(writer.root, "events"));
  expect(await ensure(home, "repo-w1", uid)).toBe(own);
  expect((await lstat(own)).mode & 0o777).toBe(0o700);
  expect(await ensure(home, "repo-w1", uid)).toBe(own);
  expect(await readdir(writer.root)).toEqual(["events"]);
});
it("does not need a runtime directory", async () => {
  const saved = process.env.XDG_RUNTIME_DIR;
  delete process.env.XDG_RUNTIME_DIR;
  try { const { home, own } = await fixture(); expect(await ensure(home, "repo-w1", uid)).toBe(own); }
  finally { if (saved !== undefined) process.env.XDG_RUNTIME_DIR = saved; }
});
it("refuses a malformed writer name", async () => {
  const { home } = await fixture();
  const failure = await ensure(home, "../x", uid).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EventsDirectoryError);
  expect(failure).toMatchObject({ code: "events_directory_unavailable", message: "events_directory_unavailable" });
});
it("refuses a missing writer state directory without creating it", async () => {
  const home = await temporaryRoot("pi-writer-home-");
  await expect(ensure(home, "repo-w1", uid)).rejects.toBeInstanceOf(EventsDirectoryError);
  await expect(lstat(writerPaths(home, "repo-w1").root)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses a writer state directory owned by someone else", async () => {
  const { home, own } = await fixture();
  await expect(ensure(home, "repo-w1", uid + 1)).rejects.toBeInstanceOf(EventsDirectoryError);
  await expect(lstat(own)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([0o750, 0o705, 0o770])("refuses a writer state directory with mode %o", async (mode) => {
  const { home } = await fixture(mode);
  await expect(ensure(home, "repo-w1", uid)).rejects.toBeInstanceOf(EventsDirectoryError);
});
it("refuses a writer state directory that is a symlink, and a symlinked spool directory, without following them", async () => {
  const home = await temporaryRoot("pi-writer-home-"), outside = await temporaryRoot("pi-writer-outside-");
  await chmod(outside, 0o700);
  const writer = writerPaths(home, "repo-w1");
  await mkdir(dirname(writer.root), { recursive: true });
  await symlink(outside, writer.root);
  await expect(ensure(home, "repo-w1", uid)).rejects.toBeInstanceOf(EventsDirectoryError);
  expect(await readdir(outside)).toEqual([]);
  const other = await fixture();
  await symlink(outside, other.own);
  await expect(ensure(other.home, "repo-w1", uid)).rejects.toBeInstanceOf(EventsDirectoryError);
  expect(await readdir(outside)).toEqual([]);
});
it.each([0o777, 0o770, 0o000, 0o500])("resets a spool directory the worker changed to mode %o instead of refusing", async (mode) => {
  const { home, own } = await fixture();
  await mkdir(own, { mode: 0o700 });
  await chmod(own, mode);
  expect(await ensure(home, "repo-w1", uid)).toBe(own);
  expect((await lstat(own)).mode & 0o777).toBe(0o700);
});
const HOUR = 3_600_000;
const INSTANCE = "inst-0123456789abcdef", OTHER_INSTANCE = "inst-fedcba9876543210";
async function age(path: string, hours: number): Promise<void> {
  const when = new Date(Date.now() - hours * HOUR);
  await utimes(path, when, when);
}
it("removes everything in the writer's own directory that is not an instance directory, without following links", async () => {
  const { home, own } = await fixture(), outside = await temporaryRoot("pi-writer-outside-");
  await chmod(outside, 0o700); await writeFile(join(outside, "keep"), "keep");
  const sibling = join(writerPaths(home, "repo-w1").root, "events-sibling");
  await mkdir(own, { mode: 0o700 }); await mkdir(join(own, "junk", "deep"), { recursive: true, mode: 0o700 });
  await writeFile(join(own, "stray"), "x"); await writeFile(join(own, "00000001-turn_terminal.json"), "{}");
  await mkdir(join(own, "inst-short")); await mkdir(join(own, "INST-0123456789abcdef")); await mkdir(join(own, "inst-0123456789abcdeg"));
  await symlink(outside, join(own, "link-dir")); await symlink(join(outside, "keep"), join(own, "link-file"));
  // A link named like an instance directory is junk too and is not followed.
  await symlink(outside, join(own, OTHER_INSTANCE));
  await symlink(outside, join(own, "junk", "deep", "link-dir"));
  await mkdir(join(own, "locked", "inner"), { recursive: true }); await writeFile(join(own, "locked", "inner", "f"), "x");
  await chmod(join(own, "locked", "inner"), 0o000); await chmod(join(own, "locked"), 0o000);
  await mkdir(sibling, { mode: 0o700 }); await writeFile(join(sibling, "keep"), "keep");
  expect(await ensureWriterEventsDirectory(home, "repo-w1", uid)).toBe(own);
  expect(await readdir(own)).toEqual([]);
  expect(await readdir(outside)).toEqual(["keep"]);
  expect(await readFile(join(outside, "keep"), "utf8")).toBe("keep");
  expect(await readdir(sibling)).toEqual(["keep"]);
});
it("keeps an instance directory with fresh files, since its server may be live", async () => {
  const { home, own } = await fixture();
  await mkdir(own, { mode: 0o700 }); await mkdir(join(own, INSTANCE), { mode: 0o700 });
  await mkdir(join(own, OTHER_INSTANCE), { mode: 0o700 });
  for (const name of ["00000001-turn_terminal.json", "00000002-instance_ended.json", ".tmp-3-abcd1234"]) await writeFile(join(own, INSTANCE, name), "{}");
  // An old but empty-looking instance directory that still holds a fresh file must stay, and so must its file.
  await writeFile(join(own, OTHER_INSTANCE, "00000001-turn_terminal.json"), "{}");
  await age(join(own, OTHER_INSTANCE), 48);
  await chmod(join(own, INSTANCE), 0o000);
  await ensureWriterEventsDirectory(home, "repo-w1", uid);
  expect((await readdir(own)).sort()).toEqual([INSTANCE, OTHER_INSTANCE].sort());
  expect((await readdir(join(own, INSTANCE))).sort()).toEqual([".tmp-3-abcd1234", "00000001-turn_terminal.json", "00000002-instance_ended.json"]);
  expect(await readdir(join(own, OTHER_INSTANCE))).toEqual(["00000001-turn_terminal.json"]);
  expect((await lstat(join(own, INSTANCE))).mode & 0o777).toBe(0o700);
});
it("removes event files older than 24 hours and then an instance directory that is empty and old", async () => {
  const { home, own } = await fixture();
  await mkdir(own, { mode: 0o700 }); await mkdir(join(own, INSTANCE), { mode: 0o700 });
  await mkdir(join(own, OTHER_INSTANCE), { mode: 0o700 });
  for (const name of ["00000001-turn_terminal.json", ".tmp-2-abcd1234"]) { await writeFile(join(own, INSTANCE, name), "{}"); await age(join(own, INSTANCE, name), 25); }
  await age(join(own, INSTANCE), 25);
  // An instance directory with one old and one fresh file keeps the fresh one and the directory.
  await writeFile(join(own, OTHER_INSTANCE, "00000001-turn_terminal.json"), "{}"); await age(join(own, OTHER_INSTANCE, "00000001-turn_terminal.json"), 30);
  await writeFile(join(own, OTHER_INSTANCE, "00000002-turn_terminal.json"), "{}");
  await age(join(own, OTHER_INSTANCE), 30);
  await ensureWriterEventsDirectory(home, "repo-w1", uid);
  expect(await readdir(own)).toEqual([OTHER_INSTANCE]);
  expect(await readdir(join(own, OTHER_INSTANCE))).toEqual(["00000002-turn_terminal.json"]);
});
it("keeps an emptied instance directory that changed within 24 hours, and removes old junk inside one without following links", async () => {
  const { home, own } = await fixture(), outside = await temporaryRoot("pi-writer-outside-");
  await chmod(outside, 0o700); await writeFile(join(outside, "keep"), "keep");
  await mkdir(own, { mode: 0o700 }); await mkdir(join(own, INSTANCE), { mode: 0o700 });
  await mkdir(join(own, OTHER_INSTANCE), { mode: 0o700 });
  await writeFile(join(own, INSTANCE, "00000001-turn_terminal.json"), "{}"); await age(join(own, INSTANCE, "00000001-turn_terminal.json"), 25);
  // The directory itself is fresh: it stays although it is now empty.
  await symlink(outside, join(own, OTHER_INSTANCE, "link")); await mkdir(join(own, OTHER_INSTANCE, "dir")); await writeFile(join(own, OTHER_INSTANCE, "dir", "f"), "x");
  await age(join(own, OTHER_INSTANCE, "dir", "f"), 30); await age(join(own, OTHER_INSTANCE, "dir"), 30);
  await ensureWriterEventsDirectory(home, "repo-w1", uid);
  expect(await readdir(own)).toEqual([INSTANCE, OTHER_INSTANCE].sort());
  expect(await readdir(join(own, INSTANCE))).toEqual([]);
  // The old directory with junk goes; the fresh link stays and is never followed.
  expect(await readdir(join(own, OTHER_INSTANCE))).toEqual(["link"]);
  expect(await readdir(outside)).toEqual(["keep"]);
});
it("uses the injected clock for the 24 hour boundary", async () => {
  const { home, own } = await fixture();
  await mkdir(own, { mode: 0o700 }); await mkdir(join(own, INSTANCE), { mode: 0o700 });
  await writeFile(join(own, INSTANCE, "00000001-turn_terminal.json"), "{}");
  await ensureWriterEventsDirectory(home, "repo-w1", uid, Date.now() + 23 * HOUR);
  expect(await readdir(join(own, INSTANCE))).toEqual(["00000001-turn_terminal.json"]);
  await ensureWriterEventsDirectory(home, "repo-w1", uid, Date.now() + 25 * HOUR);
  expect(await readdir(own)).toEqual([]);
});
it("refuses a spool directory with more stale entries than the cleanup bound", async () => {
  const { home, own } = await fixture();
  await mkdir(own, { mode: 0o700 });
  await Promise.all(Array.from({ length: EVENTS_CLEANUP_MAX_ENTRIES + 1 }, (_, i) => writeFile(join(own, `f${i}`), "")));
  await expect(ensureWriterEventsDirectory(home, "repo-w1", uid)).rejects.toMatchObject({ code: "events_directory_unavailable" });
  // At the bound exactly, the directory is cleaned.
  const at = await fixture(), ownAt = at.own;
  await mkdir(ownAt, { mode: 0o700 });
  await Promise.all(Array.from({ length: EVENTS_CLEANUP_MAX_ENTRIES }, (_, i) => writeFile(join(ownAt, `f${i}`), "")));
  await ensureWriterEventsDirectory(at.home, "repo-w1", uid);
  expect(await readdir(ownAt)).toEqual([]);
});

/** A directory outside the spool that a swapped link points at; it must come out of every race untouched. */
async function victim(): Promise<{ dir: string; snapshot: () => Promise<string> }> {
  const dir = await temporaryRoot("pi-writer-victim-");
  await chmod(dir, 0o755);
  await mkdir(join(dir, "sub"), { mode: 0o755 });
  await writeFile(join(dir, "keep"), "keep"); await writeFile(join(dir, "sub", "keep"), "keep");
  for (const path of [join(dir, "keep"), join(dir, "sub", "keep")]) await age(path, 48);
  await age(join(dir, "sub"), 48); await age(dir, 48);
  const snapshot = async (): Promise<string> => JSON.stringify(await Promise.all([dir, join(dir, "sub"), join(dir, "keep"), join(dir, "sub", "keep")]
    .map(async (path) => { const stat = await lstat(path); return [path, stat.mode & 0o777, stat.ino]; })));
  return { dir, snapshot };
}
async function swapForLink(path: string, target: string): Promise<void> {
  // The worker owns the directory: it can lift a stripped mode itself before it replaces the directory.
  if ((await lstat(path)).isDirectory()) await chmod(path, 0o700);
  await rm(path, { recursive: true, force: true });
  await symlink(target, path);
}
it.each([
  ["a junk directory", ["junk"], "inspected", "junk"],
  ["a nested junk directory", ["junk", "deep"], "inspected", "junk/deep"],
  ["an instance directory", [INSTANCE], "inspected", INSTANCE],
  ["a junk directory after it was emptied", ["junk"], "emptied", "junk"],
  ["an emptied old instance directory", [INSTANCE], "emptied", INSTANCE],
] as const)("never follows %s swapped for a link during the cleanup (%s)", async (_label, parts, stage, swapped) => {
  const { home, own } = await fixture(), out = await victim();
  await mkdir(join(own, "junk", "deep"), { recursive: true, mode: 0o700 });
  await writeFile(join(own, "junk", "deep", "f"), "x");
  await mkdir(join(own, INSTANCE), { mode: 0o700 });
  await writeFile(join(own, INSTANCE, "00000001-turn_terminal.json"), "{}");
  await age(join(own, INSTANCE, "00000001-turn_terminal.json"), 48); await age(join(own, INSTANCE), 48);
  // A mode the cleanup would have to repair makes a followed link visible as a chmod of the victim.
  await chmod(join(own, "junk"), 0o000);
  const before = await out.snapshot();
  const target = join(own, swapped);
  let swaps = 0;
  const seam = async (at: string, logical: string): Promise<void> => {
    if (at !== stage || logical !== target) return;
    swaps++;
    await swapForLink(target, out.dir);
  };
  try { await ensure(home, "repo-w1", uid, Date.now(), seam).catch((error: unknown) => { expect(error).toBeInstanceOf(EventsDirectoryError); }); }
  finally {
    // Leave nothing the test runner cannot remove: restore a mode the aborted cleanup did not get to repair.
    for (const path of [join(own, "junk"), join(own, "junk", "deep")]) if ((await lstat(path).catch(() => undefined))?.isDirectory()) await chmod(path, 0o700);
  }
  expect(parts.length).toBeGreaterThan(0);
  expect(swaps).toBe(1);
  expect(await out.snapshot()).toBe(before);
  expect(await readFile(join(out.dir, "sub", "keep"), "utf8")).toBe("keep");
});
it("still cleans up when no swap happens through the same seam", async () => {
  const { home, own } = await fixture();
  await mkdir(join(own, "junk", "deep"), { recursive: true, mode: 0o700 });
  const seen: string[] = [];
  await ensure(home, "repo-w1", uid, Date.now(), (stage, logical) => { seen.push(`${stage}:${logical.slice(own.length)}`); });
  expect(await readdir(own)).toEqual([]);
  expect(seen).toEqual(["inspected:/junk", "inspected:/junk/deep", "emptied:/junk/deep", "emptied:/junk"]);
});
it("refuses a spool directory nested deeper than the cleanup bound", async () => {
  const { home, own } = await fixture();
  await mkdir(join(own, ...Array.from({ length: 12 }, () => "d")), { recursive: true, mode: 0o700 });
  await expect(ensureWriterEventsDirectory(home, "repo-w1", uid)).rejects.toBeInstanceOf(EventsDirectoryError);
});
it("keeps hostile values positional and mounts only requested throwaway data", () => {
  const args = throwawayArgs(paths, imageId, { clone: "ro", bundles: true }, "x", ["--upload-pack=evil"]);
  expect(args.slice(-6)).toEqual([imageId, "sh", "-c", "x", "sh", "--upload-pack=evil"]);
  for (const value of ["--network=none", "--pull=never", "--read-only", "--cap-drop=all", "HOME=/tmp", "/tmp:rw,nosuid,nodev,size=1g", `${paths.clone}:${paths.clone}:ro`, `${paths.bundles}:/bundles:rw`]) expect(args).toContain(value);
  expect(args.join(" ")).not.toContain(paths.agent);
  const minimal = throwawayArgs(paths, imageId, { clone: "rw", bundles: false }, `${BOUNDARY_GIT} --version`, []);
  expect(minimal).toContain(`${paths.clone}:${paths.clone}:rw`);
  expect(minimal.join(" ")).not.toContain(paths.bundles);
});

it("validates ref names", () => {
  expect(isSafeRefName("feature/x-1")).toBe(true);
  expect(isSafeRefName("a".repeat(200))).toBe(true);
  for (const name of ["", "-x", "a..b", "a b", "x.lock", "--upload-pack=x", "a".repeat(201), "a//b", "a/"]) expect(isSafeRefName(name)).toBe(false);
});

async function clone() {
  const root = await temporaryRoot("pi-writer-boundary-");
  await mkdir(join(root, ".git", "hooks"), { recursive: true });
  await writeFile(join(root, ".git", "hooks", "pre-commit.sample"), "sample");
  await writeFile(join(root, ".git", "config"), "[core]\n");
  return root;
}
it("accepts a regular .git directory with sample hooks", async () => {
  await expect(verifyCloneLayout(await clone())).resolves.toBeUndefined();
});
it.each(["commondir", "gitdir", "config.worktree", "hooks/pre-commit", "hooks/directory.sample", "hooks/link.sample"])("refuses unsafe .git entry %s", async (entry) => {
  const root = await clone();
  const target = join(root, ".git", entry);
  if (entry === "hooks/directory.sample") await mkdir(target);
  else if (entry === "hooks/link.sample") await symlink("pre-commit.sample", target);
  else await writeFile(target, "SECRET_SENTINEL");
  await expect(verifyCloneLayout(root)).rejects.toMatchObject({ code: "clone_verification_failed" });
});
it.each(["missing", "symlink", "directory"])("refuses a %s .git/config", async (kind) => {
  const root = await clone();
  const config = join(root, ".git", "config");
  await unlink(config);
  if (kind === "symlink") {
    await writeFile(join(root, "other-config"), "[core]\n");
    await symlink(join(root, "other-config"), config);
  }
  if (kind === "directory") await mkdir(config);
  await expect(verifyCloneLayout(root)).rejects.toMatchObject({ code: "clone_verification_failed" });
});
it("refuses a gitfile, missing .git, and a symlinked .git", async () => {
  for (const kind of ["missing", "file", "symlink"]) {
    const root = await temporaryRoot("pi-writer-layout-");
    if (kind === "file") await writeFile(join(root, ".git"), "gitdir: elsewhere");
    if (kind === "symlink") await symlink(join(await clone(), ".git"), join(root, ".git"));
    await expect(verifyCloneLayout(root)).rejects.toBeInstanceOf(BoundaryError);
  }
});
it("probes rootless Podman and its version with bounded commands", async () => {
  const fake = runner(ok("true\n"), ok("6.1.4\n"));
  expect(await podmanInfo(fake)).toEqual({ usable: true, version: "6.1.4" });
  expect(fake.run.mock.calls.map(([cmd, args]) => [cmd, args])).toEqual([
    ["podman", ["info", "--format", "{{.Host.Security.Rootless}}"]],
    ["podman", ["version", "--format", "{{.Client.Version}}"]],
  ]);
  for (const call of fake.run.mock.calls) expect(call[2]).toBeInstanceOf(AbortSignal);
});
it("fails closed without a version for failed or non-rootless probes", async () => {
  for (const fake of [runner(failed), runner(ok("false\n")), runner(ok("true\n"), failed), runner(ok("true\n"), ok("")), { run: vi.fn().mockRejectedValue(new Error("SECRET_SENTINEL")) }]) {
    expect(await podmanInfo(fake)).toEqual({ usable: false });
  }
});
it("resolves the accepted node image locally or by explicit pull then inspection", async () => {
  const fake = runner(failed, ok("pulled"), ok(`sha256:${imageId}\n`));
  expect(await resolveImage(fake, "node", true)).toBe(imageId);
  expect(fake.run.mock.calls.map(([, args]) => args)).toEqual([
    ["image", "inspect", "--format", "{{.Id}}", NODE_IMAGE_REF], ["pull", "-q", NODE_IMAGE_REF],
    ["image", "inspect", "--format", "{{.Id}}", NODE_IMAGE_REF],
  ]);
  expect(await resolveImage(runner(ok(`${imageId}\n`)), "node", false)).toBe(imageId);
});
it("gives only image pulls a dedicated timeout and a distinct signal", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  try {
    const fake = runner(ok("true\n"), ok("6.1.4\n"), failed, ok("pulled"), ok(imageId));
    expect(await podmanInfo(fake)).toEqual({ usable: true, version: "6.1.4" });
    expect(await resolveImage(fake, "node", true)).toBe(imageId);
    expect(IMAGE_PULL_TIMEOUT_MS).toBe(900_000);
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([
      DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS,
      IMAGE_PULL_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS,
    ]);
    const signals = fake.run.mock.calls.map(([, , signal]) => signal);
    expect(signals[3]).toBeInstanceOf(AbortSignal);
    expect(signals[3]).not.toBe(signals[2]);
    expect(signals[3]).not.toBe(signals[4]);
  } finally { timeout.mockRestore(); }
});
it("pulls and reinspects node when a successful inspect yields an invalid ID", async () => {
  const fake = runner(ok("not-an-id\n"), ok("pulled"), ok(imageId));
  expect(await resolveImage(fake, "node", true)).toBe(imageId);
  expect(fake.run.mock.calls.map(([, args]) => args[0])).toEqual(["image", "pull", "image"]);
});
it("never pulls local IDs or disabled pulls, and rejects invalid IDs and output", async () => {
  expect(await resolveImage(runner(ok(`sha256:${imageId}`)), imageId, true)).toBe(imageId);
  for (const [image, pull] of [[imageId, true], ["node", false], ["latest", true]] as const) {
    const fake = runner(failed);
    await expect(resolveImage(fake, image, pull)).rejects.toMatchObject({ code: "image_unavailable" });
    expect(fake.run.mock.calls.some(([, args]) => args[0] === "pull")).toBe(false);
  }
  for (const output of ["short", "a".repeat(65), `${imageId}\n${imageId}`]) {
    await expect(resolveImage(runner(ok(output)), "node", false)).rejects.toMatchObject({ code: "image_unavailable" });
  }
  await expect(resolveImage(runner(failed, failed), "node", true)).rejects.toThrow(BoundaryError);
});
