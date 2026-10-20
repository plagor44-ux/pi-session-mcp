import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { auditLog } from "./audit.js";
import { runHelper, type HelperRunner } from "./helpers.js";
import type { SandboxPlan } from "./sandbox.js";
import { tracedCommand } from "./supervise.js";
import type { ToolPaths } from "./tools.js";

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

/** Host paths outside the home that hold credentials, environment files, core dumps or the journal, or whole data volumes: none may exist in the sandbox (R51). */
export const ABSENT_PATHS = ["/mnt", "/media", "/srv", "/var/lib/systemd/coredump", "/var/log/journal", "/etc/llama-server"];
/** One provider host whose name resolution must work through the full shape. */
const DNS_HOST = "api.deepseek.com";

const SOCKETS = ["/run/user/UID/bus", "/run/dbus/system_bus_socket", "/run/systemd/private", "/run/systemd/journal/socket", "/run/docker.sock"];

const PROBE = `
const fs = require("fs"), net = require("net"), path = require("path"), dns = require("dns"), cp = require("child_process");
const [home, scope, oracleHome, uid, marker, absentJson, entry, codegraph] = process.argv.slice(1);
const out = { home: null, ssh: null, entry: null, absent: {}, scope: false, oracleHome: false, tmp: false, dns: false, codegraph: false, sockets: {} };
const code = (fn) => { try { fn(); return true; } catch (e) { return e.code; } };
out.home = code(() => fs.writeFileSync(path.join(home, ".containment-probe-" + process.pid), "x")) ;
out.ssh = code(() => fs.readdirSync(path.join(home, ".ssh")));
if (entry !== "") out.entry = code(() => fs.lstatSync(path.join(home, entry)));
for (const p of JSON.parse(absentJson)) out.absent[p] = code(() => fs.lstatSync(p));
out.scope = code(() => fs.writeFileSync(path.join(scope, "probe"), "x"));
out.oracleHome = code(() => fs.writeFileSync(path.join(oracleHome, "probe"), "x"));
out.tmp = code(() => fs.writeFileSync(marker, "x"));
const sockets = ${JSON.stringify(SOCKETS)}.map((p) => p.replace("UID", uid));
out.codegraph = code(() => { if (cp.execFileSync(codegraph, ["--version"], { env: { PATH: process.env.PATH ?? "" }, timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }).length === 0) throw new Error("no output"); });
(async () => {
  out.dns = await new Promise((resolve) => dns.lookup(${JSON.stringify(DNS_HOST)}, { all: true }, (e, addresses) => resolve(!e && addresses.length > 0)));
  for (const p of sockets) out.sockets[p] = await new Promise((resolve) => {
    const s = net.connect(p);
    s.on("connect", () => { s.destroy(); resolve("connected"); });
    s.on("error", (e) => resolve(e.code));
  });
  console.log(JSON.stringify(out));
})();
`;

/**
 * The first non-hidden top-level entry of the real home that the plan does not bind back (nor contain a bind), else `.ssh` when it
 * exists; null when there is none. It exists on the host and must be absent inside.
 */
async function hostHomeEntry(home: string, plan: SandboxPlan, scope: string, oracleHome: string): Promise<string | null> {
  let names: string[];
  try { names = (await readdir(home)).sort(); } catch { return null; }
  const binds = [...plan.homeReadOnly, ...plan.homeLinks.map((link) => link.path), ...plan.extraReadOnly, scope, oracleHome];
  const visible = (name: string): boolean => binds.some((path) => path === join(home, name) || path.startsWith(`${join(home, name)}/`));
  return names.find((name) => !name.startsWith(".") && !visible(name)) ?? (names.includes(".ssh") ? ".ssh" : null);
}

/**
 * Runs the containment through the production command shape before anything else (prlimit, strace, bubblewrap, the build bind and the
 * oracle-home bind): the real $HOME must give EROFS for a write and ENOENT for `.ssh` and for one real entry of it, the scope and the
 * oracle home must be writable, /tmp must be private to the sandbox (a marker must not exist on the host afterwards), none of the host
 * service sockets and none of `ABSENT_PATHS` may exist, a provider host must resolve, `codegraph --version` must run, and the strace
 * log of the probe must show no outside write. Any deviation, or a sandbox that does not start, is `containment_failed`.
 */
export async function containmentSelfTest(
  tools: Pick<ToolPaths, "bwrap" | "strace" | "prlimit" | "codegraph">,
  plan: SandboxPlan,
  deps: { run?: HelperRunner; home?: string; uid?: number } = {},
): Promise<void> {
  const run = deps.run ?? runHelper;
  const home = deps.home ?? userInfo().homedir;
  const scratch = await mkdtemp(join(tmpdir(), "ablation-containment-"));
  const scope = join(scratch, "scope");
  const oracleHome = join(scratch, "oracle-home");
  const log = join(scratch, "strace.log");
  const marker = join("/tmp", `ablation-containment-marker-${process.pid}-${Date.now()}`);
  try {
    await mkdir(scope); await mkdir(oracleHome);
    const entry = await hostHomeEntry(home, plan, scope, oracleHome);
    const { file, args } = tracedCommand(tools, plan, scope, log, "", {
      extraWritable: [oracleHome],
      workload: [process.execPath, "-e", PROBE, home, scope, oracleHome, String(deps.uid ?? process.getuid?.() ?? 0), marker, JSON.stringify(ABSENT_PATHS), entry ?? "", tools.codegraph],
    });
    let stdout: string;
    try { stdout = (await run(file, args, { cwd: scope, env: { PATH: process.env.PATH ?? "" } })).stdout; } catch { throw new Error("containment_failed"); }
    let result: { home?: unknown; ssh?: unknown; entry?: unknown; absent?: Record<string, unknown>; scope?: unknown; oracleHome?: unknown; tmp?: unknown; dns?: unknown; codegraph?: unknown; sockets?: Record<string, unknown> };
    try { result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as typeof result; } catch { throw new Error("containment_failed"); }
    const sockets = Object.values(result.sockets ?? {});
    const absent = result.absent ?? {};
    const ok = result.home === "EROFS" && result.ssh === "ENOENT" && result.entry === (entry === null ? null : "ENOENT")
      && ABSENT_PATHS.every((path) => absent[path] === "ENOENT")
      && result.scope === true && result.oracleHome === true && result.tmp === true && result.dns === true && result.codegraph === true
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
