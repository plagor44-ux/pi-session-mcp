import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { ALIAS_PATTERN } from "./execution-profile.js";
import { RegistryError } from "./session-registry.js";

export interface WriterGuard {
  check(workspace: string, openCodingSessions: number): Promise<void>;
}
export type GitProbe = (cwd: string) => Promise<{
  head: string;
  branches: { ref: string; commit: string }[];
  dirty: boolean;
  stash: boolean;
}>;
const guardSchema = z.object({
  schemaVersion: z.literal(1),
  workspace: z.string().regex(ALIAS_PATTERN),
  baseRef: z.string().startsWith("refs/heads/").refine((ref) =>
    !/[\u0000-\u0020\u007f~^:?*\[\\]/.test(ref) && !ref.includes("..") && !ref.includes("@{") &&
    ref.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"))),
  baseCommit: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/),
}).strict();
const run = promisify(execFile);
const defaultGit: GitProbe = async (cwd) => {
  const git = async (...args: string[]) => (await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.useReplaceRefs=false", ...args], { cwd, timeout: 10_000, encoding: "utf8" })).stdout;
  const [status, head, refs] = await Promise.all([
    git("status", "--porcelain=v1", "-uall"),
    git("rev-parse", "HEAD"),
    git("for-each-ref", "--format=%(refname)", "refs/heads", "refs/stash"),
  ]);
  const names = refs.trim().split("\n").filter(Boolean);
  const branches = await Promise.all(names.filter((ref) => ref.startsWith("refs/heads/")).map(async (ref) => ({ ref, commit: (await git("rev-parse", ref)).trim() })));
  return { head: head.trim(), branches, dirty: status.length > 0, stash: names.includes("refs/stash") };
};

export function createWriterGuard(guardPath: string, workspaces: ReadonlyMap<string, string>, git: GitProbe = defaultGit): WriterGuard {
  return {
    async check(workspace, openCodingSessions) {
      try {
        // Reset replaces this file by rename. Never retain the previous baseline.
        const guard = guardSchema.parse(JSON.parse(await readFile(guardPath, "utf8")) as unknown);
        if (!workspaces.has(guard.workspace)) throw new RegistryError("writer_uncollected");
        if (workspace !== guard.workspace) return;
        if (openCodingSessions > 0) throw new RegistryError("writer_busy");
        const cwd = workspaces.get(workspace);
        if (!cwd) throw new RegistryError("writer_uncollected");
        const state = await git(cwd);
        if (state.dirty || state.stash || state.head !== guard.baseCommit || state.branches.length !== 1 ||
          state.branches[0]!.ref !== guard.baseRef || state.branches[0]!.commit !== guard.baseCommit) {
          throw new RegistryError("writer_uncollected");
        }
      } catch (error) {
        if (error instanceof RegistryError && error.code === "writer_busy") throw error;
        throw new RegistryError("writer_uncollected");
      }
    },
  };
}
