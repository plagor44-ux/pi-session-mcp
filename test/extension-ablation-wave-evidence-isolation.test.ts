import { execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { sourceCommit } from "../eval/extensions/cli.js";
import { buildMatrix, PAIRINGS } from "../eval/extensions/matrix.js";
import { runHelper } from "../eval/extensions/helpers.js";
import { readVerifiedOutput } from "../eval/extensions/audit.js";
import { removeTree } from "../eval/extensions/evidence.js";
import { EMPTY_PLAN } from "../eval/extensions/sandbox.js";
import { assertWaveDirOutsideSources, resolveTools, type ToolPaths } from "../eval/extensions/tools.js";
import { macOf, sha256Hex } from "../eval/extensions/output-mac.js";
import { readRegularFile } from "../eval/extensions/safe-read.js";
import { BUILD_ROOT, CORE_LIMIT, assertHostSafe, groupIsEmpty, tracedCommand, untracedCommand } from "../eval/extensions/supervise.js";
import { dnsServers, modelHost } from "../eval/extensions/network.js";
import { assertPreflightPassed, runPreflight } from "../eval/extensions/preflight.js";
import { hash } from "../eval/profiles/files.js";
import { runWave, type WaveDeps, type WaveInput } from "../eval/extensions/wave.js";
import { prepareRunScope, privateRunDir, renderPrompt, scopeEnv, scopeRoot, type RunScope } from "../eval/extensions/workspace.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { exec, PROFILE, productionConfig, GOOD_REVIEW, benignTrace, fake, fakePrepare, reviewTask, type Setup, approvalFor, seedLedger, seams, waveSetup, TOOLS, baseDeps, findDirs, findFiles, realTools, LEDGER_ID, text } from "./extension-ablation-wave-fixtures.js";

afterAll(removeTemporaryRoots);

describe("shared ledger and output safety (R37)", () => {
  it("refuses before any spawn when an output of a planned run already exists", async () => {
    for (const make of [
      (s: Setup) => mkdir(join(s.waveDir, "runs"), { recursive: true }).then(() => writeFile(join(s.waveDir, "runs", `${s.runs[1]!.runId}.json`), "{}")),
      (s: Setup) => mkdir(privateRunDir(s.waveDir, s.runs[1]!.runId), { recursive: true }),
      (s: Setup) => mkdir(scopeRoot(s.waveDir, s.runs[1]!.runId), { recursive: true }),
    ]) {
      const s = await waveSetup(2);
      await make(s);
      const { deps, captured } = s.deps([text()]);
      await expect(runWave(s.input, deps)).rejects.toThrow("output_exists");
      expect(captured).toHaveLength(0);
      // Nothing was charged and no lock is left behind.
      expect(JSON.parse(await readFile(s.input.ledgerPath, "utf8")).entries).toEqual([]);
      expect(existsSync(`${s.input.ledgerPath}.lock`)).toBe(false);
    }
  });

  it("counts a preflight's spend in the wave through the shared ledger file", async () => {
    const root = await temporaryRoot("ablation-shared-ledger-");
    const ledgerPath = join(root, "evaluation-ledger.json");
    const tasks = [await reviewTask(root, "P1")];
    const runs = buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review"));
    const approval = approvalFor(tasks, runs);
    await seedLedger(ledgerPath);
    const { spawnRun } = fake([{ cost: 9.6, text: "PONG" }], root);
    const hostAuth = { openai: { type: "oauth", access: "a", refresh: "", expires: Date.now() + 3_600_000 } };
    const pre = await runPreflight({ approval, waveDir: join(root, "pre"), ledgerPath, productionConfig, hostAuth }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => true,
    });
    expect(pre.routes.map((r) => r.ok)).toEqual([true]);
    const s = await waveSetup(1, { ledgerPath });
    const { deps, captured } = s.deps([text()]);
    const r = await runWave(s.input, deps);
    expect(r.stopReason).toBe("budget");
    expect(r.spentUsd).toBeCloseTo(9.6);
    expect(captured).toHaveLength(0);
  });

  it("refuses to preflight into an output directory that already holds a preflight", async () => {
    const root = await temporaryRoot("ablation-preflight-exists-");
    const tasks = [await reviewTask(root, "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    await mkdir(join(root, "wave"), { recursive: true });
    await writeFile(join(root, "wave", "preflight.json"), "{}");
    await expect(runPreflight({ approval, waveDir: join(root, "wave"), ledgerPath: join(root, "l.json"), productionConfig, hostAuth: {} }, seams())).rejects.toThrow("output_exists");
  });

  it("lets the wave start only on a passed preflight of the same approval and ledger", async () => {
    const root = await temporaryRoot("ablation-preflight-gate-");
    const tasks = [await reviewTask(root, "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    const ledgerPath = join(root, "ledger.json");
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("preflight_missing");
    const binding = { sourceCommit: approval.sourceCommit, tasksDigest: approval.tasksDigest, matrixDigest: approval.matrixDigest };
    const passed = (ok: boolean) => approval.routes.map((r) => ({ profile: r.profile, ok, terminal: "completed", costUsd: 0.01, failure: null }));
    const write = (file: unknown) => writeFile(join(root, "preflight.json"), JSON.stringify(file));
    const writeLedger = (ledgerId: string, runs: string[]) => writeFile(ledgerPath, JSON.stringify({
      ledgerId, limitUsd: 10, spentUsd: 0.01 * runs.length, entries: runs.map((runId) => ({ runId, profile: "review", costUsd: 0.01 })),
    }));
    const entries = approval.routes.map((r) => `preflight-${r.profile}`);
    await write({ binding, ledgerId: LEDGER_ID, routes: passed(true), spentUsd: 0.01 });
    await writeLedger(LEDGER_ID, entries);
    await expect(assertPreflightPassed(root, approval, ledgerPath)).resolves.toBeUndefined();
    await write({ binding: { ...binding, matrixDigest: "sha256:0" }, ledgerId: LEDGER_ID, routes: passed(true), spentUsd: 0 });
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("preflight_binding_changed");
    await write({ binding, ledgerId: LEDGER_ID, routes: passed(false), spentUsd: 0 });
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("preflight_failed");
    // R37b: a different ledger file, or one without the preflight's entries, is refused.
    await write({ binding, ledgerId: LEDGER_ID, routes: passed(true), spentUsd: 0 });
    await writeLedger("22222222-2222-4222-8222-222222222222", entries);
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("ledger_mismatch");
    await writeLedger(LEDGER_ID, ["something-else"]);
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("ledger_mismatch");
    // R55: a ledger file that is missing is refused, never silently created; one whose id differs from the approval's is a mismatch.
    await rm(ledgerPath);
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("ledger_missing");
    await write({ binding, ledgerId: "33333333-3333-4333-8333-333333333333", routes: passed(true), spentUsd: 0 });
    await writeLedger("33333333-3333-4333-8333-333333333333", entries);
    await expect(assertPreflightPassed(root, approval, ledgerPath)).rejects.toThrow("ledger_mismatch");
  });

  it("rejects a malformed preflight file instead of throwing a TypeError", async () => {
    const root = await temporaryRoot("ablation-preflight-malformed-");
    const tasks = [await reviewTask(root, "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    for (const content of ["{", "null", "[]", JSON.stringify({ routes: "x" }), JSON.stringify({ binding: {}, ledgerId: "x", routes: [], spentUsd: 0 })]) {
      await writeFile(join(root, "preflight.json"), content);
      await expect(assertPreflightPassed(root, approval, join(root, "l.json"))).rejects.toThrow("preflight_invalid");
    }
  });
});

describe("credentials and traces stay out of kept evidence (I2, R35)", () => {
  it("keeps no worker-derived artefact: only the sanitized record survives (R42)", async () => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed" }, text: "partial" }, text()]).deps);
    for (const record of r.records) {
      expect(existsSync(scopeRoot(s.waveDir, record.runId))).toBe(false);
      expect(existsSync(privateRunDir(s.waveDir, record.runId))).toBe(false);
    }
    expect(await findDirs(s.waveDir, "base.git")).toEqual([]);
    expect(await findFiles(s.waveDir, /auth/i)).toEqual([]);
    const files = (await findFiles(s.waveDir, /./)).map((file) => file.slice(s.waveDir.length + 1)).sort();
    // The records plus the wave's own bookkeeping (the approval it ran under, the guard baseline and how it ended).
    expect(files).toEqual([...s.runs.map((run) => `runs/${run.runId}.json`), "approval.json", "guard.json", "status.json"].sort());
    // The text itself is gone; its hash is recorded.
    expect(r.records[1]!.assistantTextSha256).toBe(sha256Hex(GOOD_REVIEW));
    expect(r.records[0]!.assistantTextSha256).toBe(sha256Hex("partial"));
  });

  it("leaves a boundary key a worker copied into the clone nowhere on disk", async () => {
    const secret = "sk-test-boundary-secret-0123456789";
    const root = await temporaryRoot("ablation-redact-");
    const waveDir = join(root, "wave");
    const tasks = [await reviewTask(join(root, "repo"), "T1")];
    const runs = buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")).slice(0, 1);
    const hostAuth = { openai: { type: "api_key", key: secret } };
    const input: WaveInput = {
      approval: approvalFor(tasks, runs), tasks, waveDir, ledgerPath: join(root, "ledger.json"), productionConfig,
      extensionTemplate: join(root, "t"), repoRoot: join(root, "repo"), hostAuth, killGraceMs: 0,
    };
    await seedLedger(input.ledgerPath);
    const { spawnRun } = fake([text({ writeFile: { name: "x.txt", content: secret } })], root);
    const r = await runWave(input, { ...baseDeps(), spawnRun });
    expect(existsSync(scopeRoot(waveDir, r.records[0]!.runId))).toBe(false);
    for (const file of await findFiles(waveDir, /./)) expect(await readFile(file, "utf8")).not.toContain(secret);
  });

  it("removes the scope even when a step after the spawn throws", async () => {
    const s = await waveSetup(2);
    const flaky = fake([text()], s.root);
    const r = await runWave(s.input, { ...baseDeps(), spawnRun: flaky.spawnRun, residualCheck: async () => { throw new Error("residual exploded"); } });
    expect(r.records[0]).toMatchObject({ outcome: "stopped", stopReason: "harness_failure" });
    expect(existsSync(scopeRoot(s.waveDir, s.runs[0]!.runId))).toBe(false);
    expect(existsSync(privateRunDir(s.waveDir, s.runs[0]!.runId))).toBe(false);
    const guarded = await waveSetup(2);
    let n = 0;
    const g = await runWave(guarded.input, { ...baseDeps(), spawnRun: fake([text()], guarded.root).spawnRun, guard: async () => { if (++n > 1) throw new Error("boom"); return { files: {} }; } });
    expect(g.records[0]).toMatchObject({ outcome: "stopped", stopReason: "harness_failure" });
    expect(existsSync(scopeRoot(guarded.waveDir, guarded.runs[0]!.runId))).toBe(false);
  });

  it("removes links without following them and tolerates a missing path (R42)", async () => {
    const root = await temporaryRoot("ablation-remove-tree-");
    const victim = join(root, "victim");
    await mkdir(victim);
    await writeFile(join(victim, "keep.txt"), "precious");
    // The private run path itself is a symlink to a directory outside.
    await symlink(victim, join(root, "private-link"));
    await removeTree(join(root, "private-link"));
    expect(existsSync(join(root, "private-link"))).toBe(false);
    expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("precious");
    // A symlink inside a real directory, to a directory and to a file.
    await mkdir(join(root, "dir", "sub"), { recursive: true });
    await symlink(victim, join(root, "dir", "sub", "to-dir"));
    await symlink(join(victim, "keep.txt"), join(root, "dir", "to-file"));
    await removeTree(join(root, "dir"));
    expect(existsSync(join(root, "dir"))).toBe(false);
    expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("precious");
    // A plain file or FIFO planted where the directory should be is unlinked, and a missing path is fine.
    await writeFile(join(root, "plain"), "x");
    await exec("mkfifo", [join(root, "fifo")]);
    await removeTree(join(root, "plain"));
    await removeTree(join(root, "fifo"));
    await removeTree(join(root, "nothing"));
    expect(existsSync(join(root, "plain")) || existsSync(join(root, "fifo"))).toBe(false);
  });

  it("records only counts for out-of-scope files and the hash of the text, never paths", async () => {
    const s = await waveSetup(1, { kind: "implementation" });
    const scored: WaveDeps["scoreImplementation"] = async () => ({ accepted: false, testsPassed: true, outOfScope: ["/home/u/evil name.txt", "src/other.ts"] });
    const r = await runWave(s.input, s.deps([text()], { scoreImplementation: scored }).deps);
    expect(r.records[0]).toMatchObject({ outcome: "scored", accepted: false, implementation: { accepted: false, testsPassed: true, outOfScopeCount: 2 } });
    const file = await readFile(join(s.waveDir, "runs", `${r.records[0]!.runId}.json`), "utf8");
    expect(file).not.toContain("evil name");
    expect(file).not.toContain("other.ts");
    expect(JSON.parse(file).implementation).not.toHaveProperty("outOfScope");
  });

  it("keeps every strace log outside the scope root and stops on a missing oracle log", async () => {
    const s = await waveSetup(1, { kind: "implementation" });
    const logs: string[] = [];
    const missing: WaveDeps["scoreImplementation"] = async (_clone, _task, options) => {
      logs.push(options.wrap!(["npm", "test"]).at(options.wrap!(["x"]).indexOf("-o") + 1)!);
      return { accepted: true, testsPassed: true, outOfScope: [] };
    };
    const { deps, captured } = s.deps([text()], { scoreImplementation: missing });
    const r = await runWave(s.input, deps);
    expect(r.stopReason).toBe("harness_failure");
    expect(r.records[0]).toMatchObject({ outcome: "stopped", harnessError: "trace_missing" });
    const root = captured[0]!.scope.root;
    expect(root.startsWith(join(s.waveDir, "private"))).toBe(false);
    expect(logs.every((path) => path.startsWith(privateRunDir(s.waveDir, r.records[0]!.runId)) && !path.startsWith(root))).toBe(true);
  });
});

describe("record safety (items 7 and 8)", () => {
  it("turns a post-processing failure into a harness_failure record and still writes the rest", async () => {
    const s = await waveSetup(2);
    const { spawnRun } = fake([{ output: { terminal: "failed" } }], s.root);
    // A read-only directory with content inside the private run directory makes its removal fail.
    const blocking = (scope: RunScope, runInput: string, log: string): ChildProcess => {
      const locked = join(privateRunDir(s.waveDir, s.runs[0]!.runId), "locked");
      mkdirSync(join(locked, "f"), { recursive: true });
      chmodSync(locked, 0o500);
      return spawnRun(scope, runInput, log);
    };
    const r = await runWave(s.input, { ...baseDeps(), spawnRun: blocking });
    chmodSync(join(privateRunDir(s.waveDir, s.runs[0]!.runId), "locked"), 0o700);
    expect(r.stopReason).toBe("harness_failure");
    expect(r.records.map((x) => x.outcome)).toEqual(["stopped", "not_run"]);
    expect(r.records[0]).toMatchObject({ stopReason: "harness_failure" });
    for (const run of s.runs) expect(existsSync(join(s.waveDir, "runs", `${run.runId}.json`))).toBe(true);
    const ledger = JSON.parse(await readFile(s.input.ledgerPath, "utf8")) as { entries: unknown[] };
    expect(ledger.entries).toHaveLength(1);
  });

  it("replaces a harness error string that is not a fixed code", async () => {
    const s = await waveSetup(1);
    const r = await runWave(s.input, s.deps([{ output: { terminal: "failed", harnessError: "ENOENT /home/u/secret failed" } }]).deps);
    expect(r.records[0]).toMatchObject({ stopReason: "harness_failure", harnessError: "invalid_harness_error" });
    expect(await readFile(join(s.waveDir, "runs", `${s.runs[0]!.runId}.json`), "utf8")).not.toContain("/home/u");
  });
});

describe("network audit addresses", () => {
  it("passes provider and DNS addresses to the connect audit", async () => {
    const s = await waveSetup(2);
    const connect = (ip: string, port: number) => `4242 connect(3, {sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${ip}")}, 16) = 0\n`;
    const trace = benignTrace() + connect("203.0.113.9", 443) + connect("203.0.113.53", 53) + connect("198.51.100.7", 443);
    const addresses = { providerAddresses: new Set(["203.0.113.9"]), dnsAddresses: new Set(["203.0.113.53"]) };
    const r = await runWave(s.input, s.deps([text({ trace })], { resolveAddresses: async () => addresses }).deps);
    expect(r.records[0]!.trace).toMatchObject({ connects: 3, unexpectedConnects: [{ family: "inet", address: "198.51.100.7", port: 443 }] });
  });

  it("reads the model endpoint host from the pinned SDK catalog offline and the nameservers from resolv.conf", async () => {
    expect(await modelHost({ provider: "openai", model: "gpt-6.1-sol" })).toBe("api.openai.com");
    await expect(modelHost({ provider: "openai", model: "no-such-model" })).rejects.toThrow("provider_model_unknown");
    const root = await temporaryRoot("ablation-resolv-");
    await writeFile(join(root, "resolv.conf"), "# c\nnameserver 192.0.2.1\nnameserver fe80::1%eth0\nsearch x\n");
    expect([...await dnsServers(join(root, "resolv.conf"))].sort()).toEqual(["127.0.0.53", "192.0.2.1", "fe80::1"]);
    expect([...await dnsServers(join(root, "missing"))]).toEqual(["127.0.0.53"]);
  });

  it("fails a preflight route whose endpoint cannot be resolved", async () => {
    const root = await temporaryRoot("ablation-unresolved-");
    const tasks = [await reviewTask(root, "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    await seedLedger(join(root, "l.json"));
    const { spawnRun, captured } = fake([], root);
    const r = await runPreflight({ approval, waveDir: join(root, "w"), ledgerPath: join(root, "l.json"), productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, "x"), checkRoute: async () => { throw new Error("provider_host_unresolvable"); },
    });
    expect(r.routes).toMatchObject([{ ok: false, failure: "provider_host_unresolvable" }]);
    expect(captured).toHaveLength(0);
  });
});

describe("source binding and prompt rewrite (items 10 and 11)", () => {
  it("refuses a dirty tracked tree and a missing repository, and ignores untracked files", async () => {
    const root = await temporaryRoot("ablation-source-");
    const git = (...args: string[]) => exec("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(root, "a.txt"), "1");
    await git("add", "."); await git("commit", "--quiet", "-m", "one");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(root, "untracked.txt"), "x");
    expect(await sourceCommit(root)).toBe(head);
    await writeFile(join(root, "a.txt"), "2");
    await expect(sourceCommit(root)).rejects.toThrow("source_dirty");
    await expect(sourceCommit(await temporaryRoot("ablation-nogit-"))).rejects.toThrow("source_unavailable");
  });

  it("rewrites the configured, real and home-relative forms on path boundaries only", async () => {
    const root = await temporaryRoot("ablation-prompt-");
    const real = join(root, "repo");
    await mkdir(real);
    await symlink(real, join(root, "link"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      expect(homedir()).toBe(root);
      const clone = join(root, "wave", "scopes", "r1", "clone");
      const body = `A ${join(root, "link")}/a.ts, B ${real}/b.ts, C ~/repo/c.ts, D ${real}-other/d.ts, E x${real}/e.ts, F ${real}.`;
      const task = { ...(await reviewTask(root, "W1")), promptRef: "eval/results/ablation-test/W1.txt", promptHash: hash(body) };
      await writeFile(join(root, task.promptRef), body);
      const out = await renderPrompt(root, task, join(root, "link"), clone);
      expect(out).toBe(`A ${clone}/a.ts, B ${clone}/b.ts, C ${clone}/c.ts, D ${real}-other/d.ts, E x${real}/e.ts, F ${clone}.`);
    } finally { process.env.HOME = previousHome; }
  });

  it("does not report a leak when the clone itself lives below the source path", async () => {
    const root = await temporaryRoot("ablation-prompt-below-");
    const clone = join(root, "eval", "results", "wave", "scopes", "r1", "clone");
    const body = `see ${root}/src/a.ts`;
    const task = { ...(await reviewTask(root, "W2")), promptHash: hash(body) };
    await writeFile(join(root, task.promptRef), body);
    expect(await renderPrompt(root, task, root, clone)).toBe(`see ${clone}/src/a.ts`);
  });
});

describe("exit status and host safety (N1, R40)", () => {
  it.each([
    ["a signal after a valid output", { signal: "SIGKILL" as const }],
    ["a core-dump signal after a valid output", { signal: "SIGABRT" as const }],
    ["a non-zero exit after a valid output", { exitCode: 3 }],
  ])("does not trust the output of a worker that ends with %s", async (_name, ending) => {
    const s = await waveSetup(2);
    const r = await runWave(s.input, s.deps([text({ cost: 0.4, ...ending })]).deps);
    expect(r.stopReason).toBe("output_integrity");
    expect(r.records[0]).toMatchObject({ outcome: "stopped", accepted: null, usage: null, terminal: null, stopReason: "output_integrity" });
    // R41: the untrusted output's cost is not believed; the estimate is charged and flagged.
    expect(r.spentUsd).toBe(1);
  });

  it("refuses to start without prlimit or with a Yama ptrace_scope below 1", async () => {
    const ok = { hasPrlimit: async () => true, readPtraceScope: async () => "1\n" };
    await expect(assertHostSafe(ok)).resolves.toBeUndefined();
    await expect(assertHostSafe({ ...ok, readPtraceScope: async () => "3" })).resolves.toBeUndefined();
    await expect(assertHostSafe({ ...ok, readPtraceScope: async () => "0\n" })).rejects.toThrow("ptrace_scope_unsafe");
    await expect(assertHostSafe({ ...ok, readPtraceScope: async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } })).rejects.toThrow("ptrace_scope_unsafe");
    await expect(assertHostSafe({ ...ok, readPtraceScope: async () => "garbage" })).rejects.toThrow("ptrace_scope_unsafe");
    await expect(assertHostSafe({ ...ok, hasPrlimit: async () => false })).rejects.toThrow("prlimit_missing");
  });

  it("runs the wave's host check before anything is prepared", async () => {
    const s = await waveSetup(1);
    const { deps, captured } = s.deps([text()], { hostCheck: async () => { throw new Error("ptrace_scope_unsafe"); } });
    await expect(runWave(s.input, deps)).rejects.toThrow("ptrace_scope_unsafe");
    expect(captured).toHaveLength(0);
    expect(existsSync(s.waveDir)).toBe(false);
  });

  // A real-host test: it needs prlimit on the PATH and skips otherwise.
  it.skipIf(process.platform !== "linux" || !(process.env.PATH ?? "").split(":").some((dir) => dir.startsWith("/") && existsSync(join(dir, "prlimit"))))("sets a hard core limit of 0 with the flag the spawn uses", async () => {
    const { stdout } = await exec("prlimit", [CORE_LIMIT, "sh", "-c", "ulimit -Hc; ulimit -Sc"]);
    expect(stdout.trim().split("\n")).toEqual(["0", "0"]);
  }, 60_000);
});

describe("helper processes (N3)", () => {
  it("retries a ps that was killed by a signal once, and counts a second failure as not clean", async () => {
    const killed = Object.assign(new Error("helper_failed"), { code: null, signal: "SIGINT", stdout: "", stderr: "" });
    const calls: string[] = [];
    const flaky = (failures: number) => async (file: string, args: readonly string[]) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (calls.length <= failures) throw killed;
      return { stdout: "", stderr: "" };
    };
    expect(await groupIsEmpty(4242, flaky(1))).toBe(true);
    expect(calls).toHaveLength(2);
    calls.length = 0;
    expect(await groupIsEmpty(4242, flaky(2))).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("ps -o pid=,stat= -g 4242");
  });

  it("runs helpers in their own process group, so a terminal Ctrl-C does not reach them", async () => {
    const own = (await runHelper("ps", ["-o", "pgid=", "-p", String(process.pid)])).stdout.trim();
    const helper = (await runHelper("sh", ["-c", "ps -o pgid= -p $$"])).stdout.trim();
    expect(helper).not.toBe(own);
    await expect(runHelper("sh", ["-c", "exit 3"])).rejects.toMatchObject({ code: 3, signal: null });
    await expect(runHelper("sh", ["-c", "kill -INT $$"])).rejects.toMatchObject({ code: null, signal: "SIGINT" });
  });

  it("treats exit code 1 as an empty group and ignores zombies", async () => {
    expect(await groupIsEmpty(1, async () => { throw Object.assign(new Error("helper_failed"), { code: 1, signal: null }); })).toBe(true);
    expect(await groupIsEmpty(1, async () => ({ stdout: "  77 Z\n  78 Z+\n", stderr: "" }))).toBe(true);
  });
});

describe("safe reads from the scope (R39)", () => {
  const key = Buffer.alloc(32, 9);
  const signed = (extra: Record<string, unknown> = {}) => {
    const out: Record<string, unknown> = {
      runId: "r1", terminal: "completed", startErrorCode: null,
      usage: { session: null, assistant: { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, providerError: null },
      durationMs: 1, sessionsLeft: 0, assistantTextRef: null, assistantTextTruncated: false, assistantTextSha256: null, harnessError: null, mac: null, ...extra,
    };
    return JSON.stringify({ ...out, mac: macOf(out, key) });
  };

  it("reads a regular file within the cap and refuses a symlink, a FIFO and an oversize file", async () => {
    const root = await temporaryRoot("ablation-safe-read-");
    await writeFile(join(root, "ok"), "fine");
    expect((await readRegularFile(join(root, "ok"), 1024)).toString()).toBe("fine");
    await symlink(join(root, "ok"), join(root, "link"));
    await expect(readRegularFile(join(root, "link"), 1024)).rejects.toThrow("unsafe_read");
    await exec("mkfifo", [join(root, "fifo")]);
    await expect(readRegularFile(join(root, "fifo"), 1024)).rejects.toThrow("unsafe_read");
    await writeFile(join(root, "big"), Buffer.alloc(2 * 1024 * 1024));
    await expect(readRegularFile(join(root, "big"), 1024 * 1024)).rejects.toThrow("unsafe_read");
    await expect(readRegularFile(join(root, "missing"), 1024)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a FIFO, a symlink and a 2 MiB file in place of the output or the text as tampering", async () => {
    const root = await temporaryRoot("ablation-verified-output-");
    const scope = join(root, "scope");
    const priv = join(scope, "private");
    await mkdir(priv, { recursive: true });
    await writeFile(join(scope, "run-output.json"), signed());
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: false, present: true });
    expect(await readVerifiedOutput(join(root, "none"), priv, "r1", key)).toMatchObject({ tampered: false, present: false });

    await rm(join(scope, "run-output.json"));
    await exec("mkfifo", [join(scope, "run-output.json")]);
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: true, output: null });

    await rm(join(scope, "run-output.json"));
    await writeFile(join(root, "elsewhere.json"), signed());
    await symlink(join(root, "elsewhere.json"), join(scope, "run-output.json"));
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: true, output: null });

    await rm(join(scope, "run-output.json"));
    await writeFile(join(scope, "run-output.json"), Buffer.concat([Buffer.from(signed()), Buffer.alloc(2 * 1024 * 1024, 32)]));
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: true });

    // The same guards apply to the assistant text the output points at.
    const text = "hello";
    await rm(join(scope, "run-output.json"));
    await writeFile(join(scope, "run-output.json"), signed({ assistantTextRef: "r1.txt", assistantTextSha256: sha256Hex(text) }));
    await exec("mkfifo", [join(priv, "r1.txt")]);
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: true });
    await rm(join(priv, "r1.txt"));
    await symlink(join(root, "elsewhere.json"), join(priv, "r1.txt"));
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: true });
    await rm(join(priv, "r1.txt"));
    await writeFile(join(priv, "r1.txt"), text);
    expect(await readVerifiedOutput(scope, priv, "r1", key)).toMatchObject({ tampered: false, text });
  });

  it("refuses a strace log that is a symlink or a FIFO (as a missing trace)", async () => {
    const s = await waveSetup(2);
    const { spawnRun } = fake([text({ trace: null })], s.root);
    const planting = (scope: RunScope, runInput: string, log: string): ChildProcess => {
      execFileSync("mkfifo", [log]);
      return spawnRun(scope, runInput, log);
    };
    const r = await runWave(s.input, { ...baseDeps(), spawnRun: planting });
    expect(r.records[0]).toMatchObject({ stopReason: "harness_failure", harnessError: "trace_missing" });
  });
});

describe("estimates for untrusted runs (R41)", () => {
  it("charges the current estimate and flags it for a killed run, using the highest observed cost afterwards", async () => {
    // The first run must finish inside the run timeout even on a slow CI runner; only the second one hangs.
    const s = await waveSetup(3, { runTimeoutMs: 3_000 });
    const r = await runWave(s.input, s.deps([text({ cost: 0.5 }), { hang: true }, text({ cost: 0.1 })], { residualCheck: undefined }).deps);
    const ledger = JSON.parse(await readFile(s.input.ledgerPath, "utf8")) as { entries: { runId: string; costUsd: number; estimated?: boolean }[] };
    expect(ledger.entries[0]).toMatchObject({ costUsd: 0.5 });
    expect(ledger.entries[0]!.estimated).toBeUndefined();
    // After a 0.5 observation the estimate for that profile is 0.5.
    expect(ledger.entries[1]).toMatchObject({ runId: s.runs[1]!.runId, costUsd: 0.5, estimated: true });
    expect(r.stopReason).toBe("harness_failure");
    expect(r.spentUsd).toBeCloseTo(1);
  }, 30_000);
});

describe("source isolation (N5)", () => {
  async function gitSource(prefix: string) {
    const root = await temporaryRoot(prefix);
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args: string[]) => exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await git("init", "--quiet");
    await writeFile(join(source, "a.txt"), "base");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "codegraph"), "#!/bin/sh\nmkdir -p \"$3/.codegraph\"\n");
    await chmod(join(bin, "codegraph"), 0o755);
    return { root, source, bin, git, base: (await git("rev-parse", "HEAD")).stdout.trim() };
  }
  const withPath = async <T>(bin: string, body: () => Promise<T>): Promise<T> => {
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try { return await body(); } finally { process.env.PATH = previous; }
  };

  it("leaves no mention of the source path in the clone's .git or the pristine clone's config", async () => {
    const { root, source, bin, base } = await gitSource("ablation-isolation-");
    const task = { ...(await reviewTask(root, "I1")), baseCommit: base };
    const run = buildMatrix([task], PAIRINGS.filter((p) => p.id === "pl-review"))[0]!;
    const scope = await withPath(bin, async () => prepareRunScope({
      waveDir: join(root, "wave"), run, task, sourceRepoPath: source, extensionTemplate: join(root, "t"), hostAuth: {}, productionProfile: PROFILE, tools: await realTools(bin),
    }));
    const mentions = async (dir: string): Promise<string[]> => {
      const hits: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) hits.push(...await mentions(path));
        else if (entry.isFile() && (await readFile(path)).includes(source)) hits.push(path);
      }
      return hits;
    };
    expect(await mentions(join(scope.clone, ".git"))).toEqual([]);
    expect(await readFile(join(scope.baseGitDir, "config"), "utf8")).not.toContain(source);
    expect((await exec("git", ["-C", scope.clone, "reflog"])).stdout).toContain(base.slice(0, 7));
    expect(await readFile(join(scope.clone, "a.txt"), "utf8")).toBe("base");
  });

  it("refuses a source repository that borrows objects through alternates", async () => {
    const { root, source, bin, base } = await gitSource("ablation-alternates-");
    await writeFile(join(source, ".git", "objects", "info", "alternates"), "/nonexistent/objects\n");
    const task = { ...(await reviewTask(root, "I2")), baseCommit: base };
    const run = buildMatrix([task], PAIRINGS.filter((p) => p.id === "pl-review"))[0]!;
    await expect(withPath(bin, async () => prepareRunScope({
      waveDir: join(root, "wave"), run, task, sourceRepoPath: source, extensionTemplate: join(root, "t"), hostAuth: {}, productionProfile: PROFILE, tools: await realTools(bin),
    }))).rejects.toThrow("source_alternates");
    expect(existsSync(scopeRoot(join(root, "wave"), run.runId))).toBe(false);
  });
});

describe("hardening (R44)", () => {
  it("builds every command from absolute tool paths, inside bubblewrap, without an inspector", () => {
    const traced = tracedCommand(TOOLS, EMPTY_PLAN, "/scope", "/priv/strace.log", "/scope/run-input.json");
    expect(traced.file).toBe(TOOLS.prlimit);
    expect(traced.args.slice(0, 3)).toEqual([CORE_LIMIT, "--", TOOLS.strace]);
    const afterStrace = traced.args.slice(traced.args.indexOf("-o") + 2);
    expect(afterStrace.slice(0, 2)).toEqual(["--", TOOLS.bwrap]);
    // The build the run unit loads from lives under /tmp, which the sandbox hides: it is bound back read-only, after the tmpfs.
    const withBuild = tracedCommand(TOOLS, { ...EMPTY_PLAN, extraReadOnly: [BUILD_ROOT] }, "/scope", "/priv/strace.log", "/scope/run-input.json");
    const sandboxArgs = withBuild.args.slice(withBuild.args.indexOf("-o") + 2);
    const roAt = sandboxArgs.findIndex((arg, i) => arg === "--ro-bind" && sandboxArgs[i + 1] === BUILD_ROOT && sandboxArgs[i + 2] === BUILD_ROOT);
    expect(roAt).toBeGreaterThan(sandboxArgs.indexOf("--tmpfs"));
    const sandboxEnd = afterStrace.indexOf("--", 2);
    expect(afterStrace.slice(sandboxEnd + 1, sandboxEnd + 3)).toEqual([process.execPath, "--disable-sigusr1"]);
    expect(traced.args.at(-1)).toBe("/scope/run-input.json");
    const plain = untracedCommand(TOOLS, EMPTY_PLAN, "/scope", "/scope/run-input.json");
    expect(plain.file).toBe(TOOLS.prlimit);
    expect(plain.args.slice(0, 3)).toEqual([CORE_LIMIT, "--", TOOLS.bwrap]);
    expect(plain.args.slice(plain.args.indexOf("--", 2) + 1, plain.args.indexOf("--", 2) + 3)).toEqual([process.execPath, "--disable-sigusr1"]);
    expect(plain.args.at(-1)).toBe("/scope/run-input.json");
  });

  it("resolves tools once to absolute paths from the supervisor's PATH and fails closed", async () => {
    const present = new Set(["/opt/a/strace", "/opt/b/prlimit", "/opt/b/git", "/opt/b/codegraph", "/opt/b/bwrap", "/rel/strace"]);
    const exists = async (path: string) => present.has(path);
    expect(await resolveTools("/opt/a:/opt/b", exists)).toEqual({ strace: "/opt/a/strace", prlimit: "/opt/b/prlimit", git: "/opt/b/git", codegraph: "/opt/b/codegraph", bwrap: "/opt/b/bwrap" });
    // A relative PATH entry (the worker's cwd, for instance) is never used.
    await expect(resolveTools("rel:/opt/b", exists)).rejects.toThrow("strace_missing");
    present.delete("/opt/b/codegraph");
    await expect(resolveTools("/opt/a:/opt/b", exists)).rejects.toThrow("codegraph_missing");
    present.add("/opt/b/codegraph");
    present.delete("/opt/b/bwrap");
    await expect(resolveTools("/opt/a:/opt/b", exists)).rejects.toThrow("bwrap_missing");
  });

  it("hands the resolved tools to scope preparation, the oracle wrap and the spawn, and refuses when one is missing", async () => {
    const s = await waveSetup(1, { kind: "implementation" });
    const seen: ToolPaths[] = [];
    const wraps: string[][] = [];
    const scored: WaveDeps["scoreImplementation"] = async (_c, _t, options) => {
      const argv = options.wrap!(["npm", "test"]);
      wraps.push(argv);
      await writeFile(argv[argv.indexOf("-o") + 1]!, benignTrace());
      return { accepted: true, testsPassed: true, outOfScope: [] };
    };
    const { deps } = s.deps([text()], {
      scoreImplementation: scored, prepareScope: async (input) => { seen.push(input.tools as ToolPaths); return fakePrepare(input); },
    });
    await runWave(s.input, deps);
    expect(seen[0]).toMatchObject({ git: TOOLS.git, codegraph: TOOLS.codegraph });
    expect(wraps[0]![0]).toBe(TOOLS.strace);
    const missing = await waveSetup(1);
    const failing = missing.deps([text()], { resolveTools: async () => { throw new Error("strace_missing"); } });
    await expect(runWave(missing.input, failing.deps)).rejects.toThrow("strace_missing");
    expect(failing.captured).toHaveLength(0);
  });

  it("refuses a wave directory inside a source repository or containing one", async () => {
    const root = await temporaryRoot("ablation-wave-dir-");
    const source = join(root, "repo");
    await mkdir(join(source, "eval", "results"), { recursive: true });
    await assertWaveDirOutsideSources(join(root, "elsewhere", "wave"), [source]);
    await expect(assertWaveDirOutsideSources(join(source, "eval", "results", "wave"), [source])).rejects.toThrow("wave_dir_in_source");
    await expect(assertWaveDirOutsideSources(source, [source])).rejects.toThrow("wave_dir_in_source");
    await expect(assertWaveDirOutsideSources(root, [source])).rejects.toThrow("wave_dir_in_source");
    // A symlinked route into the repository does not hide it.
    await symlink(source, join(root, "alias"));
    await expect(assertWaveDirOutsideSources(join(root, "alias", "wave"), [source])).rejects.toThrow("wave_dir_in_source");
    await expect(assertWaveDirOutsideSources(join(root, "repo-two", "wave"), [source])).resolves.toBeUndefined();
  });

  it("makes runWave and runPreflight refuse that layout before anything starts", async () => {
    const s = await waveSetup(1);
    const inside = { ...productionConfig, workspaces: { repo: join(s.waveDir, "..") } };
    const { deps, captured } = s.deps([text()]);
    await expect(runWave({ ...s.input, productionConfig: inside }, deps)).rejects.toThrow("wave_dir_in_source");
    expect(captured).toHaveLength(0);
    expect(existsSync(s.waveDir)).toBe(false);
    const tasks = s.input.tasks;
    const approval = approvalFor(tasks, s.runs);
    await expect(runPreflight({ approval, waveDir: s.waveDir, ledgerPath: s.input.ledgerPath, productionConfig: inside, hostAuth: {} }, { hostCheck: async () => undefined, containmentCheck: async () => undefined, planSandbox: async () => EMPTY_PLAN, resolveTools: async () => TOOLS })).rejects.toThrow("wave_dir_in_source");
  });

  it("gives the scope no session bus and no runtime directory, whatever the supervisor has", async () => {
    const saved = { runtime: process.env.XDG_RUNTIME_DIR, bus: process.env.DBUS_SESSION_BUS_ADDRESS };
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
    try {
      const env = scopeEnv("/scope", { home: "/scope/home", agentDir: "/scope/agent" });
      expect(env).not.toHaveProperty("XDG_RUNTIME_DIR");
      expect(env).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
      expect(Object.values(env).every((value) => !value.includes("/run/user"))).toBe(true);
    } finally {
      if (saved.runtime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved.runtime;
      if (saved.bus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = saved.bus;
    }
  });
});
