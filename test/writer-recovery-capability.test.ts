import { lstat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/client-adapters/types.js";
import { recoverWriter } from "../src/writer-recover.js";
import { probeRecoveryRefTransactions } from "../src/writer-recovery-capability.js";
import { fixture, git } from "./real-git-writer-fixture.js";
import { removeTemporaryRoots } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const oid = "a".repeat(40);
function simulatedProbe(mode: "refuses" | "succeeds" | "replaces" | "throws") {
  const directories = new Set<string>(), symbolic = new Map<string, string>();
  const run = vi.fn<CommandRunner["run"]>(async (_command, args) => {
    const directory = args[args.indexOf("-C") + 1]!;
    directories.add(directory);
    if (args.includes("commit") && mode === "throws") throw Error("probe interrupted");
    if (args.includes("rev-parse")) return { exitCode: 0, stdout: oid, stderr: "" };
    if (args.includes("writer-recovery")) {
      expect(args.some(arg => /start\ncreate refs\/heads\/probe-(dangling|existing) [a-f0-9]+\nprepare\ncommit/.test(arg))).toBe(true);
      return { exitCode: mode === "succeeds" ? 0 : 128, stdout: "", stderr: "" };
    }
    if (args.includes("symbolic-ref")) {
      const ref = args[args.indexOf("symbolic-ref") + 1]!;
      if (ref !== "--quiet") symbolic.set(ref, args.at(-1)!);
      else return { exitCode: mode === "replaces" ? 1 : 0, stdout: symbolic.get(args.at(-1)!) ?? "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return { run, directories };
}
async function expectRemoved(directories: Set<string>, checkout: string) {
  expect(directories.size).toBe(1);
  for (const directory of directories) {
    expect(relative(checkout, directory).startsWith("..")).toBe(true);
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }
}
it.each(["refuses", "succeeds", "replaces", "throws"] as const)("checks behavior and removes the temporary repository when the probe %s", async mode => {
  const f = await fixture(), probe = simulatedProbe(mode);
  expect(await probeRecoveryRefTransactions({ ...f.ctx, runner: probe })).toBe(mode === "refuses");
  await expectRemoved(probe.directories, f.checkout);
  const transactions = probe.run.mock.calls.filter(([, args]) => args.includes("writer-recovery"));
  expect(transactions).toHaveLength(mode === "refuses" ? 2 : mode === "throws" ? 0 : 1);
});
it.each(["succeeds", "replaces"] as const)("fails recovery before any import fetch or ref write when an injected probe %s", async mode => {
  const f = await fixture(), probe = simulatedProbe(mode);
  const before = await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)");
  const run = vi.fn<CommandRunner["run"]>(async (command, args, signal, options) => {
    if (command === "podman") {
      await writeFile(join(f.paths.bundles, "recover.bundle"), "synthetic bundle");
      return { exitCode: 0, stdout: "recovered", stderr: "" };
    }
    const directory = args[args.indexOf("-C") + 1]!;
    if (directory !== f.checkout) return probe.run(command, args, signal, options);
    expect(args).not.toContain("fetch");
    expect(args).not.toContain("writer-recovery");
    if (args.includes("list-heads")) return { exitCode: 0, stdout: `${oid} refs/heads/recovery/worktree\n${oid} refs/heads/recovery/manifest\n`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  expect(await recoverWriter({ ...f.ctx, runner: { run } }, "repo-w1")).toEqual({ status: "failed", code: "writer_recover_failed" });
  expect(await git(f.checkout, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(before);
  await expect(lstat(join(f.paths.bundles, "recover.bundle"))).rejects.toMatchObject({ code: "ENOENT" });
  await expectRemoved(probe.directories, f.checkout);
});
