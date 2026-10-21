import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseArgs } from "../eval/extensions/cli.js";
import { assertDependencyDir, checkDependencies } from "../eval/extensions/dependencies.js";
import { buildMatrix, PAIRINGS } from "../eval/extensions/matrix.js";
import { changedPaths, scoreImplementation } from "../eval/extensions/oracles.js";
import { bwrapArgs, planSandbox, sandboxed, type SandboxBind, type SandboxPlan } from "../eval/extensions/sandbox.js";
import { taskSpecSchema, type TaskSpec } from "../eval/extensions/schemas.js";
import { BUILD_ROOT, spawnTracedRunOne, tracedCommand } from "../eval/extensions/supervise.js";
import { assertDepsDirOutsideSources, resolveTool } from "../eval/extensions/tools.js";
import { privateRunDir, prepareRunScope, scopeRoot, type RunScope } from "../eval/extensions/workspace.js";
import { bubblewrapWorks, which } from "./real-host.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const exec = promisify(execFile);
afterAll(removeTemporaryRoots);

const TOOLS = { strace: "/opt/tools/bin/strace", prlimit: "/opt/tools/bin/prlimit", git: "/opt/tools/bin/git", codegraph: "/opt/tools/bin/codegraph", bwrap: "/opt/tools/bin/bwrap" };
const PROFILE = { provider: "openai", model: "model-a", thinkingLevel: "high", permissionProfile: "coding", default: false, skills: [] as string[] };
const DEPENDENCY = { path: "backend/.venv", lockfile: "backend/uv.lock" };

const baseTask = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "impl-1", kind: "implementation", repo: "repo", baseCommit: "a".repeat(40), promptRef: "eval/results/x/p.txt", promptHash: `sha256:${"b".repeat(64)}`, sourceSession: "s",
  allowedPaths: ["a.txt"], scopeIgnore: [], oracle: { kind: "implementation", command: ["true"], timeoutMs: 1000 }, ...over,
});

describe("task dependencies in the task schema (R68)", () => {
  const parse = (dependencies: unknown) => taskSpecSchema.safeParse(baseTask({ dependencies }));

  it("accepts none, one to four distinct directories and their lockfiles", () => {
    expect(taskSpecSchema.safeParse(baseTask()).success).toBe(true);
    expect(parse([DEPENDENCY]).success).toBe(true);
    expect(parse([DEPENDENCY, { path: "frontend/node_modules", lockfile: "frontend/package-lock.json" }, { path: "node_modules", lockfile: "package-lock.json" }, { path: "tools/.venv2", lockfile: "tools/uv.lock" }]).success).toBe(true);
    // The same lockfile may serve two directories, and a sibling with a common prefix is not a nested path.
    expect(parse([{ path: "a/.venv", lockfile: "uv.lock" }, { path: "a/.venv2", lockfile: "uv.lock" }]).success).toBe(true);
  });

  it.each([
    ["five entries", Array.from({ length: 5 }, (_, i) => ({ path: `d${i}`, lockfile: "uv.lock" }))],
    ["an unknown key", [{ ...DEPENDENCY, extra: 1 }]],
    ["a missing lockfile", [{ path: "backend/.venv" }]],
    ["a trailing slash", [{ path: "backend/.venv/", lockfile: "backend/uv.lock" }]],
    ["an absolute path", [{ path: "/backend/.venv", lockfile: "backend/uv.lock" }]],
    ["a parent segment", [{ path: "backend/../.venv", lockfile: "backend/uv.lock" }]],
    ["the git directory", [{ path: ".git", lockfile: "backend/uv.lock" }]],
    ["a path below the git directory", [{ path: ".git/hooks", lockfile: "backend/uv.lock" }]],
    ["a nested git directory", [{ path: "vendor/.git", lockfile: "backend/uv.lock" }]],
    ["a glob character", [{ path: "backend/*", lockfile: "backend/uv.lock" }]],
    ["a bracket", [{ path: "backend/[a]", lockfile: "backend/uv.lock" }]],
    ["a brace", [{ path: "backend/{a,b}", lockfile: "backend/uv.lock" }]],
    ["a parent segment in the lockfile", [{ path: "backend/.venv", lockfile: "../uv.lock" }]],
    ["an absolute lockfile", [{ path: "backend/.venv", lockfile: "/uv.lock" }]],
    ["a duplicate path", [DEPENDENCY, { path: "backend/.venv", lockfile: "other.lock" }]],
    ["a path below another dependency", [DEPENDENCY, { path: "backend/.venv/lib", lockfile: "backend/uv.lock" }]],
    ["a path above another dependency", [{ path: "backend/.venv/lib", lockfile: "backend/uv.lock" }, DEPENDENCY]],
  ])("refuses %s", (_name, dependencies) => {
    expect(parse(dependencies).success).toBe(false);
  });
});

describe("allowedPaths entries (R77)", () => {
  const parse = (allowedPaths: unknown) => taskSpecSchema.safeParse(baseTask({ allowedPaths }));

  it("accepts files and directory prefixes with a trailing slash", () => {
    expect(parse([]).success).toBe(true);
    expect(parse(["a.txt", "src/config.ts"]).success).toBe(true);
    expect(parse(["backend/tests/", "src/a.ts", "docs/"]).success).toBe(true);
  });

  it.each([["an absolute prefix", "/abs/"], ["an absolute file", "/abs.txt"], ["a parent segment in a prefix", "a/../b/"], ["a parent segment in a file", "a/../b.txt"],
    ["a glob in a prefix", "src/*/"], ["a brace in a prefix", "src/{a,b}/"], ["an empty entry", ""], ["a backslash", "a\\b.txt"]])("refuses %s", (_name, entry) => {
    expect(parse([entry]).success).toBe(false);
  });

  it("parses the pre-registered tasks file", () => {
    const tasks = JSON.parse(readFileSync(fileURLToPath(new URL("../docs/evaluation/extension-ablation-2026-10-20/tasks.json", import.meta.url)), "utf8")) as { id: string; oracle: { kind: string; verdict?: unknown } }[];
    // Every review oracle carries a verdict pattern (R78); the file is parsed as committed.
    expect(tasks.filter((task) => task.oracle.kind === "review" && task.oracle.verdict === undefined).map((task) => task.id)).toEqual([]);
    expect(tasks.some((task) => task.oracle.kind === "review")).toBe(true);
    const parsed = z.array(taskSpecSchema).min(1).safeParse(tasks);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)).toEqual([]);
  });
});

describe("the dependency binds in the sandbox argv (R68)", () => {
  const plan: SandboxPlan = {
    rootLinks: [], rootReadOnly: [], etcReadOnly: [], runReadOnly: [], home: "/home/op", homeReadOnly: ["/home/op/repo/node_modules"], homeLinks: [], extraReadOnly: ["/tmp/build"],
  };
  const binds: SandboxBind[] = [
    { source: "/home/op/deps/impl-1/mounts/backend/.venv", target: "/tmp/w/scopes/r/clone/backend/.venv" },
    { source: "/home/op/deps/impl-1/runtime", target: "/home/op/deps/impl-1/runtime" },
  ];
  const triple = (args: string[], flag: string, source: string, target: string): number => args.findIndex((arg, i) => arg === flag && args[i + 1] === source && args[i + 2] === target);

  it("binds each mount at its place in the clone and the runtime at its own path, read-only, after the scope and oracle-home binds", () => {
    const args = bwrapArgs("/tmp/w/scopes/r", plan, ["/tmp/w/private/r/oracle-home"], binds);
    const scope = triple(args, "--bind", "/tmp/w/scopes/r", "/tmp/w/scopes/r");
    const oracleHome = triple(args, "--bind", "/tmp/w/private/r/oracle-home", "/tmp/w/private/r/oracle-home");
    const mount = triple(args, "--ro-bind", binds[0]!.source, binds[0]!.target);
    const runtime = triple(args, "--ro-bind", binds[1]!.source, binds[1]!.target);
    expect(scope).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(oracleHome);
    expect(oracleHome).toBeGreaterThan(scope);
    expect(runtime).toBeGreaterThan(mount);
    // After the home tmpfs and every other read-only bind, before the final remounts.
    expect(mount).toBeGreaterThan(args.indexOf("/home/op/repo/node_modules"));
    expect(mount).toBeGreaterThan(triple(args, "--ro-bind", "/tmp/build", "/tmp/build"));
    expect(runtime).toBeLessThan(args.findIndex((arg, i) => arg === "--remount-ro" && args[i + 1] === "/home/op"));
    // Nothing else of the deps directory is bound; writable binds stay the scope and the oracle home.
    expect(args.filter((arg) => arg.startsWith("/home/op/deps"))).toEqual([binds[0]!.source, binds[1]!.source, binds[1]!.target]);
    expect(args.filter((arg) => arg === "--bind")).toHaveLength(2);
    expect(args.at(-1)).toBe("--");
  });

  it("adds nothing without binds, and the command line of the run unit and the oracle carries them", () => {
    expect(bwrapArgs("/s", plan)).toEqual(bwrapArgs("/s", plan, [], []));
    expect(bwrapArgs("/s", plan).filter((arg) => arg === "--ro-bind")).toHaveLength(3); // /usr, the node_modules and the build
    const oracle = sandboxed(TOOLS, plan, "/tmp/w/scopes/r", ["env", "-C", "backend", ".venv/bin/python", "-m", "pytest"], ["/tmp/w/private/r/oracle-home"], binds);
    expect(triple(oracle, "--ro-bind", binds[0]!.source, binds[0]!.target)).toBeGreaterThan(-1);
    expect(oracle.slice(-6)).toEqual(["env", "-C", "backend", ".venv/bin/python", "-m", "pytest"]);
    const run = tracedCommand(TOOLS, plan, "/tmp/w/scopes/r", "/tmp/w/private/r/strace.log", "/tmp/w/scopes/r/run-input.json", { binds });
    expect(triple(run.args, "--ro-bind", binds[0]!.source, binds[0]!.target)).toBeGreaterThan(-1);
    expect(triple(run.args, "--ro-bind", binds[1]!.source, binds[1]!.target)).toBeGreaterThan(triple(run.args, "--bind", "/tmp/w/scopes/r", "/tmp/w/scopes/r"));
    expect(tracedCommand(TOOLS, plan, "/tmp/w/scopes/r", "/l", "/i").args).toEqual(tracedCommand(TOOLS, plan, "/tmp/w/scopes/r", "/l", "/i", { binds: [] }).args);
  });

  it("spawns the traced run unit with the scope's binds", async () => {
    const root = await temporaryRoot("ablation-deps-spawn-");
    // A stand-in `prlimit` that writes its arguments instead of starting anything.
    const prlimit = join(root, "prlimit");
    await writeFile(prlimit, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "argv")}"\n`);
    await chmod(prlimit, 0o755);
    const scope = { root, env: {}, dependencyBinds: binds } as unknown as RunScope;
    const child = spawnTracedRunOne({ ...TOOLS, prlimit }, plan, scope, join(root, "run-input.json"), join(root, "strace.log"));
    await new Promise((resolve) => child.once("exit", resolve));
    const argv = readFileSync(join(root, "argv"), "utf8").split("\n");
    expect(triple(argv, "--ro-bind", binds[0]!.source, binds[0]!.target)).toBeGreaterThan(-1);
    expect(triple(argv, "--ro-bind", binds[1]!.source, binds[1]!.target)).toBeGreaterThan(triple(argv, "--ro-bind", binds[0]!.source, binds[0]!.target));
  });
});

describe("the deps directory (R68)", () => {
  it("is refused inside a source or the wave directory, or above one, with a fixed code", async () => {
    const root = await temporaryRoot("ablation-deps-dir-");
    await mkdir(join(root, "repo"), { recursive: true });
    await expect(assertDepsDirOutsideSources(join(root, "deps"), [join(root, "repo"), join(root, "wave")])).resolves.toBeUndefined();
    await expect(assertDepsDirOutsideSources(join(root, "repo", "deps"), [join(root, "repo")])).rejects.toThrow("deps_dir_in_source");
    await expect(assertDepsDirOutsideSources(root, [join(root, "repo")])).rejects.toThrow("deps_dir_in_source");
    await expect(assertDepsDirOutsideSources(join(root, "wave", "deps"), [join(root, "wave")])).rejects.toThrow("deps_dir_in_source");
    await symlink(join(root, "repo"), join(root, "link"));
    await expect(assertDepsDirOutsideSources(join(root, "link", "deps"), [join(root, "repo")])).rejects.toThrow("deps_dir_in_source");
  });

  it("is an option of --wave and --dry-load only", () => {
    const live = ["--approval", "a.json", "--tasks", "t.json", "--template", "x", "--out", "w", "--ledger", "l.json"];
    expect(parseArgs(["--wave", ...live, "--deps", "d"]).options["--deps"]).toBe("d");
    expect(parseArgs(["--dry-load", "--tasks", "t.json", "--template", "/tpl", "--out", "/o", "--deps", "d"]).options["--deps"]).toBe("d");
    expect(() => parseArgs(["--plan", "--tasks", "t.json", "--deps", "d"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--preflight", "--approval", "a.json", "--tasks", "t.json", "--out", "w", "--ledger", "l.json", "--deps", "d"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--report", "--wave", "w", "--ledger", "l.json", "--evidence", "e", "--deps", "d"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--scan", "--transcripts", "t", "--out", "o", "--deps", "d"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--wave", ...live, "--deps", "d", "--deps", "e"])).toThrow("invalid_argument");
  });
});

/** A source repository: a base commit, and after it a commit on another branch and a tag that change `a.txt` to the "solution". */
async function sourceWithFuture(root: string) {
  const source = join(root, "source");
  await mkdir(join(source, "backend"), { recursive: true });
  const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
  await git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(source, "a.txt"), "base\n");
  await writeFile(join(source, "backend", "uv.lock"), "lock-v1\n");
  await git("add", "."); await git("commit", "--quiet", "-m", "base");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("checkout", "--quiet", "-b", "dev");
  await writeFile(join(source, "a.txt"), "solution\n");
  await git("commit", "--quiet", "-am", "solution");
  const later = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("tag", "solution-tag");
  return { source, base, later, git };
}

async function standIn(root: string): Promise<Pick<typeof TOOLS, "git" | "codegraph">> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "codegraph"), "#!/bin/sh\nmkdir -p \"$3/.codegraph\"\n");
  await chmod(join(bin, "codegraph"), 0o755);
  return { git: await resolveTool("git", process.env.PATH ?? ""), codegraph: join(bin, "codegraph") };
}

const taskAt = (base: string, over: Record<string, unknown> = {}): TaskSpec => taskSpecSchema.parse(baseTask({ baseCommit: base, promptRef: "eval/results/x/p.txt", ...over }));
const arm = (task: TaskSpec) => buildMatrix([task], PAIRINGS.filter((p) => p.id === "pl-code")).find((run) => run.arm === "A")!;

async function scopeFor(root: string, source: string, task: TaskSpec, depsDir?: string): Promise<RunScope> {
  return prepareRunScope({
    waveDir: join(root, "wave"), run: arm(task), task, sourceRepoPath: source, extensionTemplate: join(root, "template"), hostAuth: { openai: { type: "api_key", key: "k" } },
    productionProfile: PROFILE, tools: await standIn(root), ...(depsDir === undefined ? {} : { depsDir }),
  });
}

describe("the worker clone holds only history reachable from the base commit (R69)", () => {
  it("has neither the later commit, nor a branch, nor a tag, nor any ref, while the pristine bare clone keeps everything", async () => {
    const root = await temporaryRoot("ablation-history-");
    const { source, base, later } = await sourceWithFuture(root);
    const scope = await scopeFor(root, source, taskAt(base));
    const clone = (...args: string[]) => exec("git", ["-C", scope.clone, ...args]);
    expect((await clone("rev-parse", "HEAD")).stdout.trim()).toBe(base);
    expect(await readFile(join(scope.clone, "a.txt"), "utf8")).toBe("base\n");
    await expect(clone("cat-file", "-e", `${later}^{commit}`)).rejects.toThrow();
    const objects = (await clone("cat-file", "--batch-all-objects", "--batch-check")).stdout;
    expect(objects).not.toContain(later);
    expect((await clone("log", "--all", "--format=%H")).stdout.trim().split("\n")).toEqual([base]);
    expect((await clone("for-each-ref")).stdout).toBe("");
    expect((await clone("tag", "-l")).stdout.trim()).toBe("");
    await expect(clone("rev-parse", "--verify", "--quiet", "solution-tag")).rejects.toThrow();
    await expect(clone("rev-parse", "--verify", "--quiet", "dev")).rejects.toThrow();
    await expect(clone("rev-parse", "--verify", "--quiet", "origin/dev")).rejects.toThrow();
    await expect(clone("show", "dev:a.txt")).rejects.toThrow();
    // The history is cut by git itself: nothing of the later commit is in the clone's object directory, packed or loose.
    expect((await clone("rev-list", "--all", "--objects")).stdout).not.toContain(later);
    // origin still points at the pristine bare clone, which has the full history and no trace of the temporary branch.
    expect((await clone("remote", "get-url", "origin")).stdout.trim()).toBe(scope.baseGitDir);
    const bare = (...args: string[]) => exec("git", ["--git-dir", scope.baseGitDir, ...args]);
    await expect(bare("cat-file", "-e", `${later}^{commit}`)).resolves.toBeDefined();
    const refs = (await bare("for-each-ref", "--format=%(refname)")).stdout.trim().split("\n").sort();
    expect(refs).toEqual(["refs/heads/dev", "refs/heads/main", "refs/tags/solution-tag"]);
  });

  it("never overwrites a source branch, whatever it is called", async () => {
    const root = await temporaryRoot("ablation-history-name-");
    const { source, base, later, git } = await sourceWithFuture(root);
    await git("branch", "eval-base", later);
    const scope = await scopeFor(root, source, taskAt(base));
    expect((await exec("git", ["--git-dir", scope.baseGitDir, "rev-parse", "refs/heads/eval-base"])).stdout.trim()).toBe(later);
    expect((await exec("git", ["-C", scope.clone, "for-each-ref"])).stdout).toBe("");
    expect((await exec("git", ["-C", scope.clone, "rev-parse", "HEAD"])).stdout.trim()).toBe(base);
  });

  it("lets the oracle reach a later commit through the pristine bare clone, e.g. to check out the solution in a setup step", async () => {
    const root = await temporaryRoot("ablation-history-oracle-");
    const { source, base, later } = await sourceWithFuture(root);
    const task = taskAt(base);
    const scope = await scopeFor(root, source, task);
    const score = await scoreImplementation(scope.clone, {
      allowedPaths: ["a.txt"], scopeIgnore: [], baseCommit: base,
      oracle: { kind: "implementation", setup: [["git", "checkout", later, "--", "a.txt"]], command: ["grep", "-q", "^solution$", "a.txt"], timeoutMs: 30_000 },
    }, { gitDir: scope.baseGitDir, home: join(root, "oracle-home") });
    expect(score).toEqual({ accepted: true, testsPassed: true, outOfScope: [] });
    // Without the setup step the base file does not pass (a fresh clone: the worktree above now holds the solution).
    const fresh = await scopeFor(await temporaryRoot("ablation-history-plain-"), source, task);
    const plain = await scoreImplementation(fresh.clone, { allowedPaths: ["a.txt"], scopeIgnore: [], baseCommit: base, oracle: { kind: "implementation", command: ["grep", "-q", "^solution$", "a.txt"], timeoutMs: 30_000 } }, { gitDir: fresh.baseGitDir });
    expect(plain.testsPassed).toBe(false);
  });
});

describe("preparing the dependencies of a task (R68)", () => {
  /** `<deps>/<taskId>` for the layout of the requirement: mounts, lock copy and runtime. */
  async function depsFor(root: string, taskId = "impl-1", lock = "lock-v1\n"): Promise<{ deps: string; taskDir: string }> {
    const deps = join(root, "deps");
    const taskDir = join(deps, taskId);
    await mkdir(join(taskDir, "mounts", "backend", ".venv", "bin"), { recursive: true });
    await writeFile(join(taskDir, "mounts", "backend", ".venv", "pyvenv.cfg"), "home = runtime\n");
    await mkdir(join(taskDir, "lock", "backend"), { recursive: true });
    await writeFile(join(taskDir, "lock", "backend", "uv.lock"), lock);
    await mkdir(join(taskDir, "runtime", "py"), { recursive: true });
    await writeFile(join(taskDir, "runtime", "py", "python3"), "interpreter");
    return { deps, taskDir };
  }
  const withDeps = (base: string) => taskAt(base, { dependencies: [DEPENDENCY] });

  it("creates the mount point as an empty directory, returns the read-only binds and leaves the scope check clean", async () => {
    const root = await temporaryRoot("ablation-deps-ok-");
    const { source, base } = await sourceWithFuture(root);
    const { deps, taskDir } = await depsFor(root);
    const task = withDeps(base);
    const scope = await scopeFor(root, source, task, deps);
    expect(scope.dependencyBinds).toEqual([
      { source: await realpath(join(taskDir, "mounts", "backend", ".venv")), target: join(scope.clone, "backend", ".venv") },
      { source: await realpath(join(taskDir, "runtime")), target: await realpath(join(taskDir, "runtime")) },
    ]);
    expect(await readdir(join(scope.clone, "backend", ".venv"))).toEqual([]);
    // Git does not list an empty directory: the scope check reports nothing for the mount point, before and after a run that writes elsewhere.
    expect(await changedPaths(scope.clone, { gitDir: scope.baseGitDir, commit: base }, [])).toEqual([]);
    await writeFile(join(scope.clone, "a.txt"), "changed\n");
    expect(await changedPaths(scope.clone, { gitDir: scope.baseGitDir, commit: base }, [])).toEqual(["a.txt"]);
    // Nothing of the deps directory is copied into the scope.
    expect(existsSync(join(scope.clone, "backend", ".venv", "pyvenv.cfg"))).toBe(false);
  });

  it("works without a runtime and for a mount point whose parents do not exist yet", async () => {
    const root = await temporaryRoot("ablation-deps-bare-");
    const { source, base } = await sourceWithFuture(root);
    const taskDir = join(root, "deps", "impl-1");
    await mkdir(join(taskDir, "mounts", "node_modules", "left-pad"), { recursive: true });
    await mkdir(join(taskDir, "lock", "backend"), { recursive: true });
    await writeFile(join(taskDir, "lock", "backend", "uv.lock"), "lock-v1\n");
    const task = taskAt(base, { dependencies: [{ path: "node_modules", lockfile: "backend/uv.lock" }, { path: "ui/deep/node_modules", lockfile: "backend/uv.lock" }] });
    await mkdir(join(taskDir, "mounts", "ui", "deep", "node_modules"), { recursive: true });
    const scope = await scopeFor(root, source, task, join(root, "deps"));
    expect(scope.dependencyBinds?.map((bind) => bind.target)).toEqual([join(scope.clone, "node_modules"), join(scope.clone, "ui", "deep", "node_modules")]);
    expect(await changedPaths(scope.clone, { gitDir: scope.baseGitDir, commit: base }, [])).toEqual([]);
  });

  it("leaves a task without dependencies untouched, whether or not a deps directory is given", async () => {
    const root = await temporaryRoot("ablation-deps-none-");
    const { source, base } = await sourceWithFuture(root);
    expect((await scopeFor(root, source, taskAt(base))).dependencyBinds).toBeUndefined();
    const second = await temporaryRoot("ablation-deps-none2-");
    expect((await scopeFor(second, source, taskAt(base), join(second, "deps"))).dependencyBinds).toBeUndefined();
  });

  it("refuses a task that declares dependencies when no deps directory is given", async () => {
    const root = await temporaryRoot("ablation-deps-required-");
    const { source, base } = await sourceWithFuture(root);
    await expect(scopeFor(root, source, withDeps(base))).rejects.toThrow("deps_missing");
    expect(existsSync(scopeRoot(join(root, "wave"), arm(withDeps(base)).runId))).toBe(false);
  });

  const failures: [string, string, (root: string, taskDir: string, base: string) => Promise<void>][] = [
    ["dependency_lock_mismatch", "a lock copy that differs by one byte", async (_r, taskDir) => { await writeFile(join(taskDir, "lock", "backend", "uv.lock"), "lock-v1"); }],
    ["dependency_lock_mismatch", "a lock copy of other content", async (_r, taskDir) => { await writeFile(join(taskDir, "lock", "backend", "uv.lock"), "lock-v2\n"); }],
    ["dependency_lock_mismatch", "a missing lock copy", async (_r, taskDir) => { await rm(join(taskDir, "lock"), { recursive: true }); }],
    ["dependency_lock_mismatch", "a lock copy that is a link to the right content", async (root, taskDir) => {
      await writeFile(join(root, "right.lock"), "lock-v1\n");
      await rm(join(taskDir, "lock", "backend", "uv.lock"));
      await symlink(join(root, "right.lock"), join(taskDir, "lock", "backend", "uv.lock"));
    }],
    ["dependency_lock_mismatch", "a lockfile that is not in the base tree", async (_r, taskDir) => {
      await mkdir(join(taskDir, "lock", "other"), { recursive: true });
      await writeFile(join(taskDir, "lock", "other", "x.lock"), "lock-v1\n");
    }],
    ["dependency_mount_invalid", "a task directory that is a link", async (root, taskDir) => {
      await mkdir(join(root, "elsewhere"), { recursive: true });
      await rename(taskDir, join(root, "elsewhere", "impl-1"));
      await symlink(join(root, "elsewhere", "impl-1"), taskDir);
    }],
    ["dependency_mount_invalid", "a mounts directory that is a link to a tree with a source checkout", async (root, taskDir) => {
      // The scenario of the review: `mounts -> ~/src` with a repository (and its .git) where the mount path leads.
      await mkdir(join(root, "projects", "backend", ".venv", ".git"), { recursive: true });
      await rm(join(taskDir, "mounts"), { recursive: true });
      await symlink(join(root, "projects"), join(taskDir, "mounts"));
    }],
    ["dependency_lock_mismatch", "a lock directory that is a link", async (root, taskDir) => {
      await rename(join(taskDir, "lock"), join(root, "lock-real"));
      await symlink(join(root, "lock-real"), join(taskDir, "lock"));
    }],
    ["dependency_missing", "a missing mount directory", async (_r, taskDir) => { await rm(join(taskDir, "mounts", "backend", ".venv"), { recursive: true }); }],
    ["dependency_missing", "a task directory that does not exist", async (_r, taskDir) => { await rm(taskDir, { recursive: true }); }],
    ["dependency_mount_invalid", "a mount that is a link to a real directory", async (root, taskDir) => {
      await mkdir(join(root, "elsewhere"), { recursive: true });
      await rm(join(taskDir, "mounts", "backend", ".venv"), { recursive: true });
      await symlink(join(root, "elsewhere"), join(taskDir, "mounts", "backend", ".venv"));
    }],
    ["dependency_mount_invalid", "a mount below a linked directory", async (root, taskDir) => {
      await mkdir(join(root, "elsewhere", ".venv"), { recursive: true });
      await rm(join(taskDir, "mounts", "backend"), { recursive: true });
      await symlink(join(root, "elsewhere"), join(taskDir, "mounts", "backend"));
    }],
    ["dependency_mount_invalid", "a mount that is a file", async (_r, taskDir) => {
      await rm(join(taskDir, "mounts", "backend", ".venv"), { recursive: true });
      await writeFile(join(taskDir, "mounts", "backend", ".venv"), "x");
    }],
    ["dependency_mount_invalid", "a runtime that is a link", async (root, taskDir) => {
      await mkdir(join(root, "elsewhere"), { recursive: true });
      await rm(join(taskDir, "runtime"), { recursive: true });
      await symlink(join(root, "elsewhere"), join(taskDir, "runtime"));
    }],
  ];
  it.each(failures)("refuses with %s: %s", async (code, _name, damage) => {
    const root = await temporaryRoot("ablation-deps-bad-");
    const { source, base } = await sourceWithFuture(root);
    const { deps, taskDir } = await depsFor(root);
    await damage(root, taskDir, base);
    const task = _name === "a lockfile that is not in the base tree" ? taskAt(base, { dependencies: [{ path: "backend/.venv", lockfile: "other/x.lock" }] }) : withDeps(base);
    await expect(scopeFor(root, source, task, deps)).rejects.toThrow(code);
    // A refused scope keeps nothing: neither the scope, nor the pristine clone.
    expect(existsSync(scopeRoot(join(root, "wave"), arm(task).runId))).toBe(false);
    expect(existsSync(join(privateRunDir(join(root, "wave"), arm(task).runId), "base.git"))).toBe(false);
  });

  it("refuses a deps directory that is a link or has a link on its way (deps_dir_not_canonical)", async () => {
    const root = await temporaryRoot("ablation-deps-canonical-");
    const { source, base } = await sourceWithFuture(root);
    const { deps } = await depsFor(root);
    await symlink(deps, join(root, "link-to-deps"));
    await expect(scopeFor(root, source, withDeps(base), join(root, "link-to-deps"))).rejects.toThrow("deps_dir_not_canonical");
    await mkdir(join(root, "parent"));
    await symlink(root, join(root, "parent", "up"));
    await expect(scopeFor(root, source, withDeps(base), join(root, "parent", "up", "deps"))).rejects.toThrow("deps_dir_not_canonical");
    await expect(assertDependencyDir(join(root, "link-to-deps"), [], [join(root, "elsewhere")])).rejects.toThrow("deps_dir_not_canonical");
    await expect(assertDependencyDir(deps, [], [join(root, "elsewhere")])).resolves.toBeUndefined();
    // A directory that does not exist yet is the mount check's business.
    await expect(assertDependencyDir(join(root, "not-yet"), [], [])).resolves.toBeUndefined();
  });

  it("checks every bind source against the sources, with the read-only checks alone and a single git contract", async () => {
    const root = await temporaryRoot("ablation-deps-check-");
    const { source, base } = await sourceWithFuture(root);
    const { deps, taskDir } = await depsFor(root);
    const task = withDeps(base);
    const calls: string[][] = [];
    const git = async (args: string[]) => { calls.push(args); return exec("git", ["-C", source, ...args]); };
    const checked = await checkDependencies({ depsDir: deps, task, git, sources: [source] });
    expect(checked).toEqual({ mounts: [{ path: "backend/.venv", source: join(await realpath(deps), "impl-1", "mounts", "backend", ".venv") }], runtime: join(await realpath(deps), "impl-1", "runtime") });
    // The injected function chooses the repository: no argument names one.
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).not.toContain("--git-dir");
    // Nothing is created in any clone, and a source that contains a bind source refuses.
    await expect(checkDependencies({ depsDir: deps, task, git, sources: [deps] })).rejects.toThrow("deps_dir_in_source");
    await expect(checkDependencies({ depsDir: deps, task, git, sources: [join(taskDir, "mounts", "backend")] })).rejects.toThrow("deps_dir_in_source");
    await expect(checkDependencies({ depsDir: undefined, task, git })).rejects.toThrow("deps_missing");
    await expect(checkDependencies({ depsDir: join(root, "nope"), task, git })).rejects.toThrow("dependency_missing");
  });

  it("refuses with dependency_path_tracked when the path exists in the base tree, as a file or as a directory", async () => {
    const root = await temporaryRoot("ablation-deps-tracked-");
    const { source, base, git } = await sourceWithFuture(root);
    // A new base commit that tracks `backend/.venv/keep` (the directory) and `vendor` (a file).
    await git("checkout", "--quiet", "main");
    await mkdir(join(source, "backend", ".venv"), { recursive: true });
    await writeFile(join(source, "backend", ".venv", "keep"), "x");
    await writeFile(join(source, "vendor"), "y");
    await git("add", "."); await git("commit", "--quiet", "-m", "tracked");
    const tracked = (await git("rev-parse", "HEAD")).stdout.trim();
    const { deps, taskDir } = await depsFor(root);
    await mkdir(join(taskDir, "mounts", "vendor"), { recursive: true });
    await expect(scopeFor(root, source, taskAt(tracked, { dependencies: [DEPENDENCY] }), deps)).rejects.toThrow("dependency_path_tracked");
    await expect(scopeFor(await temporaryRoot("ablation-deps-tracked2-"), source, taskAt(tracked, { dependencies: [{ path: "vendor", lockfile: "backend/uv.lock" }] }), deps)).rejects.toThrow("dependency_path_tracked");
    // At the earlier base commit the same directory is free.
    expect((await scopeFor(await temporaryRoot("ablation-deps-tracked3-"), source, withDeps(base), deps)).dependencyBinds).toHaveLength(2);
  });
});

// A real bind needs a bubblewrap that can create a user namespace (Linux); the test skips without it. The plan comes from the host, without codegraph.
describe("a real bind (R68)", () => {
  it.skipIf(!bubblewrapWorks())("shows the mount read-only at its place in the clone and the runtime at its own path, and nothing else of the deps directory", async () => {
    const bwrap = which("bwrap")!;
    const root = await temporaryRoot("ablation-deps-real-");
    const scopeDir = join(root, "scope");
    const clone = join(scopeDir, "clone");
    const deps = join(root, "deps", "impl-1");
    await mkdir(join(clone, "backend", ".venv"), { recursive: true });
    // The clone is a repository, as in a run: its base commit is what the scope check compares with.
    const git = (...args: string[]) => exec("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    await git("init", "--quiet");
    await writeFile(join(clone, "a.txt"), "base\n");
    await git("add", "a.txt"); await git("commit", "--quiet", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await mkdir(join(deps, "mounts", "backend", ".venv", "bin"), { recursive: true });
    await mkdir(join(deps, "runtime"), { recursive: true });
    await mkdir(join(deps, "lock"), { recursive: true });
    await writeFile(join(deps, "runtime", "python3"), "interpreter");
    await writeFile(join(deps, "lock", "uv.lock"), "secret lock");
    await symlink(join(deps, "runtime", "python3"), join(deps, "mounts", "backend", ".venv", "bin", "python"));
    const plan = await planSandbox({ tools: { codegraph: join(root, "no-codegraph") }, repoRoot: process.cwd(), buildRoot: BUILD_ROOT });
    const binds: SandboxBind[] = [
      { source: join(deps, "mounts", "backend", ".venv"), target: join(clone, "backend", ".venv") },
      { source: join(deps, "runtime"), target: join(deps, "runtime") },
    ];
    const script = [
      `test "$(cat '${clone}/backend/.venv/bin/python')" = interpreter`, // the venv's link resolves through the runtime at its own path
      `! (echo x > '${clone}/backend/.venv/new') 2>/dev/null`, `! (echo x > '${deps}/runtime/new') 2>/dev/null`,
      `echo ok > '${clone}/written'`, `test ! -e '${deps}/lock'`, `test ! -e '${deps}/mounts'`,
    ].join(" && ");
    await exec(bwrap, sandboxed({ bwrap }, plan, scopeDir, ["sh", "-c", script], [], binds).slice(1));
    expect(await readFile(join(clone, "written"), "utf8")).toBe("ok\n");
    expect(await readdir(join(clone, "backend", ".venv"))).toEqual([]);
    expect(existsSync(join(deps, "runtime", "new"))).toBe(false);
    // After the run the mount point is an empty directory again, and the scope check reports only what the run wrote.
    expect(await changedPaths(clone, { gitDir: join(clone, ".git"), commit: base }, [])).toEqual(["written"]);
    await rm(join(clone, "written"));
    expect(await changedPaths(clone, { gitDir: join(clone, ".git"), commit: base }, [])).toEqual([]);
  }, 60_000);
});
