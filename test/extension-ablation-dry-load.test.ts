import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parseArgs } from "../eval/extensions/cli.js";
import { DRY_MODEL, DRY_PROVIDER, dryLoad, dryLoadOutputSchema, type DryLoadDeps, type DryLoadInput, type DryLoadOutput } from "../eval/extensions/dry-load.js";
import { PAIRINGS } from "../eval/extensions/matrix.js";
import { macOf } from "../eval/extensions/output-mac.js";
import { EMPTY_PLAN } from "../eval/extensions/sandbox.js";
import type { TaskSpec } from "../eval/extensions/schemas.js";
import { assertHostSafe } from "../eval/extensions/supervise.js";
import { resolveTools, type ToolPaths } from "../eval/extensions/tools.js";
import { countIoUringSetups } from "../eval/extensions/trace.js";
import { privateRunDir, scopeRoot, type RunScope, type ScopeInput } from "../eval/extensions/workspace.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const execFileAsync = promisify(execFile);
afterAll(removeTemporaryRoots);

const FIXTURES = fileURLToPath(new URL("./fixtures/extension-ablation/", import.meta.url));
const EXTENSION_FIXTURE = fileURLToPath(new URL("./fixtures/pi-extension-fixture", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOLS: ToolPaths = { strace: "/opt/tools/bin/strace", prlimit: "/opt/tools/bin/prlimit", git: "/opt/tools/bin/git", codegraph: "/opt/tools/bin/codegraph", bwrap: "/opt/tools/bin/bwrap" };
const KEY = Buffer.alloc(32, 9);
const IO_URING_LOG = readFileSync(join(FIXTURES, "io-uring-injected.strace"), "utf8");

const prelude = (pid: number) => `${pid - 2} clone(child_stack=NULL, flags=CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUSER|CLONE_NEWPID|SIGCHLD) = ${pid - 1}\n${pid - 1} clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f0) = ${pid}\n`;
const benignTrace = (pid = 4242) => `${prelude(pid)}${pid} openat(AT_FDCWD</scope>, "/etc/hosts", O_RDONLY) = 3</etc/hosts>\n`;

describe("io_uring_setup counting (R36)", () => {
  const line = (pid: number, body: string) => `${pid} ${body}\n`;
  it("counts none for injected failures and counts successes and cut-off calls", () => {
    expect(countIoUringSetups(IO_URING_LOG)).toBe(0);
    expect(countIoUringSetups(line(1, "io_uring_setup(8, {flags=0}) = 5"))).toBe(1);
    expect(countIoUringSetups(line(1, "io_uring_setup(8, {flags=0}) = -1 ENOSYS (Function not implemented) (INJECTED)"))).toBe(0);
    expect(countIoUringSetups(line(1, "io_uring_setup(8, {flags=0}"))).toBe(1);
    expect(countIoUringSetups(`${line(7, "io_uring_setup(8, <unfinished ...>")}${line(8, "openat(AT_FDCWD, \"/x\", O_RDONLY) = 3</x>")}${line(7, "<... io_uring_setup resumed>) = -1 ENOSYS (x)")}`)).toBe(0);
    expect(countIoUringSetups(`${line(7, "io_uring_setup(8, <unfinished ...>")}${line(7, "<... io_uring_setup resumed>) = 6")}`)).toBe(1);
    expect(countIoUringSetups(line(7, "io_uring_setup(8, <unfinished ...>"))).toBe(1);
    expect(countIoUringSetups("not a strace line\n")).toBe(0);
  });
});

describe("dry load report assembly (provider-free, injected scope and process)", () => {
  const tasks = JSON.parse(readFileSync(join(FIXTURES, "tasks.json"), "utf8")) as TaskSpec[];
  interface Behavior { output?: Partial<DryLoadOutput> | "missing" | "forged"; trace?: string | null; exitCode?: number }
  const REVIEW_TOOLS = PAIRINGS.find((p) => p.id === "pl-review")!.grantedExtensionTools!;

  async function setup(behavior: (profile: string, extension: string) => Behavior = () => ({})) {
    const root = await temporaryRoot("ablation-dry-load-");
    const waveDir = join(root, "wave");
    const input: DryLoadInput = {
      templateDir: join(root, "template"), tasks, waveDir,
      productionConfig: {
        workspaces: { "synthetic-repo": join(root, "source") },
        skillCatalog: { "pi-session-review": "builtin:pi-session-review" },
        executionProfiles: {
          review: { permissionProfile: "read-only", provider: "openai", model: "m", thinkingLevel: "high", default: true },
          "review-grok": { permissionProfile: "read-only", provider: "xai", model: "m", thinkingLevel: "high", default: false },
          code: { permissionProfile: "coding", provider: "openai", model: "m", thinkingLevel: "medium", default: false },
          "code-deepseek": { permissionProfile: "coding", provider: "deepseek", model: "m", thinkingLevel: "high", default: false },
        },
      },
    };
    const prepared: ScopeInput[] = [];
    const states: { scopeExisted: boolean; runId: string }[] = [];
    const deps: DryLoadDeps = {
      hostCheck: async () => undefined, resolveTools: async () => TOOLS, planSandbox: async () => EMPTY_PLAN, containmentCheck: async () => undefined,
      residualCheck: async () => true, newKey: () => KEY, repoRoot: join(root, "repo"),
      changedPaths: async () => ["dist/generated.js"],
      prepareScope: async (scopeInput) => {
        prepared.push(scopeInput);
        const dir = scopeRoot(scopeInput.waveDir, scopeInput.run.runId);
        await mkdir(join(dir, "clone"), { recursive: true });
        return { root: dir, clone: join(dir, "clone"), home: join(dir, "home"), agentDir: join(dir, "agent"), configPath: join(dir, "config.json"), env: {}, privateDir: join(dir, "private"), baseGitDir: join(dir, "no-base.git") } satisfies RunScope;
      },
      spawn: (scope, inputPath, log): ChildProcess => {
        const started = JSON.parse(readFileSync(inputPath, "utf8")) as { runId: string; profile: string };
        const pairing = prepared.at(-1)!.pairing!;
        const how = behavior(pairing.profile, pairing.extension);
        states.push({ scopeExisted: existsSync(scope.root), runId: started.runId });
        const base: DryLoadOutput = {
          runId: started.runId, started: true, startErrorCode: null, harnessError: null, providerCalls: 0, sessionsLeft: 0, mac: null,
          activeTools: ["bash", "edit", "read", "write", ...(pairing.grantedExtensionTools ?? ["fixture_tool"])].sort(), ...(typeof how.output === "object" ? how.output : {}),
        };
        if (how.output !== "missing") {
          const signed = { ...base, mac: macOf({ ...base }, KEY) };
          const shown = how.output === "forged" ? { ...signed, activeTools: [...signed.activeTools, "tampered"] } : signed;
          writeFileSync(join(scope.root, "dry-load-output.json"), JSON.stringify(shown));
        }
        if (how.trace !== null) writeFileSync(log, how.trace ?? benignTrace());
        return spawn(process.execPath, ["-e", `process.stdin.resume(); process.stdin.on("end", () => process.exit(${how.exitCode ?? 0}))`], { stdio: ["pipe", "ignore", "ignore"], detached: true });
      },
    };
    return { root, input, deps, prepared, states, waveDir };
  }

  it("reports one entry per arm-B pairing: the first task of its kind, the replaced route, the active tools, the clone writes and zero trace counts", async () => {
    const s = await setup();
    const report = await dryLoad(s.input, s.deps);
    expect(report.pairs.map((p) => [p.pairing, p.ok, p.failure])).toEqual(PAIRINGS.map((p) => [p.id, true, null]));
    expect(report.deviation).toContain(DRY_PROVIDER);
    for (const pair of report.pairs) {
      expect(pair).toMatchObject({ grantedOk: true, cloneWrites: ["dist/generated.js"], trace: { outsideWrites: 0, unresolvedWrites: 0, deniedWriteAttempts: 0, unresolvedEgress: 0, ioUringSetupsSucceeded: 0 } });
    }
    expect(report.pairs.find((p) => p.pairing === "pl-review-grok")!.activeTools).toEqual(expect.arrayContaining([...REVIEW_TOOLS]));
    expect(s.prepared.map((p) => [p.pairing!.id, p.task.id, p.run.arm])).toEqual(PAIRINGS.map((p) => [p.id, p.profile.startsWith("review") ? "synthetic-review" : "synthetic-impl", p.extension]));
    for (const scopeInput of s.prepared) {
      expect(scopeInput.productionProfile).toMatchObject({ provider: DRY_PROVIDER, model: DRY_MODEL });
      expect(scopeInput.hostAuth).toEqual({});
      expect(scopeInput.extensionTemplate).toBe(s.input.templateDir);
    }
    // R42: nothing of a scope is kept.
    for (const scopeInput of s.prepared) {
      expect(existsSync(scopeRoot(s.waveDir, scopeInput.run.runId))).toBe(false);
      expect(existsSync(privateRunDir(s.waveDir, scopeInput.run.runId))).toBe(false);
    }
    expect(s.states.every((state) => state.scopeExisted)).toBe(true);
  });

  const failing: [string, Behavior, Record<string, unknown>][] = [
    ["an outside write", { trace: `${benignTrace()}4242 openat(AT_FDCWD</scope>, "/home/u/x", O_WRONLY|O_CREAT, 0644) = 3</home/u/x>\n` }, { failure: "trace_not_clean", trace: { outsideWrites: 1 } }],
    ["a relative write that cannot be resolved", { trace: `${benignTrace()}777 openat(AT_FDCWD, "y", O_RDWR) = 3\n` }, { failure: "trace_not_clean", trace: { unresolvedWrites: 1 } }],
    ["a successful io_uring_setup", { trace: `${benignTrace()}4242 io_uring_setup(8, {flags=0}) = 5\n` }, { failure: "trace_not_clean", trace: { unresolvedEgress: 1, ioUringSetupsSucceeded: 1 } }],
    ["a missing strace log", { trace: null }, { failure: "trace_missing" }],
    ["a session that did not start", { output: { started: false, startErrorCode: "extension_load_failed", activeTools: [] } }, { failure: "start_failed_extension_load_failed", activeTools: [] }],
    ["a harness error of the entry", { output: { harnessError: "unexpected_tool_result" } }, { failure: "unexpected_tool_result" }],
    ["a provider call", { output: { providerCalls: 1 } }, { failure: "provider_call_attempted" }],
    ["an open session", { output: { sessionsLeft: 1 } }, { failure: "session_left_open" }],
    ["a forged output", { output: "forged" }, { failure: "output_integrity", activeTools: [] }],
    ["no output", { output: "missing" }, { failure: "output_missing" }],
    ["a bad exit status", { exitCode: 3 }, { failure: "bad_exit" }],
  ];
  it.each(failing)("is not ok on %s", async (_name, behavior, expected) => {
    const s = await setup((profile, extension) => (profile === "code-deepseek" && extension === "pi-lens" ? behavior : {}));
    const report = await dryLoad(s.input, { ...s.deps, pairings: PAIRINGS.filter((p) => p.id === "pl-code-deepseek") });
    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0]).toMatchObject({ ok: false, ...expected });
  });

  it("is not ok when a granted tool is not active, and says which check failed", async () => {
    const s = await setup((profile) => (profile === "review-grok" ? { output: { activeTools: ["bash", "read", "symbol_search"] } } : {}));
    const report = await dryLoad(s.input, { ...s.deps, pairings: PAIRINGS.filter((p) => p.id === "pl-review-grok") });
    expect(report.pairs[0]).toMatchObject({ ok: false, grantedOk: false, failure: "granted_tool_missing" });
  });

  it("refuses before anything starts: no task of the kind, a missing profile or workspace, a wave dir in a source, existing output", async () => {
    const s = await setup();
    await expect(dryLoad({ ...s.input, tasks: tasks.filter((t) => t.kind === "review") }, s.deps)).rejects.toThrow("no_task_for_pairing");
    const { code: _code, ...withoutCode } = (s.input.productionConfig as { executionProfiles: Record<string, unknown> }).executionProfiles;
    await expect(dryLoad({ ...s.input, productionConfig: { ...(s.input.productionConfig as object), executionProfiles: withoutCode } }, s.deps)).rejects.toThrow("run_inputs_missing");
    await expect(dryLoad({ ...s.input, tasks: tasks.map((t) => ({ ...t, repo: "elsewhere" })) }, s.deps)).rejects.toThrow("run_inputs_missing");
    await expect(dryLoad({ ...s.input, waveDir: join(s.root, "source", "wave") }, s.deps)).rejects.toThrow("wave_dir_in_source");
    await expect(dryLoad({ ...s.input, waveDir: join(s.root, "repo", "wave") }, s.deps)).rejects.toThrow("wave_dir_in_source");
    expect(s.prepared).toHaveLength(0);
    await dryLoad(s.input, { ...s.deps, pairings: PAIRINGS.slice(0, 1) });
    const first = s.prepared[0]!.run.runId;
    await mkdir(scopeRoot(s.waveDir, first), { recursive: true });
    await expect(dryLoad(s.input, { ...s.deps, pairings: PAIRINGS.slice(0, 1) })).rejects.toThrow("output_exists");
  });

  it("stops at the host and containment checks", async () => {
    const s = await setup();
    await expect(dryLoad(s.input, { ...s.deps, hostCheck: async () => { throw new Error("ptrace_scope_unsafe"); } })).rejects.toThrow("ptrace_scope_unsafe");
    await expect(dryLoad(s.input, { ...s.deps, containmentCheck: async () => { throw new Error("containment_failed"); } })).rejects.toThrow("containment_failed");
    expect(s.prepared).toHaveLength(0);
  });

  it("validates the output schema strictly", () => {
    expect(dryLoadOutputSchema.safeParse({ runId: "r", started: true, startErrorCode: null, activeTools: [], providerCalls: 0, sessionsLeft: 0, harnessError: null, mac: null }).success).toBe(true);
    expect(dryLoadOutputSchema.safeParse({ runId: "r", started: true, startErrorCode: null, activeTools: [], providerCalls: 0, sessionsLeft: 0, harnessError: null, mac: null, extra: 1 }).success).toBe(false);
  });

  it("parses --dry-load with its required options and --config only", () => {
    expect(parseArgs(["--dry-load", "--tasks", "t.json", "--template", "/tpl", "--out", "/o"])).toMatchObject({ mode: "--dry-load" });
    expect(parseArgs(["--dry-load", "--tasks", "t.json", "--template", "/tpl", "--out", "/o", "--config", "c.json"])).toMatchObject({ mode: "--dry-load" });
    expect(() => parseArgs(["--dry-load", "--template", "/tpl", "--out", "/o"])).toThrow("tasks_required");
    expect(() => parseArgs(["--dry-load", "--tasks", "t.json", "--out", "/o"])).toThrow("template_required");
    expect(() => parseArgs(["--dry-load", "--tasks", "t.json", "--template", "/tpl"])).toThrow("out_required");
    expect(() => parseArgs(["--dry-load", "--tasks", "t.json", "--template", "/tpl", "--out", "/o", "--approval", "a.json"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--dry-load", "--tasks", "t.json", "--template", "/tpl", "--out", "/o", "--trim"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--dry-load", "--scan", "--tasks", "t.json"])).toThrow("choose_one_mode");
  });
});

const which = (name: string): string | undefined => (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, name)).find((path) => existsSync(path));
const hasTools = ["bwrap", "strace", "prlimit", "git", "codegraph"].every((name) => which(name) !== undefined);
const ptrace = (() => { try { return Number(readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim()) >= 1; } catch { return false; } })();

describe("dry load through the real sandbox", () => {
  it.skipIf(!hasTools || !ptrace)("loads a template extension under strace and bubblewrap and reports its tool with clean counts", async () => {
    await assertHostSafe();
    const tools = await resolveTools();
    const root = await temporaryRoot("ablation-dry-load-real-");
    // The compiled entry, as the wrapper builds it: the sandbox runs JavaScript from a read-only disposable build.
    const build = join(root, "build");
    await execFileAsync(process.execPath, [join(REPO_ROOT, "node_modules/typescript/bin/tsc"), "-p", join(REPO_ROOT, "tsconfig.eval.json"), "--outDir", build], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 });
    await symlink(join(REPO_ROOT, "node_modules"), join(build, "node_modules"), "dir");
    await symlink(join(REPO_ROOT, "skills"), join(build, "skills"), "dir");
    // The template: the repository's extension fixture under the pinned name of the pi-lens pairing, in the layout Pi's resolver reads.
    const template = join(root, "template");
    const lens = join(template, "npm", "node_modules", "pi-lens");
    await cp(EXTENSION_FIXTURE, lens, { recursive: true });
    await writeFile(join(lens, "package.json"), JSON.stringify({ name: "pi-lens", version: "4.4.3", private: true, type: "module", pi: { extensions: ["./index.js"] } }));
    // A small source repository with one commit.
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args: string[]) => execFileAsync(tools.git, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: source });
    await git("init", "-q");
    await writeFile(join(source, "README.md"), "synthetic\n");
    await git("add", "README.md");
    await git("commit", "-q", "-m", "base");
    const baseCommit = (await git("rev-parse", "HEAD")).stdout.trim();
    const task: TaskSpec = {
      id: "dry-impl", kind: "implementation", repo: "repo", baseCommit, promptRef: "eval/results/none.txt", promptHash: `sha256:${"a".repeat(64)}`, sourceSession: "synthetic",
      allowedPaths: [], scopeIgnore: [], oracle: { kind: "implementation", command: ["true"], timeoutMs: 1000 },
    };
    const input = (templateDir: string, wave: string): DryLoadInput => ({
      templateDir, tasks: [task], waveDir: join(root, wave),
      productionConfig: {
        workspaces: { repo: source },
        skillCatalog: { "pi-session-implementation": "builtin:pi-session-implementation" },
        executionProfiles: { "code-deepseek": { permissionProfile: "coding", provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high", default: false, skills: ["pi-session-implementation"] } },
      },
    });
    const deps: DryLoadDeps = {
      pairings: PAIRINGS.filter((p) => p.id === "pl-code-deepseek"), entry: join(build, "eval/extensions/dry-load-entry.js"), buildRoot: build,
      repoRoot: REPO_ROOT, containmentCheck: async () => undefined,
    };
    const report = await dryLoad(input(template, "wave"), deps);
    expect(report.pairs).toHaveLength(1);
    const pair = report.pairs[0]!;
    expect(pair).toMatchObject({
      pairing: "pl-code-deepseek", extension: "pi-lens", profile: "code-deepseek", failure: null, ok: true, grantedOk: true,
      trace: { outsideWrites: 0, unresolvedWrites: 0, deniedWriteAttempts: 0, unresolvedEgress: 0, ioUringSetupsSucceeded: 0 },
    });
    expect(pair.activeTools).toContain("fixture_tool");
    expect(pair.activeTools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
    expect(existsSync(scopeRoot(join(root, "wave"), "001-dry-impl-code-deepseek-pi-lens"))).toBe(false);
    // A template without the pinned package is reported by the product's own start failure, not by a crash.
    await mkdir(join(root, "empty", "npm", "node_modules"), { recursive: true });
    const missing = await dryLoad(input(join(root, "empty"), "wave-missing"), deps);
    expect(missing.pairs[0]).toMatchObject({ ok: false, failure: "start_failed_extension_not_installed", activeTools: [] });
  }, 300_000);
});
