import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { auditLog } from "./audit.js";
import { runHelper, type HelperRunner } from "./helpers.js";
import type { SandboxPlan } from "./sandbox.js";
import { tracedCommand } from "./supervise.js";
import type { ToolPaths } from "./tools.js";

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

const SOCKETS = ["/run/user/UID/bus", "/run/dbus/system_bus_socket", "/run/systemd/private", "/run/systemd/journal/socket", "/run/docker.sock"];

const PROBE = `
const fs = require("fs"), net = require("net"), path = require("path");
const [home, scope, oracleHome, uid, marker] = process.argv.slice(1);
const out = { home: null, ssh: null, scope: false, oracleHome: false, tmp: false, sockets: {} };
const code = (fn) => { try { fn(); return true; } catch (e) { return e.code; } };
out.home = code(() => fs.writeFileSync(path.join(home, ".containment-probe-" + process.pid), "x")) ;
out.ssh = code(() => fs.readdirSync(path.join(home, ".ssh")));
out.scope = code(() => fs.writeFileSync(path.join(scope, "probe"), "x"));
out.oracleHome = code(() => fs.writeFileSync(path.join(oracleHome, "probe"), "x"));
out.tmp = code(() => fs.writeFileSync(marker, "x"));
const sockets = ${JSON.stringify(SOCKETS)}.map((p) => p.replace("UID", uid));
(async () => {
  for (const p of sockets) out.sockets[p] = await new Promise((resolve) => {
    const s = net.connect(p);
    s.on("connect", () => { s.destroy(); resolve("connected"); });
    s.on("error", (e) => resolve(e.code));
  });
  console.log(JSON.stringify(out));
})();
`;

/**
 * Runs the containment through the production command shape before anything else (prlimit, strace, bubblewrap, the build bind and the
 * oracle-home bind): the real $HOME must give EROFS for a write and ENOENT for `.ssh`, the scope and the oracle home must be writable,
 * /tmp must be private to the sandbox (a marker must not exist on the host afterwards), none of the host service sockets may exist,
 * and the strace log of the probe must show no outside write. Any deviation, or a sandbox that does not start, is `containment_failed`.
 */
export async function containmentSelfTest(
  tools: Pick<ToolPaths, "bwrap" | "strace" | "prlimit">,
  plan: SandboxPlan,
  deps: { run?: HelperRunner; home?: string; uid?: number } = {},
): Promise<void> {
  const run = deps.run ?? runHelper;
  const scratch = await mkdtemp(join(tmpdir(), "ablation-containment-"));
  const scope = join(scratch, "scope");
  const oracleHome = join(scratch, "oracle-home");
  const log = join(scratch, "strace.log");
  const marker = join("/tmp", `ablation-containment-marker-${process.pid}-${Date.now()}`);
  try {
    await mkdir(scope); await mkdir(oracleHome);
    const { file, args } = tracedCommand(tools, plan, scope, log, "", {
      extraWritable: [oracleHome],
      workload: [process.execPath, "-e", PROBE, deps.home ?? homedir(), scope, oracleHome, String(deps.uid ?? process.getuid?.() ?? 0), marker],
    });
    let stdout: string;
    try { stdout = (await run(file, args, { cwd: scope, env: { PATH: process.env.PATH ?? "" } })).stdout; } catch { throw new Error("containment_failed"); }
    let result: { home?: unknown; ssh?: unknown; scope?: unknown; oracleHome?: unknown; tmp?: unknown; sockets?: Record<string, unknown> };
    try { result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as typeof result; } catch { throw new Error("containment_failed"); }
    const sockets = Object.values(result.sockets ?? {});
    const ok = result.home === "EROFS" && result.ssh === "ENOENT" && result.scope === true && result.oracleHome === true && result.tmp === true
      && sockets.length === SOCKETS.length && sockets.every((value) => value === "ENOENT");
    if (!ok || await exists(marker)) throw new Error("containment_failed");
    // The probe's own strace log, parsed the way the wave parses a run: no outside write.
    const found = await auditLog(log, [scope, oracleHome], scope, { providerAddresses: new Set(), dnsAddresses: new Set() });
    if (found === null || found.outsideWrites.length > 0) throw new Error("containment_failed");
  } finally {
    await rm(marker, { force: true }).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}
