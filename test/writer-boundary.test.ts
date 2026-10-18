import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "../src/client-adapters/types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "../src/client-adapters/command.js";
import { BOUNDARY_GIT, BoundaryError, IMAGE_PULL_TIMEOUT_MS, NODE_IMAGE_REF, isSafeRefName, podmanInfo, resolveImage, serveArgs, throwawayArgs, verifyCloneLayout } from "../src/writer-boundary.js";
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

it("keeps hostile values positional and mounts only requested throwaway data", () => {
  const args = throwawayArgs(paths, imageId, { clone: "ro", bundles: true, base: "/operator/repo" }, "x", ["--upload-pack=evil"]);
  expect(args.slice(-6)).toEqual([imageId, "sh", "-c", "x", "sh", "--upload-pack=evil"]);
  for (const value of ["--network=none", "--pull=never", "--read-only", "--cap-drop=all", "HOME=/tmp", "/tmp:rw,nosuid,nodev,size=1g", `${paths.clone}:${paths.clone}:ro`, `${paths.bundles}:/bundles:rw`, "/operator/repo:/base:ro"]) expect(args).toContain(value);
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
