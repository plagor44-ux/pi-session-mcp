import { realpath } from "node:fs/promises";
import type { WorkspaceModeEntry } from "./execution-modes.js";
import { lockSnapshotShared, readSnapshotState, snapshotPaths, SnapshotError, verifySnapshot, type SnapshotBinding, type SnapshotGit } from "./review-snapshot.js";

export interface SnapshotSessionLease {
  readonly binding: SnapshotBinding;
  verify(): Promise<void>;
  release(): Promise<void>;
}
export interface SnapshotGuard {
  isSnapshot(workspace: string): boolean;
  acquire(workspace: string, cwd: string, signal?: AbortSignal): Promise<SnapshotSessionLease>;
}
export function createSnapshotGuard(options: {
  home: string;
  workspaceModes: ReadonlyMap<string, WorkspaceModeEntry>;
  git: SnapshotGit | undefined;
  lockOptions?: Omit<NonNullable<Parameters<typeof lockSnapshotShared>[1]>, "signal">;
}): SnapshotGuard {
  return {
    isSnapshot: (workspace) => options.workspaceModes.get(workspace)?.mode === "snapshot",
    async acquire(workspace, cwd, signal) {
      const mode = options.workspaceModes.get(workspace);
      if (mode?.mode !== "snapshot" || !mode.snapshot || !options.git || signal?.aborted) throw new SnapshotError("snapshot_unavailable");
      const paths = snapshotPaths(options.home, workspace);
      try {
        if (await realpath(cwd) !== await realpath(paths.worktree)) throw new Error();
      } catch { throw new SnapshotError("snapshot_unavailable"); }
      const lock = await lockSnapshotShared(paths, { ...options.lockOptions, ...(signal ? { signal } : {}) });
      try {
        const state = await readSnapshotState(paths);
        if (!state || state.source !== mode.snapshot.source || signal?.aborted) throw new SnapshotError("snapshot_unavailable");
        const binding = { base: state.base, head: state.head, tree: state.tree };
        const git = options.git;
        await verifySnapshot(git, paths.worktree, binding);
        if (signal?.aborted) throw new SnapshotError("snapshot_unavailable");
        return { binding, verify: () => verifySnapshot(git, paths.worktree, binding), release: () => lock.release() };
      } catch (error) {
        await lock.release();
        if (error instanceof SnapshotError && error.code !== "snapshot_incomplete") throw error;
        throw new SnapshotError("snapshot_unavailable");
      }
    },
  };
}
