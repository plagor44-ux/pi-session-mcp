import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { dryLoadCommand, parseArgs } from "../eval/extensions/cli.js";
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
  it("joins a call split by the tracer with its resumed line before judging the return value (R67)", () => {
    const head = "io_uring_setup(256, {flags=IORING_SETUP_NO_SQARRAY, sq_thread_cpu=0, sq_thread_idle=0 <unfinished ...>";
    expect(countIoUringSetups(`${line(1074925, head)}${line(1074925, "<... io_uring_setup resumed>})  = -1 ENOSYS (Function not implemented) (INJECTED)")}`)).toBe(0);
    expect(countIoUringSetups(`${line(1074925, head)}${line(1074925, "<... io_uring_setup resumed>})  = 7")}`)).toBe(1);
    expect(countIoUringSetups(line(1, "io_uring_setup(256, {flags=IORING_SETUP_NO_SQARRAY, sq_thread_cpu=0, sq_thread_idle=0})  = 7"))).toBe(1);
    expect(countIoUringSetups(line(1, "io_uring_setup(256, {flags=IORING_SETUP_NO_SQARRAY, sq_thread_cpu=0, sq_thread_idle=0})  = -1 ENOSYS (Function not implemented) (INJECTED)"))).toBe(0);
    expect(countIoUringSetups(`[pid 5] ${head}\n[pid 5] <... io_uring_setup resumed>})  = -1 ENOSYS (x)\n`)).toBe(0);
  });
});

describe("dry load report assembly (provider-free, injected scope and process)", () => {
  const tasks = JSON.parse(readFileSync(join(FIXTURES, "tasks.json"), "utf8")) as TaskSpec[];
  interface Behavior { output?: Partial<DryLoadOutput> | "missing" | "forged"; trace?: string | null; exitCode?: number; after?: (scope: RunScope) => void }
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
        how.after?.(scope);
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
    ["a refused write outside the scope", { trace: `${benignTrace()}4242 openat(AT_FDCWD</scope>, "/home/u/x", O_WRONLY|O_CREAT, 0644) = -1 EACCES (Permission denied)\n` }, { failure: "trace_not_clean", trace: { outsideWrites: 0, deniedWriteAttempts: 1 } }],
    ["unresolved egress other than io_uring (an AF_UNIX connect outside the scope)", { trace: `${benignTrace()}4242 connect(3, {sa_family=AF_UNIX, sun_path="/run/user/1000/bus"}, 110) = 0\n` }, { failure: "trace_not_clean", trace: { unresolvedEgress: 1, ioUringSetupsSucceeded: 0 } }],
    ["a connection to an address that is not name resolution (R53)", { trace: `${benignTrace()}4242 connect(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("93.184.216.34")}, 16) = 0\n` },
      { failure: "unexpected_connect", unexpectedConnects: [{ family: "inet", address: "93.184.216.34", port: 443 }], trace: { connects: 1, outsideWrites: 0, unresolvedEgress: 0 } }],
  ];
  it.each(failing)("is not ok on %s", async (_name, behavior, expected) => {
    const s = await setup((profile, extension) => (profile === "code-deepseek" && extension === "pi-lens" ? behavior : {}));
    const report = await dryLoad(s.input, { ...s.deps, pairings: PAIRINGS.filter((p) => p.id === "pl-code-deepseek") });
    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0]).toMatchObject({ ok: false, ...expected });
  });

  it("keeps a connection to a nameserver on port 53 out of the unexpected ones", async () => {
    const dns = (await import("../eval/extensions/network.js")).dnsServers;
    const address = [...await dns()].find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? "127.0.0.53";
    const s = await setup(() => ({ trace: `${benignTrace()}4242 connect(3, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("${address}")}, 16) = 0\n` }));
    const report = await dryLoad(s.input, { ...s.deps, pairings: PAIRINGS.filter((p) => p.id === "pl-code-deepseek") });
    expect(report.pairs[0]).toMatchObject({ ok: true, unexpectedConnects: [], trace: { connects: 1 } });
  });

  it("does not remove through a swapped scopes directory and fails the pair (R42)", async () => {
    const victim = await temporaryRoot("ablation-dry-load-victim-");
    let survivor = "";
    const s = await setup(() => ({
      after: (scope) => {
        const runId = scope.root.split("/").at(-1)!;
        // The worker replaces `scopes` by a link to a directory that holds a look-alike run directory.
        renameSync(join(s.waveDir, "scopes"), join(s.waveDir, "scopes-moved"));
        mkdirSync(join(victim, runId), { recursive: true });
        survivor = join(victim, runId, "precious.txt");
        writeFileSync(survivor, "keep");
        symlinkSync(victim, join(s.waveDir, "scopes"));
      },
    }));
    const report = await dryLoad(s.input, { ...s.deps, pairings: PAIRINGS.filter((p) => p.id === "pl-code-deepseek") });
    expect(report.pairs[0]).toMatchObject({ ok: false, failure: "cleanup_failed" });
    expect(readFileSync(survivor, "utf8")).toBe("keep");
  });

  it("fails the pair, and does not hide it, when a removal fails or a directory is swapped before the next pair", async () => {
    const s = await setup();
    const calls: string[] = [];
    const report = await dryLoad(s.input, { ...s.deps, pairings: PAIRINGS.filter((p) => p.id === "pl-code-deepseek"), removeTree: async (path) => { calls.push(path); throw new Error("EBUSY"); } });
    expect(report.pairs[0]).toMatchObject({ ok: false, failure: "cleanup_failed" });
    expect(calls).toHaveLength(1);
    // The guard also stands in front of the next pair's directories.
    const t = await setup(() => ({ after: () => { renameSync(join(t.waveDir, "private"), join(t.waveDir, "private-moved")); mkdirSync(join(t.waveDir, "private")); } }));
    const second = await dryLoad(t.input, { ...t.deps, pairings: PAIRINGS.filter((p) => p.profile === "code-deepseek" || p.id === "pl-code") });
    expect(second.pairs.map((p) => [p.pairing, p.failure])).toEqual([["pl-code-deepseek", "cleanup_failed"], ["pl-code", "cleanup_failed"]]);
    expect(t.prepared).toHaveLength(1);
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

  describe("task dependencies (R68)", () => {
    const dependent = (): TaskSpec[] => tasks.map((task) => ({ ...task, dependencies: [{ path: "backend/.venv", lockfile: "backend/uv.lock" }] }));
    const BINDS = [{ source: "/deps/t/mounts/backend/.venv", target: "/scope/clone/backend/.venv" }, { source: "/deps/t/runtime", target: "/deps/t/runtime" }];

    it("requires --deps when a task that is loaded declares dependencies, before anything is prepared", async () => {
      const s = await setup();
      await expect(dryLoad({ ...s.input, tasks: dependent() }, s.deps)).rejects.toThrow("deps_missing");
      expect(s.prepared).toHaveLength(0);
      expect(existsSync(s.waveDir)).toBe(false);
      // Only tasks that are loaded count: the first task of each kind is used, and a second review task is not.
      const [review] = tasks.filter((t) => t.kind === "review");
      const extra = { ...review!, id: "unused-review", dependencies: [{ path: "x", lockfile: "y" }] };
      await expect(dryLoad({ ...s.input, tasks: [...tasks, extra] }, s.deps)).resolves.toBeDefined();
    });

    it("refuses a deps directory inside a source, the evaluation repository or the wave directory", async () => {
      const s = await setup();
      for (const dir of [join(s.root, "source", "deps"), join(s.root, "repo", "deps"), join(s.waveDir, "deps"), s.root]) {
        await expect(dryLoad({ ...s.input, tasks: dependent(), depsDir: dir }, s.deps)).rejects.toThrow("deps_dir_in_source");
      }
      expect(s.prepared).toHaveLength(0);
    });

    it("hands the deps directory to every scope", async () => {
      const s = await setup();
      const depsDir = join(s.root, "deps");
      await dryLoad({ ...s.input, tasks: dependent(), depsDir }, s.deps);
      expect(s.prepared.map((input) => input.depsDir)).toEqual(PAIRINGS.map(() => depsDir));
    });

    it("starts the entry in a sandbox that carries the scope's binds after the scope bind", async () => {
      const s = await setup();
      const root = await temporaryRoot("ablation-dry-load-argv-");
      const prlimit = join(root, "prlimit");
      writeFileSync(prlimit, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "argv")}"\n`, { mode: 0o755 });
      const { spawn: _spawn, ...rest } = s.deps;
      await dryLoad({ ...s.input, tasks: dependent(), depsDir: join(root, "deps") }, {
        ...rest, pairings: PAIRINGS.slice(0, 1), resolveTools: async () => ({ ...TOOLS, prlimit }),
        prepareScope: async (scopeInput) => ({ ...await s.deps.prepareScope!(scopeInput), dependencyBinds: BINDS }),
      });
      const argv = readFileSync(join(root, "argv"), "utf8").split("\n");
      const at = (flag: string, source: string, target: string) => argv.findIndex((arg, i) => arg === flag && argv[i + 1] === source && argv[i + 2] === target);
      const scopeBind = argv.findIndex((arg, i) => arg === "--bind" && argv[i + 1] === argv[i + 2] && argv[i + 1]!.includes("/scopes/"));
      expect(scopeBind).toBeGreaterThan(-1);
      expect(at("--ro-bind", BINDS[0]!.source, BINDS[0]!.target)).toBeGreaterThan(scopeBind);
      expect(at("--ro-bind", BINDS[1]!.source, BINDS[1]!.target)).toBeGreaterThan(at("--ro-bind", BINDS[0]!.source, BINDS[0]!.target));
    });
  });

  describe("--dry-load command", () => {
    async function files(s: Awaited<ReturnType<typeof setup>>) {
      const tasksFile = join(s.root, "tasks.json");
      const configFile = join(s.root, "production.json");
      writeFileSync(tasksFile, JSON.stringify(tasks));
      writeFileSync(configFile, JSON.stringify(s.input.productionConfig));
      return { tasksFile, configFile };
    }
    async function repository(clean: boolean): Promise<string> {
      const repo = await temporaryRoot("ablation-dry-load-git-");
      const git = (...args: string[]) => execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
      await git("init", "-q");
      writeFileSync(join(repo, "a.txt"), "1\n");
      await git("add", "a.txt");
      await git("commit", "-q", "-m", "base");
      if (!clean) writeFileSync(join(repo, "a.txt"), "2\n");
      return repo;
    }
    const args = (f: { tasksFile: string; configFile: string }, out: string) => parseArgs(["--dry-load", "--tasks", f.tasksFile, "--template", "/template", "--out", out, "--config", f.configFile]);
    async function shown(body: () => Promise<void>): Promise<string> {
      let text = "";
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { text += String(chunk); return true; }) as typeof process.stdout.write);
      try { await body(); } finally { spy.mockRestore(); }
      return text;
    }

    it("refuses a dirty tree before anything starts", async () => {
      const s = await setup();
      const f = await files(s);
      await expect(dryLoadCommand(args(f, s.waveDir), { sourceCwd: await repository(false), deps: s.deps })).rejects.toThrow("source_dirty");
      expect(existsSync(s.waveDir)).toBe(false);
      expect(s.prepared).toHaveLength(0);
    });

    it("refuses an existing output directory", async () => {
      const s = await setup();
      const f = await files(s);
      await mkdir(s.waveDir);
      await expect(dryLoadCommand(args(f, s.waveDir), { sourceCwd: await repository(true), deps: s.deps })).rejects.toThrow("output_exists");
      expect(s.prepared).toHaveLength(0);
    });

    it("writes dry-load.json into the fresh directory and prints counts without paths", async () => {
      const s = await setup();
      const f = await files(s);
      const text = await shown(async () => dryLoadCommand(args(f, s.waveDir), { sourceCwd: await repository(true), deps: s.deps }));
      const summary = JSON.parse(text) as { ok: boolean; pairs: { pairing: string; ok: boolean; cloneWrites: number; unexpectedConnects: number }[] };
      expect(summary.ok).toBe(true);
      expect(summary.pairs.map((p) => p.pairing)).toEqual(PAIRINGS.map((p) => p.id));
      expect(summary.pairs[0]).toMatchObject({ cloneWrites: 1, unexpectedConnects: 0 });
      expect(text).not.toContain(s.root);
      expect(text).not.toContain("dist/generated.js");
      const report = JSON.parse(readFileSync(join(s.waveDir, "dry-load.json"), "utf8")) as { pairs: { cloneWrites: string[] }[] };
      expect(report.pairs).toHaveLength(PAIRINGS.length);
      expect(report.pairs[0]!.cloneWrites).toEqual(["dist/generated.js"]);
    });

    it("passes --deps on as an absolute path", async () => {
      const s = await setup();
      const f = await files(s);
      const parsed = parseArgs(["--dry-load", "--tasks", f.tasksFile, "--template", "/template", "--out", s.waveDir, "--config", f.configFile, "--deps", "relative-deps"]);
      await shown(async () => dryLoadCommand(parsed, { sourceCwd: await repository(true), deps: { ...s.deps, pairings: PAIRINGS.slice(0, 1) } }));
      expect(s.prepared.map((input) => input.depsDir)).toEqual([resolve("relative-deps")]);
    });

    it("exits non-zero when a pair is not ok", async () => {
      const s = await setup((profile, extension) => (profile === "code" && extension === "pi-cache-optimizer" ? { output: { providerCalls: 1 } } : {}));
      const f = await files(s);
      const before = process.exitCode;
      try {
        const text = await shown(async () => dryLoadCommand(args(f, s.waveDir), { sourceCwd: await repository(true), deps: s.deps }));
        expect(JSON.parse(text)).toMatchObject({ ok: false });
        expect(process.exitCode).toBe(1);
      } finally { process.exitCode = before; }
    });
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
