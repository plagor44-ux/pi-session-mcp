/**
 * Account sign-in through the Pi CLI that ships with the pinned SDK (ADR 0022). Pi Session MCP runs Pi's own
 * `auth login` and `auth logout` commands as child processes and reads only their exit status: Pi talks to the
 * owner and keeps the credential in its own store, so no credential passes through this process. This is the
 * only module that starts them.
 */
import { spawn as spawnProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";

/** `terminal` hands Pi the owner's terminal for a sign-in; `silent` gives Pi no streams. */
export type PiAuthMode = "terminal" | "silent";

/** Pi's sign-in reads the owner's terminal; its stdout joins stderr, so this process's stdout stays clean. */
export const PI_SIGN_IN_STDIO = Object.freeze(["inherit", 2, "inherit"] as const);
/** Pi's sign-out needs no streams; only its exit status counts. */
export const PI_SIGN_OUT_STDIO = Object.freeze(["ignore", "ignore", "ignore"] as const);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The parsed `package.json` in `directory`; undefined when it is missing or unreadable. */
async function manifestIn(directory: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as unknown; }
  catch { return undefined; }
}

/**
 * Absolute path of the `pi` bin that the resolved SDK package declares. Rejects when the package or its bin is
 * missing, or the bin leaves the package directory. `resolveEntry` returns a `file:` URL, as `import.meta.resolve` does.
 * Never looks Pi up on `PATH`: only the Pi that ships with this package runs.
 */
export async function bundledPiCli(resolveEntry: () => string = () => import.meta.resolve(SDK_PACKAGE)): Promise<string> {
  let directory = dirname(fileURLToPath(resolveEntry()));
  for (;;) {
    const manifest = await manifestIn(directory);
    if (isRecord(manifest) && manifest.name === SDK_PACKAGE) {
      const bin = isRecord(manifest.bin) ? manifest.bin.pi : undefined;
      if (typeof bin !== "string" || bin === "") throw new Error("pi_cli_unavailable");
      const cli = resolve(directory, bin);
      const inside = relative(directory, cli);
      if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) throw new Error("pi_cli_unavailable");
      return cli;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pi_cli_unavailable");
    directory = parent;
  }
}

export interface BundledPiOptions {
  /** Defaults to {@link bundledPiCli}. */
  readonly cli?: () => Promise<string>;
  /** Pi's working directory; defaults to the account's home directory, so no project directory configures Pi. */
  readonly home?: string;
  readonly spawn?: typeof spawnProcess;
}

/**
 * Exit status of `pi <args>`; 1 when the child cannot start or ends by a signal. Never rejects. Pi inherits this
 * process's environment, so it uses the owner's own Pi store. While Pi runs, a Ctrl-C reaches Pi, which ends its
 * own command, and this process ignores it, so the caller still learns the outcome.
 */
export async function runBundledPi(args: readonly string[], mode: PiAuthMode, options: BundledPiOptions = {}): Promise<number> {
  let cli: string;
  try { cli = await (options.cli ?? bundledPiCli)(); }
  catch { return 1; }
  const stdio = mode === "terminal" ? PI_SIGN_IN_STDIO : PI_SIGN_OUT_STDIO;
  return new Promise<number>((resolveStatus) => {
    const ignoreInterrupt = (): void => {};
    let settled = false;
    const settle = (status: number): void => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", ignoreInterrupt);
      resolveStatus(status);
    };
    process.on("SIGINT", ignoreInterrupt);
    try {
      const child = (options.spawn ?? spawnProcess)(process.execPath, [cli, ...args], { cwd: options.home ?? userInfo().homedir, stdio: [...stdio] });
      child.once("error", () => settle(1));
      child.once("exit", (code) => settle(code ?? 1));
    } catch { settle(1); }
  });
}
