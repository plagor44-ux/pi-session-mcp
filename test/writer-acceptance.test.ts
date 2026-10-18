import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acceptWriter, controlStatePath, runIsolationControl } from "../src/writer-acceptance.js";
import { readWriterState, writerPaths, writeWriterState, type WriterState } from "../src/writer-state.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture(exitCode = 0, classification = "not_limited") {
  const home = await mkdtemp(join(tmpdir(), "accept-writer-")); roots.push(home);
  const paths = writerPaths(home, "repo-w1");
  const state: WriterState = { schemaVersion: 1, alias: "repo", index: 1, phase: "not_ready", lifecycle: "persistent", profiles: ["coding"], providers: [], network: "pasta", cache: "none", imageId: "a".repeat(64), base: { ref: "refs/heads/main", commit: "b".repeat(40) } };
  await writeWriterState(home, "repo-w1", state);
  await writeFile(paths.wrapper, "wrapper");
  const run = vi.fn(async (command: string, args: readonly string[], signal?: AbortSignal) => {
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
  expect((await acceptWriter(ctx, "repo-w1")).code).toBe(pass ? "writer_accepted" : "writer_acceptance_failed");
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
