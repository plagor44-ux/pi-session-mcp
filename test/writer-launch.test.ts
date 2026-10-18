import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { launch, renderWrapper, wrapperDigest, type LaunchDependencies } from "../src/writer-launch.js";
import { acceptanceFingerprint, writeWriterState, writerPaths, type WriterState } from "../src/writer-state.js";
import { PACKAGE_VERSION } from "../src/package-metadata.js";
import { serveArgs } from "../src/writer-boundary.js";
import { serveRefusal } from "../src/refusal-server.js";
import * as credentials from "../src/writer-credentials.js";
vi.mock("../src/refusal-server.js", () => ({ serveRefusal: vi.fn() }));
vi.mock("../src/writer-credentials.js", async (original) => ({ ...await original<typeof credentials>(), refreshHostLogin: vi.fn(), ensureWarmupConfig: vi.fn(), writeBoundaryCredentials: vi.fn() }));
let home: string, child: ChildProcess, deps: LaunchDependencies, tick: () => void;
const state: WriterState = { schemaVersion: 1, alias: "x", index: 1, phase: "not_ready", lifecycle: "persistent", profiles: ["coding"], providers: [{ provider: "openai", model: "m" }], network: "none", cache: "none", imageId: "a".repeat(64), base: { ref: "refs/heads/main", commit: "b".repeat(40) } };
beforeEach(async () => {
  vi.clearAllMocks(); home = await mkdtemp(join(tmpdir(), "launch-"));
  child = new EventEmitter() as ChildProcess; child.kill = vi.fn(() => true);
  deps = { home, nodePath: process.execPath, releaseRoot: "/release", env: { PI_WRITER_NO_CREDENTIAL_REFRESH: "1" }, now: () => 1_800_000_000_000,
    runner: { run: vi.fn(async (_cmd, args) => ({ exitCode: 0, stdout: args[0] === "info" ? "true" : "5.0.0", stderr: "" })) },
    spawnPodman: vi.fn(() => { setImmediate(() => child.emit("close", 7)); return child; }),
    setInterval: vi.fn((fn) => { tick = fn; return setInterval(() => {}, 100000); }), clearInterval: vi.fn(clearInterval) };
});
afterEach(async () => { vi.useRealTimers(); await rm(home, { recursive: true, force: true }); });
async function save(ready = false, version = "5.0.0") {
  await writeWriterState(home, "x-w1", state);
  await writeFile(writerPaths(home, "x-w1").wrapper, "wrapper");
  if (ready) await writeWriterState(home, "x-w1", { ...state, phase: "ready", acceptance: { verdict: "pass", at: "now", network: "limited", fingerprint: acceptanceFingerprint({ wrapperDigest: wrapperDigest("wrapper"), packageVersion: PACKAGE_VERSION, imageId: state.imageId, podmanVersion: version, network: state.network, cache: state.cache }) } });
}
it("renders a shell-valid fully quoted wrapper and rejects quotes", () => {
  const text = renderWrapper("/node space", "/release space", "x-w1");
  execFileSync("sh", ["-n"], { input: text });
  expect(text).toContain("exec '/node space' '/release space/dist/writer-launch.js' 'x-w1' \"$@\"");
  for (const args of [["'", "/r", "x"], ["/n", "'", "x"], ["/n", "/r", "x'"]]) expect(() => renderWrapper(args[0]!, args[1]!, args[2]!)).toThrow();
});
it("refuses invalid names and unusable Podman without spawning", async () => {
  await launch(["../x"], deps); expect(serveRefusal).toHaveBeenLastCalledWith("writer_not_ready");
  vi.mocked(deps.runner.run).mockRejectedValue(new Error("offline"));
  await launch(["x-w1"], deps); expect(serveRefusal).toHaveBeenLastCalledWith("container_runtime_unavailable"); expect(deps.spawnPodman).not.toHaveBeenCalled();
});
it("refuses missing, provisioning and stale accepted states", async () => {
  await launch(["x-w1"], deps);
  await writeWriterState(home, "x-w1", { ...state, phase: "provisioning" }); await launch(["x-w1"], deps);
  await save(true, "4.0.0"); await launch(["x-w1"], deps);
  expect(serveRefusal).toHaveBeenCalledTimes(3); expect(deps.spawnPodman).not.toHaveBeenCalled();
});
it("runs accepted servers with identical boundary args and skips credentials when disabled", async () => {
  await save(true); expect(await launch(["x-w1"], deps)).toBe(7);
  expect(deps.spawnPodman).toHaveBeenCalledWith(serveArgs(writerPaths(home, "x-w1"), state, ["node", "/opt/pi-session-mcp/dist/main.js"], "/release"));
  expect(credentials.writeBoundaryCredentials).not.toHaveBeenCalled(); expect(credentials.refreshHostLogin).not.toHaveBeenCalled();
});
it("invalidates acceptance when current wrapper bytes change", async () => {
  await save(true); await writeFile(writerPaths(home, "x-w1").wrapper, "changed");
  await launch(["x-w1"], deps);
  expect(serveRefusal).toHaveBeenCalledWith("writer_not_ready"); expect(deps.spawnPodman).not.toHaveBeenCalled();
});
it("allows a probe before acceptance", async () => {
  await save(); await launch(["x-w1", "node", "-", "cfg"], deps);
  expect(deps.spawnPodman).toHaveBeenCalledWith(serveArgs(writerPaths(home, "x-w1"), state, ["node", "-", "cfg"], "/release"));
});
it("recopies at the configured interval across 300000 ms and forwards signals", async () => {
  await save(); deps.env = {}; vi.mocked(deps.spawnPodman).mockReturnValue(child);
  vi.useFakeTimers(); deps.setInterval = vi.fn((fn, ms) => setInterval(fn, ms));
  const running = launch(["x-w1", "node", "-", "cfg"], deps);
  // File reads use the real filesystem even while interval time is virtual.
  await vi.waitFor(() => expect(deps.spawnPodman).toHaveBeenCalled());
  expect(deps.setInterval).toHaveBeenCalledWith(expect.any(Function), 60_000);
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(credentials.writeBoundaryCredentials).toHaveBeenCalledTimes(i + 2));
  }
  process.emit("SIGINT"); process.emit("SIGTERM");
  expect(child.kill).toHaveBeenCalledWith("SIGINT"); expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  child.emit("close", 0); expect(await running).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000); expect(credentials.writeBoundaryCredentials).toHaveBeenCalledTimes(6);
});
it("reads fresh credentials, copies after failed refresh, skips overlapping ticks and clears on exit", async () => {
  await save(); deps.env = {}; vi.mocked(credentials.ensureWarmupConfig).mockResolvedValue("warmup");
  const { mkdir } = await import("node:fs/promises"); const host = join(home, ".pi", "agent"); await mkdir(host, { recursive: true });
  await writeFile(join(host, "auth.json"), JSON.stringify({ openai: { type: "oauth", expires: 1, access: "first" } }));
  vi.mocked(credentials.refreshHostLogin).mockRejectedValueOnce(new Error("failed"));
  vi.mocked(deps.spawnPodman).mockReturnValue(child);
  const running = launch(["x-w1", "node", "-", "cfg"], deps);
  await vi.waitFor(() => expect(deps.spawnPodman).toHaveBeenCalled());
  expect(credentials.writeBoundaryCredentials).toHaveBeenCalledWith(writerPaths(home, "x-w1").agent, { openai: { type: "oauth", expires: 1, access: "first", refresh: "" } });
  await writeFile(join(host, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fresh" } }));
  tick(); await vi.waitFor(() => expect(credentials.writeBoundaryCredentials).toHaveBeenCalledTimes(2));
  expect(credentials.writeBoundaryCredentials).toHaveBeenLastCalledWith(writerPaths(home, "x-w1").agent, { openai: { type: "api_key", key: "fresh" } });
  await writeFile(join(host, "auth.json"), JSON.stringify({ openai: { type: "oauth", expires: 1 } }));
  vi.mocked(credentials.refreshHostLogin).mockImplementation(() => new Promise(() => {}));
  tick(); await vi.waitFor(() => expect(credentials.refreshHostLogin).toHaveBeenCalledTimes(2));
  for (let i = 0; i < 5; i++) tick();
  expect(credentials.refreshHostLogin).toHaveBeenCalledTimes(2);
  child.emit("close", 0); await running; expect(deps.clearInterval).toHaveBeenCalled();
});
