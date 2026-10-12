// Multi-session skill acceptance for pi-session-mcp (maintainer script).
//
// Prepares a disposable run against a frozen candidate build, launches a real
// Claude Code or Codex controller with a run-scoped MCP configuration, watches
// the processes of the run, and checks the outcome independently of the
// controller's own report. The controller itself drives the Pi Session MCP
// tools; this script never calls them. See docs/acceptance.md ("Multi-session
// skill acceptance").
//
// Usage:
//   node scripts/multi-session-acceptance.mjs prepare --candidate <dir> \
//     --base-config <file> --from-profile <alias> [--work-dir <dir>]
//   node scripts/multi-session-acceptance.mjs run --run <run dir> \
//     --client claude|codex --scenario parallel|abort [--timeout-min <n>] [--codex-model <id>]
//   node scripts/multi-session-acceptance.mjs reanalyze --run <run dir> --client <c> --scenario <s>
//   node scripts/multi-session-acceptance.mjs evidence --run <run dir> --out <file>
//
// `prepare` copies only provider, model and thinking level from one existing
// profile of the operator configuration; it never copies credentials, MCP
// servers or other workspaces. Everything sensitive (transcripts, configuration,
// the handshake token, paths) stays below <run dir>/private. `run` and
// `evidence` print and write only sanitized metadata. Linux only (it reads
// /proc); Node built-ins only. It never changes a client's persistent
// configuration, HOME or CODEX_HOME.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const SERVER = "pi-candidate";
const TOOLS = ["pi_capabilities_get", "pi_session_start", "pi_session_list", "pi_session_get", "pi_session_prompt", "pi_session_abort", "pi_session_close", "pi_turn_get"];
const CLIENTS = { claude: "cc", codex: "cx" };
const SCENARIOS = {
  parallel: { tasks: ["slug", "stats"] },
  abort: { tasks: ["wait", "range"] },
};

function fail(message, code = 2) { process.stderr.write(`${message}\n`); process.exit(code); }
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
function inside(path, parent) { const rel = relative(parent, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@invalid" } });
  if (result.status !== 0) fail(`git ${args[0]} failed in a fixture`);
  return result.stdout;
}

// ---- fixtures -----------------------------------------------------------------
const FIXTURES = {
  slug: {
    "package.json": `{ "name": "fixture-slug", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n`,
    "src/slug.js": "/** Lowercase ASCII slug: words joined by single hyphens, no leading or trailing hyphen. */\nexport function slugify(text) {\n  throw new Error(\"not implemented\");\n}\n",
    "test/slug.test.js": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { slugify } from \"../src/slug.js\";\n\ntest(\"joins words\", () => assert.equal(slugify(\"Hello World\"), \"hello-world\"));\ntest(\"drops punctuation\", () => assert.equal(slugify(\"Rock & Roll!\"), \"rock-roll\"));\ntest(\"collapses separators\", () => assert.equal(slugify(\"a--b__c\"), \"a-b-c\"));\n",
  },
  stats: {
    "package.json": `{ "name": "fixture-stats", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n`,
    "src/stats.js": "export function mean(values) {\n  if (values.length === 0) throw new RangeError(\"empty\");\n  return values.reduce((sum, value) => sum + value, 0) / values.length;\n}\n\n/** Median of a non-empty list; the input array must not be modified. */\nexport function median(values) {\n  throw new Error(\"not implemented\");\n}\n",
    "test/stats.test.js": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { mean, median } from \"../src/stats.js\";\n\ntest(\"mean\", () => assert.equal(mean([1, 2, 3]), 2));\ntest(\"odd median\", () => assert.equal(median([3, 1, 2]), 2));\ntest(\"even median\", () => assert.equal(median([4, 1, 3, 2]), 2.5));\ntest(\"keeps input\", () => { const values = [3, 1, 2]; median(values); assert.deepEqual(values, [3, 1, 2]); });\ntest(\"empty\", () => assert.throws(() => median([]), RangeError));\n",
  },
  wait: {
    "README.md": "Scratch repository for a long-running shell command.\n",
  },
  range: {
    "package.json": `{ "name": "fixture-range", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n`,
    "src/range.js": "/** Integers from start (inclusive) to end (exclusive) by a positive step (default 1). */\nexport function range(start, end, step = 1) {\n  throw new Error(\"not implemented\");\n}\n",
    "test/range.test.js": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { range } from \"../src/range.js\";\n\ntest(\"default step\", () => assert.deepEqual(range(0, 4), [0, 1, 2, 3]));\ntest(\"custom step\", () => assert.deepEqual(range(1, 10, 3), [1, 4, 7]));\ntest(\"empty\", () => assert.deepEqual(range(5, 5), []));\ntest(\"bad step\", () => assert.throws(() => range(0, 3, 0), RangeError));\n",
  },
};
const ALLOWED_CHANGES = { slug: ["src/slug.js", "test/slug.test.js", "HANDSHAKE.txt"], stats: ["src/stats.js"], wait: [], range: ["src/range.js"] };

function writeFixture(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
}

// ---- prepare --------------------------------------------------------------------
function prepare(values) {
  if (!values.candidate || !values["base-config"] || !values["from-profile"]) fail("prepare needs --candidate, --base-config and --from-profile");
  const candidate = realpathSync(resolve(values.candidate));
  const entry = join(candidate, "dist", "main.js");
  if (!existsSync(entry)) fail("the candidate has no dist/main.js; build it first");
  for (const name of ["pi-session-orchestration", "pi-session-implementation", "pi-session-review"]) {
    if (!existsSync(join(candidate, "skills", name, "SKILL.md"))) fail(`the candidate has no skills/${name}/SKILL.md`);
  }
  const base = readJson(resolve(values["base-config"]));
  const source = base.executionProfiles?.[values["from-profile"]];
  if (!source || source.extensions || source.mcpServers) fail("--from-profile must name a profile without extensions or MCP servers");
  const workDir = resolve(values["work-dir"] ?? join(homedir(), ".cache", "pi-session-mcp-acceptance"));
  if ([tmpdir(), "/tmp", "/var/tmp", "/dev/shm"].some((dir) => inside(workDir, dir))) fail("--work-dir must not be inside a temporary directory: Codex refuses helper binaries there");
  const runId = `skills-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const run = join(workDir, runId);
  const priv = join(run, "private");
  for (const dir of [priv, join(priv, "transcripts"), join(priv, "results"), join(priv, "skills", "acceptance-handshake")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(8).toString("hex");
  writeFileSync(join(priv, "skills", "acceptance-handshake", "SKILL.md"), [
    "---", "name: acceptance-handshake",
    "description: Use when a task asks you to complete the acceptance handshake of the current workspace.",
    "---", "", "# Acceptance handshake", "",
    `Create a file named \`HANDSHAKE.txt\` in the workspace root that contains exactly one line: \`handshake ${token}\`.`,
    "Do not repeat the token in your answer; say only that the handshake file was written.", "",
  ].join("\n"), { mode: 0o600 });
  const workspaces = {};
  for (const [client, prefix] of Object.entries(CLIENTS)) {
    const controller = join(run, `controller-${client}`);
    for (const task of Object.keys(FIXTURES)) {
      const dir = join(controller, "fixtures", task);
      mkdirSync(dir, { recursive: true });
      writeFixture(dir, FIXTURES[task]);
      workspaces[`${prefix}-${task}`] = relative(priv, dir);
    }
    // Run-scoped skill for the controller: one link to the canonical source, nothing global.
    const skillRoot = client === "claude" ? join(controller, ".claude", "skills") : join(controller, ".agents", "skills");
    mkdirSync(skillRoot, { recursive: true });
    symlinkSync(join(candidate, "skills", "pi-session-orchestration"), join(skillRoot, "pi-session-orchestration"));
  }
  const profile = { provider: source.provider, model: source.model, thinkingLevel: source.thinkingLevel };
  const config = {
    workspaces,
    skillCatalog: {
      implementation: join(candidate, "skills", "pi-session-implementation", "SKILL.md"),
      review: join(candidate, "skills", "pi-session-review", "SKILL.md"),
      handshake: "skills/acceptance-handshake/SKILL.md",
    },
    executionProfiles: {
      "accept-read": { default: true, permissionProfile: "read-only", ...profile, skills: ["review"] },
      "accept-code": { default: false, permissionProfile: "coding", ...profile, skills: ["implementation", "handshake"] },
    },
  };
  const configBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(priv, "config.json"), configBytes, { mode: 0o600 });
  const node = process.execPath;
  writeJson(join(priv, "claude-mcp.json"), { mcpServers: { [SERVER]: { command: node, args: [entry], env: { PI_SESSION_MCP_CONFIG: join(priv, "config.json") } } } });
  const packageJson = readJson(join(candidate, "package.json"));
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: candidate, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: candidate, encoding: "utf8" });
  writeJson(join(priv, "run.json"), {
    runId, candidate, entry, node, token,
    version: packageJson.version,
    sourceCommit: head.status === 0 ? head.stdout.trim() : undefined,
    sourceClean: dirty.status === 0 && dirty.stdout.trim() === "",
    entrySha256: sha256(readFileSync(entry)),
    configFingerprint: `sha256:${sha256(configBytes)}`,
    profile: { from: values["from-profile"], ...profile },
    preparedAt: new Date().toISOString(),
  });
  process.stdout.write(`${run}\n`);
}

// ---- controller prompts -----------------------------------------------------------
function prompt(client, scenario) {
  const p = CLIENTS[client];
  const common = [
    `You are the controller of an acceptance run of the Pi Session MCP server named \`${SERVER}\`. Use your \`pi-session-orchestration\` skill and call the \`${SERVER}\` MCP tools yourself; do not write scripts that call them.`,
    "Start with pi_capabilities_get and state the server version and the configuration fingerprint you saw.",
    "Use the execution profile `accept-code` for every task. Wait 5 to 10 seconds with the shell command `sleep` between polling rounds. Total time budget: 15 minutes.",
  ];
  if (scenario === "parallel") return [...common,
    "Run these two tasks in parallel, each in its own Pi session; start both first turns before waiting for either:",
    `- SLUG: workspace alias \`${p}-slug\` (local copy: ./fixtures/slug). Make \`node --test\` pass by implementing \`slugify\` in \`src/slug.js\`; change only that file.`,
    `- STATS: workspace alias \`${p}-stats\` (local copy: ./fixtures/stats). Make \`node --test\` pass by implementing \`median\` in \`src/stats.js\`; change only that file.`,
    "After the first SLUG turn succeeded, send one follow-up prompt in the same SLUG session: add one more test case to `test/slug.test.js` for a string with leading and trailing whitespace (it must pass), and complete the acceptance handshake described in the worker's available skills.",
    "Verify every result yourself before closing (read the changed files, run `node --test` in the fixture directory, check `git -C <fixture> status --short`). Close every session you started.",
    "Finish with a short report: per task the final turn state, whether your own verification passed, and whether all sessions were closed.",
  ].join("\n");
  return [...common,
    "Run these two tasks at the same time, each in its own Pi session:",
    `- WAIT: workspace alias \`${p}-wait\`. Ask the worker to run exactly this shell command in the repository and then report its output: \`sleep 120 && echo late > LATE.txt\`.`,
    `- RANGE: workspace alias \`${p}-range\` (local copy: ./fixtures/range). Make \`node --test\` pass by implementing \`range\` in \`src/range.js\`; change only that file.`,
    "Start both turns. About 20 seconds after both were accepted, abort the WAIT session with pi_session_abort while RANGE may still be running. Confirm that the WAIT turn ends as `aborted`; an `abort_timeout` error is not a successful abort and must be reported as such.",
    "Let RANGE finish, verify it yourself (`node --test` in ./fixtures/range, `git -C ./fixtures/range status --short`), then close both sessions.",
    "Finish with a short report: final turn state per task, the abort result, your verification result, and whether all sessions were closed.",
  ].join("\n");
}

function command(client, info, priv, controller, values) {
  const text = prompt(client, values.scenario);
  if (client === "claude") {
    const allowed = [...TOOLS.map((tool) => `mcp__${SERVER}__${tool}`), "Read", "Grep", "Glob", "Bash(sleep:*)", "Bash(node --test:*)", "Bash(git -C:*)"];
    return { file: "claude", args: ["-p", text, "--mcp-config", join(priv, "claude-mcp.json"), "--strict-mcp-config", "--permission-mode", "dontAsk",
      "--allowedTools", ...allowed, "--setting-sources", "project,local", "--output-format", "stream-json", "--verbose", "--no-session-persistence"] };
  }
  const toml = (value) => JSON.stringify(value);
  // Read-only sandbox: the controller can inspect and test the fixtures but never write them itself.
  return { file: "codex", args: ["exec", "--json", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only", "-C", controller,
    ...(values["codex-model"] ? ["-m", values["codex-model"]] : []),
    "-c", `mcp_servers.${SERVER}.command=${toml(info.node)}`,
    "-c", `mcp_servers.${SERVER}.args=[${toml(info.entry)}]`,
    "-c", `mcp_servers.${SERVER}.env={PI_SESSION_MCP_CONFIG=${toml(join(priv, "config.json"))}}`,
    ...["pi_session_prompt", "pi_session_abort", "pi_session_close"].flatMap((tool) => ["-c", `mcp_servers.${SERVER}.tools.${tool}.approval_mode="approve"`]),
    text] };
}

// ---- process watching -------------------------------------------------------------
function procInfo(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    return { pid, ppid: Number(fields[1]), start: fields[19], comm };
  } catch { return undefined; }
}
const alive = ({ pid, start }) => procInfo(pid)?.start === start;
function readSafe(read) { try { return read(); } catch { return ""; } }

function snapshot(rootPid, run, info) {
  const all = new Map();
  for (const name of readdirSync("/proc")) if (/^\d+$/.test(name)) { const p = procInfo(Number(name)); if (p) all.set(p.pid, p); }
  const found = [];
  for (const p of all.values()) {
    let ancestor = p.ppid; let fromClient = p.pid === rootPid;
    for (let hops = 0; ancestor > 1 && hops < 64 && !fromClient; hops += 1) { if (ancestor === rootPid) fromClient = true; ancestor = all.get(ancestor)?.ppid ?? 0; }
    const cmdline = readSafe(() => readFileSync(`/proc/${p.pid}/cmdline`, "utf8"));
    const isServer = cmdline.includes(info.entry) && readSafe(() => readFileSync(`/proc/${p.pid}/environ`, "utf8")).split("\0").includes(`PI_SESSION_MCP_CONFIG=${join(run, "private", "config.json")}`);
    const cwd = readSafe(() => readlinkSync(`/proc/${p.pid}/cwd`));
    const inRun = cwd !== "" && inside(cwd, run);
    // The fixture a process works in, for example `wait` for the worker's long shell command.
    const fixture = inRun ? relative(run, cwd).split("/").slice(1).join("/").match(/^fixtures\/([a-z]+)/)?.[1] : undefined;
    if (fromClient || isServer || inRun) found.push({ ...p, fixture, role: isServer ? "server" : p.pid === rootPid ? "client" : fromClient ? "client-descendant" : "run-cwd" });
  }
  return found;
}

// ---- transcript parsing ---------------------------------------------------------------
function parseResultText(content) {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("") : undefined;
  if (typeof text !== "string") return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
/** Inputs of the controller's own tools (file reads, shell commands), for the private-access check. */
function controllerActions(client, lines) {
  const actions = [];
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (client === "claude") {
      for (const item of event?.message?.content ?? []) {
        if (event.type === "assistant" && item.type === "tool_use" && !item.name?.startsWith(`mcp__${SERVER}__`)) actions.push(JSON.stringify(item.input ?? {}));
      }
    } else if (event?.type === "item.completed" && event.item?.type === "command_execution") {
      actions.push(String(event.item.command ?? ""));
    }
  }
  return actions;
}

function toolCalls(client, lines) {
  const calls = [];
  const pending = new Map();
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (client === "claude") {
      for (const item of event?.message?.content ?? []) {
        if (event.type === "assistant" && item.type === "tool_use" && item.name?.startsWith(`mcp__${SERVER}__`)) {
          const call = { tool: item.name.slice(`mcp__${SERVER}__`.length), input: item.input ?? {}, result: undefined };
          pending.set(item.id, call); calls.push(call);
        } else if (event.type === "user" && item.type === "tool_result" && pending.has(item.tool_use_id)) {
          pending.get(item.tool_use_id).result = parseResultText(item.content);
        }
      }
    } else {
      const item = event?.item;
      if (event?.type === "item.completed" && item?.type === "mcp_tool_call" && item.server === SERVER) {
        calls.push({ tool: item.tool, input: item.arguments ?? {}, result: item.result?.structured_content ?? parseResultText(item.result?.content), error: item.error ? true : undefined });
      }
    }
  }
  return calls;
}

function analyze(client, scenario, calls, info, rawText) {
  const p = CLIENTS[client];
  const counts = Object.fromEntries(TOOLS.map((tool) => [tool, calls.filter((call) => call.tool === tool).length]));
  const capabilities = calls.find((call) => call.tool === "pi_capabilities_get" && call.result?.ok)?.result;
  const code = capabilities?.executionProfiles?.find((profile) => profile.alias === "accept-code");
  const sessions = new Map();
  for (const call of calls) if (call.tool === "pi_session_start" && call.result?.ok) sessions.set(call.result.session.id, { workspace: call.result.session.workspace, profile: call.result.session.executionProfile, turns: new Map(), closed: false, aborts: [], abortedSeenAt: undefined, closedAt: undefined, polls: 0 });
  calls.forEach((call, index) => {
    const session = sessions.get(call.input?.sessionId);
    if (!session) return;
    const turn = call.result?.turn;
    if (turn?.turnId) session.turns.set(turn.turnId, { ...(session.turns.get(turn.turnId) ?? {}), ...turn });
    if (call.tool === "pi_turn_get") session.polls += 1;
    if (call.tool === "pi_turn_get" && turn?.state === "aborted") session.abortedSeenAt ??= index;
    if (call.tool === "pi_session_close" && call.result?.ok) { session.closed = true; session.closedAt ??= index; }
    // Every abort result in order: an abort_timeout followed by a successful retry stays visible.
    if (call.tool === "pi_session_abort") session.aborts.push(call.result?.ok ? "ok" : call.result?.error?.code ?? "error");
  });
  const task = (name) => [...sessions.values()].find((session) => session.workspace === `${p}-${name}`);
  const turnsOf = (session) => [...(session?.turns.values() ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const ms = (value) => (value ? Date.parse(value) : NaN);
  const [first, second] = SCENARIOS[scenario].tasks.map(task);
  const a = turnsOf(first)[0]; const b = turnsOf(second)[0];
  const overlapMs = a && b ? Math.min(ms(a.completedAt), ms(b.completedAt)) - Math.max(ms(a.startedAt), ms(b.startedAt)) : NaN;
  const prompts = calls.filter((call) => call.tool === "pi_session_prompt").map((call) => String(call.input?.prompt ?? ""));
  // Structural leak scan: every pi tool result, assistant text removed (model output is counted separately).
  const leakMarkers = [homedir(), info.candidate, info.token, "sk-", "Bearer ", "PI_SESSION_MCP_CONFIG", "config.json", "SKILL.md"];
  let structuralLeaks = 0; let assistantTextMentions = 0;
  for (const call of calls) {
    const text = JSON.stringify(call.result ?? {}, (key, value) => (key === "assistantText" ? undefined : value));
    structuralLeaks += leakMarkers.filter((marker) => text.includes(marker)).length;
    const assistant = call.result?.turn?.assistantText ?? "";
    assistantTextMentions += leakMarkers.filter((marker) => assistant.includes(marker)).length;
  }
  const result = {
    capabilitiesFirst: calls[0]?.tool === "pi_capabilities_get",
    candidateConfirmed: capabilities?.server?.version === info.version && capabilities?.configuration?.fingerprint === info.configFingerprint,
    acceptCodeSkills: code?.skills,
    toolCalls: counts,
    sessionsStarted: sessions.size,
    sessions: [...sessions.values()].map((session) => ({ workspace: session.workspace, profile: session.profile, turns: turnsOf(session).map((turn) => turn.state), polls: session.polls, aborts: session.aborts, closed: session.closed })),
    firstTurnsOverlapSeconds: Number.isFinite(overlapMs) ? Math.round(overlapMs / 100) / 10 : undefined,
    firstTurnsOverlap: Number.isFinite(overlapMs) && overlapMs > 0,
    tokenInControllerPrompts: prompts.some((text) => text.includes(info.token)),
    tokenInControllerTask: prompt(client, scenario).includes(info.token),
    // The controller's own reads and commands must never touch the private run directory.
    controllerTouchedPrivate: controllerActions(client, rawText.split("\n")).some((action) => ["/private", "run.json", "acceptance-handshake", "config.json"].some((marker) => action.includes(marker))),
    structuralLeaks,
    assistantTextMentions,
    controllerTranscriptHasToken: rawText.includes(info.token),
  };
  result.turnIntervals = Object.fromEntries(SCENARIOS[scenario].tasks.map((name) => [name, turnsOf(task(name)).map((turn) => [turn.startedAt, turn.completedAt])]));
  if (scenario === "parallel") {
    const slugTurns = turnsOf(first);
    result.followUpCompleted = slugTurns.length >= 2 && slugTurns[1].state === "completed";
  } else {
    const wait = turnsOf(first)[0]; const range = turnsOf(second)[0];
    result.abortedTurn = wait?.state === "aborted";
    result.abortResults = first?.aborts ?? [];
    result.abortOk = (first?.aborts.length ?? 0) >= 1 && first.aborts.every((code) => code === "ok");
    // `aborted` must be observed through pi_turn_get before the session was closed, so close did not cause it.
    result.abortedBeforeClose = first?.abortedSeenAt !== undefined && (first.closedAt === undefined || first.abortedSeenAt < first.closedAt);
    result.neighborCompleted = range?.state === "completed";
    result.abortWhileNeighborRunning = Boolean(wait && range && ms(wait.completedAt) > ms(range.startedAt) && ms(wait.completedAt) < ms(range.completedAt));
  }
  return result;
}

/** Whether a file was last written inside one of the worker turns (1 s tolerance for clock granularity). */
function writtenDuring(path, intervals) {
  const mtime = readSafe(() => statSync(path).mtimeMs);
  return typeof mtime === "number" && intervals.some(([start, end]) => end !== undefined && mtime >= Date.parse(start) - 1_000 && mtime <= Date.parse(end) + 1_000);
}

function oracle(controller, scenario, info, intervals = {}) {
  const out = {};
  for (const task of SCENARIOS[scenario].tasks) {
    const dir = join(controller, "fixtures", task);
    const changed = git(dir, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).map((line) => line.slice(3));
    const check = { onlyAllowedChanges: changed.every((file) => ALLOWED_CHANGES[task].includes(file)), changedFiles: changed.length };
    // Attribution: every changed file was last written during a worker turn of this task's session.
    check.changesWrittenDuringWorkerTurns = changed.every((file) => writtenDuring(join(dir, file), intervals[task] ?? []));
    if (task !== "wait") {
      const test = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
      check.testsPass = test.status === 0;
    }
    if (task === "slug") {
      const tests = readFileSync(join(dir, "test", "slug.test.js"), "utf8").match(/\btest\(/g)?.length ?? 0;
      check.addedTest = tests > 3;
      check.handshake = readSafe(() => readFileSync(join(dir, "HANDSHAKE.txt"), "utf8")).trim() === `handshake ${info.token}`;
      check.handshakeWrittenDuringFollowUp = writtenDuring(join(dir, "HANDSHAKE.txt"), (intervals.slug ?? []).slice(1));
    }
    if (task === "wait") check.lateFileAbsent = !existsSync(join(dir, "LATE.txt"));
    out[task] = check;
  }
  return out;
}

async function runClient(values) {
  if (!values.run || !CLIENTS[values.client] || !SCENARIOS[values.scenario]) fail("run needs --run, --client claude|codex and --scenario parallel|abort");
  if (process.platform !== "linux") fail("run reads /proc and supports Linux only");
  const run = realpathSync(resolve(values.run));
  const priv = join(run, "private");
  const info = readJson(join(priv, "run.json"));
  const controller = join(run, `controller-${values.client}`);
  const label = `${values.client}-${values.scenario}`;
  if (existsSync(join(priv, "results", `${label}.json`))) fail("this client and scenario already ran; prepare a new run for a new attempt");
  if (sha256(readFileSync(info.entry)) !== info.entrySha256) fail("the candidate entry point changed since prepare");
  const before = snapshot(-1, run, info).filter((p) => p.role === "server");
  if (before.length > 0) fail("a server of this run is already running");
  const { file, args } = command(values.client, info, priv, controller, values);
  const transcript = join(priv, "transcripts", `${label}.jsonl`);
  const started = Date.now();
  const child = spawn(file, args, { cwd: controller, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const chunks = []; let stderrBytes = 0;
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
  const seen = new Map();
  const timer = setInterval(() => { for (const p of snapshot(child.pid, run, info)) seen.set(`${p.pid}:${p.start}`, p); }, 250);
  let timedOut = false;
  const limit = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ } }, Number(values["timeout-min"] ?? 25) * 60_000);
  const exitCode = await new Promise((done) => child.on("close", (code, signal) => done(code ?? signal)));
  clearTimeout(limit);
  clearInterval(timer);
  const durationSeconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(transcript, Buffer.concat(chunks), { mode: 0o600 });
  // Cleanup: every process this run started must be gone, matched by PID and start time.
  let residual = [];
  // The server may take up to 15 s for its bounded process shutdown.
  for (let waited = 0; waited <= 17_000; waited += 500) {
    residual = [...seen.values()].filter(alive).concat(snapshot(-1, run, info).filter((p) => !seen.has(`${p.pid}:${p.start}`)));
    if (residual.length === 0) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  const rawText = Buffer.concat(chunks).toString("utf8");
  const calls = toolCalls(values.client, rawText.split("\n"));
  const roles = (list) => list.reduce((acc, p) => ({ ...acc, [p.role]: (acc[p.role] ?? 0) + 1 }), {});
  const observed = [...seen.values()];
  const result = {
    client: values.client, scenario: values.scenario, exitCode, timedOut, durationSeconds, stderrBytes,
    processes: {
      observedByRole: roles(observed),
      serversObserved: observed.filter((p) => p.role === "server").length,
      workerSleepObserved: observed.some((p) => p.comm === "sleep" && p.fixture === "wait"),
      residualByRole: roles(residual),
      residualCommands: [...new Set(residual.map((p) => p.comm))],
    },
    transcript: analyze(values.client, values.scenario, calls, info, rawText),
  };
  result.oracle = oracle(controller, values.scenario, info, result.transcript.turnIntervals);
  delete result.transcript.turnIntervals;
  writeJson(join(priv, "results", `${label}.json`), result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/** Recomputes the transcript analysis and the oracles of a finished run; the process record is kept. */
function reanalyze(values) {
  if (!values.run || !CLIENTS[values.client] || !SCENARIOS[values.scenario]) fail("reanalyze needs --run, --client and --scenario");
  const run = realpathSync(resolve(values.run));
  const priv = join(run, "private");
  const info = readJson(join(priv, "run.json"));
  const label = `${values.client}-${values.scenario}`;
  const stored = readJson(join(priv, "results", `${label}.json`));
  const rawText = readFileSync(join(priv, "transcripts", `${label}.jsonl`), "utf8");
  const calls = toolCalls(values.client, rawText.split("\n"));
  const transcript = analyze(values.client, values.scenario, calls, info, rawText);
  const result = { ...stored, transcript, oracle: oracle(join(run, `controller-${values.client}`), values.scenario, info, transcript.turnIntervals) };
  delete transcript.turnIntervals;
  writeJson(join(priv, "results", `${label}.json`), result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function evidence(values) {
  if (!values.run || !values.out) fail("evidence needs --run and --out");
  const priv = join(resolve(values.run), "private");
  const info = readJson(join(priv, "run.json"));
  const results = readdirSync(join(priv, "results")).sort().map((name) => readJson(join(priv, "results", name)));
  const text = JSON.stringify({
    runId: info.runId, date: info.preparedAt.slice(0, 10), platform: `${process.platform}-${process.arch}`, node: process.versions.node,
    sourceCommit: info.sourceCommit, sourceClean: info.sourceClean, version: info.version, entrySha256: info.entrySha256,
    configFingerprint: info.configFingerprint, profiles: ["accept-read", "accept-code"], derivedFrom: { provider: info.profile.provider, model: info.profile.model, thinkingLevel: info.profile.thinkingLevel },
    results,
  }, null, 2);
  for (const marker of [homedir(), info.token, info.candidate, resolve(values.run)]) if (text.includes(marker)) fail("refusing to write evidence that contains a local path or the token", 1);
  writeFileSync(resolve(values.out), `${text}\n`);
}

const [subcommand, ...rest] = process.argv.slice(2);
let values;
try {
  ({ values } = parseArgs({ args: rest, options: {
    candidate: { type: "string" }, "base-config": { type: "string" }, "from-profile": { type: "string" }, "work-dir": { type: "string" },
    run: { type: "string" }, client: { type: "string" }, scenario: { type: "string" }, "timeout-min": { type: "string" }, "codex-model": { type: "string" }, out: { type: "string" },
  } }));
} catch (error) { fail(error.message); }
if (subcommand === "prepare") prepare(values);
else if (subcommand === "run") await runClient(values);
else if (subcommand === "reanalyze") reanalyze(values);
else if (subcommand === "evidence") evidence(values);
else fail("usage: multi-session-acceptance.mjs prepare|run|evidence ...");
