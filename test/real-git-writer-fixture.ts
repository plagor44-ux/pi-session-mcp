import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import type { CommandResult, CommandRunner } from "../src/client-adapters/types.js";
import { provisionWriter, type WriterContext } from "../src/writer-lifecycle.js";
import { readWriterState, writerPaths, writeWriterState } from "../src/writer-state.js";
import { temporaryRoot } from "./temporary-roots.js";

/*
 * The real boundary scripts against real Git, without Podman: the injected runner forwards host `git`
 * commands to real git and executes every `podman run ... sh -c <script> sh <args...>` (throwawayArgs)
 * locally, with `/tmp/` and `/bundles/` replaced by private temporary directories, in the clone
 * directory, with a private HOME and GIT_CONFIG_NOSYSTEM=1.
 */

const imageId = "a".repeat(64);
const settings = { writers: 1, lifecycle: "persistent", profiles: ["code"], image: "node", network: "none", cache: "none", tags: "none", clean: "untracked" } as const;
const rawConfig = { executionProfiles: { code: { default: false, permissionProfile: "coding", provider: "example", model: "model", thinkingLevel: "off" } } };

export function spawn(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal | undefined } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd: options.cwd, env: options.env ?? { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, signal: options.signal, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolve({ exitCode: error && typeof error.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
}

export async function git(dir: string, ...args: string[]): Promise<string> {
  const result = await spawn("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args]);
  expect(result.exitCode, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}
export async function gitPresent(dir: string, ...args: string[]): Promise<boolean> {
  return (await spawn("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args])).exitCode === 0;
}

/** Forwards `git` to real git and runs every throwaway `podman run` script with `sh -c` in the clone. */
export function realRunner(paths: { clone: string; bundles: string }): CommandRunner {
  return { async run(command, args, signal) {
    if (command === "git") return spawn("git", args, { signal });
    if (command !== "podman" || args[0] !== "run") return { exitCode: 1, stdout: "", stderr: `unexpected command: ${command} ${args[0] ?? ""}` };
    // throwawayArgs shape: [...flags, imageId, "sh", "-c", script, "sh", ...positional]
    const cIndex = args.indexOf("-c");
    if (cIndex < 1 || args[cIndex - 1] !== "sh" || args[cIndex + 2] !== "sh") return { exitCode: 1, stdout: "", stderr: "unexpected podman run shape" };
    const script = (args[cIndex + 1] ?? "").replaceAll("/tmp/", `${await temporaryRoot("pi-boundary-tmp-")}/`).replaceAll("/bundles/", `${paths.bundles}/`);
    const home = await temporaryRoot("pi-boundary-home-");
    return spawn("sh", ["-c", script, "sh", ...args.slice(cIndex + 3)], { cwd: paths.clone, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, signal });
  } };
}

export async function fixture() {
  const home = await temporaryRoot("pi-writer-collect-real-");
  const checkout = join(home, "source");
  const paths = writerPaths(home, "repo-w1");
  // The synthetic operator checkout: a real repository whose main is the base commit.
  await mkdir(checkout);
  await git(checkout, "init", "-b", "main");
  await git(checkout, "config", "user.name", "operator");
  await git(checkout, "config", "user.email", "operator@example.invalid");
  await writeFile(join(checkout, "base.txt"), "base\n");
  await git(checkout, "add", "base.txt");
  await git(checkout, "commit", "-m", "base");
  await git(checkout, "update-ref", "refs/remotes/origin/main", "HEAD");
  await git(checkout, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const baseCommit = await git(checkout, "rev-parse", "HEAD");
  // Provision with a mocked runner (as in writer-collect.test.ts) ...
  const mocked: CommandRunner = { async run(command, args) {
    let stdout = "";
    if (command === "git") {
      if (args.includes("symbolic-ref")) stdout = "refs/remotes/origin/main";
      else if (args.includes("rev-parse")) stdout = args.includes("--symbolic-full-name") ? "refs/heads/main" : baseCommit;
      else if (args.includes("create")) await writeFile(join(paths.bundles, "base.bundle"), "bundle");
    } else if (args[0] === "image") stdout = imageId;
    else if (args.some((arg) => arg.includes("clone --no-hardlinks"))) {
      await mkdir(join(paths.clone, ".git/hooks"), { recursive: true });
      await writeFile(join(paths.clone, ".git/config"), "");
    }
    return { exitCode: 0, stdout, stderr: "" };
  } };
  const ctx: WriterContext = { home, checkout, releaseRoot: home, nodePath: process.execPath, runner: mocked, alias: "repo" };
  expect(await provisionWriter(ctx, { index: 1, settings, rawConfig })).toMatchObject({ status: "ok", code: "writer_provisioned" });
  // ... then replace the clone with a real clone of the synthetic source and record the real base commit.
  await rm(paths.clone, { recursive: true, force: true });
  const clone = await spawn("git", ["clone", "--quiet", "--no-hardlinks", checkout, paths.clone]);
  expect(clone.exitCode, clone.stderr).toBe(0);
  await git(paths.clone, "config", "user.name", "writer");
  await git(paths.clone, "config", "user.email", "writer@example.invalid");
  const state = (await readWriterState(home, "repo-w1"))!;
  await writeWriterState(home, "repo-w1", { ...state, base: { ref: "refs/heads/main", commit: baseCommit } });
  const runner = realRunner(paths);
  ctx.runner = runner;
  const work = async (...args: string[]) => git(paths.clone, ...args);
  const commit = async (message: string, file: string, content: string) => {
    await writeFile(join(paths.clone, file), content);
    await work("add", file);
    await work("commit", "-m", message);
    return work("rev-parse", "HEAD");
  };
  return { ctx, home, checkout, paths, baseCommit, runner, work, commit };
}

