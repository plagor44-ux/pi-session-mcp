import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/client-adapters/types.js";
import { launch, type LaunchDependencies } from "../src/writer-launch.js";
import { provisionWriter, resetWriter, type WriterContext } from "../src/writer-lifecycle.js";
import { copyModelsStore, hostModelsStorePath, MODELS_STORE_FILE, MODELS_STORE_MAX_BYTES } from "../src/writer-models-store.js";
import { writerPaths, writeWriterState, type WriterState } from "../src/writer-state.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

vi.mock("../src/refusal-server.js", () => ({ serveRefusal: vi.fn() }));
afterAll(removeTemporaryRoots);

const catalog = JSON.stringify({ openai: { models: [{ id: "overlay-only-model" }], checkedAt: 1, lastModified: 2 } });
const mode = async (path: string) => (await lstat(path)).mode & 0o777;

it("derives the host source next to the host auth.json", () => {
  expect(hostModelsStorePath("/home/u")).toBe(join("/home/u", ".pi", "agent", MODELS_STORE_FILE));
});

it("copies the catalog byte for byte into the agent directory with mode 0600 and leaves no temporary file", async () => {
  const root = await temporaryRoot("pi-models-store-");
  const source = join(root, "host-models-store.json");
  const agent = join(root, "agent");
  await writeFile(source, catalog, { mode: 0o644 });
  expect(await copyModelsStore(source, agent)).toBe(true);
  expect(await readFile(join(agent, MODELS_STORE_FILE), "utf8")).toBe(catalog);
  expect(await mode(join(agent, MODELS_STORE_FILE))).toBe(0o600);
  expect(await readdir(agent)).toEqual([MODELS_STORE_FILE]);
  // A second copy replaces the first atomically.
  await writeFile(source, "{}");
  expect(await copyModelsStore(source, agent)).toBe(true);
  expect(await readFile(join(agent, MODELS_STORE_FILE), "utf8")).toBe("{}");
});

it("skips silently when the source is missing", async () => {
  const root = await temporaryRoot("pi-models-store-");
  expect(await copyModelsStore(join(root, "absent.json"), join(root, "agent"))).toBe(false);
  await expect(lstat(join(root, "agent", MODELS_STORE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
});

it("removes a stale or worker-left destination file when no copy is made", async () => {
  const root = await temporaryRoot("pi-models-store-");
  const agent = join(root, "agent");
  await mkdir(agent);
  await writeFile(join(agent, MODELS_STORE_FILE), "left by a worker");
  expect(await copyModelsStore(join(root, "absent.json"), agent)).toBe(false);
  await expect(lstat(join(agent, MODELS_STORE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  const big = join(root, "big.json");
  await writeFile(big, Buffer.alloc(MODELS_STORE_MAX_BYTES + 1, 0x20));
  await writeFile(join(agent, MODELS_STORE_FILE), "stale copy");
  expect(await copyModelsStore(big, agent)).toBe(false);
  await expect(lstat(join(agent, MODELS_STORE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses a symlinked source and a non-regular source", async () => {
  const root = await temporaryRoot("pi-models-store-");
  const target = join(root, "target.json");
  await writeFile(target, catalog);
  await symlink(target, join(root, "link.json"));
  await mkdir(join(root, "dir.json"));
  expect(await copyModelsStore(join(root, "link.json"), join(root, "agent"))).toBe(false);
  expect(await copyModelsStore(join(root, "dir.json"), join(root, "agent"))).toBe(false);
  await expect(lstat(join(root, "agent", MODELS_STORE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
});

it("skips an oversized source", async () => {
  const root = await temporaryRoot("pi-models-store-");
  const source = join(root, "big.json");
  await writeFile(source, Buffer.alloc(MODELS_STORE_MAX_BYTES + 1, 0x20));
  expect(await copyModelsStore(source, join(root, "agent"))).toBe(false);
});

it("replaces a symlink at the destination without following it", async () => {
  const root = await temporaryRoot("pi-models-store-");
  const source = join(root, "host.json");
  const outside = join(root, "outside.json");
  const agent = join(root, "agent");
  await writeFile(source, catalog);
  await writeFile(outside, "outside");
  await mkdir(agent);
  await symlink(outside, join(agent, MODELS_STORE_FILE));
  expect(await copyModelsStore(source, agent)).toBe(true);
  expect(await readFile(outside, "utf8")).toBe("outside");
  expect((await lstat(join(agent, MODELS_STORE_FILE))).isSymbolicLink()).toBe(false);
  expect(await readFile(join(agent, MODELS_STORE_FILE), "utf8")).toBe(catalog);
});

it("never changes the source file", async () => {
  const root = await temporaryRoot("pi-models-store-");
  const source = join(root, "host.json");
  await writeFile(source, catalog);
  await chmod(source, 0o640);
  await copyModelsStore(source, join(root, "agent"));
  expect(await mode(source)).toBe(0o640);
  expect(await readFile(source, "utf8")).toBe(catalog);
});

const profile = { default: false, permissionProfile: "coding", provider: "example", model: "model", thinkingLevel: "high" };
const rawConfig = { workspaces: { repo: "/host" }, executionProfiles: { code: profile } };
const settings = { writers: 1, lifecycle: "persistent", profiles: ["code"], image: "node", network: "none", cache: "none", tags: "none", clean: "untracked" } as const;
const commit = "b".repeat(40), tree = "c".repeat(40), imageId = "a".repeat(64);

async function lifecycleFixture(modelsStorePath: string | undefined) {
  const home = await temporaryRoot("pi-writer-models-store-");
  const paths = writerPaths(home, "repo-w1");
  const runner: CommandRunner = { async run(command, args) {
    let stdout = "";
    if (command === "git") {
      if (args.includes("symbolic-ref")) stdout = "refs/remotes/origin/main\n";
      if (args.includes("rev-parse")) stdout = `${commit}\n`;
      if (args.includes("get-url")) stdout = "git@github.com:o/r.git";
      if (args.includes("bundle")) await writeFile(join(paths.bundles, "base.bundle"), "bundle", { mode: 0o600 });
    } else if (args[0] === "info") stdout = "true";
    else if (args[0] === "version") stdout = "5.4.0";
    else if (args[0] === "image") stdout = imageId;
    else if (args[0] === "run") {
      if (args.some((arg) => arg.includes("clone --no-hardlinks"))) {
        await mkdir(join(paths.clone, ".git/hooks"), { recursive: true });
        await writeFile(join(paths.clone, ".git/config"), "");
      } else stdout = `${commit}\nrefs/heads/main ${commit}\n${tree}\n${tree}\n${tree}\n${tree}\n`;
    }
    return { exitCode: 0, stdout, stderr: "" };
  } };
  const ctx: WriterContext = { home, releaseRoot: "/release", nodePath: process.execPath, runner, checkout: join(home, "source"), alias: "repo", ...(modelsStorePath ? { modelsStorePath } : {}) };
  return { ctx, paths, home };
}

it("copies the host catalog into the writer agent directory at provisioning and after a reset", async () => {
  const outside = await temporaryRoot("pi-models-store-");
  const source = join(outside, "host.json");
  await writeFile(source, catalog);
  const f = await lifecycleFixture(source);
  expect((await provisionWriter(f.ctx, { index: 1, settings, rawConfig })).status).toBe("ok");
  expect(await readFile(join(f.paths.agent, MODELS_STORE_FILE), "utf8")).toBe(catalog);
  expect(await mode(join(f.paths.agent, MODELS_STORE_FILE))).toBe(0o600);
  await writeFile(source, "{}");
  expect((await resetWriter(f.ctx, "repo-w1", { discard: true })).status).toBe("ok");
  expect(await readFile(join(f.paths.agent, MODELS_STORE_FILE), "utf8")).toBe("{}");
});

it("provisions without a catalog file when the host has none", async () => {
  const f = await lifecycleFixture(undefined);
  expect((await provisionWriter(f.ctx, { index: 1, settings, rawConfig })).status).toBe("ok");
  expect((await readdir(f.paths.agent)).sort()).toEqual(["auth.json"]);
});

const state: WriterState = { schemaVersion: 1, alias: "x", index: 1, phase: "not_ready", lifecycle: "persistent", profiles: ["coding"], providers: [{ provider: "openai", model: "m" }], network: "none", cache: "none", tags: "none", clean: "untracked", imageId, base: { ref: "refs/heads/main", commit } };
let home: string, child: ChildProcess, deps: LaunchDependencies;
beforeEach(async () => {
  home = await temporaryRoot("pi-launch-models-store-");
  child = new EventEmitter() as ChildProcess; child.kill = vi.fn(() => true);
  deps = { home, releaseRoot: "/release", env: { PI_WRITER_NO_CREDENTIAL_REFRESH: "1" }, now: () => 1_800_000_000_000,
    runner: { run: vi.fn(async (_cmd, args) => ({ exitCode: 0, stdout: args[0] === "info" ? "true" : "5.0.0", stderr: "" })) },
    lease: { acquire: vi.fn(async () => ({ fd: 42, release: vi.fn(async () => {}) })), adopt: vi.fn(async () => ({ fd: 3, release: vi.fn(async () => {}) })) },
    ensureAbsent: vi.fn(async () => {}),
    spawnPodman: vi.fn(() => { setImmediate(() => child.emit("close", 0)); return child; }),
    setInterval: vi.fn(() => setInterval(() => {}, 100000)), clearInterval: vi.fn(clearInterval) };
  await writeWriterState(home, "x-w1", state);
  await writeFile(writerPaths(home, "x-w1").wrapper, "wrapper");
});

it("copies the host catalog into the writer agent directory at each launch", async () => {
  const host = join(home, ".pi", "agent");
  await mkdir(host, { recursive: true });
  await writeFile(join(host, MODELS_STORE_FILE), catalog);
  const paths = writerPaths(home, "x-w1");
  // A probe launch (extra arguments) needs no acceptance, like the existing launcher tests.
  await launch(["x-w1", "node", "-"], deps);
  expect(await readFile(join(paths.agent, MODELS_STORE_FILE), "utf8")).toBe(catalog);
  expect(await mode(join(paths.agent, MODELS_STORE_FILE))).toBe(0o600);
  await writeFile(join(host, MODELS_STORE_FILE), "{}");
  child = new EventEmitter() as ChildProcess; child.kill = vi.fn(() => true);
  await launch(["x-w1", "node", "-"], deps);
  expect(await readFile(join(paths.agent, MODELS_STORE_FILE), "utf8")).toBe("{}");
});

it("still launches when the host has no catalog or a symlinked one", async () => {
  const paths = writerPaths(home, "x-w1");
  await mkdir(paths.agent, { recursive: true });
  await launch(["x-w1", "node", "-"], deps);
  expect(deps.spawnPodman).toHaveBeenCalledTimes(1);
  await expect(lstat(join(paths.agent, MODELS_STORE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  const host = join(home, ".pi", "agent");
  await mkdir(host, { recursive: true });
  await writeFile(join(home, "elsewhere.json"), catalog);
  await symlink(join(home, "elsewhere.json"), join(host, MODELS_STORE_FILE));
  child = new EventEmitter() as ChildProcess; child.kill = vi.fn(() => true);
  await launch(["x-w1", "node", "-"], deps);
  expect(deps.spawnPodman).toHaveBeenCalledTimes(2);
  await expect(lstat(join(paths.agent, MODELS_STORE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
});
