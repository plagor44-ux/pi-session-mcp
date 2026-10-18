// Provider-free probe for the ADR 0008 isolation acceptance (docs/isolation-setup.md).
//
// scripts/isolation-acceptance.mjs pipes this file to `<launch prefix> - <config>`, so it runs inside
// the boundary under test as the boundary's Node.js process. It reads its configuration from argv[2]
// (base64url JSON), attempts the escapes listed there through Node.js file writes and through
// `bash -c`, observes credentials, environment, namespaces and network, and prints exactly one line
// "ISOLATION_PROBE_RESULT <json>" on stdout. The harness consumes that line and never copies it into
// its own report.
//
// Safety: the probe only creates NEW files (O_EXCL / noclobber) whose names carry the per-run token,
// and appends one comment line to the config of the harness-owned disposable source repository. It
// never reads file contents, never runs a mutating remote command and never prints a path or value.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const net = require("node:net");

const config = JSON.parse(Buffer.from(process.argv[2] || "", "base64url").toString("utf8"));
const home = os.homedir();
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");

const sanitizeCode = (code) => (typeof code === "string" && /^[A-Z0-9_]{2,16}$/.test(code) ? code : "OTHER");

function bashCode(stderr) {
  const text = String(stderr || "");
  if (/read-only file system/i.test(text)) return "EROFS";
  if (/permission denied/i.test(text)) return "EACCES";
  if (/no such file/i.test(text)) return "ENOENT";
  if (/not a directory/i.test(text)) return "ENOTDIR";
  if (/cannot overwrite|file exists/i.test(text)) return "EEXIST";
  return "OTHER";
}

// Create attempts get a per-method suffix so the node and bash attempt never collide on one name.
function nodeAttempt(target, kind) {
  try {
    if (kind === "append") fs.appendFileSync(target, `\n# ${config.prefix}-node\n`);
    else fs.writeFileSync(`${target}-node`, "x\n", { flag: "wx" });
    return { blocked: false, error_code: null };
  } catch (error) {
    return { blocked: true, error_code: sanitizeCode(error && error.code) };
  }
}

let bashAvailable = true;
function bashAttempt(target, kind) {
  const script = 'set -C; if [ "$K" = append ]; then printf "\\n# %s-bash\\n" "$M" >> "$T"; else printf "x\\n" > "$T-bash"; fi';
  const result = cp.spawnSync("bash", ["-c", script], {
    env: { ...process.env, T: target, K: kind, M: config.prefix },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error && result.error.code === "ENOENT") { bashAvailable = false; return { blocked: true, error_code: "ENOENT" }; }
  if (result.status === 0) return { blocked: false, error_code: null };
  return { blocked: true, error_code: bashCode(result.stderr) };
}

// The harness passes host-side paths. `inner` attempts name the same location as this process sees it
// (its own home or agent directory); they matter when the boundary maps those somewhere else.
function resolveTarget(attempt) {
  if (attempt.path) return attempt.path;
  const base = { home, agent: agentDir, ext: path.join(agentDir, "npm", "node_modules") }[attempt.inner];
  const target = path.join(base, attempt.name);
  return target === attempt.compare ? null : target;
}

const attempts = [];
for (const attempt of config.attempts) {
  const target = resolveTarget(attempt);
  if (target === null) { attempts.push({ id: attempt.id, skipped: true }); continue; }
  const viaNode = nodeAttempt(target, attempt.kind);
  attempts.push({ id: `${attempt.id}.node`, ...viaNode });
  const viaBash = bashAttempt(target, attempt.kind);
  attempts.push({ id: `${attempt.id}.bash`, ...viaBash });
}

// Persistence: leave a detached process behind; the harness looks for it after this process ends.
let markerStarted = false;
try {
  const child = cp.spawn("bash", ["-c", 'exec -a "$M" sleep 120'], { detached: true, stdio: "ignore", env: { ...process.env, M: config.marker } });
  child.on("error", () => {});
  child.unref();
  markerStarted = true;
} catch { markerStarted = false; }

function visible(candidates) {
  let exists = false;
  let readable = false;
  for (const candidate of candidates) {
    try {
      fs.statSync(candidate);
      exists = true;
      try { fs.accessSync(candidate, fs.constants.R_OK); readable = true; } catch { /* not readable */ }
    } catch { /* absent */ }
  }
  return { exists, readable };
}

const homes = [...new Set([config.hostHome, home])];
const xdgConfig = process.env.XDG_CONFIG_HOME;
const underHomes = (...segments) => homes.map((base) => path.join(base, ...segments));
const configDirs = [...underHomes(".config"), ...(xdgConfig ? [xdgConfig] : [])];

function gitCredentialConfig() {
  const result = cp.spawnSync("git", ["config", "--show-origin", "--get-regexp", "^credential\\."], {
    encoding: "utf8", timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) return { exists: false, readable: false };
  const count = String(result.stdout || "").split("\n").filter(Boolean).length;
  return { exists: count > 0, readable: count > 0 };
}

const credentials = {
  ssh_dir: visible(underHomes(".ssh")),
  ssh_auth_sock: visible(process.env.SSH_AUTH_SOCK ? [process.env.SSH_AUTH_SOCK] : []),
  gh_hosts_file: visible([...configDirs.map((dir) => path.join(dir, "gh", "hosts.yml")), ...(process.env.GH_CONFIG_DIR ? [path.join(process.env.GH_CONFIG_DIR, "hosts.yml")] : [])]),
  gh_token_env: { exists: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_ENTERPRISE_TOKEN), readable: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_ENTERPRISE_TOKEN) },
  git_credentials_file: visible([...underHomes(".git-credentials"), ...configDirs.map((dir) => path.join(dir, "git", "credentials"))]),
  git_credential_config: gitCredentialConfig(),
  claude_client_config: visible([...underHomes(".claude.json"), ...underHomes(".claude")]),
  codex_client_config: visible([...underHomes(".codex")]),
  // The host configuration directories only; the boundary's own configuration is reported separately below.
  pi_session_mcp_config: visible(configDirs.map((dir) => path.join(dir, "pi-session-mcp"))),
};
// The boundary's own server configuration must be readable; only a digest prefix leaves the probe, so the
// harness can tell whether it is the host's configuration file.
function ownConfig() {
  const file = process.env.PI_SESSION_MCP_CONFIG;
  if (!file) return { present: false, digest: null };
  try { return { present: true, digest: require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12) }; }
  catch { return { present: false, digest: null }; }
}
// The filesystem type of the mount that holds HOME, from /proc/self/mountinfo (longest matching mount point).
function homeMountType() {
  try {
    const target = fs.realpathSync(home);
    let best = { point: "", type: null };
    for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      const [left, right] = line.split(" - ");
      if (!left || !right) continue;
      const point = left.split(" ")[4];
      if (point && (target === point || target.startsWith(point.endsWith("/") ? point : point + "/")) && point.length > best.point.length) best = { point, type: right.split(" ")[0] };
    }
    return best.type;
  } catch { return null; }
}
// Informational: the boundary's own provider authentication, expected to exist for a working session.
const piAgentAuth = visible([path.join(agentDir, "auth.json")]);

let sshAuthenticated = null;
let networkTcp = null;
if (!config.skipRemote) {
  const ssh = cp.spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-T", "git@github.com"], { encoding: "utf8", timeout: 20_000 });
  // Only "authentication succeeded" is kept; GitHub answers with exit status 1 and a fixed greeting.
  sshAuthenticated = !ssh.error && /successfully authenticated/i.test(`${ssh.stdout || ""}${ssh.stderr || ""}`);
}

function envNamesOfChild() {
  const result = cp.spawnSync("bash", ["-c", "env -0"], { encoding: "utf8", timeout: 10_000 });
  const raw = result.status === 0 ? String(result.stdout || "") : null;
  const names = raw === null ? Object.keys(process.env) : raw.split("\0").map((entry) => entry.split("=")[0]).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  return [...new Set(names)];
}
const childEnvNames = envNamesOfChild();

function ns(kind) {
  try { return fs.readlinkSync(`/proc/self/ns/${kind}`); } catch { return null; }
}
const namespaces = { user: ns("user"), mnt: ns("mnt"), pid: ns("pid"), net: ns("net") };

function tcpProbe() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: config.networkHost, port: 443 });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(5000);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

(async () => {
  if (!config.skipRemote) networkTcp = await tcpProbe();
  // Give the detached marker a moment to reach its exec before this process (and a container) ends.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const result = {
    attempts,
    bash_available: bashAvailable,
    marker_started: markerStarted,
    credentials,
    pi_agent_auth: piAgentAuth,
    own_config: ownConfig(),
    home_mount_type: homeMountType(),
    ssh_authenticated: sshAuthenticated,
    network_tcp_443: networkTcp,
    child_env_names: childEnvNames,
    namespaces,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
  };
  process.stdout.write(`ISOLATION_PROBE_RESULT ${JSON.stringify(result)}\n`);
})();
