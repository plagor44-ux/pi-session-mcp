import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acceptWriter, controlStatePath, runIsolationControl } from "../src/writer-acceptance.js";
import { acceptanceFingerprint, currentAcceptanceFingerprint, readWriterState, writerPaths, writeWriterState, type WriterState } from "../src/writer-state.js";
import { PACKAGE_VERSION } from "../src/package-metadata.js";
import { wrapperDigest } from "../src/writer-wrapper.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture(exitCode = 0, classification = "not_limited") {
  const home = await mkdtemp(join(tmpdir(), "accept-writer-")); roots.push(home);
  const paths = writerPaths(home, "repo-w1");
  const state: WriterState = { schemaVersion: 1, alias: "repo", index: 1, phase: "not_ready", lifecycle: "persistent", profiles: ["coding"], providers: [], network: "pasta", cache: "none", imageId: "a".repeat(64), base: { ref: "refs/heads/main", commit: "b".repeat(40) } };
  await writeWriterState(home, "repo-w1", state);
  await writeFile(paths.wrapper, "wrapper");
  const run = vi.fn(async (command: string, args: readonly string[], signal?: AbortSignal, _options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    if (command === "podman") return { exitCode: 0, stdout: args[0] === "info" ? "true" : "5.4.0", stderr: "" };
    if (command === "git") { await mkdir(args.at(-1)!, { recursive: true }); return { exitCode: 0, stdout: "", stderr: "" }; }
    const out = args[args.indexOf("--out") + 1]!;
    await expect(readFile(out)).rejects.toThrow();
    await writeFile(out, JSON.stringify({ verdict: args.includes("uncontained-control") ? "control_detected_escapes" : "pass", network: { classification } }));
    return { exitCode, stdout: "ignored", stderr: "ignored" };
  });
  const ctx = { home, releaseRoot: "/release", checkout: "/checkout", alias: "repo", nodePath: process.execPath, runner: { run } };
  return { ctx, paths, run };
}
it("requires control without spawning", async () => {
  const { ctx, run } = await fixture();
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe("isolation_control_required"); expect(run).not.toHaveBeenCalled();
});
it.each([[0, "not_limited", true], [0, "limited", true], [1, "not_limited", false], [0, "not_recorded", false]])("accepts only proven reports %s %s", async (exit, network, pass) => {
  const { ctx, run } = await fixture(exit, network);
  await writeFile(controlStatePath(ctx.home), JSON.stringify({ schemaVersion: 1, verdict: "control_detected_escapes", at: "now" }));
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe(pass ? "writer_accepted" : "acceptance_harness_failed");
  const state = await readWriterState(ctx.home, "repo-w1");
  expect(state?.phase).toBe(pass ? "ready" : "not_ready");
  if (pass) expect(state?.acceptance?.fingerprint).toMatch(/^sha256:/);
  const call = run.mock.calls.find(([cmd]) => cmd === process.execPath)!;
  expect(call[1][0]).toBe("/release/scripts/isolation-acceptance.mjs");
});
it("records a path-free successful control and uses new clones", async () => {
  const { ctx, run } = await fixture();
  for (let i = 0; i < 2; i++) expect((await runIsolationControl(ctx)).status).toBe("ok");
  const record = JSON.parse(await readFile(controlStatePath(ctx.home), "utf8"));
  expect(record).toEqual({ schemaVersion: 1, verdict: "control_detected_escapes", at: expect.any(String) });
  const clones = run.mock.calls.filter(([cmd]) => cmd === "git").map(([, args]) => args.at(-1));
  expect(new Set(clones).size).toBe(2);
});
it("overwrites a stale control pass after a throwing harness", async () => {
  const { ctx, run } = await fixture();
  const control = controlStatePath(ctx.home);
  const stale = JSON.stringify({ schemaVersion: 1, verdict: "control_detected_escapes", at: "old" });
  await writeFile(control, stale);
  const original = run.getMockImplementation()!;
  run.mockImplementation(async (command, args, signal) => {
    if (command !== ctx.nodePath) return original(command, args, signal);
    expect(JSON.parse(await readFile(control, "utf8")).verdict).toBe("fail");
    // Simulate a stale pass reappearing after the pre-emptive invalidation.
    await writeFile(control, stale);
    throw new Error("harness failed");
  });
  expect(await runIsolationControl(ctx)).toEqual({ status: "failed", code: "isolation_control_failed" });
  expect(JSON.parse(await readFile(control, "utf8")).verdict).toBe("fail");
  const clone = run.mock.calls.find(([cmd]) => cmd === "git")![1].at(-1)!;
  await expect(readdir(clone)).rejects.toThrow();
  expect(await readdir(join(ctx.home, ".local/state/pi-session-mcp/writers"))).toEqual(["repo-w1"]);
});
it("cleans the fresh disposable control clone even on harness failure", async () => {
  const { ctx, run } = await fixture(1);
  expect((await runIsolationControl(ctx)).status).toBe("failed");
  const clone = run.mock.calls.find(([cmd]) => cmd === "git")![1].at(-1)!;
  expect(clone).toMatch(/control-[^/]+\/clone$/);
  expect(run.mock.calls.find(([cmd]) => cmd === "git")![1]).toContain("--no-hardlinks");
  await expect(readdir(clone)).rejects.toThrow();
  expect(await readdir(join(ctx.home, ".local/state/pi-session-mcp/writers"))).toEqual(["repo-w1"]);
});
it.each([[false], [true]])("binds the acceptance to event delivery only when enabled (delivery %s)", async (delivery) => {
  const { ctx, paths } = await fixture();
  await writeFile(controlStatePath(ctx.home), JSON.stringify({ schemaVersion: 1, verdict: "control_detected_escapes", at: "now" }));
  await mkdir(paths.config, { recursive: true });
  if (delivery) await writeFile(join(paths.config, "pi-session-mcp.json"), JSON.stringify({ events: { delivery: "spool" } }));
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe("writer_accepted");
  const state = (await readWriterState(ctx.home, "repo-w1"))!;
  const wrapper = wrapperDigest("wrapper");
  const expected = (eventDelivery: boolean) => acceptanceFingerprint({ wrapperDigest: wrapper, packageVersion: PACKAGE_VERSION, imageId: state.imageId, podmanVersion: "5.4.0", network: state.network, cache: state.cache, ...(eventDelivery ? { eventDelivery } : {}) });
  expect(state.acceptance?.fingerprint).toBe(expected(delivery));
  expect(state.acceptance?.fingerprint === expected(!delivery)).toBe(false);
  // Changing the writer's delivery afterwards no longer matches the accepted fingerprint: it needs a new acceptance.
  await writeFile(join(paths.config, "pi-session-mcp.json"), JSON.stringify(delivery ? {} : { events: { delivery: "spool" } }));
  expect(await currentAcceptanceFingerprint(paths.wrapper, state, "5.4.0")).not.toBe(state.acceptance?.fingerprint);
});

// Failure diagnosis (#121).
async function armed(exitCode = 0, classification = "not_limited") {
  const f = await fixture(exitCode, classification);
  await writeFile(controlStatePath(f.ctx.home), JSON.stringify({ schemaVersion: 1, verdict: "control_detected_escapes", at: "now" }));
  const original = f.run.getMockImplementation()!;
  const harnessWith = (behavior: (out: string, args: readonly string[]) => Promise<{ exitCode: number }>) => {
    f.run.mockImplementation(async (command, args, signal) => {
      if (command !== f.ctx.nodePath) return original(command, args, signal);
      const result = await behavior(args[args.indexOf("--out") + 1]!, args);
      return { exitCode: result.exitCode, stdout: "", stderr: "" };
    });
  };
  const failure = async () => JSON.parse(await readFile(f.paths.acceptanceFailure, "utf8"));
  return { ...f, harnessWith, failure };
}
const phase = async (home: string) => (await readWriterState(home, "repo-w1"))?.phase;
it("returns writer_state_invalid for missing state or a foreign alias, without a record", async () => {
  const { ctx, paths } = await armed();
  expect(await acceptWriter({ ...ctx, alias: "other" }, "repo-w1")).toEqual({ status: "failed", code: "writer_state_invalid" });
  await rm(paths.state);
  expect(await acceptWriter(ctx, "repo-w1")).toEqual({ status: "failed", code: "writer_state_invalid" });
  await expect(stat(paths.acceptanceFailure)).rejects.toThrow();
});
it("returns the state error code for a malformed or unreadable state, without a record", async () => {
  const { ctx, paths } = await armed();
  await writeFile(paths.state, "{");
  expect(await acceptWriter(ctx, "repo-w1")).toEqual({ status: "failed", code: "writer_state_invalid" });
  await rm(paths.state); await mkdir(paths.state);
  expect(await acceptWriter(ctx, "repo-w1")).toEqual({ status: "failed", code: "writer_state_invalid" });
  await rm(paths.state, { recursive: true }); await writeFile(paths.state, "{}", { mode: 0o000 });
  expect(await acceptWriter(ctx, "repo-w1")).toEqual({ status: "failed", code: "writer_state_unreadable" });
  await expect(stat(paths.acceptanceFailure)).rejects.toThrow();
});
it("downgrades a ready writer and drops its acceptance when a new acceptance fails", async () => {
  const { ctx, harnessWith } = await armed();
  const ready = await readWriterState(ctx.home, "repo-w1");
  await writeWriterState(ctx.home, "repo-w1", { ...ready!, phase: "ready", acceptance: { fingerprint: "sha256:old", verdict: "pass", network: "limited", at: "then" } });
  harnessWith(async () => ({ exitCode: 1 }));
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe("acceptance_harness_failed");
  const state = await readWriterState(ctx.home, "repo-w1");
  expect(state?.phase).toBe("not_ready");
  expect(state?.acceptance).toBeUndefined();
});
it("does not follow a link placed at the record's path", async () => {
  const { ctx, paths, harnessWith } = await armed();
  const target = join(ctx.home, "elsewhere.json");
  await writeFile(target, "untouched");
  await symlink(target, paths.acceptanceFailure);
  harnessWith(async () => ({ exitCode: 2 }));
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe("acceptance_harness_failed");
  expect(await readFile(target, "utf8")).toBe("untouched");
});
it("returns podman_unavailable and records it without a harness section", async () => {
  const { ctx, run, failure } = await armed();
  const original = run.getMockImplementation()!;
  run.mockImplementation(async (command, args, signal) => command === "podman" ? { exitCode: 1, stdout: "", stderr: "" } : original(command, args, signal));
  expect(await acceptWriter(ctx, "repo-w1")).toEqual({ status: "failed", code: "podman_unavailable" });
  expect(await failure()).toEqual({ schemaVersion: 1, at: expect.any(String), code: "podman_unavailable" });
  expect(await phase(ctx.home)).toBe("not_ready");
});
it("records an absent report when the harness exits 2 without writing --out", async () => {
  const { ctx, harnessWith, failure } = await armed();
  harnessWith(async () => ({ exitCode: 2 }));
  expect(await acceptWriter(ctx, "repo-w1")).toEqual({ status: "failed", code: "acceptance_harness_failed" });
  expect(await failure()).toEqual({ schemaVersion: 1, at: expect.any(String), code: "acceptance_harness_failed",
    harness: { exitCode: 2, report: "absent", verdict: null, network: null, failedChecks: [], inconclusiveChecks: [], changedDigestGroups: [] } });
  expect(await phase(ctx.home)).toBe("not_ready");
});
it.each([["not json"], ["[1,2]"], ["null"], ['"text"']])("records an invalid report (%s)", async (content) => {
  const { ctx, harnessWith, failure } = await armed();
  harnessWith(async (out) => { await writeFile(out, content); return { exitCode: 0 }; });
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe("acceptance_harness_failed");
  expect((await failure()).harness).toMatchObject({ exitCode: 0, report: "invalid", verdict: null, network: null });
});
it("lists failed and inconclusive checks of a failing verdict and caps them", async () => {
  const { ctx, harnessWith, failure } = await armed();
  const many = Array.from({ length: 100 }, (_, i) => `check_${i}`);
  harnessWith(async (out) => {
    await writeFile(out, JSON.stringify({ verdict: "fail", network: { classification: "limited" }, failed_checks: ["env_leak", "net.egress"], inconclusive_checks: many, secret: "do-not-copy" }));
    return { exitCode: 1 };
  });
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe("acceptance_harness_failed");
  const record = await failure();
  expect(record.harness).toMatchObject({ exitCode: 1, report: "present", verdict: "fail", network: "limited", failedChecks: ["env_leak", "net.egress"] });
  expect(record.harness.inconclusiveChecks).toEqual(many.slice(0, 64));
  expect(JSON.stringify(record)).not.toContain("do-not-copy");
});
it("drops unsafe strings from the record", async () => {
  const { ctx, harnessWith, failure } = await armed();
  harnessWith(async (out) => {
    await writeFile(out, JSON.stringify({ verdict: "/home/x", network: { classification: "has space" }, failed_checks: ["/home/x", "has space", "ok_check", 7, "a".repeat(81)], inconclusive_checks: "nope" }));
    return { exitCode: 1 };
  });
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe("acceptance_harness_failed");
  const record = await failure();
  expect(record.harness).toEqual({ exitCode: 1, report: "present", verdict: null, network: null, failedChecks: ["ok_check"], inconclusiveChecks: [], changedDigestGroups: [] });
  expect(JSON.stringify(record)).not.toContain("/home");
});
it("returns acceptance_fingerprint_changed when the wrapper changes during the run", async () => {
  const { ctx, paths, harnessWith, failure } = await armed();
  harnessWith(async (out) => {
    await writeFile(out, JSON.stringify({ verdict: "pass", network: { classification: "limited" } }));
    await writeFile(paths.wrapper, "changed wrapper");
    return { exitCode: 0 };
  });
  expect(await acceptWriter(ctx, "repo-w1")).toEqual({ status: "failed", code: "acceptance_fingerprint_changed" });
  expect(await failure()).toMatchObject({ code: "acceptance_fingerprint_changed", harness: { exitCode: 0, report: "present", verdict: "pass", network: "limited" } });
  expect(await phase(ctx.home)).toBe("not_ready");
});
it("writes the record with mode 0600 and removes it after a later success", async () => {
  const { ctx, paths, harnessWith } = await armed();
  harnessWith(async () => ({ exitCode: 2 }));
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe("acceptance_harness_failed");
  expect((await stat(paths.acceptanceFailure)).mode & 0o777).toBe(0o600);
  harnessWith(async (out) => { await writeFile(out, JSON.stringify({ verdict: "pass", network: { classification: "limited" } })); return { exitCode: 0 }; });
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe("writer_accepted");
  await expect(stat(paths.acceptanceFailure)).rejects.toThrow();
  expect(await phase(ctx.home)).toBe("ready");
});
it("keeps the returned code when the record cannot be written", async () => {
  const { ctx, paths, harnessWith } = await armed();
  await mkdir(paths.acceptanceFailure); // A directory in the way makes the write fail.
  harnessWith(async () => ({ exitCode: 2 }));
  expect(await acceptWriter(ctx, "repo-w1")).toEqual({ status: "failed", code: "acceptance_harness_failed" });
});
it("keeps writer_acceptance_failed for unexpected errors and still records it", async () => {
  const { ctx, harnessWith, failure } = await armed();
  harnessWith(async () => { throw new Error("boom"); });
  expect(await acceptWriter(ctx, "repo-w1")).toEqual({ status: "failed", code: "writer_acceptance_failed" });
  expect(await failure()).toMatchObject({ code: "writer_acceptance_failed" });
  expect(await phase(ctx.home)).toBe("not_ready");
});
it.each([["absent"], ["invalid"]])("fails the isolation control on a %s report", async (kind) => {
  const { ctx, harnessWith } = await armed();
  harnessWith(async (out) => { if (kind === "invalid") await writeFile(out, "{"); return { exitCode: 2 }; });
  expect(await runIsolationControl(ctx)).toEqual({ status: "failed", code: "isolation_control_failed" });
  expect(JSON.parse(await readFile(controlStatePath(ctx.home), "utf8")).verdict).toBe("fail");
});

// Expired host token during acceptance (#131).
it("launches the harness without a credential refresh, so an expired host token cannot change the agent directory", async () => {
  const { ctx, run, harnessWith, failure } = await armed();
  let refreshed = false;
  harnessWith(async (out) => {
    const env = run.mock.calls.at(-1)![3]?.env;
    // Stands in for the writer launch refreshing the host's Pi store inside the digest window.
    refreshed = env?.PI_WRITER_NO_CREDENTIAL_REFRESH !== "1";
    await writeFile(out, JSON.stringify(refreshed
      ? { verdict: "fail", network: { classification: "limited" }, failed_checks: ["digests.preexisting_changed", "digests.preexisting_changed_after_probe"],
        digests: { groups: [{ id: "agent_dir", unchanged: false }, { id: "workspace_root", unchanged: true }] } }
      : { verdict: "pass", network: { classification: "limited" } }));
    return { exitCode: refreshed ? 1 : 0 };
  });
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe("writer_accepted");
  expect(refreshed).toBe(false);
  await expect(failure()).rejects.toThrow();
});
it("records the ids of the changed digest groups, and nothing else of them", async () => {
  const { ctx, harnessWith, failure } = await armed();
  harnessWith(async (out) => {
    await writeFile(out, JSON.stringify({ verdict: "fail", network: { classification: "limited" }, failed_checks: ["digests.preexisting_changed"],
      digests: { groups: [{ id: "agent_dir", unchanged: false, before: "0123456789ab", after: "ba9876543210" }, { id: "startup_files", unchanged: true }, { id: "/home/x", unchanged: false }, { unchanged: false }] } }));
    return { exitCode: 1 };
  });
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe("acceptance_harness_failed");
  const record = await failure();
  expect(record.harness.changedDigestGroups).toEqual(["agent_dir"]);
  expect(JSON.stringify(record)).not.toMatch(/0123456789ab|\/home/);
});

