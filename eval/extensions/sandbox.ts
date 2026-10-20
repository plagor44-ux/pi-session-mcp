import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runHelper, type HelperRunner } from "./helpers.js";
import type { ToolPaths } from "./tools.js";

/*
 * R46: every traced command (the run unit and the oracle's setup and test commands) runs inside bubblewrap: the root is read-only, only
 * the scope root (and the oracle's home) is writable, /tmp is a fresh tmpfs, and /run/user and /run/dbus are empty, so the user and
 * system bus sockets do not exist for the worker. The network stays shared, because the providers are reached over it. The strace
 * audit stays as the second line of defence: a write the kernel refuses shows up as a denied attempt.
 */

/**
 * The bwrap arguments up to and including `--`. The scope bind comes after `--tmpfs /tmp`, so a scope below /tmp stays writable.
 * `--unshare-pid` is added to the verified shape: `--new-session` moves the command into its own session, where a kill of the
 * supervisor's process group (strace is the leader) would miss it; in a PID namespace the death of bwrap, which `--die-with-parent`
 * ties to strace, ends every process of the sandbox.
 */
export function bwrapArgs(scopeRoot: string, extraWritable: readonly string[] = [], extraReadOnly: readonly string[] = []): string[] {
  return [
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run/user", "--tmpfs", "/run/dbus",
    "--bind", scopeRoot, scopeRoot, ...extraWritable.flatMap((path) => ["--bind", path, path]),
    // Directories under /tmp that must stay visible read-only after the tmpfs hid them, such as the disposable build the run unit loads from.
    ...extraReadOnly.flatMap((path) => ["--ro-bind", path, path]),
    "--die-with-parent", "--new-session", "--unshare-ipc", "--unshare-pid", "--",
  ];
}

/** `bwrap … -- <command>` with an absolute bwrap path. */
export function sandboxed(tools: Pick<ToolPaths, "bwrap">, scopeRoot: string, command: readonly string[], extraWritable: readonly string[] = [], extraReadOnly: readonly string[] = []): string[] {
  return [tools.bwrap, ...bwrapArgs(scopeRoot, extraWritable, extraReadOnly), ...command];
}

const PROBE = `
const fs = require("fs"), net = require("net"), path = require("path");
const [home, scope, uid] = process.argv.slice(1);
const out = { home: null, scope: false, bus: null };
try { fs.writeFileSync(path.join(home, ".containment-probe-" + process.pid), "x"); out.home = "created"; } catch (e) { out.home = e.code; }
try { fs.writeFileSync(path.join(scope, "probe"), "x"); out.scope = true; } catch (e) { out.scope = e.code; }
const done = () => { console.log(JSON.stringify(out)); process.exit(0); };
const socket = net.connect("/run/user/" + uid + "/bus");
socket.on("connect", () => { out.bus = "connected"; done(); });
socket.on("error", (e) => { out.bus = e.code; done(); });
`;

/**
 * Runs the containment through the production command shape before anything else: a tiny script that must fail to create a file in the
 * supervisor's real $HOME (EROFS), must succeed in the scope root, and must get ENOENT connecting to /run/user/<uid>/bus.
 * Any other outcome, or a sandbox that does not start, is `containment_failed`.
 */
export async function containmentSelfTest(
  tools: Pick<ToolPaths, "bwrap">,
  deps: { run?: HelperRunner; home?: string; uid?: number } = {},
): Promise<void> {
  const run = deps.run ?? runHelper;
  const scope = await mkdtemp(join(tmpdir(), "ablation-containment-"));
  try {
    const [file, ...args] = sandboxed(tools, scope, [process.execPath, "-e", PROBE, deps.home ?? homedir(), scope, String(deps.uid ?? process.getuid?.() ?? 0)]);
    let stdout: string;
    try { stdout = (await run(file!, args, { env: { PATH: process.env.PATH ?? "" } })).stdout; } catch { throw new Error("containment_failed"); }
    let result: { home?: unknown; scope?: unknown; bus?: unknown };
    try { result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as typeof result; } catch { throw new Error("containment_failed"); }
    if (result.home !== "EROFS" || result.scope !== true || result.bus !== "ENOENT") throw new Error("containment_failed");
  } finally {
    await rm(scope, { recursive: true, force: true });
  }
}
