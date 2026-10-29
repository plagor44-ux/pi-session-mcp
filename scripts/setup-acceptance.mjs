// Level 2 setup acceptance for pi-session-mcp (maintainer script).
//
// Runs the nine-step setup lifecycle of docs/acceptance.md ("Level 2: setup
// acceptance") against the real `codex` and `claude` CLIs and checks the pass
// criteria. It only ever uses disposable homes below the work directory and
// never touches the real home: the real client registrations are only read to
// prove that their digest did not change.
//
// Usage:
//   node scripts/setup-acceptance.mjs --setup "<command prefix>" \
//     --label <text> --out <result.json> \
//     [--build-dir <dir>] [--clients codex,claude-code] [--work-dir <dir>]
//     [--events spool]
//
//   --setup      command that runs the setup CLI, for example
//                "node <checkout>/dist/setup-main.js" or
//                "<prefix>/bin/pi-session-mcp-setup". It is split on
//                whitespace, so paths in it must not contain spaces; its first
//                token must be an existing file or a command found on PATH
//   --label      free text that names the run in the result
//   --out        file that receives the sanitized JSON result
//   --build-dir  checkout or installed package whose package.json,
//                package-lock.json, dist/ and .pi-session-mcp-cli/ must be
//                byte-identical before and after the run
//   --clients    comma-separated subset, default "codex,claude-code"
//   --work-dir   default ~/.cache/pi-session-mcp-acceptance; it must not be
//                below a temporary directory (/tmp, /var/tmp, /dev/shm or the
//                system temporary directory), because Codex refuses helper
//                binaries there
//   --events     "spool" runs the same lifecycle with turn-event delivery
//                enabled (ADR 0011, #113): Claude Code commands get a
//                disposable XDG_RUNTIME_DIR, Codex commands none (Codex passes
//                none to MCP servers), and every Claude Code step also checks
//                the wake hook finding, its settings entry, a foreign hook that
//                must survive, and that no spool instance is left behind
//
// Exit status: 0 all checks passed, 1 a check failed, 2 on a usage,
// environment or harness error; 130 and 143 after SIGINT and SIGTERM. Node
// built-ins only; Linux and macOS.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const USAGE = 'usage: node scripts/setup-acceptance.mjs --setup "<command prefix>" --label <text> --out <result.json>\n' +
  "         [--build-dir <dir>] [--clients codex,claude-code] [--work-dir <dir>] [--events spool]\n";
const ALIAS = "pi-session-mcp";
const ALL_CLIENTS = ["codex", "claude-code"];

function usageError(message) {
  process.stderr.write(`${message}\n${USAGE}`);
  process.exit(2);
}

// ---- arguments and environment checks ------------------------------------
function parseArguments() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        setup: { type: "string" },
        label: { type: "string" },
        out: { type: "string" },
        "build-dir": { type: "string" },
        clients: { type: "string" },
        "work-dir": { type: "string" },
        events: { type: "string" },
      },
    }));
  } catch (error) {
    usageError(error.message);
  }
  if (!values.setup?.trim() || !values.label || !values.out) usageError("--setup, --label and --out are required");
  const clients = (values.clients ?? ALL_CLIENTS.join(",")).split(",").map((c) => c.trim());
  if (clients.length === 0 || clients.some((c) => !ALL_CLIENTS.includes(c)) || new Set(clients).size !== clients.length) {
    usageError(`--clients must be a comma-separated subset of ${ALL_CLIENTS.join(", ")}`);
  }
  if (values.events !== undefined && values.events !== "spool") usageError('--events must be "spool"');
  return { ...values, clients };
}

// Resolve symlinks of the nearest existing ancestor, so a not yet created
// directory is still compared by its real location.
function realPathOf(path) {
  const missing = [];
  let current = resolve(path);
  while (!existsSync(current)) { missing.unshift(basename(current)); current = dirname(current); }
  return join(realpathSync(current), ...missing);
}
function isInside(path, parent) {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function refuseTemporaryWorkDir(workDir) {
  const temporary = new Set(["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/dev/shm", tmpdir()]);
  for (const dir of [...temporary]) temporary.add(realPathOf(dir));
  const candidates = [resolve(workDir), realPathOf(workDir)];
  if ([...temporary].some((dir) => candidates.some((c) => isInside(c, dir)))) {
    usageError("--work-dir must not be inside a temporary directory: Codex refuses helper binaries there");
  }
}

// The first token of --setup must be an existing file or a command on PATH.
function checkSetupCommand(token) {
  const isExecutableFile = (p) => {
    try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
  };
  if (token.includes("/")) {
    if (!isAbsolute(token)) usageError("the first token of --setup must be an absolute path or a command name: setup commands run in another directory");
    if (!existsSync(token)) usageError("the first token of --setup is not an existing file");
    return;
  }
  const found = (process.env.PATH ?? "").split(":").some((dir) => dir !== "" && isExecutableFile(join(dir, token)));
  if (!found) usageError("the first token of --setup is not a command found on PATH");
}

const args = parseArguments();
if (process.platform !== "linux" && process.platform !== "darwin") usageError("only Linux and macOS are supported");
const WORK_DIR = args["work-dir"] ? resolve(args["work-dir"]) : join(homedir(), ".cache", "pi-session-mcp-acceptance");
refuseTemporaryWorkDir(WORK_DIR);
checkSetupCommand(args.setup.trim().split(/\s+/)[0]);
if (!existsSync(dirname(resolve(args.out)))) usageError("the directory of --out does not exist");
if (args["build-dir"] && !existsSync(resolve(args["build-dir"]))) usageError("--build-dir does not exist");

const REAL_HOME = homedir();
const CLIENTS = args.clients;
const SETUP_PREFIX = args.setup.trim().split(/\s+/);
const RUN_ID = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid}`;
const ROOT = join(WORK_DIR, RUN_ID);
const BASE_PATH = process.env.PATH ?? "";
const DELIVERY = args.events === "spool";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
};
const stripPaths = (text) => text.replace(/\/\S+/g, "<path>");

// ---- check bookkeeping ---------------------------------------------------
let total = 0;
let failures = 0;
const check = (ok) => { total += 1; if (!ok) failures += 1; return Boolean(ok); };

// ---- read-only digests of the REAL client registrations ------------------
function mcpServersOf(claudeJson) {
  const servers = { top: claudeJson.mcpServers ?? {}, projects: {} };
  for (const [key, entry] of Object.entries(claudeJson.projects ?? {})) if (entry?.mcpServers) servers.projects[key] = entry.mcpServers;
  return servers;
}
// A config file that does not exist has the constant digest "absent"; one that
// exists but cannot be read or parsed is "unreadable" and fails the run.
function digestOf(path, digest) {
  if (!existsSync(path)) return "absent";
  try { return digest(readFileSync(path, "utf8")); } catch { return "unreadable"; }
}
function realClaudeDigest() {
  return digestOf(join(REAL_HOME, ".claude.json"), (text) => sha(JSON.stringify(canonical(mcpServersOf(JSON.parse(text))))));
}
// Only the `mcp_servers` tables of the Codex config take part in the digest.
function mcpTables(text) {
  const out = [];
  let inside = false;
  for (const line of text.split("\n")) {
    const header = /^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*(#.*)?$/.exec(line);
    if (header) inside = /^mcp_servers(\.|$)/.test(header[1]);
    if (inside) out.push(line);
  }
  return out.join("\n");
}
function realCodexDigest() {
  return digestOf(join(REAL_HOME, ".codex", "config.toml"), (text) => sha(mcpTables(text)));
}
const realDigest = () => CLIENTS.map((c) => (c === "codex" ? realCodexDigest() : realClaudeDigest())).join("|");

// ---- disposable environment ----------------------------------------------
const homes = { codex: join(ROOT, "home-codex"), "claude-code": join(ROOT, "home-claude") };
const project = join(ROOT, "project");
const configPath = join(ROOT, "acceptance-config.json");
const codexHome = join(homes.codex, ".codex");
const runtimeDir = join(ROOT, "runtime");

function envFor(client) {
  const env = { HOME: homes[client], PATH: BASE_PATH, PI_SESSION_MCP_CONFIG: configPath };
  if (client === "codex") env.CODEX_HOME = codexHome;
  // Claude Code passes its full environment to MCP servers and hooks, Codex no runtime directory.
  if (DELIVERY && client === "claude-code") env.XDG_RUNTIME_DIR = runtimeDir;
  return env;
}
// Every client and setup command runs with a scrubbed environment.
function run(client, argv, timeout = 120_000) {
  const envArgs = Object.entries(envFor(client)).map(([k, v]) => `${k}=${v}`);
  const r = spawnSync("env", ["-i", ...envArgs, ...argv], { cwd: project, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

// ---- disposable client state inspection (file based) ---------------------
function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } }
const claudeJson = () => readJson(join(homes["claude-code"], ".claude.json"));
function codexConfigText() { try { return readFileSync(join(codexHome, "config.toml"), "utf8"); } catch { return ""; } }
const projectMcp = () => readJson(join(project, ".mcp.json"));

function present(client, scope, name) {
  if (client === "codex") {
    const escaped = name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    return new RegExp(`^\\s*\\[mcp_servers\\.("?)${escaped}\\1\\]`, "m").test(codexConfigText());
  }
  if (scope === "user") return Boolean(claudeJson()?.mcpServers?.[name]);
  if (scope === "local") return Boolean(claudeJson()?.projects?.[project]?.mcpServers?.[name]);
  if (scope === "project") return Boolean(projectMcp()?.mcpServers?.[name]);
  return false;
}
function clientState(client) {
  if (client === "codex") return sha(codexConfigText());
  return sha(JSON.stringify(canonical({ servers: mcpServersOf(claudeJson() ?? {}), projectFile: projectMcp() ?? null })));
}

// Ownership state lives at $HOME/.local/state/pi-session-mcp/ownership.json.
function ownership(client) {
  const dir = join(homes[client], ".local", "state", "pi-session-mcp");
  const file = join(dir, "ownership.json");
  const out = { dirMode: null, fileMode: null, records: null };
  try { out.dirMode = (statSync(dir).mode & 0o777).toString(8); } catch { /* absent */ }
  try { out.fileMode = (statSync(file).mode & 0o777).toString(8); } catch { /* absent */ }
  if (out.fileMode !== null) {
    try { const parsed = JSON.parse(readFileSync(file, "utf8")); out.records = Array.isArray(parsed) ? parsed.length : -1; } catch { out.records = -1; }
  }
  return out;
}
const ownershipChecks = (client) => {
  const own = ownership(client);
  return {
    ownershipRecordsEmpty: check(own.records === 0),
    ownershipDirMode0700: check(own.dirMode === "700"),
    ownershipFileMode0600: check(own.fileMode === "600"),
  };
};

// ---- build-dir hashing ---------------------------------------------------
function hashTree(dir) {
  const out = {};
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p); else if (entry.isFile()) out[relative(dir, p)] = sha(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}
function buildSnapshot(buildDir) {
  const snap = {};
  for (const f of ["package.json", "package-lock.json"]) { const p = join(buildDir, f); if (existsSync(p)) snap[f] = sha(readFileSync(p)); }
  for (const sub of ["dist", ".pi-session-mcp-cli"]) for (const [k, v] of Object.entries(hashTree(join(buildDir, sub)))) snap[`${sub}/${k}`] = v;
  return snap;
}

// ---- process check -------------------------------------------------------
// Process table as [{ pid, ppid, cmd }]: /proc on Linux, `ps` on macOS.
function processTable() {
  if (process.platform === "darwin") {
    const r = spawnSync("/bin/ps", ["-ww", "-A", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error("ps failed");
    return r.stdout.split("\n").flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }] : [];
    });
  }
  const table = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      table.push({ pid: Number(name), ppid, cmd: readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ") });
    } catch { /* process exited meanwhile */ }
  }
  return table;
}
// Matching processes of the build under test; this script and its ancestors
// (whose command line names the setup command) and other instances are not.
function leftoverProcesses(patterns) {
  const table = processTable();
  const parentOf = new Map(table.map((p) => [p.pid, p.ppid]));
  const skip = new Set([process.pid]);
  for (let pid = process.pid; parentOf.has(pid) && !skip.has(parentOf.get(pid)); pid = parentOf.get(pid)) skip.add(parentOf.get(pid));
  return table
    .filter((p) => !skip.has(p.pid) && !p.cmd.includes("setup-acceptance.mjs") && patterns.some((pattern) => p.cmd.includes(pattern)))
    .map((p) => p.pid);
}
// Signal handlers only run when the event loop turns; the lifecycle is
// otherwise synchronous, so it yields between steps (a running child finishes first).
const tick = () => new Promise((done) => setImmediate(done));
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---- lifecycle -----------------------------------------------------------
// Setup reports one finding per controller skill, in this order, after the registration (#139).
const CONTROLLER_SKILLS = ["pi-session-orchestration", "pi-session-profiles"];
const SKILL_SEQUENCE = [
  ["skill_absent", "absent"], ["skill_absent", "absent"],
  ["skill_installed", "ok"], ["skill_already_equivalent", "unchanged"],
  ["skill_verified", "ok"], ["skill_removed", "ok"],
  ["skill_installed", "ok"], ["skill_verified", "ok"], ["skill_removed", "ok"],
];
const SEQUENCE = [
  { n: 1, flag: null, overall: "planned", status: "absent", code: "absent" },
  { n: 2, flag: "--dry-run", overall: "planned", status: "absent", code: "absent" },
  { n: 3, flag: "--apply", overall: "ok", status: "ok", code: "applied" },
  { n: 4, flag: "--apply", overall: "ok", status: "unchanged", code: "already_equivalent" },
  { n: 5, flag: "--verify", overall: "ok", status: "ok", code: "mcp_verified" },
  { n: 6, flag: "--rollback", overall: "ok", status: "ok", code: "rolled_back" },
  { n: 7, flag: "--apply", overall: "ok", status: "ok", code: "applied" },
  { n: 8, flag: "--verify", overall: "ok", status: "ok", code: "mcp_verified" },
  { n: 9, flag: "--remove", overall: "ok", status: "ok", code: "removed" },
];
const TARGETS = [
  { client: "codex", scope: "user" },
  { client: "claude-code", scope: "user" },
  { client: "claude-code", scope: "project" },
  { client: "claude-code", scope: "local" },
].filter((t) => CLIENTS.includes(t.client));
// One sentinel per scope: an unrelated registration that must survive.
const SENTINELS = [
  { client: "codex", scope: "user", name: "acceptance-sentinel", argv: ["codex", "mcp", "add", "acceptance-sentinel", "--", "/bin/true"] },
  { client: "claude-code", scope: "user", name: "acceptance-sentinel", argv: ["claude", "mcp", "add", "--scope", "user", "acceptance-sentinel", "--", "/bin/true"] },
  { client: "claude-code", scope: "project", name: "acceptance-sentinel-project", argv: ["claude", "mcp", "add", "--scope", "project", "acceptance-sentinel-project", "--", "/bin/true"] },
  { client: "claude-code", scope: "local", name: "acceptance-sentinel-local", argv: ["claude", "mcp", "add", "--scope", "local", "acceptance-sentinel-local", "--", "/bin/true"] },
].filter((s) => CLIENTS.includes(s.client));

function skillParent(t) {
  return join(t.scope === "project" ? project : homes[t.client], t.client === "codex" ? ".agents" : ".claude", "skills");
}
const skillFiles = (t) => CONTROLLER_SKILLS.map((name) => join(skillParent(t), name, "SKILL.md"));
const skillsPresent = (t) => skillFiles(t).every((file) => existsSync(file));
const skillsAbsent = (t) => skillFiles(t).every((file) => !existsSync(file));
const foreignSkillFile = (t) => join(skillParent(t), "acceptance-foreign-skill", "SKILL.md");
const FOREIGN_SKILL_CONTENT = "foreign skill sentinel\n";

// ---- wake hook (--events spool, Claude Code targets only) ------------------
const HOOK_ALIAS = "hook:pi-session-mcp-wake";
const HOOK_SEQUENCE = [
  ["hook_add_planned", "planned"], ["hook_add_planned", "planned"],
  ["hook_added", "ok"], ["hook_already_equivalent", "unchanged"],
  ["hook_verified", "ok"], ["hook_removed", "ok"],
  ["hook_added", "ok"], ["hook_verified", "ok"], ["hook_removed", "ok"],
];
const FOREIGN_HOOK = { matcher: "acceptance-foreign", hooks: [{ type: "command", command: "/bin/true" }] };
const hookExpected = (t) => DELIVERY && t.client === "claude-code";
function settingsFile(t) {
  if (t.scope === "user") return join(homes["claude-code"], ".claude", "settings.json");
  return join(project, ".claude", t.scope === "project" ? "settings.json" : "settings.local.json");
}
const postToolUse = (t) => readJson(settingsFile(t))?.hooks?.PostToolUse;
const wakeEntries = (t) => (Array.isArray(postToolUse(t)) ? postToolUse(t).filter((e) => JSON.stringify(e).includes("/dist/wake-main.js")).length : -1);
const foreignHookUnchanged = (t) => Array.isArray(postToolUse(t)) && postToolUse(t).some((e) => JSON.stringify(e) === JSON.stringify(FOREIGN_HOOK));
// A verify run starts a real server; it must not leave an instance directory that a wake hook would wait on.
function spoolInstances() {
  try { return readdirSync(join(runtimeDir, "pi-session-mcp", "events")).filter((name) => name.startsWith("inst-")).length; } catch { return 0; }
}
function foreignSkillUnchanged(t) {
  try { return readFileSync(foreignSkillFile(t), "utf8") === FOREIGN_SKILL_CONTENT; } catch { return false; }
}

function prepareEnvironment() {
  for (const dir of [ROOT, project, ...CLIENTS.map((c) => homes[c]), ...(CLIENTS.includes("codex") ? [codexHome] : [])]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (DELIVERY) mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify({
    ...(DELIVERY ? { events: { delivery: "spool" } } : {}),
    workspaces: { "acceptance-project": project },
    executionProfiles: {
      "acceptance-readonly": { default: true, permissionProfile: "read-only", provider: "inert-provider", model: "inert-model", thinkingLevel: "off" },
    },
  }, null, 2), { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

function recordVersions(result, buildDir) {
  const first = (r) => stripPaths(r.stdout.trim().split("\n")[0]);
  const lines = (r) => r.stdout.trim().split("\n").length;
  result.versions = { node: process.version, platform: process.platform, arch: process.arch };
  if (CLIENTS.includes("codex")) {
    const r = run("codex", ["codex", "--version"]);
    result.versions.codex = first(r);
    result.versions.codexOutputLines = lines(r); // a warning line would make the strict parser reject the version
    check(r.status === 0 && lines(r) === 1);
  }
  if (CLIENTS.includes("claude-code")) {
    const r = run("claude-code", ["claude", "--version"]);
    result.versions.claude = first(r);
    result.versions.claudeOutputLines = lines(r);
    check(r.status === 0);
  }
  if (buildDir && existsSync(join(buildDir, "dist", "main.js"))) result.setupBuildMainSha256 = sha(readFileSync(join(buildDir, "dist", "main.js")));
}

function addSentinels(result) {
  for (const t of TARGETS) {
    mkdirSync(dirname(foreignSkillFile(t)), { recursive: true, mode: 0o755 });
    writeFileSync(foreignSkillFile(t), FOREIGN_SKILL_CONTENT, { mode: 0o644 });
  }
  for (const t of TARGETS.filter(hookExpected)) {
    mkdirSync(dirname(settingsFile(t)), { recursive: true, mode: 0o755 });
    writeFileSync(settingsFile(t), `${JSON.stringify({ hooks: { PostToolUse: [FOREIGN_HOOK] } }, null, 2)}\n`, { mode: 0o644 });
  }
  for (const s of SENTINELS) {
    const r = run(s.client, s.argv);
    const added = check(r.status === 0 && present(s.client, s.scope, s.name));
    result.sentinels.push({ client: s.client, scope: s.scope, name: s.name, added });
  }
}

function runStep(t, step, reports, stateBeforeStep1) {
  const targetId = `${t.client}:${t.scope}:${ALIAS}`;
  const r = run(t.client, [...SETUP_PREFIX, ...(step.flag ? [step.flag] : []), "--json", "--target", targetId]);
  reports.push(r.stdout);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { parsed = undefined; }
  const count = 1 + CONTROLLER_SKILLS.length + (hookExpected(t) ? 1 : 0);
  const complete = parsed?.findings?.length === count;
  const finding = complete ? parsed.findings[0] : undefined;
  const skillFindings = complete ? parsed.findings.slice(1, 1 + CONTROLLER_SKILLS.length) : [];
  const hookFinding = hookExpected(t) && complete ? parsed.findings[1 + CONTROLLER_SKILLS.length] : undefined;
  const [skillCode, skillStatus] = SKILL_SEQUENCE[step.n - 1];
  const [hookCode, hookStatus] = hookExpected(t) ? HOOK_SEQUENCE[step.n - 1] : [null, null];
  const observed = {
    overall: parsed?.status ?? null,
    status: finding?.status ?? null,
    code: finding?.code ?? null,
    skillStatuses: skillFindings.map((skillFinding) => skillFinding.status ?? null),
    skillCodes: skillFindings.map((skillFinding) => skillFinding.code ?? null),
    skillTargetMatches: skillFindings.length === CONTROLLER_SKILLS.length && skillFindings.every((skillFinding, index) =>
      skillFinding.target.client === t.client && skillFinding.target.scope === t.scope && skillFinding.target.alias === CONTROLLER_SKILLS[index]),
    exit: r.status,
    findingCount: parsed?.findings?.length ?? null,
    targetMatches: finding ? finding.target.client === t.client && finding.target.scope === t.scope && finding.target.alias === ALIAS : false,
    hookStatus: hookFinding?.status ?? null,
    hookCode: hookFinding?.code ?? null,
    hookTargetMatches: hookFinding ? hookFinding.target.client === t.client && hookFinding.target.scope === t.scope && hookFinding.target.alias === HOOK_ALIAS : !hookExpected(t),
  };
  const pass = check(
    observed.overall === step.overall && observed.status === step.status && observed.code === step.code &&
    observed.exit === 0 && observed.findingCount === count && observed.targetMatches &&
    observed.hookCode === hookCode && observed.hookStatus === hookStatus && observed.hookTargetMatches &&
    observed.skillCodes.every((code) => code === skillCode) && observed.skillStatuses.every((status) => status === skillStatus) &&
    observed.skillTargetMatches && !r.error && !r.signal,
  );
  const record = { step: step.n, operation: step.flag ?? "default", expected: { overall: step.overall, status: step.status, code: step.code, skillCode, skillStatus, ...(hookExpected(t) ? { hookCode, hookStatus } : {}), exit: 0 }, observed, pass };
  if (hookExpected(t)) {
    record.wakeEntriesAfter = wakeEntries(t);
    record.wakeEntryExpected = check(record.wakeEntriesAfter === (step.n === 3 || step.n === 4 || step.n === 5 || step.n === 7 || step.n === 8 ? 1 : 0));
    record.foreignHookUnchanged = check(foreignHookUnchanged(t));
  }
  if (DELIVERY && (step.n === 5 || step.n === 8)) record.noSpoolInstanceLeft = check(spoolInstances() === 0);
  if (step.n === 1 || step.n === 2) record.clientStateUnchanged = check(clientState(t.client) === stateBeforeStep1);
  if (step.n === 3 || step.n === 7) record.registrationPresentAfter = check(present(t.client, t.scope, ALIAS));
  if (step.n === 3 || step.n === 7) record.skillPresentAfter = check(skillsPresent(t));
  if (step.n === 6 || step.n === 9) record.skillAbsentAfter = check(skillsAbsent(t));
  record.foreignSkillUnchanged = check(foreignSkillUnchanged(t));
  if (step.n === 6) record.registrationAbsentAfter = check(!present(t.client, t.scope, ALIAS));
  return record;
}

async function runTarget(t, reports) {
  const entry = { target: `${t.client}:${t.scope}:${ALIAS}`, steps: [], postconditions: {} };
  const stateBeforeStep1 = clientState(t.client);
  for (const step of SEQUENCE) { await tick(); entry.steps.push(runStep(t, step, reports, stateBeforeStep1)); }
  // after step 9
  entry.postconditions = {
    registrationAbsent: check(!present(t.client, t.scope, ALIAS)),
    skillAbsent: check(skillsAbsent(t)),
    foreignSkillUnchanged: check(foreignSkillUnchanged(t)),
    sentinelPresent: check(SENTINELS.filter((s) => s.client === t.client).every((s) => present(s.client, s.scope, s.name))),
    ...(hookExpected(t) ? { wakeEntryAbsent: check(wakeEntries(t) === 0), foreignHookUnchanged: check(foreignHookUnchanged(t)) } : {}),
    ...ownershipChecks(t.client),
  };
  return entry;
}

function checkFinalState(result) {
  for (const client of CLIENTS) {
    result.finalChecks.push({
      client,
      skillsAbsentEverySlot: check(TARGETS.filter((t) => t.client === client).every(skillsAbsent)),
      foreignSkillsUnchanged: check(TARGETS.filter((t) => t.client === client).every(foreignSkillUnchanged)),
      registrationAbsentEveryScope: check(TARGETS.filter((t) => t.client === client).every((t) => !present(t.client, t.scope, ALIAS))),
      sentinelsPresent: check(SENTINELS.filter((s) => s.client === client).every((s) => present(s.client, s.scope, s.name))),
      ...ownershipChecks(client),
    });
  }
}

function checkProcesses(buildDirs) {
  const patterns = ["setup-main.js", "setup-command-guardian.js", "pi-session-mcp-setup"];
  if (buildDirs) patterns.push(...buildDirs.map((dir) => join(dir, "dist", "main.js")));
  else patterns.push("pi-session-mcp/dist/main.js");
  let leftover = leftoverProcesses(patterns);
  for (let i = 0; i < 10 && leftover.length > 0; i += 1) { sleepMs(500); leftover = leftoverProcesses(patterns); } // allow a short settle
  return { leftoverCount: leftover.length, pass: check(leftover.length === 0) };
}

// No setup report may contain a path, the configuration location, an
// environment value or a secret.
function scanReports(reports) {
  const forbidden = [
    "/home/", "/tmp/", "/Users/", ROOT, project, configPath, REAL_HOME,
    ...CLIENTS.flatMap((c) => Object.values(envFor(c))),
  ].filter((v) => v && v.length > 1);
  const secretRe = /(sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9+/_=-]{32,}|bearer\s|api[_-]?key|secret|password|passwd|authorization)/i;
  const pathRe = /(^|[^A-Za-z0-9_])\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]/; // any absolute-looking path
  let hits = 0;
  for (const text of reports) {
    for (const f of forbidden) if (text.includes(f)) hits += 1;
    if (secretRe.test(text)) hits += 1;
    if (pathRe.test(text)) hits += 1;
  }
  return { reportsScanned: reports.length, hits, pass: check(hits === 0 && reports.length === TARGETS.length * SEQUENCE.length) };
}

function summarize(result) {
  const lines = [`setup acceptance ${result.label} (events ${result.events}): ${total - failures}/${total} checks passed, ${failures} failed`];
  const v = result.versions;
  lines.push(`versions: node ${v.node}; ${v.codex ?? "codex not run"}; ${v.claude ?? "claude not run"}`);
  for (const t of result.targets) {
    const bad = t.steps.filter((s) => !s.pass).map((s) => `${s.step}(${s.observed.overall}/${s.observed.status}/${s.observed.code}${s.observed.hookCode ? `/${s.observed.hookCode}` : ""}/exit ${s.observed.exit})`);
    const post = Object.entries(t.postconditions).filter(([, ok]) => !ok).map(([k]) => k);
    lines.push(`  ${t.target}: steps ${t.steps.filter((s) => s.pass).length}/${SEQUENCE.length}${bad.length ? ` FAIL ${bad.join(", ")}` : ""}${post.length ? `; postcondition FAIL ${post.join(", ")}` : ""}`);
  }
  lines.push(`  real registrations unchanged: ${result.realRegistrationsUnchanged}; processes: ${result.processCheck?.pass}; leak check: ${result.pathLeakCheck?.pass}; build unchanged: ${result.buildUnchanged}`);
  for (const n of result.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

// ---- main ----------------------------------------------------------------
const result = {
  label: args.label,
  events: DELIVERY ? "spool" : "off",
  timestamp: new Date().toISOString(),
  clients: CLIENTS,
  versions: {},
  setupBuildMainSha256: null,
  buildUnchanged: null,
  targets: [],
  sentinels: [],
  finalChecks: [],
  realRegistrationsUnchanged: null,
  processCheck: null,
  pathLeakCheck: null,
  notes: [],
  totalChecks: 0,
  failures: 0,
};
const reports = []; // raw stdout of every setup command, for the leak scan only
// The build directory as given and with symlinks resolved: a process may name either.
const buildDirs = args["build-dir"] ? [...new Set([resolve(args["build-dir"]), realpathSync(resolve(args["build-dir"]))])] : null;
const buildDir = buildDirs ? buildDirs[buildDirs.length - 1] : null;
let harnessError = false;

// A signal skips the `finally` below: remove this run's directory only, then exit.
// The handler runs at the next tick, that is after the child process in flight.
function removeRunDirectoryAndExit(code) {
  try {
    if (basename(ROOT) === RUN_ID && dirname(ROOT) === WORK_DIR && ROOT !== WORK_DIR) rmSync(ROOT, { recursive: true, force: true });
  } catch { /* best effort */ }
  process.exit(code);
}
process.on("SIGINT", () => removeRunDirectoryAndExit(130));
process.on("SIGTERM", () => removeRunDirectoryAndExit(143));

try {
  const realBefore = realDigest();
  const buildBefore = buildDir ? buildSnapshot(buildDir) : null;

  prepareEnvironment();
  // The Claude Code local scope is keyed by the project path as the client sees it.
  if (realpathSync(project) !== project) result.notes.push("project path is a symlink; local-scope inspection may mismatch");
  await tick();
  recordVersions(result, buildDir);
  await tick();
  addSentinels(result);
  for (const t of TARGETS) result.targets.push(await runTarget(t, reports));
  checkFinalState(result);

  if (buildDir) {
    const after = buildSnapshot(buildDir);
    result.buildUnchanged = check(JSON.stringify(canonical(buildBefore)) === JSON.stringify(canonical(after)));
    result.buildFileCount = Object.keys(after).length;
  }
  result.processCheck = checkProcesses(buildDirs);
  result.pathLeakCheck = scanReports(reports);

  const realAfter = realDigest();
  result.realRegistrationsUnchanged = check(realBefore === realAfter && !realBefore.includes("unreadable") && !realAfter.includes("unreadable"));
  if (realBefore.includes("unreadable")) result.notes.push("a real registration source was unreadable; digest comparison is not meaningful for it");
  if (realBefore.includes("absent")) result.notes.push("a real registration source does not exist; its digest is the constant absent");
} catch (error) {
  result.notes.push(`harness_error: ${stripPaths(String(error?.message ?? error))}`);
  check(false);
  harnessError = true;
} finally {
  // Only this run's directory is removed, never the work directory itself.
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  result.disposableDirectoryRemoved = !existsSync(ROOT);
  if (!result.disposableDirectoryRemoved) check(false);
  result.totalChecks = total;
  result.failures = failures;
  writeFileSync(resolve(args.out), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
  console.log(summarize(result));
  process.exitCode = harnessError ? 2 : failures > 0 ? 1 : 0;
}
