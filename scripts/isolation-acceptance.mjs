// Provider-free isolation acceptance for ADR 0008 (maintainer/operator script).
//
// Runs scripts/isolation-probe.cjs through a launch prefix that starts Node.js inside the boundary
// under test and checks, provider-free, the ADR's "Launch binding", "Writes", "Credentials",
// "Persistence", "Children" (as far as checkable without a provider) and "Network" items. The
// "Live" item needs a provider and a real coding session and is not covered. See
// docs/isolation-setup.md.
//
// Usage:
//   node scripts/isolation-acceptance.mjs --launch "<prefix that runs node>" --workspace <dir> \
//     --mode contained|uncontained-control [--out <json>] [--env-allow A,B] \
//     [--agent-dir-copy-writable] [--no-remote-checks]
//
// `--launch` is split into words (single and double quotes, backslash) and started without a shell;
// the harness appends `- <probe configuration>` and pipes the probe to its stdin, so the prefix must
// end in a command that behaves like `node` (for example `podman run -i --rm ... <image> node`).
// `--workspace` is the writer's full clone as the harness sees it on the host; the boundary must
// mount the same clone read-write. `--mode uncontained-control` is a calibration run with
// `--launch node`: it really performs the escapes (new, uniquely named files only), expects to
// detect every one, and removes them again.
//
// SAFETY. Pre-existing files are never modified or deleted. The probe creates only NEW files whose
// names carry a per-run token (exclusive create, bash noclobber) and appends one comment line to
// the config of a disposable source repository that this harness creates below ~/.cache. Git is never
// run inside the workspace. Before and after, the harness digests every host-side target from outside
// the boundary, removes every canary it finds, and verifies the removal. The report holds booleans,
// counts, check ids and short digests only: no path, file content or environment value.
//
// Exit codes: 0 pass (contained) or control detected every escape, 1 fail, 2 usage/environment error
// or inconclusive. Linux only (it reads /proc). Node built-ins only. Importing the module never runs
// anything; only a direct `node` invocation does.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const MODES = ["contained", "uncontained-control"];
export const NETWORK_HOST = "1.1.1.1";
const PROBE_PATH = join(dirname(fileURLToPath(import.meta.url)), "isolation-probe.cjs");
const RESULT_MARKER = "ISOLATION_PROBE_RESULT ";
const LAUNCH_TIMEOUT_MS = 180_000;
const MAX_HASHED_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
// Environment names a plain boundary may carry. Anything else counts as unexpected under `--env-allow`.
const BASE_ENV_NAMES = new Set(["PATH", "HOME", "LANG", "LANGUAGE", "TERM", "PWD", "OLDPWD", "SHLVL", "_", "HOSTNAME", "TMPDIR", "USER", "LOGNAME", "SHELL", "NODE_VERSION", "container"]);
const SECRET_LIKE = /(TOKEN|SECRET|PASSW|API_?KEY|PRIVATE|CREDENTIAL|AUTH|^SSH_|^GH_|^GITHUB|ASKPASS)/i;
const STARTUP_FILES = [".bashrc", ".bash_profile", ".bash_logout", ".profile", ".zshrc", ".zshenv", ".zprofile", ".gitconfig", ".npmrc", join(".config", "fish", "config.fish")];
const AGENT_COPY_GROUPS = new Set(["agentdir", "agentdir_inner", "extdir", "extdir_inner"]);

/** A usage or environment problem; the CLI entry turns it into exit code 2. */
export class UsageError extends Error {
  constructor(message) { super(message); this.name = "UsageError"; }
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------------------------

/** Splits a command prefix into words: whitespace separates, quotes group, backslash escapes. No shell. */
export function tokenizeCommand(text) {
  const words = [];
  let current = "";
  let started = false;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null; else current += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && index + 1 < text.length && '"\\$`'.includes(text[index + 1])) { index += 1; current += text[index]; }
      else current += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === "\\" && index + 1 < text.length) { index += 1; current += text[index]; started = true; }
    else if (/\s/.test(char)) { if (started || current) { words.push(current); current = ""; started = false; } }
    else { current += char; started = true; }
  }
  if (quote) throw new UsageError("--launch has an unterminated quote");
  if (started || current) words.push(current);
  return words;
}

/** Validates the command line; returns normalized options or throws a UsageError. */
export function parseArguments(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        launch: { type: "string" },
        workspace: { type: "string" },
        mode: { type: "string" },
        out: { type: "string" },
        "env-allow": { type: "string" },
        "agent-dir-copy-writable": { type: "boolean", default: false },
        "no-remote-checks": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
  const values = parsed.values;
  if (values.help) return { help: true };
  if (!values.mode || !MODES.includes(values.mode)) throw new UsageError(`--mode must be one of: ${MODES.join(", ")}`);
  if (!values.launch || !values.launch.trim()) throw new UsageError("--launch is required");
  const launch = tokenizeCommand(values.launch);
  if (launch.length === 0 || launch[0] === "") throw new UsageError("--launch needs a command");
  if (!values.workspace) throw new UsageError("--workspace is required");
  if (values.mode === "uncontained-control" && values["agent-dir-copy-writable"]) throw new UsageError("--agent-dir-copy-writable only applies to --mode contained");
  let envAllow = null;
  if (values["env-allow"] !== undefined) {
    envAllow = values["env-allow"].split(",").map((name) => name.trim()).filter(Boolean);
    if (envAllow.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new UsageError("--env-allow takes a comma-separated list of environment variable names");
  }
  return {
    help: false,
    mode: values.mode,
    launch,
    workspace: resolve(values.workspace),
    out: values.out ? resolve(values.out) : null,
    envAllow,
    agentDirCopyWritable: values["agent-dir-copy-writable"] === true,
    skipRemote: values["no-remote-checks"] === true,
  };
}

export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Classifies environment variable names of the boundary's child processes; returns counts only. */
export function classifyEnvNames(names, allow) {
  const allowed = new Set(allow ?? []);
  let secretLike = 0;
  let unexpected = 0;
  for (const name of names) {
    if (allowed.has(name)) continue;
    if (SECRET_LIKE.test(name)) secretLike += 1;
    if (!BASE_ENV_NAMES.has(name) && !name.startsWith("LC_")) unexpected += 1;
  }
  return { env_names_total: names.length, secret_like_unallowed: secretLike, unexpected_names: unexpected, strict: allow !== null };
}

/** Network classification of the TCP connect result. */
export function classifyNetwork(tcp) {
  return { tcp_443: tcp, classification: tcp === true ? "not_limited" : tcp === false ? "limited" : "not_recorded" };
}

/**
 * Decides the overall verdict from a report. Pure; the report holds only booleans, counts and ids.
 * Returns { verdict, exit_code, failed_checks, inconclusive_checks }.
 */
export function evaluateVerdict(report, options = {}) {
  const copyWritable = options.agentDirCopyWritable === true;
  const failed = [];
  const inconclusive = [];
  const writes = report.writes.filter((write) => !write.skipped);
  const controls = report.controls;

  if (!controls.bash_available) inconclusive.push("controls.bash_unavailable");
  if (!controls.workspace_write_node || !controls.workspace_write_bash) inconclusive.push("controls.workspace_not_writable");
  if (!controls.marker_started) inconclusive.push("controls.marker_not_started");
  if (report.cleanup.residual_canaries > 0) failed.push("cleanup.residual_canaries");
  if (!report.cleanup.run_root_removed) failed.push("cleanup.run_root_remains");
  if (!report.digests.preexisting_unchanged_after_cleanup) failed.push("digests.preexisting_changed");

  if (report.mode === "uncontained-control") {
    if (report.launch_binding.bound) failed.push("control.launch_is_bound");
    for (const write of writes) {
      if (!write.host_observable || !write.applicable) continue;
      if (write.probe_blocked !== false || !write.host_changed) failed.push(`control.missed.${write.id}`);
    }
    if (report.persistence.marker_survivors < 1) failed.push("control.persistence_not_detected");
    const verdict = failed.length === 0 && inconclusive.length === 0 ? "control_detected_escapes" : failed.length > 0 ? "control_missed_escapes" : "inconclusive";
    return { verdict, exit_code: verdict === "control_detected_escapes" ? 0 : verdict === "inconclusive" ? 2 : 1, failed_checks: failed, inconclusive_checks: inconclusive };
  }

  if (report.launch_binding.bound !== true) failed.push("launch_binding.not_bound");
  for (const write of writes) {
    const exempt = copyWritable && AGENT_COPY_GROUPS.has(write.group);
    if (write.probe_blocked !== true && !exempt) failed.push(`writes.not_blocked.${write.id}`);
    if (write.host_changed) failed.push(`writes.host_changed.${write.id}`);
  }
  if (!report.digests.preexisting_unchanged_after_probe) failed.push("digests.preexisting_changed_after_probe");
  if (report.credentials.visible_count > 0) failed.push("credentials.visible");
  if (report.credentials.ssh_authenticated === true) failed.push("credentials.ssh_authenticated");
  if (report.credentials.ssh_authenticated === null) inconclusive.push("credentials.ssh_not_checked");
  if (report.persistence.marker_survivors > 0) failed.push("persistence.process_survived");
  if (report.persistence.crontab_delta !== 0) failed.push("persistence.crontab_changed");
  if (report.persistence.user_unit_delta !== 0) failed.push("persistence.user_units_changed");
  if (report.children.secret_like_unallowed > 0) failed.push("children.secret_like_env");
  if (report.children.strict && report.children.unexpected_names > 0) failed.push("children.unexpected_env");
  if (report.network.tcp_443 === null) inconclusive.push("network.not_recorded");
  const verdict = failed.length > 0 ? "fail" : inconclusive.length > 0 ? "inconclusive" : "pass";
  return { verdict, exit_code: verdict === "pass" ? 0 : verdict === "fail" ? 1 : 2, failed_checks: failed, inconclusive_checks: inconclusive };
}

const SAFE_STRING = /^[A-Za-z0-9_.:+\-]{0,80}$/;

/**
 * Fails closed on anything that is not a boolean, number, null, safe token string, array or object of
 * those: a path (slash), an `A=B` pair (equals sign), a space or a long string cannot appear.
 */
export function assertSanitized(value, where = "report") {
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (!SAFE_STRING.test(value)) throw new UsageError(`unsanitized string in ${where}`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => assertSanitized(item, `${where}[${index}]`)); return; }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!SAFE_STRING.test(key)) throw new UsageError(`unsanitized key in ${where}`);
      assertSanitized(item, `${where}.${key}`);
    }
    return;
  }
  throw new UsageError(`unsupported value in ${where}`);
}

/** Aggregated digest of a directory listing (and, in content mode, shallow file contents) or one file; canaries are excluded. */
export function digestTarget(target, mode, prefix) {
  const hash = createHash("sha256");
  let stat;
  try { stat = lstatSync(target); } catch { return hash.update("absent").digest("hex"); }
  const fileDigest = (path, size) => (size <= MAX_HASHED_BYTES ? createHash("sha256").update(readFileSync(path)).digest("hex") : `size-${size}`);
  if (!stat.isDirectory()) {
    hash.update(`file:${stat.isFile() ? fileDigest(target, stat.size) : "other"}`);
    return hash.digest("hex");
  }
  let names;
  try { names = readdirSync(target).sort(); } catch { return hash.update("unreadable").digest("hex"); }
  for (const name of names) {
    if (name.includes(prefix)) continue;
    let entry;
    try { entry = lstatSync(join(target, name)); } catch { hash.update(`${name}\0gone\n`); continue; }
    const type = entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : entry.isFile() ? "f" : "o";
    hash.update(`${name}\0${type}`);
    if (mode === "content" && entry.isFile()) hash.update(`\0${entry.size}\0${fileDigest(join(target, name), entry.size)}`);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function digestFiles(paths) {
  const hash = createHash("sha256");
  for (const path of paths) hash.update(`${digestTarget(path, "content", "")}\n`);
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------------------------

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function ownProcesses() {
  const uid = process.getuid();
  const processes = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (statSync(`/proc/${entry}`).uid !== uid) continue;
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      processes.set(`${entry}:${start}`, Number(entry));
    } catch { /* the process ended */ }
  }
  return processes;
}

function markerProcesses(marker) {
  const pids = [];
  for (const pid of ownProcesses().values()) {
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] === marker) pids.push(pid);
    } catch { /* ended */ }
  }
  return pids;
}

function killMarkerProcesses(marker) {
  let killed = 0;
  for (const pid of markerProcesses(marker)) {
    try { process.kill(pid, "SIGKILL"); killed += 1; } catch { /* ended */ }
  }
  for (let attempt = 0; attempt < 20 && markerProcesses(marker).length > 0; attempt += 1) sleepSync(100);
  return killed;
}

function crontabLines() {
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  if (result.error) return 0;
  return result.status === 0 ? String(result.stdout).split("\n").filter((line) => line.trim() && !line.trim().startsWith("#")).length : 0;
}

function activeUserUnits() {
  const result = spawnSync("systemctl", ["--user", "list-units", "--state=active", "--no-legend", "--plain"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  return result.error || result.status !== 0 ? null : String(result.stdout).split("\n").filter(Boolean).length;
}

function listNames(dir, prefix) {
  try { return readdirSync(dir).filter((name) => !name.includes(prefix)); } catch { return []; }
}

function pathExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

function hostNamespaces() {
  const read = (kind) => { try { return readlinkSync(`/proc/self/ns/${kind}`); } catch { return null; } };
  return { user: read("user"), mnt: read("mnt"), pid: read("pid"), net: read("net") };
}

function agentDirectory() {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
}

/** The fixed attempts: the probe runs each one through Node.js and through bash. Detection paths are host-side. */
export function buildAttempts(layout) {
  const { prefix, home, agentDir, extDir, userUnitDir, workspace, outside, source, linkName } = layout;
  const name = (suffix) => `${prefix}-${suffix}`;
  const create = (id, group, path, extra = {}) => ({ id, group, kind: "create", path, host_observable: true, ...extra });
  const inner = (id, group, innerKind, suffix, compare) => ({ id, group, kind: "create", inner: innerKind, name: name(suffix), compare, host_observable: false });
  return [
    create("abs", "abs", join(outside, name("abs"))),
    // Deliberately not normalized: the `../` segment is part of the attempt.
    create("dotdot", "dotdot", `${workspace}${sep}..${sep}${name("dotdot")}`),
    create("symlink", "symlink", join(workspace, linkName, name("symlink")), { detect: join(outside, "linkdir", name("symlink")) }),
    create("home", "home", join(home, name("home"))),
    inner("home_inner", "home_inner", "home", "home", join(home, name("home"))),
    create("agentdir", "agentdir", join(agentDir, name("agent"))),
    inner("agentdir_inner", "agentdir_inner", "agent", "agent", join(agentDir, name("agent"))),
    create("extdir", "extdir", join(extDir, name("ext"))),
    inner("extdir_inner", "extdir_inner", "ext", "ext", join(extDir, name("ext"))),
    create("githooks", "githooks", join(source, ".git", "hooks", name("hook"))),
    { id: "gitconfig", group: "gitconfig", kind: "append", path: join(source, ".git", "config"), host_observable: true },
    create("userunit", "userunit", join(userUnitDir, `${name("unit")}.service`)),
    // Positive controls: an ordinary write inside the workspace must succeed, or the run proves nothing.
    create("ctl_workspace", "control", join(workspace, name("ws"))),
  ];
}

function detectionPath(attempt, method) {
  return `${attempt.detect ?? resolve(attempt.path)}-${method}`;
}

function attemptApplicable(attempt) {
  if (attempt.kind === "append") return true;
  const parent = attempt.detect ? dirname(attempt.detect) : dirname(resolve(attempt.path));
  return pathExists(parent);
}

function prepareSource(runRoot) {
  const source = join(runRoot, "source");
  mkdirSync(source, { mode: 0o700 });
  const result = spawnSync("git", ["init", "--quiet", source], {
    encoding: "utf8", timeout: 20_000, stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error || result.status !== 0) throw new UsageError("git is required to create the disposable source repository");
  return source;
}

function runProbe(launch, configuration) {
  return new Promise((resolvePromise, rejectPromise) => {
    const encoded = Buffer.from(JSON.stringify(configuration), "utf8").toString("base64url");
    const child = spawn(launch[0], [...launch.slice(1), "-", encoded], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
    let stdout = "";
    let overflow = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, LAUNCH_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) { overflow = true; child.kill("SIGKILL"); }
    });
    child.on("error", () => { clearTimeout(timer); rejectPromise(new UsageError("the launch command could not be started")); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((entry) => entry.startsWith(RESULT_MARKER));
      if (overflow || !line) { rejectPromise(new UsageError(`the probe produced no result (exit ${code ?? "signal"}${signal ? `, ${signal}` : ""})`)); return; }
      try { resolvePromise({ result: JSON.parse(line.slice(RESULT_MARKER.length)), exitCode: code }); }
      catch { rejectPromise(new UsageError("the probe result was not valid JSON")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(readFileSync(PROBE_PATH));
  });
}

function scanCanaries(dirs, prefix) {
  const found = [];
  for (const dir of new Set(dirs)) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) if (name.includes(prefix)) found.push(join(dir, name));
  }
  return found;
}

function removeCanaries(paths) {
  let removed = 0;
  for (const path of paths) {
    try {
      const stat = lstatSync(path);
      if (stat.isFile() || stat.isSymbolicLink()) { unlinkSync(path); removed += 1; }
    } catch { /* already gone */ }
  }
  return removed;
}

function ensureOwnedCacheBase() {
  const base = join(homedir(), ".cache", "pi-session-mcp-isolation");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const stat = lstatSync(base);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new UsageError("the cache directory is not an owned directory");
  return base;
}

function validateWorkspace(workspace, protectedPaths) {
  let real;
  try { real = realpathSync(workspace); } catch { throw new UsageError("--workspace does not exist"); }
  if (!statSync(real).isDirectory()) throw new UsageError("--workspace is not a directory");
  let git;
  try { git = lstatSync(join(real, ".git")); } catch { throw new UsageError("--workspace is not a Git clone (no .git)"); }
  if (!git.isDirectory()) throw new UsageError("--workspace must be a full clone with a .git directory, not a linked worktree or gitfile");
  for (const path of protectedPaths) {
    if (isInside(real, path)) throw new UsageError("--workspace must not contain the home directory, Pi's agent directory or the harness cache");
  }
  return real;
}

/** Runs the acceptance. Returns { report, evaluation }. Cleans up in every case. */
export async function runAcceptance(options) {
  if (process.platform !== "linux") throw new UsageError("the isolation acceptance reads /proc and runs on Linux only");
  const home = homedir();
  const agentDir = agentDirectory();
  const cacheBase = ensureOwnedCacheBase();
  const workspace = validateWorkspace(options.workspace, [home, agentDir, cacheBase, resolve(home, "..")]);
  if (options.out && (existsSync(options.out) || !existsSync(dirname(options.out)))) throw new UsageError("--out must be a new file in an existing directory");
  if (options.out && isInside(workspace, options.out)) throw new UsageError("--out must not be inside the workspace");

  const token = randomBytes(6).toString("hex");
  const prefix = `isolation-canary-${token}`;
  const runRoot = join(cacheBase, `run-${token}`);
  const marker = `isolation-persist-${token}`;
  const linkName = `${prefix}-link`;
  const extDir = join(agentDir, "npm", "node_modules");
  const userUnitDir = join(home, ".config", "systemd", "user");
  const linkPath = join(workspace, linkName);

  let cleaned = false;
  const state = { canariesFound: 0, canariesRemoved: 0, markersKilled: 0 };
  const scanDirs = () => [home, dirname(workspace), workspace, join(runRoot, "outside"), join(runRoot, "outside", "linkdir"), agentDir, extDir, userUnitDir, join(runRoot, "source"), join(runRoot, "source", ".git"), join(runRoot, "source", ".git", "hooks")];
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    state.markersKilled = killMarkerProcesses(marker);
    // The harness' own symlink is removed separately and is not counted as a canary an escape produced.
    const found = scanCanaries(scanDirs(), prefix).filter((path) => path !== linkPath);
    state.canariesFound += found.length;
    state.canariesRemoved += removeCanaries(found);
    if (lstatOrNull(linkPath)?.isSymbolicLink()) unlinkSync(linkPath);
    if (basenameIsRun(runRoot, cacheBase)) rmSync(runRoot, { recursive: true, force: true });
  };
  const onSignal = () => { cleanup(); process.exit(2); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    mkdirSync(runRoot, { mode: 0o700 });
    const outside = join(runRoot, "outside");
    mkdirSync(join(outside, "linkdir"), { recursive: true, mode: 0o700 });
    const source = prepareSource(runRoot);
    symlinkSync(join(outside, "linkdir"), linkPath);

    const layout = { prefix, home, agentDir, extDir, userUnitDir, workspace, outside, source, linkName };
    const attempts = buildAttempts(layout);

    const groups = [
      { id: "startup_files", disposable: false, digest: () => digestFiles(STARTUP_FILES.map((file) => join(home, file))) },
      { id: "agent_dir", disposable: false, digest: () => digestTarget(agentDir, "content", prefix) },
      { id: "extension_packages", disposable: false, digest: () => digestTarget(extDir, "names", prefix) },
      { id: "user_units", disposable: false, digest: () => digestTarget(userUnitDir, "names", prefix) },
      { id: "workspace_parent", disposable: false, digest: () => digestTarget(dirname(workspace), "names", prefix) },
      { id: "workspace_root", disposable: false, digest: () => digestTarget(workspace, "names", prefix) },
      { id: "outside_dir", disposable: true, digest: () => digestTarget(outside, "names", prefix) },
      { id: "source_hooks", disposable: true, digest: () => digestTarget(join(source, ".git", "hooks"), "names", prefix) },
      { id: "source_config", disposable: true, digest: () => digestTarget(join(source, ".git", "config"), "content", prefix) },
    ];
    const snapshot = () => Object.fromEntries(groups.map((group) => [group.id, group.digest()]));

    const before = snapshot();
    const processesBefore = ownProcesses();
    const crontabBefore = crontabLines();
    const unitFilesBefore = listNames(userUnitDir, prefix).length;
    const activeUnitsBefore = activeUserUnits();

    const probeConfiguration = {
      prefix, marker, hostHome: home, networkHost: NETWORK_HOST, skipRemote: options.skipRemote,
      attempts: attempts.map(({ id, kind, path, inner, name, compare }) => ({ id, kind, path, inner, name, compare })),
    };
    const { result: probe } = await runProbe(options.launch, probeConfiguration);
    sleepSync(500);

    const after = snapshot();
    const configText = (() => { try { return readFileSync(join(source, ".git", "config"), "utf8"); } catch { return ""; } })();
    const processesAfter = ownProcesses();
    const crontabAfter = crontabLines();
    const unitFilesAfter = listNames(userUnitDir, prefix).length;
    const activeUnitsAfter = activeUserUnits();
    const survivors = markerProcesses(marker).length;
    const canaryHits = scanCanaries(scanDirs(), prefix).filter((path) => path !== linkPath);

    const probeById = new Map(probe.attempts.map((entry) => [entry.id, entry]));
    const writes = [];
    for (const attempt of attempts) {
      if (attempt.id.startsWith("ctl_")) continue;
      const applicable = attempt.host_observable ? attemptApplicable(attempt) : false;
      for (const method of ["node", "bash"]) {
        const entry = probeById.get(`${attempt.id}.${method}`);
        if (!entry) { writes.push({ id: `${attempt.id}.${method}`, group: attempt.group, method, skipped: true }); continue; }
        let hostChanged = false;
        if (attempt.host_observable) {
          hostChanged = attempt.kind === "append" ? configText.includes(`# ${prefix}-${method}`) : pathExists(detectionPath(attempt, method));
        }
        writes.push({
          id: `${attempt.id}.${method}`, group: attempt.group, method, skipped: false,
          host_observable: attempt.host_observable, applicable,
          probe_blocked: entry.blocked === true, host_changed: hostChanged, error_code: entry.error_code ?? null,
        });
      }
    }
    const controlNode = probeById.get("ctl_workspace.node");
    const controlBash = probeById.get("ctl_workspace.bash");

    const host = hostNamespaces();
    const guest = probe.namespaces ?? {};
    const differs = (kind) => guest[kind] != null && host[kind] != null && guest[kind] !== host[kind];
    const userNs = differs("user");
    const mntNs = differs("mnt");
    const uidDiffers = probe.uid != null && probe.uid !== process.getuid();
    // Bound = a different user namespace, mount namespace or OS user than the harness (rootless Podman, a separate user).
    const bound = options.mode === "contained" ? userNs || mntNs || uidDiffers : false;

    const credentialItems = Object.fromEntries(Object.entries(probe.credentials).map(([key, value]) => [key, { exists: value.exists === true, readable: value.readable === true }]));
    const visibleCount = Object.values(credentialItems).filter((item) => item.exists).length;

    const newProcesses = [...processesAfter.entries()].filter(([key, pid]) => !processesBefore.has(key) && pid !== process.pid).length;
    const groupResults = groups.map((group) => ({ id: group.id, disposable: group.disposable, before: before[group.id].slice(0, 12), after: after[group.id].slice(0, 12), unchanged: before[group.id] === after[group.id] }));
    const preexistingUnchangedAfterProbe = groupResults.filter((group) => !group.disposable).every((group) => group.unchanged);

    // Cleanup runs before the final comparison so that the "after cleanup" digests prove the restoration.
    state.canariesFound += canaryHits.length;
    state.canariesRemoved += removeCanaries(canaryHits);
    cleanup();
    const afterCleanup = Object.fromEntries(groups.filter((group) => !group.disposable).map((group) => [group.id, group.digest()]));
    const preexistingUnchangedAfterCleanup = groups.filter((group) => !group.disposable).every((group) => afterCleanup[group.id] === before[group.id]);
    const residual = scanCanaries(scanDirs(), prefix).length + (pathExists(linkPath) ? 1 : 0);

    const report = {
      tool: "isolation-acceptance",
      schema_version: 1,
      generated_at: new Date().toISOString(),
      mode: options.mode,
      platform: process.platform,
      remote_checks_skipped: options.skipRemote,
      agent_dir_copy_writable_declared: options.agentDirCopyWritable,
      launch_binding: {
        bound,
        user_ns_differs: userNs,
        mnt_ns_differs: mntNs,
        pid_ns_differs: differs("pid"),
        net_ns_differs: differs("net"),
        uid_differs: uidDiffers,
      },
      controls: {
        bash_available: probe.bash_available === true,
        workspace_write_node: controlNode ? controlNode.blocked === false : false,
        workspace_write_bash: controlBash ? controlBash.blocked === false : false,
        marker_started: probe.marker_started === true,
      },
      writes,
      credentials: {
        items: credentialItems,
        visible_count: visibleCount,
        pi_agent_auth_present: probe.pi_agent_auth?.exists === true,
        ssh_authenticated: probe.ssh_authenticated === null || probe.ssh_authenticated === undefined ? null : probe.ssh_authenticated === true,
      },
      persistence: {
        marker_survivors: survivors,
        new_own_processes: newProcesses,
        crontab_delta: crontabAfter - crontabBefore,
        user_unit_delta: unitFilesAfter - unitFilesBefore,
        active_user_units_delta: activeUnitsBefore === null || activeUnitsAfter === null ? null : activeUnitsAfter - activeUnitsBefore,
      },
      children: classifyEnvNames(Array.isArray(probe.child_env_names) ? probe.child_env_names : [], options.envAllow),
      network: classifyNetwork(typeof probe.network_tcp_443 === "boolean" ? probe.network_tcp_443 : null),
      digests: {
        groups: groupResults,
        preexisting_unchanged_after_probe: preexistingUnchangedAfterProbe,
        preexisting_unchanged_after_cleanup: preexistingUnchangedAfterCleanup,
      },
      cleanup: {
        canaries_found: state.canariesFound,
        canaries_removed: state.canariesRemoved,
        markers_killed: state.markersKilled,
        residual_canaries: residual,
        run_root_removed: !pathExists(runRoot),
      },
    };
    const evaluation = evaluateVerdict(report, { agentDirCopyWritable: options.agentDirCopyWritable });
    report.verdict = evaluation.verdict;
    report.failed_checks = evaluation.failed_checks;
    report.inconclusive_checks = evaluation.inconclusive_checks;
    assertSanitized(report);
    return { report, evaluation };
  } finally {
    cleanup();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

function basenameIsRun(runRoot, cacheBase) {
  return dirname(runRoot) === cacheBase && /^run-[0-9a-f]{12}$/.test(runRoot.slice(cacheBase.length + 1)) && !lstatOrNull(runRoot)?.isSymbolicLink();
}

function lstatOrNull(path) {
  try { return lstatSync(path); } catch { return null; }
}

const USAGE = `Usage: node scripts/isolation-acceptance.mjs --launch "<prefix that runs node>" --workspace <dir>
         --mode contained|uncontained-control [--out <json>] [--env-allow A,B]
         [--agent-dir-copy-writable] [--no-remote-checks]
Exit codes: 0 pass or expected control result, 1 fail, 2 usage/environment error or inconclusive.
See docs/isolation-setup.md.`;

export async function main(argv) {
  let options;
  try { options = parseArguments(argv); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "invalid arguments"}\n${USAGE}\n`); return 2; }
  if (options.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  try {
    const { report, evaluation } = await runAcceptance(options);
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out) writeFileSync(options.out, text, { mode: 0o600, flag: "wx" });
    else process.stdout.write(text);
    process.stdout.write(`verdict=${evaluation.verdict} exit=${evaluation.exit_code} failed=${evaluation.failed_checks.length} inconclusive=${evaluation.inconclusive_checks.length}\n`);
    return evaluation.exit_code;
  } catch (error) {
    process.stderr.write(`${error instanceof UsageError ? error.message : "unexpected error in the isolation acceptance"}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
