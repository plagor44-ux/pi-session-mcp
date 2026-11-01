import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { runWriterOperation, type WriterSetupDependencies } from "../src/setup-writers.js";
import { parseSetupArgs, formatSetupHuman } from "../src/setup-cli.js";
import { result } from "../src/setup-result.js";
import { fixture } from "./real-git-writer-fixture.js";
import { recoveryRefTransactionsSupported } from "./recovery-capability-fixture.js";
import { removeTemporaryRoots } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
async function setup() {
  const f = await fixture(), configPath = join(f.home, "config.json"), order: string[] = [];
  await writeFile(configPath, JSON.stringify({ workspaces: { repo: f.checkout }, executionProfiles: { review: { default: true, permissionProfile: "read-only", provider: "example", model: "model", thinkingLevel: "off" } } }));
  const deps: WriterSetupDependencies = {
    configPath, home: f.home, releaseRoot: f.home, platform: "linux", runner: f.runner,
    lock: vi.fn(async () => { order.push("lock"); return { release: async () => { order.push("unlock"); } }; }),
    lease: vi.fn(async () => { order.push("lease"); return { fd: 42, release: async () => { order.push("release"); } }; }),
    ensureAbsent: vi.fn(async () => { order.push("fence"); }),
    doctor: vi.fn(async () => { order.push("doctor"); return { schemaVersion: 1 as const, ok: true, exitCode: 0 as const, checks: [] }; }),
  };
  return { ...f, deps, order };
}
it("parses recover dry runs and explicit apply with the writer exclusivity rules", () => {
  expect(parseSetupArgs(["--writer", "repo-w1", "--recover"]).writer).toEqual({ name: "repo-w1", operation: "recover", apply: false, discard: false });
  expect(parseSetupArgs(["--writer", "repo-w1", "--recover", "--apply"]).writer?.apply).toBe(true);
  for (const extra of [["--collect"], ["--reset"], ["--recreate"], ["--finish"], ["--verify"], ["--remove"], ["--discard"], ["--base", "main"], ["--repo", "repo"], ["--target", "codex:user:x"]]) {
    expect(() => parseSetupArgs(["--writer", "repo-w1", "--recover", ...extra])).toThrow();
  }
  expect(() => parseSetupArgs(["--recover"])).toThrow();
});
it("dry run resolves only the alias, without state, lock, lease, fence or Doctor", async () => {
  const f = await setup(); await rm(f.paths.state);
  const out = await runWriterOperation("repo-w1", "recover", { apply: false, discard: false }, f.deps);
  expect(out.findings).toEqual([{ target: { client: "writer", scope: "repo", alias: "repo-w1" }, status: "planned", code: "writer_recover_planned" }]);
  expect(f.order).toEqual([]);
  expect((await runWriterOperation("unknown-w1", "recover", { apply: false, discard: false }, f.deps)).findings[0]?.code).toBe("alias_unknown");
});
// Writer leases and the fence are Linux-only, as for the other writer operations in setup-writers.test.ts.
it.skipIf(process.platform !== "linux")("fences a leftover container before Doctor and recovery, and holds both locks", async () => {
  const f = await setup();
  let leftover = true;
  const runner = { run: vi.fn(async (...args: Parameters<typeof f.runner.run>) => {
    if (args[0] === "podman" && args[1][0] === "ps") return { exitCode: 0, stdout: JSON.stringify(leftover ? [{ Id: "c".repeat(64), Names: ["leftover"] }] : []), stderr: "" };
    if (args[0] === "podman" && args[1][0] === "rm") { leftover = false; return { exitCode: 0, stdout: "", stderr: "" }; }
    expect(f.order).toEqual(["lock", "lease", "doctor"]);
    expect(args[3]?.inheritFds).toEqual([42]);
    return f.runner.run(...args);
  }) };
  const { ensureAbsent: _fence, ...deps } = f.deps;
  const out = await runWriterOperation("repo-w1", "recover", { apply: true, discard: false }, { ...deps, runner });
  expect(out.findings[0]?.code).toBe("nothing_to_recover");
  expect(runner.run.mock.calls.some(([c, a]) => c === "podman" && a[0] === "rm")).toBe(true);
  expect(f.order).toEqual(["lock", "lease", "doctor", "release", "unlock"]);
});
it("Doctor refusal takes precedence over missing state", async () => {
  const f = await setup(); await rm(f.paths.state);
  const doctor: WriterSetupDependencies["doctor"] = async () => ({ schemaVersion: 1, ok: false, exitCode: 1, checks: [{ id: "config_invalid", subject: "config", severity: "error", message: "invalid" }] });
  const out = await runWriterOperation("repo-w1", "recover", { apply: true, discard: false }, { ...f.deps, doctor });
  expect(out.findings[0]?.code).toBe("doctor_failed");
  expect(f.order).toEqual(["lock", "lease", "fence", "release", "unlock"]);
});
it("reports missing state only after the Doctor gate", async () => {
  const f = await setup(); await rm(f.paths.state);
  const out = await runWriterOperation("repo-w1", "recover", { apply: true, discard: false }, f.deps);
  expect(out.findings[0]?.code).toBe("writer_recover_failed");
  expect(f.order).toEqual(["lock", "lease", "fence", "doctor", "release", "unlock"]);
});
it.skipIf(!recoveryRefTransactionsSupported)("reports a complete recovery and earlier incomplete slots through setup", async () => {
  const f = await setup();
  await f.work("checkout", "-b", "other"); await f.commit("other", "base.txt", "other\n");
  await f.work("checkout", "main"); await f.commit("main", "base.txt", "main\n");
  const merge = await f.runner.run("git", ["-C", f.paths.clone, "merge", "other"]);
  expect(merge.exitCode).not.toBe(0);
  const imported = await f.runner.run("git", ["-C", f.checkout, "update-ref", "refs/recovery/writer-repo-w1/1/worktree", "HEAD"]);
  expect(imported.exitCode).toBe(0);
  const out = await runWriterOperation("repo-w1", "recover", { apply: true, discard: false }, f.deps);
  expect(out.exitCode).toBe(0);
  expect(out.findings).toEqual([
    { target: { client: "writer", scope: "repo", alias: "repo-w1" }, status: "ok", code: "writer_recovered", slot: 2 },
    { target: { client: "writer", scope: "repo", alias: "repo-w1" }, status: "unchanged", code: "writer_recover_incomplete", slot: 1 },
  ]);
});
it("exposes a sanitized numeric slot in both report formats", () => {
  const out = result("apply", [{ target: { client: "writer", scope: "repo", alias: "repo-w1" }, status: "ok", code: "writer_recovered", slot: 7 }]);
  expect(out.findings[0]?.slot).toBe(7);
  expect(formatSetupHuman(out)).toContain("writer_recovered, slot 7");
});
