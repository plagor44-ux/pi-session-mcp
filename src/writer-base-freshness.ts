import { join } from "node:path";
import { trustedGit, type SnapshotGit } from "./review-snapshot.js";
import { isSafeRefName } from "./writer-boundary.js";
import { writerBaseSource } from "./writer-lifecycle.js";
import { writerPaths } from "./writer-state.js";

/** One comparison, bounded so that it cannot noticeably delay a start (#254). */
export const BASE_FRESHNESS_DEADLINE_MS = 2_000;
export type BaseFreshness = "current" | "behind" | "unknown";
export interface BaseFreshnessRequest {
  readonly home: string;
  readonly name: string;
  /** The operator's checkout, never the writer's clone. */
  readonly checkout: string;
  readonly base: { readonly ref: string; readonly commit: string };
}
export interface BaseFreshnessOptions {
  readonly git?: SnapshotGit | undefined;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

async function compare({ home, name, checkout, base }: BaseFreshnessRequest, git: SnapshotGit, signal: AbortSignal): Promise<BaseFreshness> {
  if (!COMMIT.test(base.commit)) return "unknown";
  const heads = await git.run(checkout, ["bundle", "list-heads", join(writerPaths(home, name).bundles, "base.bundle")], { signal });
  const source = writerBaseSource(heads.code === 0 ? heads.stdout : undefined, base.ref);
  if (!isSafeRefName(source)) return "unknown";
  const resolved = await git.run(checkout, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${source}^{commit}`], { signal });
  const current = resolved.stdout.trim();
  if (resolved.code !== 0 || !COMMIT.test(current)) return "unknown";
  if (current === base.commit) return "current";
  return (await git.run(checkout, ["merge-base", "--is-ancestor", base.commit, current], { signal })).code === 0 ? "behind" : "unknown";
}

/**
 * Compares a writer's recorded base commit with the commit a reset would move it to, using only
 * local, read-only Git in the operator's checkout. Every failure, and a commit that is not an
 * ancestor of the branch, is `unknown`: the answer is advice and never fails its caller.
 */
export async function writerBaseFreshness(request: BaseFreshnessRequest, options: BaseFreshnessOptions = {}): Promise<BaseFreshness> {
  const git = "git" in options ? options.git : trustedGit({ timeoutMs: options.deadlineMs ?? BASE_FRESHNESS_DEADLINE_MS });
  if (!git) return "unknown";
  const deadline = AbortSignal.timeout(options.deadlineMs ?? BASE_FRESHNESS_DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  let cancel: (() => void) | undefined;
  try {
    // Race the signal as well: an injected Git, like a stopped one within its grace, may not settle at once.
    return await Promise.race([
      compare(request, git, signal),
      new Promise<BaseFreshness>((resolve) => {
        cancel = () => { resolve("unknown"); };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      }),
    ]);
  } catch { return "unknown"; }
  finally { if (cancel) signal.removeEventListener("abort", cancel); }
}
