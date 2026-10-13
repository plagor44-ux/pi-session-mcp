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
//     --base-config <file> --from-profile <alias> [--with-extensions] [--work-dir <dir>]
//   node scripts/multi-session-acceptance.mjs run --run <run dir> \
//     --client claude|codex --scenario parallel|abort|trio [--timeout-min <n>] [--codex-model <id>]
//   node scripts/multi-session-acceptance.mjs reanalyze --run <run dir> --client <c> --scenario <s>
//   node scripts/multi-session-acceptance.mjs evidence --run <run dir> --out <file>
//
// `prepare` copies only provider, model and thinking level from one existing
// profile of the operator configuration (with the explicit `--with-extensions`
// opt-in also that profile's exact `extensions` allowlist); it never copies
// credentials, MCP servers or other workspaces. Everything sensitive
// (transcripts, configuration, the handshake token, paths, fixture baselines)
// stays below <run dir>/private. `run` and `evidence` print and write only
// sanitized metadata. Linux only (it reads /proc); Node built-ins only. It
// never changes a client's persistent configuration, HOME or CODEX_HOME.
//
// The module exports its building blocks for the provider-free tests. Importing
// it never runs a subcommand; only a direct `node` invocation does.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SERVER = "pi-candidate";
const TOOLS = ["pi_capabilities_get", "pi_session_start", "pi_session_list", "pi_session_get", "pi_session_prompt", "pi_session_abort", "pi_session_close", "pi_turn_get"];
const CLIENTS = { claude: "cc", codex: "cx" };
// Two coding profiles: every task gets `accept-code`; only the slug session of `parallel` also gets the handshake skill.
// The read-only profile `accept-read` (skill `review`) is for the reviewer of `trio` and for no other session.
export const CODE_PROFILE = "accept-code";
export const HANDSHAKE_PROFILE = "accept-code-handshake";
export const READ_PROFILE = "accept-read";
export const CODE_SKILLS = ["implementation"];
export const READ_SKILLS = ["review"];
export const HANDSHAKE_SKILLS = ["implementation", "handshake"];
const SCENARIOS = {
  parallel: { tasks: ["slug", "stats"] },
  abort: { tasks: ["wait", "range"] },
  // Two writers (`slug` completes, `wait` is aborted next to the others) and a read-only reviewer of a frozen fixture.
  trio: { tasks: ["slug", "wait", "review"] },
};

/** A classified, path-free failure of the harness; the CLI entry turns it into an exit code. */
export class HarnessFailure extends Error {
  constructor(message, code = 2) { super(message); this.name = "HarnessFailure"; this.code = code; }
}
function fail(message, code = 2) { throw new HarnessFailure(message, code); }
export const HARNESS_SHA256 = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
/** A run is bound to the harness that prepared it; another version must not run or re-evaluate it. */
function sameHarness(info) { if (info.harnessSha256 !== HARNESS_SHA256) fail("this harness differs from the one that prepared the run"); }
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
/** Results are findings: a second write to the same path is a bug, never a silent overwrite. */
const writeJsonOnce = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
export function inside(path, parent) { const rel = relative(parent, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
// Fixture repositories ignore the operator's git configuration, so a signing or template setting cannot change them.
const GIT_ENV = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
export function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (result.status !== 0) fail(`git ${args[0]} failed in a fixture`);
  return result.stdout;
}

// ---- fixtures -----------------------------------------------------------------
export const FIXTURES = {
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
  // A finished, frozen implementation for the read-only reviewer of `trio`; nobody may change it.
  review: {
    "README.md": "Finished implementation of `chunk`. It is frozen: it is reviewed, never changed.\n",
    "package.json": `{ "name": "fixture-review", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n`,
    "src/chunk.js": "/** Splits a list into consecutive chunks of at most `size` items; `size` must be a positive integer. */\nexport function chunk(list, size) {\n  if (!Number.isInteger(size) || size < 1) throw new RangeError(\"size must be a positive integer\");\n  const chunks = [];\n  for (let index = 0; index < list.length; index += size) chunks.push(list.slice(index, index + size));\n  return chunks;\n}\n",
    "test/chunk.test.js": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { chunk } from \"../src/chunk.js\";\n\ntest(\"splits evenly\", () => assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]));\ntest(\"keeps a shorter last chunk\", () => assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]));\ntest(\"empty list\", () => assert.deepEqual(chunk([], 3), []));\ntest(\"bad size\", () => assert.throws(() => chunk([1], 0), RangeError));\n",
  },
};
export const ALLOWED_CHANGES = { slug: ["src/slug.js", "test/slug.test.js", "HANDSHAKE.txt"], stats: ["src/stats.js"], wait: [], range: ["src/range.js"], review: [] };

/**
 * The files a task may change in a scenario. `trio` has neither a follow-up turn nor a handshake, so its slug task may
 * change `src/slug.js` only; every other case keeps `ALLOWED_CHANGES`.
 */
export function allowedChanges(task, scenario) {
  return scenario === "trio" && task === "slug" ? ["src/slug.js"] : ALLOWED_CHANGES[task];
}

/** SHA-256 over every built runtime module, so evidence binds to all of dist/, not just its entry. */
export function distTreeSha256(candidate) {
  const hash = createHash("sha256");
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile() && entry.name.endsWith(".js")) hash.update(rel).update("\0").update(readFileSync(join(dir, entry.name))).update("\0");
    }
  };
  walk(join(candidate, "dist"), "");
  return hash.digest("hex");
}

export function writeFixture(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
}

// ---- fixture baselines and independent oracles ---------------------------------------
/** Every file below `dir` (except the top-level `.git/`) by relative path, type, mode and SHA-256. */
export function manifestOf(dir, { skipGit = false } = {}) {
  const entries = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (skipGit && prefix === "" && entry.name === ".git") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isSymbolicLink()) entries.push({ path: rel, type: "symlink", mode: 0, sha256: sha256(readlinkSync(full)) });
      else if (entry.isFile()) entries.push({ path: rel, type: "file", mode: statSync(full).mode & 0o777, sha256: sha256(readFileSync(full)) });
      else entries.push({ path: rel, type: "other", mode: 0, sha256: "" });
    }
  };
  walk(dir, "");
  return entries.sort(byPath);
}
/** One digest over a directory tree; a missing tree and a symbolic link in its place are distinct, visible values. */
export function treeSha256(dir) {
  let top; try { top = lstatSync(dir); } catch { return "missing"; }
  if (top.isSymbolicLink()) return sha256(`symlink\0${readlinkSync(dir)}`);
  if (!top.isDirectory()) return "notDirectory";
  try { return sha256(JSON.stringify(manifestOf(dir))); } catch { return "unreadable"; }
}
const fileSha256 = (path) => { try { return sha256(readFileSync(path)); } catch { return "missing"; } };
// ---- binding digest: a tree plus the content that links lead to outside of it ----------------------------
export const BOUND_ENTRY_LIMIT = 200_000;
/** A determinate result of the binding digest that is not a hash: the digest ends with this value instead of throwing. */
class BoundSentinel extends Error { constructor(code) { super(code); this.code = code; } }
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** One directory (by real path): files by content and mode, links by their text and, outside `root`, by what they lead to. */
function boundDirectory(root, state) {
  state.visited.add(root);
  const entries = [];
  const linkEntry = (full, path) => {
    const text = readlinkSync(full);
    let real; try { real = realpathSync(full); } catch { return { path, type: "symlink", text, target: "dangling" }; }
    // A link that stays inside the root needs only its text: the target is hashed as part of the root.
    if (inside(real, root)) return { path, type: "symlink", text, target: "inside" };
    const target = statSync(real);
    if (target.isDirectory()) return { path, type: "symlink", text, target: state.visited.has(real) ? "seen" : { directory: boundDirectory(real, state) } };
    if (target.isFile()) return { path, type: "symlink", text, target: { file: sha256(readFileSync(real)) } };
    return { path, type: "symlink", text, target: "other" };
  };
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(byName)) {
      if (++state.count > state.limit) throw new BoundSentinel("tooLarge");
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isSymbolicLink()) entries.push(linkEntry(full, rel));
      else if (entry.isFile()) entries.push({ path: rel, type: "file", mode: statSync(full).mode & 0o777, sha256: sha256(readFileSync(full)) });
      else entries.push({ path: rel, type: "other" });
    }
  };
  walk(root, "");
  return sha256(JSON.stringify(entries));
}
/**
 * One digest for a directory the run relies on, including what its links lead to. The tree is walked without
 * following links. Every link entry records its text; when its real path lies outside the bound root it also
 * records the content behind it (file bytes, or this digest of the target directory, recursively). A link that
 * resolves inside the root needs only its text. Real paths already visited, links in cycles included, are recorded
 * as `seen`, so the walk ends. A top-level link also binds its text and the content of its target.
 * Sentinels instead of hashes: `missing`, `notDirectory`, `unreadable` and `tooLarge` (more than `limit` entries).
 */
export function boundTreeSha256(dir, { limit = BOUND_ENTRY_LIMIT } = {}) {
  let top; try { top = lstatSync(dir); } catch { return "missing"; }
  const state = { count: 0, limit, visited: new Set() };
  try {
    if (top.isSymbolicLink()) {
      const text = readlinkSync(dir);
      let real; try { real = realpathSync(dir); } catch { return sha256(`symlink\0${text}\0dangling`); }
      return statSync(real).isDirectory() ? sha256(`symlink\0${text}\0${boundDirectory(real, state)}`) : "notDirectory";
    }
    return top.isDirectory() ? boundDirectory(dir, state) : "notDirectory";
  } catch (error) { return error instanceof BoundSentinel ? error.code : "unreadable"; }
}

/**
 * Runs git against a worker-controlled repository. GIT_DIR and GIT_WORK_TREE pin it to the fixture so a
 * damaged or removed `.git` never falls through to a parent repository, and configuration that could
 * execute commands is switched off. Returns the output, or undefined when git failed.
 */
function gitInFixture(dir, args) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: dir, env: { ...process.env, ...GIT_ENV, GIT_DIR: join(dir, ".git"), GIT_WORK_TREE: dir, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" },
    timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 && !result.error ? result.stdout : undefined;
}
const nulList = (buffer) => buffer.toString("utf8").split("\0").filter(Boolean);

/** The state a fixture starts from: its initial commit and a manifest of its files. Stored outside the worker workspace. */
export function captureBaseline(dir) {
  const head = gitInFixture(dir, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head) fail("a fixture has no initial commit");
  return { schemaVersion: 1, commit: head.toString("utf8").trim(), manifest: manifestOf(dir, { skipGit: true }) };
}

/**
 * Compares a fixture with its baseline in three independent ways and returns the union of changed paths:
 * the working tree against the manifest (added, deleted, modified, untracked, ignored), HEAD against the
 * base commit, and the index against the base commit. A missing or unreadable baseline, `.git` or base
 * commit is an error, never a clean result.
 */
export function compareToBaseline(dir, baseline, allowed) {
  const out = { ok: false, error: undefined, changed: new Set(), sources: { workingTree: 0, index: 0, head: 0 }, disallowed: 0 };
  if (baseline?.schemaVersion !== 1 || !/^[0-9a-f]{40,64}$/.test(baseline.commit ?? "") || !Array.isArray(baseline.manifest)) { out.error = "baselineUnreadable"; return out; }
  let gitDir; try { gitDir = lstatSync(join(dir, ".git")); } catch { gitDir = undefined; }
  if (!gitDir?.isDirectory()) { out.error = "gitMissing"; return out; }
  if (!gitInFixture(dir, ["cat-file", "-e", `${baseline.commit}^{commit}`])) { out.error = "baseCommitMissing"; return out; }
  if (!gitInFixture(dir, ["rev-parse", "--verify", "HEAD^{commit}"])) { out.error = "headUnreadable"; return out; }
  let now; try { now = manifestOf(dir, { skipGit: true }); } catch { out.error = "workingTreeUnreadable"; return out; }
  const before = new Map(baseline.manifest.map((entry) => [entry.path, entry]));
  const after = new Map(now.map((entry) => [entry.path, entry]));
  const tree = new Set();
  for (const [path, entry] of after) {
    const original = before.get(path);
    if (!original || original.type !== entry.type || original.mode !== entry.mode || original.sha256 !== entry.sha256) tree.add(path);
  }
  for (const path of before.keys()) if (!after.has(path)) tree.add(path);
  const head = gitInFixture(dir, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", baseline.commit, "HEAD", "--"]);
  const index = gitInFixture(dir, ["diff", "--cached", "--name-only", "-z", "--no-renames", "--no-ext-diff", baseline.commit, "--"]);
  if (!head || !index) { out.error = "gitFailed"; return out; }
  const headPaths = nulList(head); const indexPaths = nulList(index);
  out.sources = { workingTree: tree.size, index: indexPaths.length, head: headPaths.length };
  for (const path of [...tree, ...headPaths, ...indexPaths]) out.changed.add(path);
  out.disallowed = [...out.changed].filter((path) => !allowed.includes(path)).length;
  out.ok = out.disallowed === 0;
  return out;
}

/**
 * Checks the harness defines on top of the worker-editable tests, per fixture. Each case calls an exported
 * function of the worker's module in a separate `node` child and compares the result; they follow the
 * contract documented in the fixture's own source comments.
 */
export const BUSINESS_CHECKS = {
  slug: { module: "src/slug.js", cases: [
    { fn: "slugify", args: ["Hello World"], returns: "hello-world" },
    { fn: "slugify", args: ["  Leading and trailing  "], returns: "leading-and-trailing" },
    { fn: "slugify", args: ["Rock & Roll!"], returns: "rock-roll" },
    { fn: "slugify", args: ["a--b__c"], returns: "a-b-c" },
    { fn: "slugify", args: ["  --Hello,   World--  "], returns: "hello-world" },
    { fn: "slugify", args: ["Route 66"], returns: "route-66" },
    { fn: "slugify", args: ["---"], returns: "" },
    { fn: "slugify", args: [""], returns: "" },
  ] },
  stats: { module: "src/stats.js", cases: [
    { fn: "mean", args: [[1, 2, 3]], returns: 2 },
    { fn: "median", args: [[3, 1, 2]], returns: 2 },
    { fn: "median", args: [[4, 1, 3, 2]], returns: 2.5 },
    { fn: "median", args: [[5]], returns: 5 },
    { fn: "median", args: [[1, 2, 3, 4, 5, 6]], returns: 3.5 },
    { fn: "median", args: [[10, 9, 100]], returns: 10 },
    { fn: "median", args: [[-5, -1, -3]], returns: -3 },
    // A frozen input throws on an in-place sort, so this fails an implementation that modifies its input.
    { fn: "median", args: [[3, 1, 2]], frozen: true, returns: 2 },
    { fn: "median", args: [[]], throws: true },
  ] },
  range: { module: "src/range.js", cases: [
    { fn: "range", args: [0, 4], returns: [0, 1, 2, 3] },
    { fn: "range", args: [1, 10, 3], returns: [1, 4, 7] },
    { fn: "range", args: [5, 5], returns: [] },
    { fn: "range", args: [0, 3, 0], throws: true },
    { fn: "range", args: [0, 10, 5], returns: [0, 5] },
    { fn: "range", args: [0, 10, 4], returns: [0, 4, 8] },
    { fn: "range", args: [3, 1], returns: [] },
    { fn: "range", args: [-3, 2], returns: [-3, -2, -1, 0, 1] },
    { fn: "range", args: [0, 1], returns: [0] },
  ] },
};
const CHECK_RUNNER = [
  "import assert from \"node:assert/strict\";",
  "import { resolve } from \"node:path\";",
  "import { pathToFileURL } from \"node:url\";",
  "const spec = JSON.parse(process.env.ACCEPTANCE_CHECK_SPEC);",
  "const mod = await import(pathToFileURL(resolve(process.cwd(), spec.module)).href);",
  "const freeze = (value) => (Array.isArray(value) ? Object.freeze(value.map(freeze)) : value);",
  "const results = spec.cases.map((item) => {",
  "  try {",
  "    const actual = mod[item.fn](...(item.frozen ? item.args.map(freeze) : item.args));",
  "    if (item.throws) return false;",
  "    assert.deepStrictEqual(actual, item.returns);",
  "    return true;",
  "  } catch (error) { return Boolean(item.throws) && error instanceof RangeError; }",
  "});",
  "console.log(JSON.stringify(results));",
].join("\n");
/** True only when the worker's module passes every harness-defined case; any crash, hang or odd output fails. */
export function runBusinessChecks(task, dir) {
  const spec = BUSINESS_CHECKS[task];
  if (!spec) return true;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", CHECK_RUNNER], {
    cwd: dir, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH ?? "", ACCEPTANCE_CHECK_SPEC: JSON.stringify(spec) },
  });
  if (child.status !== 0 || child.error) return false;
  try {
    const results = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "");
    return Array.isArray(results) && results.length === spec.cases.length && results.every((value) => value === true);
  } catch { return false; }
}

/** The state of one fixture as a digest: working tree, HEAD and index. Used to detect changes after a run. */
export function fixtureStateSha256(dir) {
  try {
    const head = gitInFixture(dir, ["rev-parse", "--verify", "HEAD"]);
    const index = gitInFixture(dir, ["ls-files", "-s", "-z"]);
    if (!head || !index) return "unreadable";
    return sha256(JSON.stringify({ manifest: manifestOf(dir, { skipGit: true }), head: head.toString("utf8").trim(), index: sha256(index) }));
  } catch { return "unreadable"; }
}
const baselineFile = (priv, client, task) => join(priv, "baselines", client, `${task}.json`);
const baselineReader = (priv, client) => (task) => { try { return readJson(baselineFile(priv, client, task)); } catch { return undefined; } };

// ---- bound resources --------------------------------------------------------------------
/**
 * Digests of everything the acceptance relies on besides the fixtures' working trees: the candidate build,
 * the controller skill copies, the worker skills, the override directory, the run configuration, the
 * harness and the fixture baselines. Names are path-free so a mismatch can be reported as it is.
 */
/**
 * Controller skills in the operator's home that a client could load instead of the run's own copy. Claude Code
 * prefers a personal skill over a project skill of the same name; the controller runs with
 * `--setting-sources project,local`, which on Claude Code 2.1.296 was observed to hide personal skills. Both
 * copies are bound, so a change during the run is detected, and Codex is refused while its copy differs.
 */
export function operatorControllerSkills(home = homedir()) {
  return {
    operatorClaudeSkill: treeSha256(join(home, ".claude", "skills", "pi-session-orchestration")),
    operatorCodexSkill: treeSha256(join(home, ".agents", "skills", "pi-session-orchestration")),
  };
}

/** `~` and `~/...` expand against `home`; the result is absolute, and its real path where it exists. */
function resolveDirectory(configured, fallback, home) {
  const raw = configured ? (configured === "~" ? home : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured) : fallback;
  const absolute = resolve(raw);
  try { return realpathSync(absolute); } catch { return absolute; }
}
/** Pi's agent directory as the server resolves it: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. Resolved once, at prepare. */
export function resolveAgentDirectory(env = process.env, home = homedir()) {
  return resolveDirectory(env.PI_CODING_AGENT_DIR, join(home, ".pi", "agent"), home);
}
/** Codex's home as the client resolves it: `CODEX_HOME`, else `~/.codex`. Resolved once, at prepare. */
export function resolveCodexHome(env = process.env, home = homedir()) {
  return resolveDirectory(env.CODEX_HOME, join(home, ".codex"), home);
}
/** The environment of the run's MCP server in both clients: its configuration and the bound Pi agent directory. */
export function serverEnvironment(configPath, agentDir) {
  return { PI_SESSION_MCP_CONFIG: configPath, PI_CODING_AGENT_DIR: agentDir };
}

export const ETC_CODEX_SKILLS = "/etc/codex/skills";
const CONTROLLER_SKILL = "pi-session-orchestration";

/**
 * `.agents/skills` of every ancestor of the Codex controller's directory, nearest first, up to `/`. Tests pass their
 * temporary root as `boundary`, which is the last directory listed.
 */
export function codexAncestorSkillDirs(controller, boundary) {
  let real; try { real = realpathSync(controller); } catch { real = resolve(controller); }
  const dirs = [];
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    dirs.push(join(dir, ".agents", "skills"));
    if (dirname(dir) === dir || dir === boundary) break;
  }
  return dirs;
}
/**
 * Every directory a Codex controller may read skills from besides its own run-scoped link, by path-free name:
 * `$CODEX_HOME/skills` (with the bundled `.system` skills), the home's `.agents/skills` (all of it), the system
 * skills and the `.agents/skills` of the controller directory's ancestors.
 */
export function codexSkillSources(run, { home = homedir(), codexHome, etcCodexSkills = ETC_CODEX_SKILLS, ancestorBoundary } = {}) {
  return {
    codexHomeSkills: codexHome ? [join(codexHome, "skills")] : [],
    homeAgentsSkills: [join(home, ".agents", "skills")],
    etcCodexSkills: [etcCodexSkills],
    codexAncestorSkills: codexAncestorSkillDirs(join(run, "controller-codex"), ancestorBoundary),
  };
}
const YAML_ESCAPES = { 0: "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85", _: "\xa0", L: " ", P: " " };
/** A single- or double-quoted YAML scalar at the start of `text`: its value and what follows the closing quote, or undefined if malformed. */
function quotedScalar(text) {
  const quote = text[0];
  let value = ""; let i = 1; let closed = false;
  for (; i < text.length && !closed; i += 1) {
    const ch = text[i];
    if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") { value += "'"; i += 1; } else closed = true;
    } else if (ch === "\\" && quote === '"') {
      const escape = text[i + 1];
      if (escape !== undefined && Object.hasOwn(YAML_ESCAPES, escape)) { value += YAML_ESCAPES[escape]; i += 1; } else if (escape === "x" || escape === "u" || escape === "U") {
        const digits = { x: 2, u: 4, U: 8 }[escape];
        const hex = text.slice(i + 2, i + 2 + digits);
        if (!new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex) || Number.parseInt(hex, 16) > 0x10ffff) return undefined;
        value += String.fromCodePoint(Number.parseInt(hex, 16)); i += 1 + digits;
      } else return undefined;
    } else value += ch;
  }
  return closed ? { value, tail: text.slice(i) } : undefined;
}
/** One block-mapping entry (`key: rest`) without its indentation, or undefined when the text is not one. */
function mappingEntry(text) {
  if (text[0] === '"' || text[0] === "'") {
    const quoted = quotedScalar(text);
    const after = quoted ? /^[ \t]*:(?:[ \t]+(.*)|)$/.exec(quoted.tail) : null;
    return after ? { key: quoted.value, rest: after[1] ?? "" } : undefined;
  }
  // flow collections, sequences, complex keys, anchors, tags, block scalars, directives and comments are not plain entries
  if ("[{?&*!|>%@`,#".includes(text[0]) || /^-(?:[ \t]|$)/.test(text)) return undefined;
  const colon = /:(?=[ \t]|$)/.exec(text);
  return colon && colon.index > 0 ? { key: text.slice(0, colon.index).trimEnd(), rest: text.slice(colon.index + 1).replace(/^[ \t]+/, "") } : undefined;
}
/**
 * The `name:` scalar of a SKILL.md header, read the way YAML does. The header must be a block mapping: its top-level
 * indentation is that of its first content line, keys at that indentation are the top-level keys, and deeper lines
 * (nested keys, continuation lines) are not keys of the mapping. The value may be a plain, single-quoted or
 * double-quoted scalar (a ` #` comment outside quotes is dropped).
 * `{status: "named", name}`; `{status: "none"}` only for a header that is provably a block mapping without a top-level `name`
 * (or an empty one) or a file without frontmatter; `{status: "indeterminate"}` for everything else: an unclosed
 * frontmatter, a flow mapping, a sequence, a dedent below the top level, a tab as indentation, a duplicate key, an empty
 * value, a block, folded or flow scalar, a multi-line scalar and malformed quoting.
 */
export function skillNameFromHeader(text) {
  const indeterminate = { status: "indeterminate" };
  const body = text.replace(/^﻿/, "");
  if (!/^---[ \t]*\r?\n/.test(body)) return { status: "none" };
  const lines = body.split(/\r?\n/).slice(1);
  const end = lines.findIndex((line) => /^---[ \t]*$/.test(line));
  if (end < 0) return indeterminate;
  const content = lines.slice(0, end).map((line, index) => ({ line, index })).filter(({ line }) => !/^[ \t]*(?:#.*)?$/.test(line));
  if (content.length === 0) return { status: "none" };
  if (content.some(({ line }) => /^ *\t/.test(line))) return indeterminate;
  const indentOf = (line) => /^ */.exec(line)[0].length;
  const top = indentOf(content[0].line);
  const entries = [];
  for (const [position, { line }] of content.entries()) {
    const indent = indentOf(line);
    if (indent < top) return indeterminate;
    if (indent > top) continue;
    const entry = mappingEntry(line.slice(top));
    if (!entry) return indeterminate;
    entries.push({ ...entry, position });
  }
  const named = entries.filter((entry) => entry.key === "name");
  if (named.length === 0) return { status: "none" };
  if (named.length > 1) return indeterminate;
  const { rest, position } = named[0];
  const following = content[position + 1];
  if (following !== undefined && indentOf(following.line) > top) return indeterminate;
  if (rest === "" || rest.startsWith("#") || "|>&*!%@`[{".includes(rest[0])) return indeterminate;
  if (rest[0] === '"' || rest[0] === "'") {
    const quoted = quotedScalar(rest);
    // after the closing quote only blanks or a comment that starts with whitespace may follow
    return quoted && /^(?:[ \t]*|[ \t]+#.*)$/.test(quoted.tail) ? { status: "named", name: quoted.value } : indeterminate;
  }
  const comment = /[ \t]#/.exec(rest);
  const name = (comment ? rest.slice(0, comment.index) : rest).trimEnd();
  return name.includes(": ") || name.endsWith(":") ? indeterminate : { status: "named", name };
}
export const SKILL_HEADER_BYTES = 16_384;
/**
 * The first 16 KiB of a SKILL.md, or `{absent}` when there is none, or `{indeterminate}` when it cannot be read
 * safely. The type is checked before anything is opened: a final link is resolved and its target must be a regular file
 * (a FIFO, socket or device is never opened), and the descriptor is checked again after opening against a swap. Only a
 * fixed buffer is read, so a huge or endless file costs nothing.
 */
export function readSkillHeader(file) {
  const indeterminate = { indeterminate: true };
  let type; let real = file;
  try { type = lstatSync(file); } catch (error) { return error?.code === "ENOENT" ? { absent: true } : indeterminate; }
  if (type.isSymbolicLink()) { try { real = realpathSync(file); type = lstatSync(real); } catch { return indeterminate; } }
  if (!type.isFile()) return indeterminate;
  let fd; try { fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK); } catch { return indeterminate; }
  try {
    if (!fstatSync(fd).isFile()) return indeterminate;
    const buffer = Buffer.alloc(SKILL_HEADER_BYTES);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return { text: buffer.toString("utf8", 0, length) };
  } catch { return indeterminate; } finally { closeSync(fd); }
}
/** What the SKILL.md in `dir` declares as its name; no file is `none`, a file that cannot be read safely is `indeterminate`. */
function declaredSkillName(skillFile) {
  const header = readSkillHeader(skillFile);
  if (header.absent) return { status: "none" };
  return header.indeterminate ? { status: "indeterminate" } : skillNameFromHeader(header.text);
}
/**
 * The real paths of every controller skill below a skill source: a directory named `pi-session-orchestration`, or one
 * whose SKILL.md declares that `name:`. Hidden directories such as `.system` are searched, and links are followed (each
 * real directory once, so cycles end). A walk that cannot finish, or a skill whose name cannot be determined, sets `sentinel` (`tooLarge`, `unreadable`, `indeterminate`).
 */
export function findControllerSkills(source, { limit = BOUND_ENTRY_LIMIT } = {}) {
  const out = { found: [], sentinel: undefined };
  try { lstatSync(source); } catch { return out; }
  const visited = new Set();
  let count = 0;
  const consider = (path, name) => {
    const declared = declaredSkillName(join(path, "SKILL.md"));
    // A skill whose name cannot be determined might be the controller skill; the source counts as differing.
    if (declared.status === "indeterminate") out.sentinel ??= "indeterminate";
    if (name === CONTROLLER_SKILL || (declared.status === "named" && declared.name === CONTROLLER_SKILL)) out.found.push(realpathSync(path));
  };
  const walk = (dir) => {
    visited.add(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      if (++count > limit) throw new BoundSentinel("tooLarge");
      const full = join(dir, entry.name);
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink()) { try { directory = statSync(full).isDirectory(); } catch { directory = false; } }
      if (!directory) continue;
      consider(full, entry.name);
      const real = realpathSync(full);
      if (!visited.has(real)) walk(real);
    }
  };
  try {
    const real = realpathSync(source);
    if (statSync(real).isDirectory()) { consider(real, ""); walk(real); }
  } catch (error) { out.sentinel = error instanceof BoundSentinel ? error.code : "unreadable"; }
  return out;
}
/** The content of a directory behind any link at its top, as one binding digest. */
function contentDigest(path) {
  try { return boundTreeSha256(realpathSync(path)); } catch { return "missing"; }
}
/**
 * Names of the Codex skill sources that hold a controller skill whose content differs from the candidate's. Every skill
 * definition inside a source counts, not only a direct child, and an equal copy (also through a link) or none is fine. A
 * source that cannot be searched completely counts as differing.
 */
export function differingCodexControllerSkills(run, candidate, context = {}) {
  const shipped = contentDigest(join(candidate, "skills", CONTROLLER_SKILL));
  return Object.entries(codexSkillSources(run, context))
    .filter(([, dirs]) => dirs.some((dir) => {
      const { found, sentinel } = findControllerSkills(dir);
      return sentinel !== undefined || found.some((skill) => contentDigest(skill) !== shipped);
    }))
    .map(([name]) => name);
}
/** The link in the Codex controller's directory: what it points at and, when that is the candidate's skill, its tree digest. */
function codexControllerLink(run, candidate, limit) {
  const link = join(run, "controller-codex", ".agents", "skills", CONTROLLER_SKILL);
  const skill = join(candidate, "skills", CONTROLLER_SKILL);
  // The link must point at the candidate's own skill; its content is what the Codex controller reads.
  try { return resolve(dirname(link), readlinkSync(link)) === skill ? { status: "linked", tree: boundTreeSha256(skill, { limit }) } : { status: "wrongTarget" }; } catch { return { status: "missing" }; }
}
/** Per client the kind of controller skill and its tree digest, without paths: Claude Code reads an installed copy, Codex a run-scoped link. */
export function controllerSkillRecord(run, candidate) {
  const link = codexControllerLink(run, candidate);
  return {
    claude: { kind: "installed", treeSha256: boundTreeSha256(join(run, "controller-claude", ".claude", "skills", CONTROLLER_SKILL)) },
    codex: { kind: "linked", treeSha256: link.status === "linked" ? link.tree : link.status },
  };
}

/**
 * The extension package contents the server loads: one digest per allowlisted package (its real root below Pi's
 * npm installation) and one for the whole npm installation, which covers dependencies, `package.json` and the
 * lockfile. Without extensions the npm digest is the stable `none`. Keys are path-free.
 */
export function extensionResources(agentDir, extensions, limit = BOUND_ENTRY_LIMIT) {
  if (extensions.length === 0) return { extensionNpmInstallation: "none" };
  if (!agentDir) return { extensionNpmInstallation: "unset", ...Object.fromEntries(extensions.map(({ name }) => [`extension:${name}`, "unset"])) };
  const packageRoot = (name) => { try { return boundTreeSha256(realpathSync(join(agentDir, "npm", "node_modules", name)), { limit }); } catch { return "missing"; } };
  return {
    extensionNpmInstallation: boundTreeSha256(join(agentDir, "npm"), { limit }),
    ...Object.fromEntries(extensions.map(({ name }) => [`extension:${name}`, packageRoot(name)])),
  };
}

/**
 * `context` carries what the run recorded privately at prepare (`agentDir`, `codexHome`, `extensions`) and, for
 * tests, the injectable `home` and `etcCodexSkills`, `ancestorBoundary` and `boundLimit`.
 */
export function computeResources(run, candidate, context = {}) {
  const { home = homedir(), agentDir, codexHome, extensions = [], etcCodexSkills = ETC_CODEX_SKILLS, ancestorBoundary, boundLimit } = context;
  const priv = join(run, "private");
  const link = codexControllerLink(run, candidate, boundLimit);
  // A value that is not a hash (`unreadable`, `tooLarge`) must stay visible in the key, never be hashed into one.
  const codexSkill = link.status !== "linked" ? link.status : isIncomplete(link.tree) ? link.tree : sha256(`linked\0${link.tree}`);
  const sources = codexSkillSources(run, { home, codexHome, etcCodexSkills, ancestorBoundary });
  const bound = (dir) => boundTreeSha256(dir, { limit: boundLimit });
  const ancestors = sources.codexAncestorSkills.map(bound);
  let build = "missing";
  try { build = sha256(`${sha256(readFileSync(join(candidate, "dist", "main.js")))}\n${distTreeSha256(candidate)}`); } catch { /* stays missing */ }
  return {
    candidateBuild: build,
    controllerSkill: treeSha256(join(run, "controller-claude", ".claude", "skills", CONTROLLER_SKILL)),
    codexControllerSkill: codexSkill,
    // The candidate's skill roots are bound through links: a skill root that is a link also binds the content behind it.
    workerSkillImplementation: bound(join(candidate, "skills", "pi-session-implementation")),
    workerSkillReview: bound(join(candidate, "skills", "pi-session-review")),
    handshakeSkill: treeSha256(join(priv, "skills", "acceptance-handshake")),
    overrideDirectory: treeSha256(join(priv, "skills")),
    runConfiguration: fileSha256(join(priv, "config.json")),
    claudeMcpConfiguration: fileSha256(join(priv, "claude-mcp.json")),
    fixtureBaselines: treeSha256(join(priv, "baselines")),
    harness: HARNESS_SHA256,
    ...operatorControllerSkills(home),
    // Every other place a Codex controller may read skills from. Without a recorded CODEX_HOME that source is `unset`.
    codexHomeSkills: codexHome ? bound(sources.codexHomeSkills[0]) : "unset",
    homeAgentsSkills: bound(sources.homeAgentsSkills[0]),
    etcCodexSkills: bound(sources.etcCodexSkills[0]),
    codexAncestorSkills: ancestors.find(isIncomplete) ?? sha256(JSON.stringify(ancestors)),
    ...extensionResources(agentDir, extensions, boundLimit),
  };
}
/** Names of the bound resources that differ from the recorded digests. */
export function changedResources(recorded, current) {
  return [...new Set([...Object.keys(recorded ?? {}), ...Object.keys(current)])].filter((name) => recorded?.[name] !== current[name]).sort();
}
/**
 * A value that says the resource could not be read completely (`unreadable`) or was too large to digest (`tooLarge`)
 * binds nothing: content under it can change while the value stays equal. `missing`, `none`, `notDirectory` and a
 * dangling top-level link are determinate and stay legitimate.
 */
export const isIncomplete = (value) => value === "unreadable" || value === "tooLarge";
/** Names of the resources whose recorded or current value is incomplete. */
export function unboundResources(recorded, current) {
  return [...new Set([...Object.keys(recorded ?? {}), ...Object.keys(current)])].filter((name) => isIncomplete(recorded?.[name]) || isIncomplete(current[name])).sort();
}
/** What `computeResources` needs from the run's private record, plus the injectable `home`, `etcCodexSkills`, `ancestorBoundary` and `boundLimit`. */
const boundContext = (info, context = {}) => ({ agentDir: info.agentDir, codexHome: info.codexHome, extensions: info.extensions ?? [], ...context });
/** Resources that changed since prepare and resources that are unbound (recorded or current value incomplete). */
function resourceReport(run, info, context) {
  if (!info.resources) fail("the run has no recorded resource digests; prepare a new run");
  const current = computeResources(run, info.candidate, boundContext(info, context));
  return { changed: changedResources(info.resources, current), unbound: unboundResources(info.resources, current) };
}
/** State at the end of a run: bound resources plus the fixtures of the scenario. A reanalysis must find the same. */
export function endStateOf(run, info, client, scenario, context) {
  const fixtures = Object.fromEntries(SCENARIOS[scenario].tasks.map((task) => [task, fixtureStateSha256(join(run, `controller-${client}`, "fixtures", task))]));
  return { resources: computeResources(run, info.candidate, boundContext(info, context)), fixtures };
}
export function endStateChanges(recorded, current) {
  const fixtures = [...new Set([...Object.keys(recorded?.fixtures ?? {}), ...Object.keys(current.fixtures)])].filter((task) => recorded?.fixtures?.[task] !== current.fixtures[task]).sort();
  return { resources: changedResources(recorded?.resources, current.resources), fixtures };
}

// ---- prepare --------------------------------------------------------------------
const EXTENSION_SPEC = /^npm:((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
/** The server's own rule for `extensions`: at most 8 exact `npm:<name>@<version>` pins, without duplicates. */
export function parseExtensionAllowlist(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 8) fail("the source profile's extensions must be a list of 1 to 8 entries");
  const parsed = list.map((spec) => {
    const match = typeof spec === "string" && spec.length <= 256 ? EXTENSION_SPEC.exec(spec) : null;
    if (!match) fail("every extension must be an exact npm:<name>@<version> pin");
    return { spec, name: match[1], version: match[2] };
  });
  if (new Set(parsed.map((item) => item.name)).size !== parsed.length) fail("an extension is listed twice");
  return parsed;
}

/**
 * `context` is for tests: the environment and home to resolve the Pi agent directory and `CODEX_HOME` from, the
 * directories that count as temporary, the Codex system skills directory and where the ancestor search stops.
 */
export function prepare(values, { env = process.env, home = homedir(), temporaryDirs = [tmpdir(), "/tmp", "/var/tmp", "/dev/shm"], etcCodexSkills, ancestorBoundary, boundLimit } = {}) {
  if (!values.candidate || !values["base-config"] || !values["from-profile"]) fail("prepare needs --candidate, --base-config and --from-profile");
  const candidate = realpathSync(resolve(values.candidate));
  const entry = join(candidate, "dist", "main.js");
  if (!existsSync(entry)) fail("the candidate has no dist/main.js; build it first");
  for (const name of ["pi-session-orchestration", "pi-session-implementation", "pi-session-review"]) {
    if (!existsSync(join(candidate, "skills", name, "SKILL.md"))) fail(`the candidate has no skills/${name}/SKILL.md`);
  }
  const base = readJson(resolve(values["base-config"]));
  const source = base.executionProfiles?.[values["from-profile"]];
  if (!source || source.mcpServers) fail("--from-profile must name an existing profile without MCP servers");
  if (source.extensions && !values["with-extensions"]) fail("the profile has extensions; pass --with-extensions to copy exactly its allowlist, or choose another profile");
  if (values["with-extensions"] && !source.extensions) fail("--with-extensions needs a profile that has extensions");
  const extensions = values["with-extensions"] ? parseExtensionAllowlist(source.extensions) : undefined;
  const workDir = resolve(values["work-dir"] ?? join(home, ".cache", "pi-session-mcp-acceptance"));
  if (temporaryDirs.some((dir) => inside(workDir, dir))) fail("--work-dir must not be inside a temporary directory: Codex refuses helper binaries there");
  // Resolved once: the server gets this directory explicitly, so the directory that is bound is the one it loads from,
  // and the Codex controller runs with exactly this CODEX_HOME.
  const agentDir = resolveAgentDirectory(env, home);
  const codexHome = resolveCodexHome(env, home);
  const runId = `skills-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const run = join(workDir, runId);
  const priv = join(run, "private");
  for (const dir of [priv, join(priv, "transcripts"), join(priv, "results"), join(priv, "reanalyses"), join(priv, "baselines"), join(priv, "skills", "acceptance-handshake")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
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
      // The baseline lives beside the run, never inside the worker's workspace.
      mkdirSync(join(priv, "baselines", client), { recursive: true, mode: 0o700 });
      writeJson(baselineFile(priv, client, task), captureBaseline(dir));
      workspaces[`${prefix}-${task}`] = relative(priv, dir);
    }
  }
  // Codex installs skills only in the user's home, which this run must not change, so the
  // Codex controller gets a run-scoped link to the candidate's skill in its repository skills.
  const codexSkills = join(run, "controller-codex", ".agents", "skills");
  mkdirSync(codexSkills, { recursive: true });
  symlinkSync(join(candidate, "skills", "pi-session-orchestration"), join(codexSkills, "pi-session-orchestration"));
  const profile = { provider: source.provider, model: source.model, thinkingLevel: source.thinkingLevel, ...(extensions ? { extensions: extensions.map((item) => item.spec) } : {}) };
  const config = {
    workspaces,
    // Library references: the shipped worker skills, and the handshake skill from the override
    // directory `skills/` next to this configuration.
    skillCatalog: {
      implementation: "builtin:pi-session-implementation",
      review: "builtin:pi-session-review",
      handshake: "builtin:acceptance-handshake",
    },
    executionProfiles: {
      "accept-read": { default: true, permissionProfile: "read-only", ...profile, skills: ["review"] },
      // Only the slug session needs the handshake; offering it elsewhere let a worker apply it to an unrequested file.
      [CODE_PROFILE]: { default: false, permissionProfile: "coding", ...profile, skills: CODE_SKILLS },
      [HANDSHAKE_PROFILE]: { default: false, permissionProfile: "coding", ...profile, skills: HANDSHAKE_SKILLS },
    },
  };
  const configBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(priv, "config.json"), configBytes, { mode: 0o600 });
  const node = process.execPath;
  writeJson(join(priv, "claude-mcp.json"), { mcpServers: { [SERVER]: { command: node, args: [entry], env: serverEnvironment(join(priv, "config.json"), agentDir) } } });
  const claudeSkillSetup = installClaudeSkill(candidate, run, priv, Boolean(extensions), agentDir);
  const extensionList = (extensions ?? []).map(({ name, version }) => ({ name, version }));
  const resources = computeResources(run, candidate, { home, etcCodexSkills, ancestorBoundary, boundLimit, agentDir, codexHome, extensions: extensionList });
  // A bound source that cannot be read completely would let content change without notice; do not prepare such a run.
  const unbound = unboundResources(undefined, resources);
  if (unbound.length > 0) fail(`these bound resources cannot be read completely and would bind nothing: ${JSON.stringify(unbound)}`);
  const packageJson = readJson(join(candidate, "package.json"));
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: candidate, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: candidate, encoding: "utf8" });
  writeJson(join(priv, "run.json"), {
    runId, candidate, entry, node, token,
    version: packageJson.version,
    sourceCommit: head.status === 0 ? head.stdout.trim() : undefined,
    sourceClean: dirty.status === 0 && dirty.stdout.trim() === "",
    entrySha256: sha256(readFileSync(entry)),
    distSha256: distTreeSha256(candidate),
    harnessSha256: HARNESS_SHA256,
    configFingerprint: `sha256:${sha256(configBytes)}`,
    claudeSkillSetup,
    profile: { from: values["from-profile"], provider: profile.provider, model: profile.model, thinkingLevel: profile.thinkingLevel },
    // Names and versions only; the pins themselves are what the configuration holds.
    extensions: extensionList,
    // Private: where the server loads extensions from and which CODEX_HOME the Codex controller gets.
    agentDir, codexHome,
    // Per client the kind of controller skill and its digest, path-free, for the evidence.
    controllerSkills: controllerSkillRecord(run, candidate),
    resources,
    preparedAt: new Date().toISOString(),
  });
  process.stdout.write(`${run}\n`);
}

/**
 * Installs the Claude Code controller skill the way an operator does: the candidate's
 * `pi-session-mcp-setup --apply` for the project scope of the controller directory. Setup state
 * and the client's own files go to a disposable home, so no real registration changes; the
 * controller later runs with the real home and only reads the project skill.
 */
/**
 * The environment of the candidate's setup in its disposable home. Setup's Doctor resolves allowlisted
 * extensions from Pi's install, which the disposable home lacks, so an extension profile gets the operator's
 * Pi agent directory through `PI_CODING_AGENT_DIR`. Doctor only reads extension manifests there.
 */
export function setupEnvironment(home, path, configPath, withExtensions, env = process.env) {
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return [`HOME=${home}`, `PATH=${path}`, `PI_SESSION_MCP_CONFIG=${configPath}`, ...(withExtensions ? [`PI_CODING_AGENT_DIR=${agentDir}`] : [])];
}

function installClaudeSkill(candidate, run, priv, withExtensions, agentDir) {
  const home = join(run, "setup-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const claude = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
  if (!claude) fail("claude is not on PATH");
  const path = [...new Set([dirname(process.execPath), dirname(claude), "/usr/bin", "/bin"])].join(":");
  const setup = spawnSync("env", ["-i", ...setupEnvironment(home, path, join(priv, "config.json"), withExtensions, { PI_CODING_AGENT_DIR: agentDir }),
    process.execPath, join(candidate, "dist", "setup-main.js"), "--apply", "--json", "--target", "claude-code:project:pi-session-mcp"],
  { cwd: join(run, "controller-claude"), encoding: "utf8", timeout: 120_000 });
  let parsed; try { parsed = JSON.parse(setup.stdout); } catch { parsed = undefined; }
  const codes = (parsed?.findings ?? []).map((finding) => `${finding.target.alias}:${finding.code}`);
  const installed = join(run, "controller-claude", ".claude", "skills", "pi-session-orchestration", "SKILL.md");
  const copied = readSafe(() => readFileSync(installed));
  const shipped = readFileSync(join(candidate, "skills", "pi-session-orchestration", "SKILL.md"));
  const result = {
    exitCode: setup.status, codes,
    installedAsCopy: Boolean(copied) && !readSafe(() => readlinkSync(join(run, "controller-claude", ".claude", "skills", "pi-session-orchestration"))),
    matchesShipped: Boolean(copied) && Buffer.compare(copied, shipped) === 0,
  };
  if (setup.status !== 0 || !result.installedAsCopy || !result.matchesShipped) fail(`setup did not install the Claude Code skill: ${JSON.stringify(result)}`);
  return result;
}

// ---- controller prompts -----------------------------------------------------------
function prompt(client, scenario) {
  const p = CLIENTS[client];
  const common = [
    `You are the controller of an acceptance run of the Pi Session MCP server named \`${SERVER}\`. Use your \`pi-session-orchestration\` skill and call the \`${SERVER}\` MCP tools yourself; do not write scripts that call them.`,
    "Start with pi_capabilities_get and state the server version and the configuration fingerprint you saw.",
    scenario === "parallel"
      ? `Use the execution profile \`${HANDSHAKE_PROFILE}\` for the SLUG session and \`${CODE_PROFILE}\` for the STATS session; no other session uses \`${HANDSHAKE_PROFILE}\`. Wait 5 to 10 seconds with the shell command \`sleep\` between polling rounds. Total time budget: 15 minutes.`
      : scenario === "trio"
        ? `Use the execution profile \`${CODE_PROFILE}\` for the SLUG and WAIT sessions and \`${READ_PROFILE}\` for the REVIEW session. Wait 5 to 10 seconds with the shell command \`sleep\` between polling rounds. Total time budget: 15 minutes.`
        : `Use the execution profile \`${CODE_PROFILE}\` for every task. Wait 5 to 10 seconds with the shell command \`sleep\` between polling rounds. Total time budget: 15 minutes.`,
    `Read files and run commands only inside ./fixtures and your own skill directory ${client === "claude" ? "./.claude/skills" : "./.agents/skills"}; every other directory of this run is off limits.`,
  ];
  if (scenario === "parallel") return [...common,
    "Run these two tasks in parallel, each in its own Pi session; start both first turns before waiting for either:",
    `- SLUG: execution profile \`${HANDSHAKE_PROFILE}\`, workspace alias \`${p}-slug\` (local copy: ./fixtures/slug). Make \`node --test\` pass by implementing \`slugify\` in \`src/slug.js\`; change only that file.`,
    `- STATS: execution profile \`${CODE_PROFILE}\`, workspace alias \`${p}-stats\` (local copy: ./fixtures/stats). Make \`node --test\` pass by implementing \`median\` in \`src/stats.js\`; change only that file.`,
    // Only the parallel scenario has a handshake; the abort controller must not hear of it.
    "The operator checks the handshake content; you only check that the file exists.",
    "After the first SLUG turn succeeded, send one follow-up prompt in the same SLUG session: add one more test case to `test/slug.test.js` for a string with leading and trailing whitespace (it must pass), and complete the acceptance handshake described in the worker's available skills.",
    "Verify every result yourself before closing (read the changed files, run `node --test` in the fixture directory, check `git -C <fixture> status --short`). Close every session you started.",
    "Finish with a short report: per task the final turn state, whether your own verification passed, and whether all sessions were closed.",
  ].join("\n");
  if (scenario === "trio") return [...common,
    // REVIEW first and the shortest wait: the reviewer has no shell delay and must still run when WAIT is aborted.
    "Run these three tasks at the same time, each in its own Pi session. Start the first turns in this order, REVIEW, then SLUG, then WAIT, and start all three before waiting for any of them:",
    `- REVIEW: execution profile \`${READ_PROFILE}\`, workspace alias \`${p}-review\` (local copy: ./fixtures/review). Ask the worker for an enumerated review of the finished, frozen implementation in \`src/chunk.js\` and its tests: one numbered finding per exported function, each with a line reference, after reading every file in the repository. The review is read-only; the worker must not change anything.`,
    // The deliberate, bounded delay keeps SLUG running while WAIT is aborted.
    `- SLUG: execution profile \`${CODE_PROFILE}\`, workspace alias \`${p}-slug\` (local copy: ./fixtures/slug). Ask the worker to first run the shell command \`sleep 45\` in the repository (a deliberate delay for this test), and then make \`node --test\` pass by implementing \`slugify\` in \`src/slug.js\`; change only that file.`,
    `- WAIT: execution profile \`${CODE_PROFILE}\`, workspace alias \`${p}-wait\`. Ask the worker to run exactly this shell command in the repository and then report its output: \`sleep 120 && echo late > LATE.txt\`.`,
    "About 5 seconds after the WAIT turn was accepted, abort the WAIT session with pi_session_abort while SLUG and REVIEW are still running. Confirm that the WAIT turn ends as `aborted`; an `abort_timeout` error is not a successful abort and must be reported as such.",
    "Let SLUG and REVIEW finish. Verify SLUG yourself (`node --test` in ./fixtures/slug, `git -C ./fixtures/slug status --short`), check that REVIEW changed nothing (`git -C ./fixtures/review status --short`), then close all three sessions.",
    "Finish with a short report: final turn state per task, the abort result, the findings of the review, your verification result, and whether all sessions were closed.",
  ].join("\n");
  return [...common,
    "Run these two tasks at the same time, each in its own Pi session:",
    `- WAIT: workspace alias \`${p}-wait\`. Ask the worker to run exactly this shell command in the repository and then report its output: \`sleep 120 && echo late > LATE.txt\`.`,
    // The deliberate, bounded delay keeps RANGE running while WAIT is aborted.
    `- RANGE: workspace alias \`${p}-range\` (local copy: ./fixtures/range). Ask the worker to first run the shell command \`sleep 45\` in the repository (a deliberate delay for this test), and then make \`node --test\` pass by implementing \`range\` in \`src/range.js\`; change only that file.`,
    "Start both turns. About 15 seconds after both were accepted, abort the WAIT session with pi_session_abort while RANGE is still running. Confirm that the WAIT turn ends as `aborted`; an `abort_timeout` error is not a successful abort and must be reported as such.",
    "Let RANGE finish, verify it yourself (`node --test` in ./fixtures/range, `git -C ./fixtures/range status --short`), then close both sessions.",
    "Finish with a short report: final turn state per task, the abort result, your verification result, and whether all sessions were closed.",
  ].join("\n");
}

export function command(client, info, priv, controller, values) {
  const text = prompt(client, values.scenario);
  if (client === "claude") {
    const allowed = [...TOOLS.map((tool) => `mcp__${SERVER}__${tool}`), "Read", "Grep", "Glob", "Bash(sleep:*)", "Bash(node --test:*)", "Bash(git -C:*)"];
    // `--setting-sources project,local` also keeps a personal skill of the same name from shadowing the run's
    // project copy (observed on Claude Code 2.1.296); see operatorControllerSkills.
    return { file: "claude", args: ["-p", text, "--mcp-config", join(priv, "claude-mcp.json"), "--strict-mcp-config", "--permission-mode", "dontAsk",
      "--allowedTools", ...allowed, "--setting-sources", "project,local", "--output-format", "stream-json", "--verbose", "--no-session-persistence"] };
  }
  const toml = (value) => JSON.stringify(value);
  // Read-only sandbox: the controller can inspect and test the fixtures but never write them itself.
  return { file: "codex", args: ["exec", "--json", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only", "-C", controller,
    ...(values["codex-model"] ? ["-m", values["codex-model"]] : []),
    "-c", `mcp_servers.${SERVER}.command=${toml(info.node)}`,
    "-c", `mcp_servers.${SERVER}.args=[${toml(info.entry)}]`,
    "-c", `mcp_servers.${SERVER}.env={${Object.entries(serverEnvironment(join(priv, "config.json"), info.agentDir)).map(([key, value]) => `${key}=${toml(value)}`).join(",")}}`,
    ...["pi_session_prompt", "pi_session_abort", "pi_session_close"].flatMap((tool) => ["-c", `mcp_servers.${SERVER}.tools.${tool}.approval_mode="approve"`]),
    text] };
}

// ---- process watching -------------------------------------------------------------
export function procInfo(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    return { pid, ppid: Number(fields[1]), pgrp: Number(fields[2]), state: fields[0], start: fields[19], comm };
  } catch { return undefined; }
}
/** Same process (PID and start time) and not a zombie: a zombie is terminated and holds nothing. */
export const alive = ({ pid, start }) => { const now = procInfo(pid); return now?.start === start && now.state !== "Z"; };
function readSafe(read) { try { return read(); } catch { return ""; } }

/**
 * The processes of the run: the controller's tree, the run's servers and processes working inside the run. With
 * `rootStart` the controller is matched by PID and start time, so a PID that the kernel reuses after the client
 * exited never makes a foreign process, or its children, the run's own.
 */
export function snapshot(rootPid, run, info, rootStart) {
  const all = new Map();
  for (const name of readdirSync("/proc")) if (/^\d+$/.test(name)) { const p = procInfo(Number(name)); if (p) all.set(p.pid, p); }
  const isRoot = (pid) => pid === rootPid && (rootStart === undefined || all.get(pid)?.start === rootStart);
  const found = [];
  for (const p of all.values()) {
    let ancestor = p.ppid; let fromClient = isRoot(p.pid);
    for (let hops = 0; ancestor > 1 && hops < 64 && !fromClient; hops += 1) { if (isRoot(ancestor)) fromClient = true; ancestor = all.get(ancestor)?.ppid ?? 0; }
    const cmdline = readSafe(() => readFileSync(`/proc/${p.pid}/cmdline`, "utf8"));
    const isServer = cmdline.includes(info.entry) && readSafe(() => readFileSync(`/proc/${p.pid}/environ`, "utf8")).split("\0").includes(`PI_SESSION_MCP_CONFIG=${join(run, "private", "config.json")}`);
    const cwd = readSafe(() => readlinkSync(`/proc/${p.pid}/cwd`));
    const inRun = cwd !== "" && inside(cwd, run);
    // The fixture a process works in, for example `wait` for the worker's long shell command.
    const fixture = inRun ? relative(run, cwd).split("/").slice(1).join("/").match(/^fixtures\/([a-z]+)/)?.[1] : undefined;
    if (fromClient || isServer || inRun) found.push({ ...p, fixture, role: isServer ? "server" : isRoot(p.pid) ? "client" : fromClient ? "client-descendant" : "run-cwd" });
  }
  return found;
}

// ---- bounded supervision of the controller ------------------------------------------
export const DEFAULT_TIMEOUT_MIN = 25;
export const MAX_TIMEOUT_MIN = 180;
/** [min, max] in milliseconds; the maximum stays below the 2^31-1 ms timer limit. */
const BUDGET_LIMITS = { timeoutMs: [100, MAX_TIMEOUT_MIN * 60_000], graceMs: [0, 600_000], killWaitMs: [0, 60_000], drainMs: [0, 60_000], intervalMs: [10, 60_000] };
const DEFAULT_BUDGETS = { graceMs: 10_000, killWaitMs: 3_000, drainMs: 3_000, intervalMs: 250 };
/** Fills defaults and rejects any budget that is not a finite integer inside its range. */
export function validateBudgets(budgets) {
  const merged = { ...DEFAULT_BUDGETS, ...budgets };
  for (const [name, [min, max]] of Object.entries(BUDGET_LIMITS)) {
    const value = merged[name];
    if (!Number.isInteger(value) || value < min || value > max) fail(`invalid budget ${name}: must be an integer from ${min} to ${max} ms`);
  }
  return merged;
}
/** `--timeout-min`: a finite number of minutes above 0, at most MAX_TIMEOUT_MIN; the default applies when absent. */
export function parseTimeoutMinutes(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MIN;
  if (!/^\d+(\.\d+)?$/.test(value)) fail("--timeout-min must be a positive number of minutes");
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_TIMEOUT_MIN) fail(`--timeout-min must be above 0 and at most ${MAX_TIMEOUT_MIN}`);
  return minutes;
}

/** Members of a process group that started at or after `notBefore` (clock ticks): the group cannot predate its leader. */
function groupMembers(pgid, notBefore) {
  if (notBefore === undefined) return [];
  const found = [];
  for (const name of readSafe(() => readdirSync("/proc")) || []) {
    if (!/^\d+$/.test(name)) continue;
    const p = procInfo(Number(name));
    if (p && p.pgrp === pgid && p.state !== "Z" && Number(p.start) >= Number(notBefore)) found.push(p);
  }
  return found;
}
/**
 * A recorded process is this run's own to kill when it was found through the controller's process tree or as
 * this run's server. A process that merely has its working directory inside the run is only reported, since
 * an operator's shell could be there too.
 */
const ownedByRun = (p) => p.pid !== process.pid && ["client", "client-descendant", "server"].includes(p.role);
const ROLE_RANK = { "run-cwd": 0, "client-descendant": 1, client: 2, server: 3 };
/**
 * A later sighting of the same process (PID and start time) never loses what an earlier one established. A server
 * that is exiting, or a zombie that its client has not reaped yet, has no command line, environment or working
 * directory left to read, so a sweep in that window sees it only as a descendant of the client. A descendant that
 * outlives the client is reparented and would otherwise be found only through its working directory, which is
 * never killed.
 */
export function mergeSighting(earlier, later) {
  if (!earlier) return later;
  const role = ROLE_RANK[earlier.role] > ROLE_RANK[later.role] ? earlier.role : later.role;
  return { ...later, role, fixture: later.fixture ?? earlier.fixture };
}
/** SIGKILL for recorded processes that still have the recorded PID and start time. Never by name. */
export function killRecorded(list) {
  let killed = 0;
  for (const p of list) {
    if (!ownedByRun(p) || !alive(p)) continue;
    try { process.kill(p.pid, "SIGKILL"); killed += 1; } catch { /* gone in between */ }
  }
  return killed;
}

/**
 * Runs a client in its own process group and returns when it is done, always within the budgets:
 * the timeout, then (after SIGTERM and `graceMs`) SIGKILL for the group and every recorded process of the
 * run, then `killWaitMs`, then `drainMs` for the output pipes, which are destroyed when a descendant keeps
 * them open. A spawn failure and SIGINT/SIGTERM delivered to the harness (through `signals`) end the run the
 * same way and are classified. Every timer, interval and listener is gone when the promise settles.
 *
 * `scan(rootPid, rootStart)` lists the processes belonging to the run; the interval records them by PID and
 * start time. Without the client's start time nothing is recorded, since its PID alone proves nothing.
 */
export async function superviseProcess({ file, args = [], cwd, env, budgets = {}, scan = () => [], signals = process }) {
  const b = validateBudgets(budgets);
  const started = Date.now();
  const chunks = []; let stderrBytes = 0;
  const seen = new Map();
  const timers = new Set();
  const state = { exited: false, exitCode: null, spawned: false, timedOut: false, spawnFailed: false, harnessAborted: false, abortSignal: undefined, unterminated: false, drainDestroyed: false };
  const finish = () => ({
    output: Buffer.concat(chunks), stderrBytes, exitCode: state.exitCode, timedOut: state.timedOut, spawnFailed: state.spawnFailed,
    harnessAborted: state.harnessAborted, abortSignal: state.abortSignal, unterminated: state.unterminated, drainDestroyed: state.drainDestroyed,
    seen, elapsedMs: Date.now() - started,
  });
  let child;
  try { child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true }); } catch { state.spawnFailed = true; return finish(); }
  const pgid = child.pid;
  const childStart = pgid === undefined ? undefined : procInfo(pgid)?.start;
  const noop = () => {};
  child.stdout.on("data", (chunk) => chunks.push(chunk)); child.stdout.on("error", noop);
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; }); child.stderr.on("error", noop);
  let closed = false;
  const closedEvent = new Promise((done) => child.once("close", () => { closed = true; done(); }));
  const exitedEvent = new Promise((done) => {
    child.once("spawn", () => { state.spawned = true; });
    child.once("exit", (code, signal) => { state.exited = true; state.exitCode = code ?? signal; done(); });
    // Kept after the first event: a later 'error' on a ChildProcess without a listener would throw.
    child.on("error", () => { if (!state.spawned && !state.exited) { state.spawnFailed = true; state.exited = true; done(); } });
  });
  const sleep = (ms) => new Promise((done) => { const t = setTimeout(() => { timers.delete(t); done(); }, ms); timers.add(t); });
  const until = async (predicate, ms) => {
    const deadline = Date.now() + ms;
    while (!predicate()) { if (Date.now() >= deadline) return false; await sleep(Math.min(50, Math.max(1, deadline - Date.now()))); }
    return true;
  };
  const within = (promise, ms) => new Promise((done) => { const t = setTimeout(() => { timers.delete(t); done(false); }, ms); timers.add(t); promise.then(() => { clearTimeout(t); timers.delete(t); done(true); }); });
  const sweep = () => {
    if (pgid === undefined || childStart === undefined) return;
    try { for (const p of scan(pgid, childStart)) { const key = `${p.pid}:${p.start}`; seen.set(key, mergeSighting(seen.get(key), p)); } } catch { /* a racing /proc read */ }
  };
  const ownAlive = () => [...seen.values()].filter((p) => ownedByRun(p) && alive(p));
  const gone = () => state.exited && groupMembers(pgid, childStart).length === 0 && ownAlive().length === 0;
  const signalGroup = (signal) => {
    if (pgid === undefined || (state.exited && groupMembers(pgid, childStart).length === 0)) return;
    try { process.kill(-pgid, signal); } catch { /* group already gone */ }
  };
  let skipGrace = false; let terminating; let terminationDone = () => {};
  const terminated = new Promise((done) => { terminationDone = done; });
  /** SIGTERM to the group, a bounded grace period, then SIGKILL for the group and the recorded processes of the run. */
  const terminate = () => (terminating ??= (async () => {
    signalGroup("SIGTERM");
    await until(() => skipGrace || gone(), b.graceMs);
    if (!gone()) { sweep(); signalGroup("SIGKILL"); killRecorded([...seen.values()]); await until(gone, b.killWaitMs); }
    terminationDone();
  })());
  const watch = pgid === undefined ? undefined : setInterval(sweep, b.intervalMs);
  const limit = setTimeout(() => { state.timedOut = true; void terminate(); }, b.timeoutMs);
  const onSignal = (signal) => {
    if (state.spawnFailed) return;
    if (state.harnessAborted) { skipGrace = true; return; }
    state.harnessAborted = true; state.abortSignal = signal; void terminate();
  };
  const onInt = () => onSignal("SIGINT"); const onTerm = () => onSignal("SIGTERM");
  signals.on("SIGINT", onInt); signals.on("SIGTERM", onTerm);
  try {
    // The escalation is bounded, so a client that cannot be reaped still ends the wait (`unterminated`).
    await Promise.race([exitedEvent, terminated]);
    clearTimeout(limit);
    if (terminating) await terminating;
    // `exit` does not mean the pipes are closed: a descendant may hold them. Give the output a bounded drain.
    if (!state.spawnFailed) {
      if (!(await within(closedEvent, b.drainMs)) && !closed) state.drainDestroyed = true;
    }
    child.stdout.destroy(); child.stderr.destroy();
    if (!state.exited) state.unterminated = true;
    sweep();
    return finish();
  } finally {
    clearInterval(watch); clearTimeout(limit);
    for (const t of timers) clearTimeout(t);
    signals.off("SIGINT", onInt); signals.off("SIGTERM", onTerm);
  }
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

export function toolCalls(client, lines) {
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

export function analyze(client, scenario, calls, info, rawText) {
  const p = CLIENTS[client];
  const counts = Object.fromEntries(TOOLS.map((tool) => [tool, calls.filter((call) => call.tool === tool).length]));
  const capabilities = calls.find((call) => call.tool === "pi_capabilities_get" && call.result?.ok)?.result;
  const profileSkills = (alias) => capabilities?.executionProfiles?.find((profile) => profile.alias === alias)?.skills;
  const sessions = new Map();
  for (const call of calls) if (call.tool === "pi_session_start" && call.result?.ok) sessions.set(call.result.session.id, { workspace: call.result.session.workspace, profile: call.result.session.executionProfile, turns: new Map(), closed: false, aborts: [], abortedSeenAt: undefined, closedAt: undefined, polls: 0, liveness: new Map() });
  calls.forEach((call, index) => {
    const session = sessions.get(call.input?.sessionId);
    if (!session) return;
    const turn = call.result?.turn;
    if (turn?.turnId) session.turns.set(turn.turnId, { ...(session.turns.get(turn.turnId) ?? {}), ...turn });
    if (call.tool === "pi_turn_get") session.polls += 1;
    // Liveness: does `updatedAt` move past `startedAt` while the turn is still `running`? An observation, not a criterion.
    if (call.tool === "pi_turn_get" && turn?.turnId && turn.state === "running") {
      const live = session.liveness.get(turn.turnId) ?? { runningPolls: 0, updatedAtAdvancedWhileRunning: false };
      live.runningPolls += 1;
      if (Date.parse(turn.updatedAt) > Date.parse(turn.startedAt)) live.updatedAtAdvancedWhileRunning = true;
      session.liveness.set(turn.turnId, live);
    }
    if (call.tool === "pi_turn_get" && turn?.state === "aborted") session.abortedSeenAt ??= index;
    if (call.tool === "pi_session_close" && call.result?.ok) { session.closed = true; session.closedAt ??= index; }
    // Every abort result in order: an abort_timeout followed by a successful retry stays visible.
    if (call.tool === "pi_session_abort") session.aborts.push(call.result?.ok ? "ok" : call.result?.error?.code ?? "error");
    if (call.tool === "pi_session_abort" && call.result?.ok) session.abortOkAt ??= index;
  });
  const task = (name) => [...sessions.values()].find((session) => session.workspace === `${p}-${name}`);
  // Every abort call of the transcript is judged, also one on an unknown session id or on a neighbor: a failed or
  // misdirected abort never disappears behind the successful one. `abortOk` needs all of them `ok`; the calls that
  // do not target the aborted session are counted separately.
  const abortCalls = calls.filter((call) => call.tool === "pi_session_abort");
  const allAbortsOk = abortCalls.every((call) => call.result?.ok === true);
  const offTargetAborts = (target) => abortCalls.filter((call) => !target || sessions.get(call.input?.sessionId) !== target).length;
  const turnsOf = (session) => [...(session?.turns.values() ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const ms = (value) => (value ? Date.parse(value) : NaN);
  const [first, second] = SCENARIOS[scenario].tasks.map(task);
  // The first turns of every task of the scenario have one instant in common (two tasks, or three in `trio`).
  const firstTurns = SCENARIOS[scenario].tasks.map((name) => turnsOf(task(name))[0]);
  const overlapMs = firstTurns.every(Boolean) ? Math.min(...firstTurns.map((turn) => ms(turn.completedAt))) - Math.max(...firstTurns.map((turn) => ms(turn.startedAt))) : NaN;
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
    acceptCodeSkills: profileSkills(CODE_PROFILE),
    acceptCodeHandshakeSkills: profileSkills(HANDSHAKE_PROFILE),
    toolCalls: counts,
    sessionsStarted: sessions.size,
    sessions: [...sessions.values()].map((session) => ({ workspace: session.workspace, profile: session.profile, turns: turnsOf(session).map((turn) => turn.state), polls: session.polls, aborts: session.aborts, closed: session.closed,
      turnLiveness: turnsOf(session).map((turn) => session.liveness.get(turn.turnId) ?? { runningPolls: 0, updatedAtAdvancedWhileRunning: false }) })),
    firstTurnsOverlapSeconds: Number.isFinite(overlapMs) ? Math.round(overlapMs / 100) / 10 : undefined,
    firstTurnsOverlap: Number.isFinite(overlapMs) && overlapMs > 0,
    tokenInControllerPrompts: prompts.some((text) => text.includes(info.token)),
    privateMarkersInWorkerPrompts: prompts.some((text) => ["/private", "run.json", "config.json", "acceptance-handshake", "SKILL.md"].some((marker) => text.includes(marker))),
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
  } else if (scenario === "trio") {
    const wait = task("wait"); const waitTurn = turnsOf(wait)[0];
    // Only the reviewer's profile has the `review` skill; the controller saw it in the capabilities.
    result.acceptReadSkills = profileSkills(READ_PROFILE);
    result.abortedTurn = waitTurn?.state === "aborted";
    result.abortResults = wait?.aborts ?? [];
    result.abortOk = (wait?.aborts.length ?? 0) >= 1 && wait.aborts.every((code) => code === "ok") && allAbortsOk;
    result.offTargetAborts = offTargetAborts(wait);
    result.abortedBeforeClose = wait?.abortedSeenAt !== undefined && (wait.closedAt === undefined || wait.abortedSeenAt < wait.closedAt);
    result.abortBeforeAbortedSeen = wait?.abortOkAt !== undefined && wait.abortedSeenAt !== undefined && wait.abortOkAt < wait.abortedSeenAt;
    // The abort ended the WAIT turn while the turns of both others were running.
    const neighbors = ["slug", "review"].map((name) => turnsOf(task(name))[0]);
    result.abortWhileNeighborsRunning = Boolean(waitTurn && neighbors.every((turn) => turn && ms(waitTurn.completedAt) > ms(turn.startedAt) && ms(waitTurn.completedAt) < ms(turn.completedAt)));
  } else {
    const wait = turnsOf(first)[0]; const range = turnsOf(second)[0];
    result.abortedTurn = wait?.state === "aborted";
    result.abortResults = first?.aborts ?? [];
    result.abortOk = (first?.aborts.length ?? 0) >= 1 && first.aborts.every((code) => code === "ok") && allAbortsOk;
    result.offTargetAborts = offTargetAborts(first);
    // `aborted` must be observed through pi_turn_get before the session was closed, so close did not cause it.
    result.abortedBeforeClose = first?.abortedSeenAt !== undefined && (first.closedAt === undefined || first.abortedSeenAt < first.closedAt);
    result.abortBeforeAbortedSeen = first?.abortOkAt !== undefined && first.abortedSeenAt !== undefined && first.abortOkAt < first.abortedSeenAt;
    result.neighborCompleted = range?.state === "completed";
    result.abortWhileNeighborRunning = Boolean(wait && range && ms(wait.completedAt) > ms(range.startedAt) && ms(wait.completedAt) < ms(range.completedAt));
  }
  return result;
}

/** Whether a file was last written inside one of the worker turns (1 s tolerance for clock granularity). */
export function writtenDuring(path, intervals) {
  const mtime = readSafe(() => statSync(path).mtimeMs);
  return typeof mtime === "number" && intervals.some(([start, end]) => end !== undefined && mtime >= Date.parse(start) - 1_000 && mtime <= Date.parse(end) + 1_000);
}

/** True for a directory below `dir` (outside `.git`) that holds nothing: a change that no manifest or git comparison sees. */
function hasEmptyDirectory(dir) {
  const walk = (current, top) => {
    const entries = readdirSync(current, { withFileTypes: true }).filter((entry) => !(top && entry.name === ".git"));
    if (entries.length === 0 && !top) return true;
    return entries.some((entry) => entry.isDirectory() && walk(join(current, entry.name), false));
  };
  return walk(dir, true);
}

/**
 * Read-only invariance of a fixture: working tree, index and `HEAD` are exactly the baseline. Beyond the path
 * comparison it requires `HEAD` to still be the base commit (an empty commit moves it without changing a path)
 * and no empty directory (a created directory leaves no path in the manifest or in git).
 */
export function unchangedSinceBaseline(dir, baseline, comparison) {
  // `changed` is the union of the working tree, the index and HEAD against the baseline; an error is never "unchanged".
  if (comparison.error || comparison.changed.size !== 0) return false;
  const current = gitInFixture(dir, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!current || current.toString("utf8").trim() !== baseline.commit) return false;
  try { return !hasEmptyDirectory(dir); } catch { return false; }
}

export function oracle(controller, scenario, info, intervals = {}, baselineOf = () => undefined) {
  const out = {};
  for (const task of SCENARIOS[scenario].tasks) {
    const dir = join(controller, "fixtures", task);
    // Against the fixed baseline: working tree, HEAD and index. `git status` alone misses committed changes.
    const comparison = compareToBaseline(dir, baselineOf(task), allowedChanges(task, scenario));
    const changed = [...comparison.changed];
    const check = { onlyAllowedChanges: comparison.ok, baselineError: comparison.error, changedFiles: changed.length, changeSources: comparison.sources };
    // Attribution: every changed file was last written during a worker turn of this task's session.
    check.changesWrittenDuringWorkerTurns = changed.every((file) => writtenDuring(join(dir, file), intervals[task] ?? []));
    // The reviewer's fixture is frozen: tests are not rerun there; the invariance below is the oracle.
    if (task !== "wait" && task !== "review") {
      const test = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", env: { PATH: process.env.PATH ?? "" } });
      check.testsPass = test.status === 0;
      // The worker may edit the tests it is judged by, so the harness brings its own cases.
      check.businessChecks = runBusinessChecks(task, dir);
    }
    if (task === "review") check.readOnlyInvariant = unchangedSinceBaseline(dir, baselineOf(task), comparison);
    // Only `parallel` has a follow-up turn and the handshake.
    if (task === "slug" && scenario === "parallel") {
      const tests = readSafe(() => readFileSync(join(dir, "test", "slug.test.js"), "utf8")).match(/\btest\(/g)?.length ?? 0;
      check.addedTest = tests > 3;
      check.handshake = readSafe(() => readFileSync(join(dir, "HANDSHAKE.txt"), "utf8")).trim() === `handshake ${info.token}`;
      check.handshakeWrittenDuringFollowUp = writtenDuring(join(dir, "HANDSHAKE.txt"), (intervals.slug ?? []).slice(1));
    }
    if (task === "wait") check.lateFileAbsent = !existsSync(join(dir, "LATE.txt"));
    out[task] = check;
  }
  return out;
}

/**
 * The mechanical pass criteria of docs/acceptance.md for one result, as stable path-free codes. `passed` is
 * true only when no code is listed; a changed resource, or a reanalysis whose state differs from the end of
 * the original run, never passes.
 */
export function evaluateAcceptance(result, scenario) {
  const failures = [];
  const need = (ok, code) => { if (!ok) failures.push(code); };
  const t = result.transcript ?? {};
  const prefix = CLIENTS[result.client];
  need(result.exitCode === 0, "controllerExit");
  need(!result.timedOut, "timedOut");
  need(!result.spawnFailed, "spawnFailed");
  need(!result.harnessAborted, "harnessAborted");
  need(!result.analysisFailed, "analysisFailed");
  need(result.resources?.changedAfterRun?.length === 0, "resourcesChanged");
  // A bound resource whose recorded or final value is incomplete (unreadable, tooLarge) binds nothing.
  need(Array.isArray(result.unboundResources) && result.unboundResources.length === 0, "resourcesUnbound");
  need(!result.reanalysis || (result.reanalysis.stateChanges?.resources?.length === 0 && result.reanalysis.stateChanges?.fixtures?.length === 0), "stateChangedSinceRun");
  need((result.processes?.serversObserved ?? 0) >= 1, "noServerObserved");
  need(Object.keys(result.processes?.residualByRole ?? {}).length === 0, "residualProcesses");
  need(t.capabilitiesFirst === true, "capabilitiesNotFirst");
  need(t.candidateConfirmed === true, "candidateNotConfirmed");
  // Both coding profiles offer exactly their skills, and only the slug session ran on the profile with the handshake.
  // In `trio` there is no handshake: slug and wait use `accept-code`, and `accept-read` (exactly `review`) is the reviewer's alone.
  const expectedProfile = scenario === "trio"
    ? (workspace) => (workspace === `${prefix}-review` ? READ_PROFILE : CODE_PROFILE)
    : (workspace) => (workspace === `${prefix}-slug` ? HANDSHAKE_PROFILE : CODE_PROFILE);
  need(JSON.stringify(t.acceptCodeSkills) === JSON.stringify(CODE_SKILLS) && JSON.stringify(t.acceptCodeHandshakeSkills) === JSON.stringify(HANDSHAKE_SKILLS)
    && (scenario !== "trio" || JSON.stringify(t.acceptReadSkills) === JSON.stringify(READ_SKILLS))
    && (t.sessions ?? []).every((session) => session.profile === expectedProfile(session.workspace)), "workerSkills");
  need(t.structuralLeaks === 0, "structuralLeaks");
  need(t.tokenInControllerPrompts === false && t.tokenInControllerTask === false && t.controllerTranscriptHasToken === false, "tokenExposed");
  need(t.privateMarkersInWorkerPrompts === false && t.controllerTouchedPrivate === false, "privateAccess");
  need((t.sessionsStarted ?? 0) >= 2 && (t.sessions ?? []).every((session) => session.closed), "sessionsNotClosed");
  const state = (name) => t.sessions?.find((session) => session.workspace === `${prefix}-${name}`)?.turns?.[0];
  if (scenario === "parallel") {
    need(state("slug") === "completed" && state("stats") === "completed", "firstTurnsNotCompleted");
    need(t.firstTurnsOverlap === true, "noOverlap");
    need(t.followUpCompleted === true, "followUpNotCompleted");
  } else if (scenario === "trio") {
    // Association: exactly the three expected sessions, each on its workspace alias with the expected profile.
    const sessions = t.sessions ?? [];
    need(t.sessionsStarted === 3 && sessions.length === 3, "sessionsNotStarted");
    need(SCENARIOS.trio.tasks.every((name) => sessions.filter((session) => session.workspace === `${prefix}-${name}` && session.profile === expectedProfile(session.workspace)).length === 1) && sessions.length === 3, "sessionAssociation");
    need(state("slug") === "completed" && state("review") === "completed", "firstTurnsNotCompleted");
    need(t.firstTurnsOverlap === true, "noOverlap");
    need(t.abortedTurn === true && t.abortOk === true, "abortFailed");
    need(t.offTargetAborts === 0, "offTargetAbort");
    need(t.abortedBeforeClose === true && t.abortBeforeAbortedSeen === true, "abortOrder");
    need(t.abortWhileNeighborsRunning === true, "neighborsNotRunningDuringAbort");
  } else {
    need(t.abortedTurn === true && t.abortOk === true, "abortFailed");
    need(t.offTargetAborts === 0, "offTargetAbort");
    need(t.abortedBeforeClose === true && t.abortBeforeAbortedSeen === true, "abortOrder");
    need(t.neighborCompleted === true && t.abortWhileNeighborRunning === true, "neighborNotRunningDuringAbort");
  }
  for (const [task, check] of Object.entries(result.oracle ?? {})) {
    need(check.onlyAllowedChanges === true, `${task}:changes`);
    need(check.changesWrittenDuringWorkerTurns === true, `${task}:attribution`);
    if (task !== "wait" && task !== "review") need(check.testsPass === true && check.businessChecks === true, `${task}:tests`);
    if (task === "review") need(check.readOnlyInvariant === true, "review:readOnly");
    if (task === "slug" && scenario === "parallel") need(check.addedTest === true && check.handshake === true && check.handshakeWrittenDuringFollowUp === true, "slug:followUp");
    if (task === "wait") need(check.lateFileAbsent === true, "wait:lateFile");
  }
  need(Object.keys(result.oracle ?? {}).length === SCENARIOS[scenario].tasks.length, "oracleMissing");
  return { passed: failures.length === 0, failures };
}

const roleCounts = (list) => list.reduce((acc, p) => ({ ...acc, [p.role]: (acc[p.role] ?? 0) + 1 }), {});

/** Launches the controller under supervision and returns the sanitized result; the original result is written once. */
export async function runClient(values, { signals = process, budgets = {}, exit = (code) => process.exit(code), home = homedir(), etcCodexSkills = ETC_CODEX_SKILLS, ancestorBoundary, boundLimit } = {}) {
  if (!values.run || !CLIENTS[values.client] || !SCENARIOS[values.scenario]) fail("run needs --run, --client claude|codex and --scenario parallel|abort|trio");
  if (process.platform !== "linux") fail("run reads /proc and supports Linux only");
  const timeoutMs = Math.round(parseTimeoutMinutes(values["timeout-min"]) * 60_000);
  validateBudgets({ ...budgets, timeoutMs });
  const run = realpathSync(resolve(values.run));
  const priv = join(run, "private");
  const info = readJson(join(priv, "run.json"));
  const controller = join(run, `controller-${values.client}`);
  const label = `${values.client}-${values.scenario}`;
  sameHarness(info);
  if (typeof info.agentDir !== "string" || typeof info.codexHome !== "string") fail("the run has no recorded agent directory or CODEX_HOME; prepare a new run");
  if (existsSync(join(priv, "results", `${label}.json`)) || existsSync(join(priv, "launches", `${label}.json`))) fail("this client and scenario already ran; prepare a new run for a new attempt");
  const baselineOf = baselineReader(priv, values.client);
  // Codex's precedence between its other skill sources and the run's repository skill is not established, so a differing
  // copy in any of them refuses the run instead of leaving open which skill the controller read. An equal copy or none is fine.
  const context = { home, etcCodexSkills, ancestorBoundary, boundLimit };
  if (values.client === "codex") {
    const differing = differingCodexControllerSkills(run, info.candidate, { ...context, codexHome: info.codexHome });
    if (differing.length > 0) fail(`a pi-session-orchestration skill in a Codex skill source (${differing.join(", ")}) differs from the candidate's; Codex could read it instead, so this run is refused`);
  }
  // Everything bound at prepare must be unchanged before the controller starts; the fixtures must still be pristine.
  const prepared = resourceReport(run, info, context);
  if (prepared.unbound.length > 0) fail(`resourcesUnbound: ${JSON.stringify(prepared.unbound)}`);
  if (prepared.changed.length > 0) fail(`resourcesChanged: ${JSON.stringify(prepared.changed)}`);
  const dirtyFixtures = SCENARIOS[values.scenario].tasks.filter((task) => {
    const comparison = compareToBaseline(join(controller, "fixtures", task), baselineOf(task), []);
    return !comparison.ok || comparison.changed.size > 0;
  });
  if (dirtyFixtures.length > 0) fail(`fixturesChanged: ${JSON.stringify(dirtyFixtures)}`);
  const before = snapshot(-1, run, info).filter((p) => p.role === "server");
  if (before.length > 0) fail("a server of this run is already running");
  const { file, args } = command(values.client, info, priv, controller, values);
  const transcript = join(priv, "transcripts", `${label}.jsonl`);
  // A launch is on record before the controller starts, so an attempt that ends without a result is never repeated silently.
  mkdirSync(join(priv, "launches"), { recursive: true, mode: 0o700 });
  writeJsonOnce(join(priv, "launches", `${label}.json`), { launchedAt: new Date().toISOString() });
  const supervised = await superviseProcess({
    file, args, cwd: controller, budgets: { ...budgets, timeoutMs }, signals,
    scan: (rootPid, rootStart) => snapshot(rootPid, run, info, rootStart),
    // The Codex controller runs with exactly the CODEX_HOME that prepare recorded, whatever the launching environment holds.
    ...(values.client === "codex" ? { env: { ...process.env, CODEX_HOME: info.codexHome } } : {}),
  });
  const { seen } = supervised;
  const durationSeconds = Math.round(supervised.elapsedMs / 1000);
  const resultPath = join(priv, "results", `${label}.json`);
  let residual = [];
  /** The result of an analysis that did not finish: on record, and it never passes. */
  const unfinished = (signal) => {
    const result = {
      client: values.client, scenario: values.scenario, exitCode: supervised.exitCode,
      timedOut: supervised.timedOut, spawnFailed: supervised.spawnFailed, harnessAborted: supervised.harnessAborted || signal !== undefined,
      durationSeconds, stderrBytes: supervised.stderrBytes, analysisFailed: true,
    };
    // The first signal that ended the run stays the recorded one.
    if (supervised.abortSignal ?? signal) result.abortSignal = supervised.abortSignal ?? signal;
    if (supervised.unterminated) result.unterminated = true;
    if (supervised.drainDestroyed) result.drainDestroyed = true;
    const failures = Object.entries({ timedOut: result.timedOut, spawnFailed: result.spawnFailed, harnessAborted: result.harnessAborted }).filter(([, set]) => set).map(([code]) => code);
    result.acceptance = { passed: false, failures: [...failures, "analysisFailed"] };
    return result;
  };
  // superviseProcess has removed its signal listeners. A signal during the analysis would otherwise end the
  // harness without a result and without cleanup, and the launch record would then block a new attempt.
  let interrupted;
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = unfinished(signal);
    try { writeJsonOnce(resultPath, interrupted); }
    finally { killRecorded([...seen.values(), ...residual]); exit(1); }
  };
  const onInt = () => onSignal("SIGINT"); const onTerm = () => onSignal("SIGTERM");
  signals.on("SIGINT", onInt); signals.on("SIGTERM", onTerm);
  try {
    let result;
    try {
      result = await analyzeRun({ values, info, run, priv, controller, label, baselineOf, supervised, durationSeconds, transcript, context, residual: (list) => { residual = list; } });
    } catch {
      // A crash of the analysis still leaves a result on record, and it never passes.
      result = unfinished();
    }
    // Only reachable when `exit` returns, as in the tests: the interrupted result is already on record.
    if (interrupted) return interrupted;
    try { writeJsonOnce(resultPath, result); }
    // Leftovers are on record now; do not leave this run's own processes behind, also when the analysis failed.
    finally { killRecorded([...seen.values(), ...residual]); }
    return result;
  } finally {
    signals.off("SIGINT", onInt); signals.off("SIGTERM", onTerm);
  }
}

/** Everything after the supervised controller: transcript, residual processes, transcript analysis, oracles and verdict. */
async function analyzeRun({ values, info, run, priv, controller, label, baselineOf, supervised, durationSeconds, transcript, context, residual: reportResidual }) {
  const { seen } = supervised;
  writeFileSync(transcript, supervised.output, { mode: 0o600 });
  // Cleanup: every process this run started must be gone, matched by PID and start time.
  let residual = [];
  // The server may take up to 15 s for its bounded process shutdown.
  for (let waited = 0; waited <= 17_000 && !supervised.spawnFailed; waited += 500) {
    residual = [...seen.values()].filter(alive).concat(snapshot(-1, run, info).filter((p) => !seen.has(`${p.pid}:${p.start}`)));
    reportResidual(residual);
    if (residual.length === 0) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  const rawText = supervised.output.toString("utf8");
  const calls = toolCalls(values.client, rawText.split("\n"));
  const observed = [...seen.values()];
  const result = {
    client: values.client, scenario: values.scenario, exitCode: supervised.exitCode,
    timedOut: supervised.timedOut, spawnFailed: supervised.spawnFailed, harnessAborted: supervised.harnessAborted,
    durationSeconds, stderrBytes: supervised.stderrBytes,
    processes: {
      observedByRole: roleCounts(observed),
      serversObserved: observed.filter((p) => p.role === "server").length,
      workerSleepObserved: observed.some((p) => p.comm === "sleep" && p.fixture === "wait"),
      residualByRole: roleCounts(residual),
      residualCommands: [...new Set(residual.map((p) => p.comm))],
    },
    transcript: analyze(values.client, values.scenario, calls, info, rawText),
  };
  if (supervised.abortSignal) result.abortSignal = supervised.abortSignal;
  if (supervised.unterminated) result.unterminated = true;
  if (supervised.drainDestroyed) result.drainDestroyed = true;
  result.oracle = oracle(controller, values.scenario, info, result.transcript.turnIntervals, baselineOf);
  delete result.transcript.turnIntervals;
  // Recheck after the controller finished: a change since prepare must never be accepted.
  const after = resourceReport(run, info, context);
  result.resources = { changedBeforeLaunch: [], changedAfterRun: after.changed };
  result.unboundResources = after.unbound;
  result.endState = endStateOf(run, info, values.client, values.scenario, context);
  result.acceptance = evaluateAcceptance(result, values.scenario);
  return result;
}

/**
 * Recomputes the transcript analysis and the oracles of a finished run without touching the original result: the
 * outcome goes to a separate file. A reanalysis whose fixtures or bound resources differ from the state recorded
 * at the end of the original run is marked and cannot pass.
 */
export function reanalyze(values, context = {}) {
  if (!values.run || !CLIENTS[values.client] || !SCENARIOS[values.scenario]) fail("reanalyze needs --run, --client and --scenario");
  const run = realpathSync(resolve(values.run));
  const priv = join(run, "private");
  const info = readJson(join(priv, "run.json"));
  sameHarness(info);
  const label = `${values.client}-${values.scenario}`;
  const stored = readJson(join(priv, "results", `${label}.json`));
  const rawText = readFileSync(join(priv, "transcripts", `${label}.jsonl`), "utf8");
  const calls = toolCalls(values.client, rawText.split("\n"));
  const transcript = analyze(values.client, values.scenario, calls, info, rawText);
  const stateChanges = endStateChanges(stored.endState, endStateOf(run, info, values.client, values.scenario, context));
  const report = resourceReport(run, info, context);
  const result = {
    ...stored, transcript,
    oracle: oracle(join(run, `controller-${values.client}`), values.scenario, info, transcript.turnIntervals, baselineReader(priv, values.client)),
    resources: { changedBeforeLaunch: stored.resources?.changedBeforeLaunch ?? [], changedAfterRun: report.changed },
    unboundResources: report.unbound,
    reanalysis: { of: label, stateChanges, analyzedAt: new Date().toISOString() },
  };
  delete transcript.turnIntervals;
  delete result.endState;
  result.acceptance = evaluateAcceptance(result, values.scenario);
  mkdirSync(join(priv, "reanalyses"), { recursive: true, mode: 0o700 });
  // A new file per reanalysis; `wx` never replaces an earlier one.
  for (let n = 1; ; n += 1) {
    try { writeJsonOnce(join(priv, "reanalyses", `${label}-${String(n).padStart(3, "0")}.json`), result); break; }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  return result;
}

/** The sanitized record: original results first, reanalyses listed separately, and every launch with whether it left a result. */
export function evidence(values) {
  if (!values.run || !values.out) fail("evidence needs --run and --out");
  const priv = join(resolve(values.run), "private");
  const info = readJson(join(priv, "run.json"));
  const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => ({ name, value: readJson(join(dir, name)) })) : []);
  const text = JSON.stringify({
    runId: info.runId, date: info.preparedAt.slice(0, 10), platform: `${process.platform}-${process.arch}`, node: process.versions.node,
    sourceCommit: info.sourceCommit, sourceClean: info.sourceClean, version: info.version, entrySha256: info.entrySha256, distSha256: info.distSha256, harnessSha256: info.harnessSha256,
    configFingerprint: info.configFingerprint, claudeSkillSetup: info.claudeSkillSetup, controllerSkills: info.controllerSkills, profiles: ["accept-read", CODE_PROFILE, HANDSHAKE_PROFILE], derivedFrom: { provider: info.profile.provider, model: info.profile.model, thinkingLevel: info.profile.thinkingLevel },
    extensions: info.extensions ?? [], resources: info.resources,
    results: list(join(priv, "results")).map(({ value }) => value),
    reanalyses: list(join(priv, "reanalyses")).map(({ name, value }) => ({ file: name.replace(/\.json$/, ""), ...value })),
    // A launch without a result (a killed harness, an out-of-memory end) stays visible in the published record.
    launches: list(join(priv, "launches")).map(({ name, value }) => ({ label: name.replace(/\.json$/, ""), launchedAt: value.launchedAt, hasResult: existsSync(join(priv, "results", name)) })),
  }, null, 2);
  for (const marker of [homedir(), info.token, info.candidate, info.agentDir, info.codexHome, resolve(values.run)].filter(Boolean)) if (text.includes(marker)) fail("refusing to write evidence that contains a local path or the token", 1);
  writeFileSync(resolve(values.out), `${text}\n`);
}

const OPTIONS = {
  candidate: { type: "string" }, "base-config": { type: "string" }, "from-profile": { type: "string" }, "work-dir": { type: "string" }, "with-extensions": { type: "boolean" },
  run: { type: "string" }, client: { type: "string" }, scenario: { type: "string" }, "timeout-min": { type: "string" }, "codex-model": { type: "string" }, out: { type: "string" },
};
/** The CLI entry. `context` (tests only) injects what the subcommands read from the operator's machine. */
export async function main(argv, context = {}) {
  const [subcommand, ...rest] = argv;
  let values;
  try { ({ values } = parseArgs({ args: rest, options: OPTIONS })); } catch (error) { fail(error.message); }
  if (subcommand === "prepare") prepare(values, context);
  else if (subcommand === "run") {
    const result = await runClient(values, context);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    // A run that ended through the supervisor's own timeout, spawn failure or abort is not a clean finish.
    if (result.timedOut || result.spawnFailed || result.harnessAborted || result.analysisFailed) process.exitCode = 1;
  } else if (subcommand === "reanalyze") process.stdout.write(`${JSON.stringify(reanalyze(values, context), null, 2)}\n`);
  else if (subcommand === "evidence") evidence(values);
  else fail("usage: multi-session-acceptance.mjs prepare|run|reanalyze|evidence ...");
}
const entryPath = process.argv[1] === undefined ? undefined : readSafe(() => realpathSync(process.argv[1]));
if (entryPath && entryPath === readSafe(() => realpathSync(fileURLToPath(import.meta.url)))) {
  try { await main(process.argv.slice(2)); } catch (error) {
    if (!(error instanceof HarnessFailure)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code;
  }
}
