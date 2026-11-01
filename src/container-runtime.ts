import { execFile } from "node:child_process";

/** Bound of one `podman info` attempt. */
export const CONTAINER_RUNTIME_PROBE_TIMEOUT_MS = 10_000;

type ProbeAnswer = { readonly usable: boolean; readonly timedOut: boolean };

export interface ContainerRuntimeProbeOptions {
  /** Test seam for `execFile`; the default is `node:child_process`. */
  readonly execFile?: typeof execFile;
  /** Bound of each attempt; the default is 10 seconds. */
  readonly timeoutMs?: number;
}

/** `execFile` marks a child that its timeout killed with `killed` and the kill signal; an exceeded output cap is no timeout. */
function endedByTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { killed, signal, code } = error as { killed?: unknown; signal?: unknown; code?: unknown };
  return killed === true && signal === "SIGKILL" && code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function probeOnce(run: typeof execFile, timeoutMs: number): Promise<ProbeAnswer> {
  return new Promise<ProbeAnswer>((resolve) => {
    try {
      run("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], {
        shell: false,
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
      }, (error, stdout) => resolve({
        usable: error === null && String(stdout).trim() === "true",
        timedOut: endedByTimeout(error),
      }));
    } catch { resolve({ usable: false, timedOut: false }); }
  });
}

/**
 * Offline, bounded rootless Podman check; no runtime diagnostics enter reports or stdout.
 * A call that ended by its timeout is tried once more (#229): a healthy but heavily loaded host can
 * answer `podman info` late. An error or an answer other than `true` stays unusable at once.
 */
export async function containerRuntimeUsable(options: ContainerRuntimeProbeOptions = {}): Promise<boolean> {
  const run = options.execFile ?? execFile;
  const timeoutMs = options.timeoutMs ?? CONTAINER_RUNTIME_PROBE_TIMEOUT_MS;
  try {
    const first = await probeOnce(run, timeoutMs);
    if (first.usable || !first.timedOut) return first.usable;
    return (await probeOnce(run, timeoutMs)).usable;
  } catch { return false; }
}
