import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRunner } from "./client-adapters/types.js";
import { isEntryPoint } from "./entry-point.js";
import { serveRefusal } from "./refusal-server.js";
import { createProcessRunner } from "./setup-process.js";
import { ensureWriterEventsDirectory, podmanInfo, serveArgs } from "./writer-boundary.js";
import { ensureWarmupConfig, expiresWithin, REFRESH_INTERVAL_MS, REFRESH_THRESHOLD_MINUTES, refreshHostLogin, selectBoundaryCredentials, writeBoundaryCredentials } from "./writer-credentials.js";
import { currentAcceptanceFingerprint, readWriterState, WRITER_NAME_PATTERN, writerEventDeliveryEnabled, writerPaths } from "./writer-state.js";
export { currentAcceptanceFingerprint } from "./writer-state.js";
export { renderWrapper, wrapperDigest } from "./writer-wrapper.js";
export interface LaunchDependencies {
  home: string;
  nodePath: string;
  releaseRoot: string;
  runner: CommandRunner;
  spawnPodman(args: string[]): ChildProcess;
  env: NodeJS.ProcessEnv;
  /** The user id that must own the event spool directory; defaults to the process user. */
  uid?: () => number;
  now(): number;
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
  const refuse = async (code: "writer_not_ready" | "container_runtime_unavailable") => { await serveRefusal(code); return 0; };
  const name = argv[0];
  if (!name || !WRITER_NAME_PATTERN.test(name)) return refuse("writer_not_ready");
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
  let eventsDir: string | undefined;
  if (await writerEventDeliveryEnabled(paths.config)) {
    try { eventsDir = await ensureWriterEventsDirectory(deps.env, name, (deps.uid ?? (() => process.getuid!()))()); }
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
      try {
        const warmupConfig = await ensureWarmupConfig(deps.home, providers);
        if (warmupConfig) await refreshHostLogin({ nodePath: deps.nodePath, releaseRoot: deps.releaseRoot, warmupConfig, timeoutMs: 20_000 });
      } catch { /* Copy even when host refresh fails. */ }
    }
    await writeBoundaryCredentials(paths.agent, selectBoundaryCredentials(await readHost(), names));
  };
  const enabled = deps.env.PI_WRITER_NO_CREDENTIAL_REFRESH !== "1";
  try { if (enabled) await refresh(); } catch { return refuse("writer_not_ready"); }
  const command = argv.length > 1 ? argv.slice(1) : ["node", "/opt/pi-session-mcp/dist/main.js"];
  let child: ChildProcess;
  try { child = deps.spawnPodman(serveArgs(paths, state, command, deps.releaseRoot, eventsDir)); } catch { launchFailure("spawn"); return 1; }
  let busy = false;
  const timer = enabled ? deps.setInterval(() => {
    if (busy) return;
    busy = true;
    void refresh().catch(() => {
      process.stderr.write(JSON.stringify({ level: "warning", event: "writer_refresh_failed", code: "writer_refresh_failed" }) + "\n");
    }).finally(() => { busy = false; });
  }, REFRESH_INTERVAL_MS) : undefined;
  return new Promise<number>((resolveExit) => {
    const interrupt = () => { child.kill("SIGINT"); };
    const terminate = () => { child.kill("SIGTERM"); };
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) deps.clearInterval(timer);
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
      resolveExit(code);
    };
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    child.once("error", () => { if (!finished) launchFailure("spawn"); finish(1); });
    child.once("close", (code, signal) => finish(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
  });
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  void launchEntry(process.argv.slice(2), {
    home: homedir(), nodePath: process.execPath, releaseRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    runner: createProcessRunner(), spawnPodman: (args) => spawn("podman", args, { stdio: "inherit" }),
    env: process.env, now: Date.now, setInterval, clearInterval,
  }).then((code) => { process.exitCode = code; });
}
