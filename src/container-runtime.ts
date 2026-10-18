import { execFile } from "node:child_process";

/** Offline, bounded rootless Podman check; no runtime diagnostics enter reports or stdout. */
export async function containerRuntimeUsable(): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolve) => {
      execFile("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], {
        shell: false,
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
      }, (error, stdout) => resolve(error === null && stdout.trim() === "true"));
    });
  } catch { return false; }
}
