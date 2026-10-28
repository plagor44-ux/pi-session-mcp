import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LAUNCHER_CLEANUP_BOUND_MS, launch, launchEntry, renderWrapper, wrapperDigest, type LaunchDependencies } from "../src/writer-launch.js";
import { acceptanceFingerprint, writeWriterState, writerEventDeliveryEnabled, writerPaths, type WriterState } from "../src/writer-state.js";
import { PACKAGE_VERSION } from "../src/package-metadata.js";
import { serveArgs } from "../src/writer-boundary.js";
import { serveRefusal } from "../src/refusal-server.js";
import * as credentials from "../src/writer-credentials.js";
import { WriterLeaseError } from "../src/writer-lease.js";
vi.mock("../src/refusal-server.js", () => ({ serveRefusal: vi.fn() }));
vi.mock("../src/writer-credentials.js", async (original) => ({ ...await original<typeof credentials>(), refreshHostCredential: vi.fn(), writeBoundaryCredentials: vi.fn() }));
let home: string, child: ChildProcess, deps: LaunchDependencies, tick: () => void;
const state: WriterState = { schemaVersion: 1, alias: "x", index: 1, phase: "not_ready", lifecycle: "persistent", profiles: ["coding"], providers: [{ provider: "openai", model: "m" }], network: "none", cache: "none", tags: "none", imageId: "a".repeat(64), base: { ref: "refs/heads/main", commit: "b".repeat(40) } };
beforeEach(async () => {
  vi.clearAllMocks(); home = await mkdtemp(join(tmpdir(), "launch-"));
  child = new EventEmitter() as ChildProcess; child.kill = vi.fn(() => true);
  deps = { home, releaseRoot: "/release", env: { PI_WRITER_NO_CREDENTIAL_REFRESH: "1" }, now: () => 1_800_000_000_000,
    runner: { run: vi.fn(async (_cmd, args) => ({ exitCode: 0, stdout: args[0] === "info" ? "true" : "5.0.0", stderr: "" })) },
    lease: { acquire: vi.fn(async () => ({ fd: 42, release: vi.fn(async () => {}) })), adopt: vi.fn(async () => ({ fd: 3, release: vi.fn(async () => {}) })) },
    ensureAbsent: vi.fn(async () => {}),
    spawnPodman: vi.fn(() => { setImmediate(() => child.emit("close", 7)); return child; }),
    setInterval: vi.fn((fn) => { tick = fn; return setInterval(() => {}, 100000); }), clearInterval: vi.fn(clearInterval) };
});
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await rm(home, { recursive: true, force: true }); });
async function save(ready = false, version = "5.0.0") {
  await writeWriterState(home, "x-w1", state);
  await writeFile(writerPaths(home, "x-w1").wrapper, "wrapper");
  if (ready) await writeWriterState(home, "x-w1", { ...state, phase: "ready", acceptance: { verdict: "pass", at: "now", network: "limited", fingerprint: acceptanceFingerprint({ wrapperDigest: wrapperDigest("wrapper"), packageVersion: PACKAGE_VERSION, imageId: state.imageId, podmanVersion: version, network: state.network, cache: state.cache, ...(await writerEventDeliveryEnabled(writerPaths(home, "x-w1").config) ? { eventDelivery: true } : {}) }) } });
}
it.each(["throw", "error"])("reports a Podman spawn %s once without leaking error details", async (kind) => {
  await save(); const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.mocked(deps.spawnPodman).mockImplementation(() => {
    if (kind === "throw") throw new Error("/private/path secret-token");
    setImmediate(() => { child.emit("error", new Error("/private/path secret-token")); child.emit("close", -2); });
    return child;
  });
  expect(await launchEntry(["x-w1", "node", "probe"], deps)).toBe(1);
  expect(stderr.mock.calls).toEqual([[JSON.stringify({ level: "error", event: "writer_launch_failed", stage: "spawn", code: "writer_launch_failed" }) + "\n"]]);
});
it("reports entry-point rejection once without leaking error details", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.mocked(serveRefusal).mockRejectedValueOnce(new Error("/private/path secret-token"));
  expect(await launchEntry([], deps)).toBe(1);
  expect(stderr.mock.calls).toEqual([[JSON.stringify({ level: "error", event: "writer_launch_failed", stage: "entry", code: "writer_launch_failed" }) + "\n"]]);
});
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
  expect(deps.spawnPodman).toHaveBeenCalledWith(serveArgs(writerPaths(home, "x-w1"), state, ["node", "/opt/pi-session-mcp/dist/main.js"], "/release", undefined, { name: "x-w1" }), [42]);
  expect(credentials.writeBoundaryCredentials).not.toHaveBeenCalled(); expect(credentials.refreshHostCredential).not.toHaveBeenCalled();
});
it("invalidates acceptance when current wrapper bytes change", async () => {
  await save(true); await writeFile(writerPaths(home, "x-w1").wrapper, "changed");
  await launch(["x-w1"], deps);
  expect(serveRefusal).toHaveBeenCalledWith("writer_not_ready"); expect(deps.spawnPodman).not.toHaveBeenCalled();
});
it("allows a probe before acceptance", async () => {
  await save(); await launch(["x-w1", "node", "-", "cfg"], deps);
  expect(deps.spawnPodman).toHaveBeenCalledWith(serveArgs(writerPaths(home, "x-w1"), state, ["node", "-", "cfg"], "/release", undefined, { name: "x-w1" }), [42]);
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
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGINT");
  child.emit("close", 0); expect(await running).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000); expect(credentials.writeBoundaryCredentials).toHaveBeenCalledTimes(6);
});
it("logs a sanitized periodic refresh failure and retries on the next tick", async () => {
  await save(); deps.env = {}; vi.mocked(deps.spawnPodman).mockReturnValue(child);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const running = launch(["x-w1", "node", "probe"], deps);
  await vi.waitFor(() => expect(deps.spawnPodman).toHaveBeenCalled());
  vi.mocked(credentials.writeBoundaryCredentials).mockRejectedValueOnce(new Error("/private/path secret-token"));
  tick();
  await vi.waitFor(() => expect(stderr).toHaveBeenCalledTimes(1));
  expect(stderr.mock.calls).toEqual([[JSON.stringify({ level: "warning", event: "writer_refresh_failed", code: "writer_refresh_failed" }) + "\n"]]);
  tick();
  await vi.waitFor(() => expect(credentials.writeBoundaryCredentials).toHaveBeenCalledTimes(3));
  expect(stderr).toHaveBeenCalledTimes(1);
  expect(serveRefusal).not.toHaveBeenCalled();
  child.emit("close", 0); expect(await running).toBe(0);
  expect(deps.clearInterval).toHaveBeenCalled();
});
it("reads fresh credentials, copies after failed refresh, skips overlapping ticks and clears on exit", async () => {
  await save(); deps.env = {};
  const { mkdir } = await import("node:fs/promises"); const host = join(home, ".pi", "agent"); await mkdir(host, { recursive: true });
  await writeFile(join(host, "auth.json"), JSON.stringify({ openai: { type: "oauth", expires: 1, access: "first" } }));
  vi.mocked(credentials.refreshHostCredential).mockRejectedValueOnce(new Error("failed"));
  vi.mocked(deps.spawnPodman).mockReturnValue(child);
  const running = launch(["x-w1", "node", "-", "cfg"], deps);
  await vi.waitFor(() => expect(deps.spawnPodman).toHaveBeenCalled());
  expect(credentials.refreshHostCredential).toHaveBeenCalledWith({ authPath: join(home, ".pi", "agent", "auth.json"), provider: "openai", minOAuthValidityMs: 600_000, timeoutMs: 20_000 });
  expect(credentials.writeBoundaryCredentials).toHaveBeenCalledWith(writerPaths(home, "x-w1").agent, { openai: { type: "oauth", expires: 1, access: "first", refresh: "" } });
  await writeFile(join(host, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fresh" } }));
  tick(); await vi.waitFor(() => expect(credentials.writeBoundaryCredentials).toHaveBeenCalledTimes(2));
  expect(credentials.writeBoundaryCredentials).toHaveBeenLastCalledWith(writerPaths(home, "x-w1").agent, { openai: { type: "api_key", key: "fresh" } });
  await writeFile(join(host, "auth.json"), JSON.stringify({ openai: { type: "oauth", expires: 1 } }));
  let finishRefresh!: () => void;
  vi.mocked(credentials.refreshHostCredential).mockImplementation(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));
  tick(); await vi.waitFor(() => expect(credentials.refreshHostCredential).toHaveBeenCalledTimes(2));
  for (let i = 0; i < 5; i++) tick();
  expect(credentials.refreshHostCredential).toHaveBeenCalledTimes(2);
  child.emit("close", 0); finishRefresh(); await running; expect(deps.clearInterval).toHaveBeenCalled();
});
it("refreshes an OAuth token 8 minutes from expiry with the threshold validity and copies the refreshed credentials", async () => {
  await save(); deps.env = {};
  const { mkdir } = await import("node:fs/promises"); const host = join(home, ".pi", "agent"); await mkdir(host, { recursive: true });
  const now = deps.now();
  await writeFile(join(host, "auth.json"), JSON.stringify({ openai: { type: "oauth", expires: now + 8 * 60_000, access: "old" } }));
  const warmup = vi.fn(async () => {
    await writeFile(join(host, "auth.json"), JSON.stringify({ openai: { type: "oauth", expires: now + 60 * 60_000, access: "new" } }));
  });
  deps.warmupHostCredential = warmup;
  vi.mocked(deps.spawnPodman).mockReturnValue(child);
  const running = launch(["x-w1", "node", "-", "cfg"], deps);
  await vi.waitFor(() => expect(deps.spawnPodman).toHaveBeenCalled());
  expect(warmup).toHaveBeenCalledWith({ authPath: join(home, ".pi", "agent", "auth.json"), provider: "openai", minOAuthValidityMs: 600_000, timeoutMs: 20_000 });
  expect(credentials.refreshHostCredential).not.toHaveBeenCalled();
  expect(credentials.writeBoundaryCredentials).toHaveBeenCalledWith(writerPaths(home, "x-w1").agent, { openai: { type: "oauth", expires: now + 60 * 60_000, access: "new", refresh: "" } });
  child.emit("close", 0); await running;
});
it("copies an OAuth token 20 minutes from expiry without refreshing it", async () => {
  await save(); deps.env = {};
  const { mkdir } = await import("node:fs/promises"); const host = join(home, ".pi", "agent"); await mkdir(host, { recursive: true });
  const now = deps.now();
  await writeFile(join(host, "auth.json"), JSON.stringify({ openai: { type: "oauth", expires: now + 20 * 60_000, access: "token" } }));
  vi.mocked(deps.spawnPodman).mockReturnValue(child);
  const running = launch(["x-w1", "node", "-", "cfg"], deps);
  await vi.waitFor(() => expect(deps.spawnPodman).toHaveBeenCalled());
  tick(); await vi.waitFor(() => expect(credentials.writeBoundaryCredentials).toHaveBeenCalledTimes(2));
  expect(credentials.refreshHostCredential).not.toHaveBeenCalled();
  expect(credentials.writeBoundaryCredentials).toHaveBeenLastCalledWith(writerPaths(home, "x-w1").agent, { openai: { type: "oauth", expires: now + 20 * 60_000, access: "token", refresh: "" } });
  child.emit("close", 0); await running;
});
it("never refreshes API-key providers", async () => {
  await save(); deps.env = {};
  const { mkdir } = await import("node:fs/promises"); const host = join(home, ".pi", "agent"); await mkdir(host, { recursive: true });
  await writeFile(join(host, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "key" } }));
  vi.mocked(deps.spawnPodman).mockReturnValue(child);
  const running = launch(["x-w1", "node", "-", "cfg"], deps);
  await vi.waitFor(() => expect(deps.spawnPodman).toHaveBeenCalled());
  tick(); await vi.waitFor(() => expect(credentials.writeBoundaryCredentials).toHaveBeenCalledTimes(2));
  expect(credentials.refreshHostCredential).not.toHaveBeenCalled();
  expect(credentials.writeBoundaryCredentials).toHaveBeenLastCalledWith(writerPaths(home, "x-w1").agent, { openai: { type: "api_key", key: "key" } });
  child.emit("close", 0); await running;
});
it("still copies the host credentials without new logging when the refresh fails", async () => {
  await save(); deps.env = {};
  const { mkdir } = await import("node:fs/promises"); const host = join(home, ".pi", "agent"); await mkdir(host, { recursive: true });
  const now = deps.now();
  await writeFile(join(host, "auth.json"), JSON.stringify({ openai: { type: "oauth", expires: now + 8 * 60_000, access: "old" } }));
  vi.mocked(credentials.refreshHostCredential).mockRejectedValueOnce(new Error("refresh failed: /private/path secret-token"));
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.mocked(deps.spawnPodman).mockReturnValue(child);
  const running = launch(["x-w1", "node", "-", "cfg"], deps);
  await vi.waitFor(() => expect(deps.spawnPodman).toHaveBeenCalled());
  expect(credentials.refreshHostCredential).toHaveBeenCalledTimes(1);
  expect(credentials.writeBoundaryCredentials).toHaveBeenCalledWith(writerPaths(home, "x-w1").agent, { openai: { type: "oauth", expires: now + 8 * 60_000, access: "old", refresh: "" } });
  // Only the existing sanitized writer_refresh_failed warning may ever be logged, and only when the copy itself fails.
  expect(stderr).not.toHaveBeenCalled();
  child.emit("close", 0); await running;
});

it.skipIf(process.platform !== "linux")("launches in lease, runtime, fence, events, credentials, spawn, timer order", async () => {
  await save(); await enableDelivery(); deps.env = {};
  const order: string[] = [];
  vi.mocked(deps.lease!.acquire).mockImplementation(async () => {
    order.push("lease"); return { fd: 42, release: vi.fn(async () => { order.push("release"); }) };
  });
  const run = vi.mocked(deps.runner.run).getMockImplementation()!;
  vi.mocked(deps.runner.run).mockImplementation(async (...args) => { order.push("runtime"); return run(...args); });
  vi.mocked(deps.ensureAbsent!).mockImplementation(async () => {
    order.push("fence");
    if (!vi.mocked(deps.spawnPodman).mock.calls.length) await expect(lstat(eventsDir())).rejects.toMatchObject({ code: "ENOENT" });
  });
  vi.mocked(credentials.writeBoundaryCredentials).mockImplementationOnce(async () => {
    expect((await lstat(eventsDir())).isDirectory()).toBe(true); order.push("credentials");
  });
  vi.mocked(deps.spawnPodman).mockImplementation(() => { order.push("spawn"); setImmediate(() => child.emit("close", 0)); return child; });
  const interval = deps.setInterval;
  deps.setInterval = vi.fn((callback, ms) => { order.push("timer"); return interval(callback, ms); });
  await launch(["x-w1", "probe"], deps);
  expect(order).toEqual(["lease", "runtime", "runtime", "fence", "credentials", "spawn", "timer", "fence", "release"]);
});
it("refuses with writer_busy and spawns no podman when the lease is held", async () => {
  vi.mocked(deps.lease!.acquire).mockRejectedValue(new WriterLeaseError("writer_busy"));
  await launch(["x-w1"], deps);
  expect(serveRefusal).toHaveBeenCalledWith("writer_busy");
  expect(deps.runner.run).not.toHaveBeenCalled(); expect(deps.spawnPodman).not.toHaveBeenCalled();
});
it("adopts PI_WRITER_LEASE_FD and does not acquire a second lease", async () => {
  await save(); deps.env.PI_WRITER_LEASE_FD = "3";
  await launch(["x-w1", "probe"], deps);
  expect(deps.lease!.adopt).toHaveBeenCalledWith(home, "x-w1", 3);
  expect(deps.lease!.acquire).not.toHaveBeenCalled();
  expect(deps.spawnPodman).toHaveBeenCalledWith(expect.arrayContaining(["--name", "pi-writer-x-w1"]), [3]);
});
it.each(["", "-1", "3x", " 3", "+3", "3.0", "1e2", "9007199254740992", "3\n", "03"])("refuses malformed inherited descriptor %j before Podman", async (fd) => {
  deps.env.PI_WRITER_LEASE_FD = fd;
  await launch(["x-w1"], deps);
  expect(serveRefusal).toHaveBeenCalledWith("writer_not_ready");
  expect(deps.lease!.adopt).not.toHaveBeenCalled(); expect(deps.runner.run).not.toHaveBeenCalled();
});
it.each(["acquire", "adopt"] as const)("maps other %s failures to writer_not_ready", async (method) => {
  if (method === "adopt") deps.env.PI_WRITER_LEASE_FD = "3";
  vi.mocked(deps.lease![method]).mockRejectedValue(new WriterLeaseError("writer_lease_unavailable"));
  await launch(["x-w1"], deps);
  expect(serveRefusal).toHaveBeenCalledWith("writer_not_ready"); expect(deps.spawnPodman).not.toHaveBeenCalled();
});
it("holds the lease while the refusal server serves and releases it on exit", async () => {
  const release = vi.fn(async () => {});
  vi.mocked(deps.lease!.acquire).mockResolvedValue({ fd: 42, release });
  let finish!: () => void;
  vi.mocked(serveRefusal).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const running = launch(["x-w1"], deps);
  await vi.waitFor(() => expect(serveRefusal).toHaveBeenCalled());
  expect(release).not.toHaveBeenCalled(); finish(); await running;
  expect(release).toHaveBeenCalledTimes(1);
});
it("refuses with writer_fenced and writes no credentials or events when absence cannot be confirmed", async () => {
  await save(); await enableDelivery(); deps.env = {};
  const paths = writerPaths(home, "x-w1"); await mkdir(paths.agent);
  await writeFile(join(paths.agent, "auth.json"), "unchanged");
  vi.mocked(deps.ensureAbsent!).mockRejectedValue(new Error("private"));
  await launch(["x-w1", "probe"], deps);
  expect(serveRefusal).toHaveBeenCalledWith("writer_fenced");
  expect(credentials.writeBoundaryCredentials).not.toHaveBeenCalled(); expect(deps.spawnPodman).not.toHaveBeenCalled();
  const { readFile } = await import("node:fs/promises");
  expect(await readFile(join(paths.agent, "auth.json"), "utf8")).toBe("unchanged");
  await expect(lstat(paths.events)).rejects.toMatchObject({ code: "ENOENT" });
});
it.skipIf(process.platform !== "linux")("relay launch omits the events mount; legacy launch keeps it", async () => {
  await save(); await enableDelivery();
  await writeWriterState(home, "x-w1", { ...state, launch: "relay" });
  await launch(["x-w1", "probe"], deps);
  expect(vi.mocked(deps.spawnPodman).mock.calls[0]![0].join(" ")).not.toContain("/pi/events");
  await expect(lstat(eventsDir())).rejects.toMatchObject({ code: "ENOENT" });
  await writeWriterState(home, "x-w1", { ...state, launch: "legacy" });
  await launch(["x-w1", "probe"], deps);
  expect(vi.mocked(deps.spawnPodman).mock.calls[1]![0]).toContain(`${eventsDir()}:/pi/events:rw`);
});
it.skipIf(process.platform !== "linux")("on host stdin end and child close joins an outstanding refresh before releasing the lease", async () => {
  await save(); deps.env = {}; vi.mocked(deps.spawnPodman).mockReturnValue(child);
  const release = vi.fn(async () => {});
  vi.mocked(deps.lease!.acquire).mockResolvedValue({ fd: 42, release });
  const running = launch(["x-w1", "probe"], deps);
  await vi.waitFor(() => expect(deps.spawnPodman).toHaveBeenCalled());
  let finish!: () => void;
  vi.mocked(credentials.writeBoundaryCredentials).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  tick(); await vi.waitFor(() => expect(credentials.writeBoundaryCredentials).toHaveBeenCalledTimes(2));
  process.stdin.emit("end");
  // EOF reaches the child through the pipe; a finite probe must be allowed to finish on its own.
  expect(child.kill).not.toHaveBeenCalled();
  child.emit("close", 0);
  await Promise.resolve(); expect(release).not.toHaveBeenCalled();
  finish(); await running;
  expect(release).toHaveBeenCalledTimes(1); expect(deps.ensureAbsent).toHaveBeenCalledTimes(2);
});
it("on SIGHUP forwards SIGTERM to podman once and releases after the child closes", async () => {
  await save(); vi.mocked(deps.spawnPodman).mockReturnValue(child);
  const release = vi.fn(async () => {});
  vi.mocked(deps.lease!.acquire).mockResolvedValue({ fd: 42, release });
  const running = launch(["x-w1", "probe"], deps);
  await vi.waitFor(() => expect(deps.spawnPodman).toHaveBeenCalled());
  process.emit("SIGHUP"); process.emit("SIGTERM");
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM"); expect(release).not.toHaveBeenCalled();
  child.emit("close", 0); await running; expect(release).toHaveBeenCalledTimes(1);
});
it.each([false, true])("force-removes after LAUNCHER_CLEANUP_BOUND_MS and confirms absence even if rm fails (%s)", async (rmFails) => {
  await save(); vi.mocked(deps.spawnPodman).mockReturnValue(child);
  const running = launch(["x-w1", "probe"], deps);
  await vi.waitFor(() => expect(deps.spawnPodman).toHaveBeenCalled());
  if (rmFails) vi.mocked(deps.runner.run).mockRejectedValue(new Error("rm failed"));
  vi.useFakeTimers(); process.emit("SIGTERM");
  await vi.advanceTimersByTimeAsync(LAUNCHER_CLEANUP_BOUND_MS - 1);
  expect(deps.runner.run).not.toHaveBeenCalledWith("podman", expect.arrayContaining(["rm"]), expect.anything(), expect.anything());
  await vi.advanceTimersByTimeAsync(1); expect(await running).toBe(1);
  expect(deps.runner.run).toHaveBeenCalledWith("podman", ["rm", "-f", "-t", "0", "pi-writer-x-w1"], expect.any(AbortSignal), { inheritFds: [42] });
  expect(deps.ensureAbsent).toHaveBeenCalledTimes(2);
});

const uid = process.getuid!();
async function enableDelivery(config: unknown = { events: { delivery: "spool" } }) {
  const paths = writerPaths(home, "x-w1");
  await mkdir(paths.config, { recursive: true });
  await chmod(paths.root, 0o700); // setup creates the writer state directory private
  await writeFile(join(paths.config, "pi-session-mcp.json"), JSON.stringify(config));
}
// The spool cleanup needs /proc/self/fd; writers are Linux-only in the product.
const itLinux = it.runIf(process.platform === "linux");
const eventsFailure = JSON.stringify({ level: "error", event: "writer_launch_failed", stage: "events", code: "events_directory_unavailable" }) + "\n";
const eventsDir = () => writerPaths(home, "x-w1").events;
itLinux("mounts a freshly created private spool directory of the writer when its configuration enables delivery", async () => {
  await enableDelivery(); await save(true);
  const dir = eventsDir();
  expect(dir).toBe(join(writerPaths(home, "x-w1").root, "events"));
  expect(await launch(["x-w1"], deps)).toBe(7);
  expect(deps.spawnPodman).toHaveBeenCalledWith(serveArgs(writerPaths(home, "x-w1"), state, ["node", "/opt/pi-session-mcp/dist/main.js"], "/release", dir, { name: "x-w1" }), [42]);
  const args = vi.mocked(deps.spawnPodman).mock.calls[0]![0];
  expect(args).toContain(`${dir}:/pi/events:rw`); expect(args).toContain("PI_SESSION_MCP_EVENTS_DIR=/pi/events");
  expect((await lstat(dir)).mode & 0o777).toBe(0o700);
  expect(serveRefusal).not.toHaveBeenCalled();
});
itLinux("needs no runtime directory for writer delivery", async () => {
  await enableDelivery(); await save(true);
  for (const env of [{}, { XDG_RUNTIME_DIR: "relative" }, { XDG_RUNTIME_DIR: join(home, "absent") }]) {
    deps.env = { PI_WRITER_NO_CREDENTIAL_REFRESH: "1", ...env };
    expect(await launch(["x-w1"], deps)).toBe(7);
  }
  expect(deps.spawnPodman).toHaveBeenCalledTimes(3);
  expect(serveRefusal).not.toHaveBeenCalled();
  await expect(lstat(join(home, "absent"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses a writer accepted without delivery once its configuration enables delivery", async () => {
  await save(true);
  await enableDelivery();
  expect(await launch(["x-w1"], deps)).toBe(0);
  expect(serveRefusal).toHaveBeenCalledWith("writer_not_ready"); expect(deps.spawnPodman).not.toHaveBeenCalled();
  await expect(lstat(eventsDir())).rejects.toMatchObject({ code: "ENOENT" });
});
itLinux("mounts the spool directory for a probe launch too, and reuses an existing one", async () => {
  await enableDelivery(); await save();
  const dir = eventsDir();
  await launch(["x-w1", "node", "-"], deps); await launch(["x-w1", "node", "-"], deps);
  expect(deps.spawnPodman).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(deps.spawnPodman).mock.calls) expect(call[0]).toEqual(serveArgs(writerPaths(home, "x-w1"), state, ["node", "-"], "/release", dir, { name: "x-w1" }));
});
it.each([
  ["no events field", { workspaces: {} }],
  ["an unexpected delivery value", { events: { delivery: "off" } }],
  ["extra events keys", { events: { delivery: "spool", extra: true } }],
  ["a non-object events field", { events: "spool" }],
])("adds no mount and creates no directory with %s", async (_label, config) => {
  await enableDelivery(config); await save(true);
  await launch(["x-w1"], deps);
  expect(deps.spawnPodman).toHaveBeenCalledWith(serveArgs(writerPaths(home, "x-w1"), state, ["node", "/opt/pi-session-mcp/dist/main.js"], "/release", undefined, { name: "x-w1" }), [42]);
  await expect(lstat(eventsDir())).rejects.toMatchObject({ code: "ENOENT" });
});
it("adds no mount without a writer configuration file", async () => {
  await save(true);
  await launch(["x-w1"], deps);
  expect(vi.mocked(deps.spawnPodman).mock.calls[0]![0].join(" ")).not.toContain("/pi/events");
});
it.each([
  ["a group-accessible writer state directory", async () => { await chmod(writerPaths(home, "x-w1").root, 0o770); }],
  ["a symlinked spool directory", async () => {
    const outside = join(home, "outside");
    await mkdir(outside, { mode: 0o700 }); await symlink(outside, eventsDir());
  }],
])("fails the launch with a stable sanitized code for %s", async (_label, damage) => {
  await enableDelivery(); await save(true); await damage();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(await launch(["x-w1"], deps)).toBe(0);
  expect(serveRefusal).toHaveBeenCalledWith("writer_not_ready"); expect(deps.spawnPodman).not.toHaveBeenCalled();
  expect(stderr.mock.calls).toEqual([[eventsFailure]]);
  expect(eventsFailure).not.toContain(home);
});
it("fails the launch when the writer state directory belongs to another user", async () => {
  await enableDelivery(); await save(true); deps.uid = () => uid + 1;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await launch(["x-w1"], deps);
  expect(serveRefusal).toHaveBeenCalledWith("writer_not_ready"); expect(deps.spawnPodman).not.toHaveBeenCalled();
  expect(stderr.mock.calls).toEqual([[eventsFailure]]);
});
it("does not refresh credentials when the spool directory fails", async () => {
  await enableDelivery(); await save(true); deps.env = {}; deps.uid = () => uid + 1;
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await launch(["x-w1"], deps);
  expect(credentials.writeBoundaryCredentials).not.toHaveBeenCalled();
});
itLinux("repairs a changed mode and removes junk but leaves a possibly live instance directory alone", async () => {
  await enableDelivery(); await save(true);
  const dir = eventsDir(), live = join(dir, "inst-0123456789abcdef");
  await mkdir(live, { recursive: true, mode: 0o700 });
  await writeFile(join(live, "00000001-turn_terminal.json"), "{}");
  await writeFile(join(dir, "stray"), "x"); await mkdir(join(dir, "junk")); await chmod(dir, 0o777);
  let seen: string[] | undefined, mode: number | undefined;
  const { readdir } = await import("node:fs/promises");
  vi.mocked(deps.spawnPodman).mockImplementation(() => {
    void Promise.all([readdir(dir), lstat(dir)]).then(([names, stat]) => { seen = names; mode = stat.mode & 0o777; });
    setImmediate(() => child.emit("close", 7)); return child;
  });
  expect(await launch(["x-w1"], deps)).toBe(7);
  await vi.waitFor(() => expect(seen).toEqual(["inst-0123456789abcdef"]));
  expect(mode).toBe(0o700);
  expect(await readdir(live)).toEqual(["00000001-turn_terminal.json"]);
  expect(serveRefusal).not.toHaveBeenCalled();
});
