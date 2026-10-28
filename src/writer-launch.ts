import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRunner } from "./client-adapters/types.js";
import { isEntryPoint } from "./entry-point.js";
import { serveRefusal, type RefusalCode } from "./refusal-server.js";
import { acquireWriterLease, adoptInheritedLease, WriterLeaseError, type WriterLease } from "./writer-lease.js";
import { ensureWriterAbsent, writerContainerName } from "./writer-fence.js";
import { createProcessRunner } from "./setup-process.js";
import { ensureWriterEventsDirectory, podmanInfo, serveArgs } from "./writer-boundary.js";
import { expiresWithin, type HostCredentialRefresh, REFRESH_INTERVAL_MS, REFRESH_THRESHOLD_MINUTES, refreshHostCredential, selectedOAuthProviders, selectBoundaryCredentials, writeBoundaryCredentials } from "./writer-credentials.js";
import { currentAcceptanceFingerprint, readWriterState, WRITER_NAME_PATTERN, writerEventDeliveryEnabled, writerPaths } from "./writer-state.js";
export { currentAcceptanceFingerprint } from "./writer-state.js";
export { renderWrapper, wrapperDigest } from "./writer-wrapper.js";
export const LAUNCHER_CLEANUP_BOUND_MS = 40_000;

export interface LaunchDependencies {
  home: string;
  releaseRoot: string;
  runner: CommandRunner;
  spawnPodman(args: string[], inheritFds: readonly number[]): ChildProcess;
  lease?: { acquire: typeof acquireWriterLease; adopt: typeof adoptInheritedLease };
  ensureAbsent?: typeof ensureWriterAbsent;
  env: NodeJS.ProcessEnv;
  /** The user id that must own the event spool directory; defaults to the process user. */
  uid?: () => number;
  now(): number;
  /** Warms up one host OAuth credential through Pi's locked store; defaults to the SDK refresh, tests inject a fake. */
  warmupHostCredential?: (input: HostCredentialRefresh) => Promise<void>;
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

function launchFailure(stage: "spawn" | "entry"): void {
  process.stderr.write(JSON.stringify({ level: "error", event: "writer_launch_failed", stage, code: "writer_launch_failed" }) + "\n");
}

function eventsFailure(): void {
  process.stderr.write(JSON.stringify({ level: "error", event: "writer_launch_failed", stage: "events", code: "events_directory_unavailable" }) + "\n");
}

export async function launchEntry(argv: readonly string[], deps: LaunchDependencies): Promise<number> {
  try { return await launch(argv, deps); }
  catch { launchFailure("entry"); return 1; }
}

export async function launch(argv: readonly string[], deps: LaunchDependencies): Promise<number> {
  const name = argv[0];
  if (!name || !WRITER_NAME_PATTERN.test(name)) { await serveRefusal("writer_not_ready"); return 0; }
  const inherited = deps.env.PI_WRITER_LEASE_FD;
  if (inherited !== undefined && (!Number.isSafeInteger(Number(inherited)) || Number(inherited) < 0 || String(Number(inherited)) !== inherited)) {
    await serveRefusal("writer_not_ready"); return 0;
  }
  let lease: WriterLease;
  try {
    lease = inherited === undefined
      ? await (deps.lease?.acquire ?? acquireWriterLease)(deps.home, name, { waitMs: 0 })
      : await (deps.lease?.adopt ?? adoptInheritedLease)(deps.home, name, Number(inherited));
  } catch (error) {
    await serveRefusal(error instanceof WriterLeaseError && error.code === "writer_busy" ? "writer_busy" : "writer_not_ready");
    return 0;
  }
  try { return await launchLeased(argv, deps, name, lease); }
  finally { await lease.release(); }
}

async function launchLeased(argv: readonly string[], deps: LaunchDependencies, name: string, lease: WriterLease): Promise<number> {
  const refuse = async (code: RefusalCode) => { await serveRefusal(code); return 0; };
  const info = await podmanInfo(deps.runner);
  if (!info.usable || !info.version) return refuse("container_runtime_unavailable");
  const paths = writerPaths(deps.home, name);
  let state;
  try {
    state = await readWriterState(deps.home, name);
    if (!state) return refuse("writer_not_ready");
    if (argv.length === 1) {
      if (state.phase !== "ready" || state.acceptance?.fingerprint !== await currentAcceptanceFingerprint(paths.wrapper, state, info.version)) return refuse("writer_not_ready");
    }
  } catch { return refuse("writer_not_ready"); }
  const ensureAbsent = () => (deps.ensureAbsent ?? ensureWriterAbsent)(deps.runner, paths, name, { leaseFd: lease.fd });
  try { await ensureAbsent(); } catch { return refuse("writer_fenced"); }
  let eventsDir: string | undefined;
  if (state.launch !== "relay" && await writerEventDeliveryEnabled(paths.config)) {
    try { eventsDir = await ensureWriterEventsDirectory(deps.home, name, (deps.uid ?? (() => process.getuid!()))()); }
    catch { eventsFailure(); return refuse("writer_not_ready"); }
  }
  const providers = state.providers;
  const names = providers.map(({ provider }) => provider);
  const readHost = async (): Promise<unknown> => {
    try { return JSON.parse(await readFile(join(deps.home, ".pi", "agent", "auth.json"), "utf8")) as unknown; }
    catch { return undefined; }
  };
  const refresh = async () => {
    const host = await readHost();
    if (expiresWithin(host, names, REFRESH_THRESHOLD_MINUTES, deps.now())) {
      const warmup = deps.warmupHostCredential ?? refreshHostCredential;
      const authPath = join(deps.home, ".pi", "agent", "auth.json");
      // In parallel, so the whole warm-up stays bounded at 20 s; Pi's locked store writes the file, never this launcher.
      // A failed refresh is ignored: the copy below still runs.
      await Promise.allSettled(selectedOAuthProviders(host, names).map((provider) =>
        warmup({ authPath, provider, minOAuthValidityMs: REFRESH_THRESHOLD_MINUTES * 60_000, timeoutMs: 20_000 })));
    }
    await writeBoundaryCredentials(paths.agent, selectBoundaryCredentials(await readHost(), names));
  };
  const enabled = deps.env.PI_WRITER_NO_CREDENTIAL_REFRESH !== "1";
  try { if (enabled) await refresh(); } catch { return refuse("writer_not_ready"); }
  const command = argv.length > 1 ? argv.slice(1) : ["node", "/opt/pi-session-mcp/dist/main.js"];
  let child: ChildProcess;
  try { child = deps.spawnPodman(serveArgs(paths, state, command, deps.releaseRoot, eventsDir, { name }), [lease.fd]); }
  catch { launchFailure("spawn"); await ensureAbsent(); return 1; }
  let outstanding: Promise<void> | undefined;
  let stopping = false;
  const timer = enabled ? deps.setInterval(() => {
    if (stopping || outstanding) return;
    outstanding = refresh().catch(() => {
      process.stderr.write(JSON.stringify({ level: "warning", event: "writer_refresh_failed", code: "writer_refresh_failed" }) + "\n");
    }).finally(() => { outstanding = undefined; });
  }, REFRESH_INTERVAL_MS) : undefined;
  let closed = false;
  let exitCode = 1;
  let spawnFailed = false;
  let resolveClosed: () => void;
  const childClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let cleanup: Promise<number> | undefined;
  let resolveExit!: (code: number) => void;
  let rejectExit!: (error: unknown) => void;
  const finished = new Promise<number>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  const stop = (signal?: NodeJS.Signals): Promise<number> => {
    if (cleanup) return cleanup;
    stopping = true;
    if (timer !== undefined) deps.clearInterval(timer);
    cleanup = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<void>((resolve) => { timeout = setTimeout(resolve, LAUNCHER_CLEANUP_BOUND_MS); });
      try {
        await outstanding;
        await Promise.race([childClosed, bounded]);
        if (!closed) {
          await deps.runner.run("podman", ["rm", "-f", "-t", "0", writerContainerName(name)], AbortSignal.timeout(20_000), { inheritFds: [lease.fd] }).catch(() => undefined);
        }
        await ensureAbsent();
        return exitCode;
      } finally {
        clearTimeout(timeout);
        process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", terminate);
        process.stdin.off("end", terminate);
        if (child.stdin) {
          process.stdin.unpipe(child.stdin);
          child.stdin.destroy();
          process.stdin.pause();
        }
        // A wedged Podman client still retains its inherited lease, but must not pin this launcher.
        if (!closed) child.unref?.();
      }
    })();
    void cleanup.then(resolveExit, rejectExit);
    // Publish the shared cleanup promise before forwarding a signal can produce close.
    if (signal && !closed) child.kill(signal);
    return cleanup;
  };
  const interrupt = () => { void stop("SIGINT"); };
  const terminate = () => { void stop("SIGTERM"); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate); process.on("SIGHUP", terminate);
  process.stdin.once("end", terminate);
  {
    // Signal/EOF cleanup and child-exit cleanup share exactly one completion.
    const complete = () => { void stop(); };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      closed = true;
      exitCode = spawnFailed ? 1 : code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
      resolveClosed(); complete();
    };
    child.once("error", () => { spawnFailed = true; launchFailure("spawn"); complete(); });
    child.once("close", onClose);
    // Attach before piping: EOF can arrive immediately, and must not steal MCP input.
    if (child.stdin) {
      // Podman can close its pipe before the host notices; cleanup still owns the fence.
      child.stdin.once("error", terminate);
      process.stdin.pipe(child.stdin);
    }
    if (process.stdin.readableEnded) terminate();
  }
  return finished;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  void launchEntry(process.argv.slice(2), {
    home: homedir(), releaseRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    runner: createProcessRunner(), spawnPodman: (args, inheritFds) => spawn("podman", args, { stdio: ["pipe", "inherit", "inherit", ...inheritFds] }),
    env: process.env, now: Date.now, setInterval, clearInterval,
  }).then((code) => { process.exitCode = code; });
}
