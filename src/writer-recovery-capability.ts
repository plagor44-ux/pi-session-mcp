import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { IMAGE_PULL_TIMEOUT_MS } from "./writer-boundary.js";
import type { WriterContext } from "./writer-lifecycle.js";

/** Shared by the capability probe and import, so they exercise the identical transaction form. */
export function recoveryTransactionArgs(creates: readonly string[]): string[] {
  // CommandRunner has no stdin channel. The caller supplies only validated ref names and OIDs.
  const commands = ["start", ...creates, "prepare", "commit"].join("\n");
  return ["-c", `alias.writer-recovery=!LC_ALL=C git update-ref --no-deref --stdin <<'RECOVERY_REFS'\n${commands}\nRECOVERY_REFS`, "writer-recovery"];
}

/**
 * The Git environment for the probe and the host import alike: no inherited `GIT_*` redirection
 * (`GIT_DIR`, `GIT_EXEC_PATH`, object directories, templates) and no global or system configuration.
 * Repository-local configuration still applies to the import; callers pin what matters with `-c`.
 */
export function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith("GIT_")).map(key => [key, undefined]));
  return Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
}

/** Offline behavioral check, never in the operator checkout and never cached across operations. */
export async function probeRecoveryRefTransactions(ctx: Pick<WriterContext, "runner" | "checkout" | "leaseFd">): Promise<boolean> {
  let directory: string | undefined;
  let supported = false;
  try {
    directory = await mkdtemp(join(tmpdir(), "pi-recovery-probe-"));
    const fromCheckout = relative(await realpath(ctx.checkout), await realpath(directory));
    if (fromCheckout === "" || (!isAbsolute(fromCheckout) && fromCheckout !== ".." && !fromCheckout.startsWith("../"))) throw Error("probe location refused");
    // Do not inherit Git redirection, object storage, templates, identity or configuration from the host.
    const env = isolatedGitEnvironment();
    const run = (...args: string[]) => ctx.runner.run("git", [
      "-c", "core.hooksPath=/dev/null", "-c", "core.useReplaceRefs=false", "-C", directory!, ...args,
    ], AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS), { env, ...(ctx.leaseFd === undefined ? {} : { inheritFds: [ctx.leaseFd] }) });
    const git = async (...args: string[]) => {
      const r = await run(...args);
      if (r.exitCode !== 0) throw Error("probe command failed");
      return r.stdout.trim();
    };
    await git("init", "--quiet", "--template=", "--initial-branch=probe");
    await git("-c", "user.name=pi-recovery-probe", "-c", "user.email=probe@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "--no-verify", "-m", "recovery capability probe");
    const oid = await git("rev-parse", "HEAD");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw Error("probe object refused");
    for (const [ref, target] of [["refs/heads/probe-dangling", "refs/heads/missing"], ["refs/heads/probe-existing", "refs/heads/probe"]] as const) {
      await git("symbolic-ref", ref, target);
      const transaction = await run(...recoveryTransactionArgs([`create ${ref} ${oid}`]));
      const symbolic = await run("symbolic-ref", "--quiet", ref);
      if (transaction.exitCode === 0 || symbolic.exitCode !== 0 || symbolic.stdout.trim() !== target) throw Error("unsafe ref transactions");
    }
    // Neither refusal may have written through the symbolic refs.
    if ((await run("rev-parse", "--quiet", "--verify", "refs/heads/missing")).exitCode === 0) throw Error("unsafe ref transactions");
    if (await git("rev-parse", "refs/heads/probe") !== oid) throw Error("unsafe ref transactions");
    supported = true;
  } catch { /* All probe failures refuse import; no diagnostics expose temporary paths. */ }
  finally {
    if (directory !== undefined) {
      try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }); }
      catch { supported = false; }
    }
  }
  return supported;
}
