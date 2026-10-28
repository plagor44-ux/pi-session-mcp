import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, expect, it } from "vitest";
import type { CommandRunner } from "../src/client-adapters/types.js";
import { BOUNDARY_GIT, IMAGE_PULL_TIMEOUT_MS, podmanInfo, resolveImage, throwawayArgs } from "../src/writer-boundary.js";
import { collectWriter, inspectWork, provisionWriter, removeWriter, resetWriter } from "../src/writer-lifecycle.js";
import { readWriterState, writerPaths, writeWriterState } from "../src/writer-state.js";
import { acquireWriterLease } from "../src/writer-lease.js";
import { writerContainerName, writerLabel } from "../src/writer-fence.js";
import { LAUNCHER_CLEANUP_BOUND_MS } from "../src/writer-launch.js";
import { createProcessRunner } from "../src/setup-process.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const runner: CommandRunner = { run: (command, args, signal) => new Promise((resolve, reject) => {
  execFile(command, [...args], { signal, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && (typeof error.code !== "number")) { reject(error); return; }
    resolve({ exitCode: error && typeof error.code === "number" ? error.code : 0, stdout, stderr });
  });
}) };
let skipReason: string | undefined;
if (!(await podmanInfo(runner)).usable) skipReason = "Podman is unavailable or is not usable rootless";
else {
  try { await resolveImage(runner, "node", false); } catch { skipReason = "The accepted pinned Node image is not available locally (integration tests do not pull)"; }
}
if (skipReason) console.error(`writer-lifecycle.podman: skipped: ${skipReason}`);
afterAll(removeTemporaryRoots);
it.skipIf(skipReason !== undefined)("provisions, collects branch and WIP refs, and resets to a verified baseline", async () => {
  const home = await temporaryRoot("pi-writer-lifecycle-podman-");
  const checkout = join(home, "source");
  await mkdir(checkout);
  async function git(...args: string[]) {
    const result = await runner.run("git", ["-c", "core.hooksPath=/dev/null", "-C", checkout, ...args]);
    expect(result.exitCode, result.stderr).toBe(0);
  }
  await git("init", "-b", "main");
  await writeFile(join(checkout, "base.txt"), "base\n");
  await git("add", "base.txt");
  await git("-c", "user.name=writer-test", "-c", "user.email=writer@example.invalid", "commit", "-m", "base");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const ctx = { home, checkout, runner, alias: "repo", releaseRoot: home, nodePath: process.execPath };
  const rawConfig = { executionProfiles: { code: { default: false, permissionProfile: "coding", provider: "example", model: "model", thinkingLevel: "off" } } };
  expect(await provisionWriter(ctx, { index: 1, settings: { writers: 1, lifecycle: "persistent", profiles: ["code"], image: "node", network: "none", cache: "none", tags: "none", clean: "untracked" }, rawConfig })).toMatchObject({ status: "ok" });
  expect(await inspectWork(ctx, "repo-w1")).toMatchObject({ baseline: true, dirty: false });
  const paths = writerPaths(home, "repo-w1");
  const state = (await readWriterState(home, "repo-w1"))!;
  const work = await runner.run("podman", throwawayArgs("repo-w1", paths, state.imageId, { clone: "rw", bundles: false }, `set -eu
export GIT_CONFIG_NOSYSTEM=1
${BOUNDARY_GIT} checkout -b feature
printf '%s\\n' committed > committed.txt
${BOUNDARY_GIT} add committed.txt
${BOUNDARY_GIT} -c user.name=writer-test -c user.email=writer@example.invalid commit -m feature
printf '%s\\n' untracked > untracked.txt`, []), AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS));
  expect(work.exitCode, work.stderr).toBe(0);
  expect(await inspectWork(ctx, "repo-w1")).toMatchObject({ baseline: false, dirty: true });
  expect(await removeWriter(ctx, "repo-w1", { discard: false })).toEqual({ code: "writer_uncollected", status: "failed" });
  const collected = await collectWriter(ctx, "repo-w1");
  expect(collected).toMatchObject({ status: "ok", refused: 0 });
  expect(collected.refs).toEqual(["refs/remotes/writer-repo-w1/feature", "refs/remotes/writer-repo-w1/feature-wip"]);
  await git("rev-parse", "--verify", "refs/remotes/writer-repo-w1/feature");
  await git("rev-parse", "--verify", "refs/remotes/writer-repo-w1/feature-wip:untracked.txt");
  expect(await resetWriter(ctx, "repo-w1", { discard: false })).toMatchObject({ code: "writer_reset", status: "ok" });
  expect(await inspectWork(ctx, "repo-w1")).toMatchObject({ baseline: true, dirty: false });
  expect(await removeWriter(ctx, "repo-w1", { discard: false })).toMatchObject({ status: "ok" });
  await expect(lstat(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
}, 120_000);

it.skipIf(skipReason !== undefined).each(["uv", "npm"] as const)("keeps the %s cache across reset, preserving ignored files by default and cleaning with all (#162, #165)", async (cache) => {
  const home = await temporaryRoot("pi-writer-clean-podman-");
  const checkout = join(home, "source");
  await mkdir(checkout);
  async function git(...args: string[]) {
    const result = await runner.run("git", ["-c", "core.hooksPath=/dev/null", "-C", checkout, ...args]);
    expect(result.exitCode, result.stderr).toBe(0);
  }
  await git("init", "-b", "main");
  await writeFile(join(checkout, ".gitignore"), "ignored/\n");
  await git("add", ".gitignore");
  await git("-c", "user.name=writer-test", "-c", "user.email=writer@example.invalid", "commit", "-m", "base");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const ctx = { home, checkout, runner, alias: "repo", releaseRoot: home, nodePath: process.execPath };
  const rawConfig = { executionProfiles: { code: { default: false, permissionProfile: "coding", provider: "example", model: "model", thinkingLevel: "off" } } };
  expect(await provisionWriter(ctx, { index: 1, settings: { writers: 1, lifecycle: "persistent", profiles: ["code"], image: "node", network: "none", cache, tags: "none", clean: "untracked" }, rawConfig })).toMatchObject({ status: "ok" });
  const paths = writerPaths(home, "repo-w1");
  const state = (await readWriterState(home, "repo-w1"))!;
  await writeFile(join(paths[cache], "cached.txt"), "cache\n");
  const leaveIgnored = async () => {
    const work = await runner.run("podman", throwawayArgs("repo-w1", paths, state.imageId, { clone: "rw", bundles: false }, `set -eu
mkdir -p ignored
printf '%s\\n' left > ignored/left.txt`, []), AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS));
    expect(work.exitCode, work.stderr).toBe(0);
  };
  await leaveIgnored();
  expect(await inspectWork(ctx, "repo-w1")).toMatchObject({ baseline: true });
  expect(await resetWriter(ctx, "repo-w1", { discard: false })).toMatchObject({ code: "writer_reset", status: "ok" });
  expect(await readFile(join(paths.clone, "ignored", "left.txt"), "utf8")).toBe("left\n");
  await writeWriterState(home, "repo-w1", { ...(await readWriterState(home, "repo-w1"))!, clean: "all" });
  expect(await resetWriter(ctx, "repo-w1", { discard: false })).toMatchObject({ code: "writer_reset", status: "ok" });
  await expect(lstat(join(paths.clone, "ignored"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(paths.clone, ".gitignore"), "utf8")).toBe("ignored/\n");
  expect(await readFile(join(paths[cache], "cached.txt"), "utf8")).toBe("cache\n");
  expect(await inspectWork(ctx, "repo-w1")).toMatchObject({ baseline: true, dirty: false });
  expect(await removeWriter(ctx, "repo-w1", { discard: false })).toMatchObject({ status: "ok" });
}, 120_000);

it.skipIf(skipReason !== undefined)("neither the container nor Podman's monitor holds the lease descriptor", async () => {
  const home = await temporaryRoot("pi-writer-fd-podman-");
  const name = "fd-w1", paths = writerPaths(home, name), fdRunner = createProcessRunner();
  const image = await resolveImage(runner, "node", false);
  await mkdir(paths.clone, { recursive: true });
  const lease = await acquireWriterLease(home, name, { waitMs: 0 });
  let id: string | undefined;
  try {
    const args = throwawayArgs(name, paths, image, { clone: "rw", bundles: false }, "exec sleep 120", []);
    const result = await fdRunner.run("podman", ["run", "-d", ...args.slice(1)], AbortSignal.timeout(20_000), { inheritFds: [lease.fd] });
    expect(result.exitCode, result.stderr).toBe(0); id = result.stdout.trim();
    await lease.release();
    const fresh = await acquireWriterLease(home, name, { waitMs: 0 });
    await fresh.release();
    expect((await runner.run("podman", ["inspect", "--format", "{{.State.Running}}", id])).stdout.trim()).toBe("true");
    const fds = await runner.run("podman", ["exec", id, "sh", "-c", "ls /proc/1/fd"]);
    expect(fds.exitCode, fds.stderr).toBe(0);
    expect(fds.stdout.trim().split(/\s+/).sort()).toEqual(["0", "1", "2"]);
    expect((await runner.run("podman", ["inspect", "--format", '{{index .Config.Labels "pi-session-mcp.writer"}}', id])).stdout.trim()).toBe(name);
  } finally {
    await lease.release();
    if (id) await runner.run("podman", ["rm", "-f", "-t", "0", id]);
  }
}, 60_000);

it.skipIf(skipReason !== undefined)("a finite-input probe gets EOF and runs to completion", async () => {
  const { home, name, release } = await relayWriter();
  const launcher = join(home, "launcher.mjs");
  await writeFile(launcher, `
    import { spawn } from 'node:child_process';
    import { launchEntry } from ${JSON.stringify(pathToFileURL(join(release, "dist", "writer-launch.js")).href)};
    import { createProcessRunner } from ${JSON.stringify(pathToFileURL(join(release, "dist", "setup-process.js")).href)};
    process.exitCode = await launchEntry([${JSON.stringify(name)}, 'node', '-e', "let d='';process.stdin.on('data',(c)=>{d+=c}).on('end',()=>{process.stdout.write('probe:'+d.trim())})"], {
      home: ${JSON.stringify(home)}, releaseRoot: ${JSON.stringify(release)}, runner: createProcessRunner(),
      env: { PI_WRITER_NO_CREDENTIAL_REFRESH: '1' }, now: Date.now, setInterval, clearInterval,
      spawnPodman: (args, fds) => spawn('podman', args, { stdio: ['pipe', 'inherit', 'inherit', ...fds] }),
    });
  `);
  const child = spawn(process.execPath, [launcher], { stdio: ["pipe", "pipe", "ignore"] });
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const exited = once(child, "exit");
  child.stdin!.end("ok");
  const [code] = await exited;
  expect(output).toContain("probe:ok");
  expect(code).toBe(0);
  const lease = await acquireWriterLease(home, name, { waitMs: 0 }); await lease.release();
}, 120_000);

/** A relay-mode writer around a fresh build of this checkout, without clone, provider or credentials. */
async function relayWriter() {
  const home = await temporaryRoot("pi-writer-relay-podman-");
  const name = "relay-w1", paths = writerPaths(home, name), container = writerContainerName(name);
  const release = join(home, "release");
  await mkdir(release);
  // Compile this checkout, not a potentially stale dist/ from a previous build.
  const build = await runner.run(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", join(release, "dist")], AbortSignal.timeout(60_000));
  expect(build.exitCode, build.stderr).toBe(0);
  await writeFile(join(release, "package.json"), await readFile(resolve("package.json")));
  await symlink(resolve("node_modules"), join(release, "node_modules"));
  for (const dir of [join(paths.clone, ".git", "hooks"), paths.config, paths.agent]) await mkdir(dir, { recursive: true });
  await writeFile(join(paths.clone, ".git", "config"), "");
  await writeWriterState(home, name, {
    schemaVersion: 1, alias: "relay", index: 1, phase: "not_ready", launch: "relay", lifecycle: "persistent",
    profiles: ["code"], providers: [], network: "none", cache: "none", tags: "none", clean: "untracked",
    imageId: await resolveImage(runner, "node", false), base: { ref: "refs/heads/main", commit: "a".repeat(40) },
  });
  return { home, name, paths, container, release };
}

it.skipIf(skipReason !== undefined)("host SIGKILL of the relay parent releases the writer within the cleanup bound", async () => {
  const { home, name, container, release } = await relayWriter();
  // No provider or session: the probe keeps stdin open, just as the inner stdio server does.
  const launcher = join(home, "launcher.mjs");
  await writeFile(launcher, `
    import { spawn } from 'node:child_process';
    import { launchEntry } from ${JSON.stringify(pathToFileURL(join(release, "dist", "writer-launch.js")).href)};
    import { createProcessRunner } from ${JSON.stringify(pathToFileURL(join(release, "dist", "setup-process.js")).href)};
    process.exitCode = await launchEntry([${JSON.stringify(name)}, 'node', '-e', 'process.stdin.resume()'], {
      home: ${JSON.stringify(home)}, releaseRoot: ${JSON.stringify(release)}, runner: createProcessRunner(),
      env: { PI_WRITER_NO_CREDENTIAL_REFRESH: '1' }, now: Date.now, setInterval, clearInterval,
      spawnPodman: (args, fds) => spawn('podman', args, { stdio: ['pipe', 'inherit', 'inherit', ...fds] }),
    });
  `);
  const parent = spawn(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, [${JSON.stringify(launcher)}], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    process.stdout.write(String(child.pid) + '\\n');
    process.stdin.resume();
  `], { stdio: ["pipe", "pipe", "pipe"] });
  let second: ChildProcess | undefined;
  let launcherPid: number | undefined;
  const waitRunning = async () => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const result = await runner.run("podman", ["inspect", "--format", "{{.State.Running}}", container]);
      if (result.exitCode === 0 && result.stdout.trim() === "true") return;
      if (Date.now() >= deadline) throw new Error("launcher container did not start");
      await delay(100);
    }
  };
  try {
    const [pid] = await once(parent.stdout!, "data"); launcherPid = Number(String(pid).trim());
    await waitRunning();
    const exited = once(parent, "exit"); const started = Date.now(); parent.kill("SIGKILL"); await exited;
    const deadline = started + LAUNCHER_CLEANUP_BOUND_MS;
    for (;;) {
      try {
        const lease = await acquireWriterLease(home, name, { waitMs: 0 }); await lease.release(); break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "writer_busy")) throw error;
        if (Date.now() >= deadline) throw new Error("launcher did not release within cleanup bound");
        await delay(100);
      }
    }
    expect(Date.now() - started).toBeLessThan(LAUNCHER_CLEANUP_BOUND_MS);
    const absent = await runner.run("podman", ["ps", "-a", "--filter", `label=${writerLabel(name)}`, "--format", "json"]);
    expect(absent.exitCode).toBe(0); expect(JSON.parse(absent.stdout)).toEqual([]);
    second = spawn(process.execPath, [launcher], { stdio: ["pipe", "ignore", "ignore"] });
    await waitRunning(); // a second launcher was admitted, not a refusal server
    const closed = once(second, "close"); second.stdin!.end(); await closed;
    const next = await acquireWriterLease(home, name, { waitMs: 0 }); await next.release();
  } finally {
    parent.kill("SIGKILL"); second?.kill("SIGTERM");
    if (launcherPid) { try { process.kill(launcherPid, "SIGTERM"); } catch { /* already exited */ } }
    await runner.run("podman", ["rm", "-f", "-t", "0", container]);
  }
}, 120_000);
