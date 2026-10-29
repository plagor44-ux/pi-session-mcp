import { EventEmitter } from "node:events";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { scriptPath, h, stubbornClient, cliDriver, notLinux, type Recorded, recordedProcesses, stillAlive, killAll, FIXTURE_RUN_TIMEOUT, runNode, EXTENSION, put, buildRun, sources, rerecord, orchestration, codexValues, variants } from "./multi-session-acceptance-fixtures.js";

// Removing the temporary roots can exceed the default 10 s hook timeout on slow macOS runners (#125).
afterAll(removeTemporaryRoots, 120_000);

// Safety net: a launch that a test expects to be refused must never reach a real client or a model. Stand-ins
// named `claude` and `codex` come first on PATH for the whole file; tests that need a working client put their own before them.
let pathBeforeGuard: string | undefined;
beforeAll(async () => {
  const guard = join(await temporaryRoot("msa-guard-"), "bin");
  mkdirSync(guard, { recursive: true });
  for (const name of ["claude", "codex"]) writeFileSync(join(guard, name), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  pathBeforeGuard = process.env.PATH;
  process.env.PATH = `${guard}:${pathBeforeGuard ?? ""}`;
});
afterAll(() => { if (pathBeforeGuard === undefined) delete process.env.PATH; else process.env.PATH = pathBeforeGuard; });

describe.skipIf(notLinux)("runs against a synthetic layout with a controlled client", () => {
  async function withFakeClient<T>(mode: string, body: (context: { statePath: string; touched: string }) => Promise<T>, run: Awaited<ReturnType<typeof buildRun>>, touch?: string, client = "claude"): Promise<T> {
    const bin = join(run.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, client), `#!${process.execPath}\nimport(${JSON.stringify(stubbornClient)});\n`, { mode: 0o755 });
    const touched = touch ?? join(run.run, "controller-claude", ".claude", "skills", "pi-session-orchestration", "SKILL.md");
    const saved = { PATH: process.env.PATH, MODE: process.env.FAKE_CLIENT_MODE, STATE: process.env.FAKE_CLIENT_STATE, TOUCH: process.env.FAKE_CLIENT_TOUCH };
    const statePath = join(run.root, "client-state.json");
    process.env.PATH = `${bin}:${saved.PATH ?? ""}`; process.env.FAKE_CLIENT_MODE = mode; process.env.FAKE_CLIENT_STATE = statePath; process.env.FAKE_CLIENT_TOUCH = touched;
    try { return await body({ statePath, touched }); } finally {
      for (const [key, value] of [["PATH", saved.PATH], ["FAKE_CLIENT_MODE", saved.MODE], ["FAKE_CLIENT_STATE", saved.STATE], ["FAKE_CLIENT_TOUCH", saved.TOUCH]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
  const values = (run: Awaited<ReturnType<typeof buildRun>>, extra: Record<string, string> = {}) => ({ run: run.run, client: "claude", scenario: "parallel", ...extra });
  const quick = { graceMs: 300, killWaitMs: 2_000, drainMs: 300 };
  // Every launch reads the operator-machine inputs from the run's temporary home.
  const launch = (run: Awaited<ReturnType<typeof buildRun>>, extra: Record<string, unknown> = {}) => ({ signals: new EventEmitter(), budgets: quick, home: run.home, etcCodexSkills: run.etc, ancestorBoundary: run.root, ...extra });
  const reanalyze = (run: Awaited<ReturnType<typeof buildRun>>) => h.reanalyze(values(run), { home: run.home, etcCodexSkills: run.etc, ancestorBoundary: run.root });

  it.each(sources)("refuses a Codex run before launch while a differing controller skill sits in %s (%s)", async (name, _label, dir) => {
    const run = await buildRun();
    put(join(dir(run), orchestration, "SKILL.md"), "an older copy\n");
    rerecord(run);
    await expect(h.runClient(codexValues(run), launch(run))).rejects.toThrow(`Codex skill source (${name})`);
    await expect(h.runClient(codexValues(run), launch(run))).rejects.toThrow("Codex could read it instead");
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
    expect(existsSync(join(run.priv, "launches"))).toBe(false);
  });

  it.each(variants)("refuses a Codex run before launch for %s", async (_label, name, place) => {
    const run = await buildRun();
    place(run);
    rerecord(run);
    await expect(h.runClient(codexValues(run), launch(run))).rejects.toThrow(`Codex skill source (${name})`);
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
    expect(existsSync(join(run.priv, "launches"))).toBe(false);
  });

  it.each(sources)("launches a Codex run while an equal controller skill sits in %s (%s)", async (_name, _label, dir) => {
    const run = await buildRun();
    cpSync(join(run.candidate, "skills", orchestration), join(dir(run), orchestration), { recursive: true });
    rerecord(run);
    const result = await withFakeClient<any>("record-env", () => h.runClient(codexValues(run), launch(run)), run, undefined, "codex");
    expect(result.exitCode).toBe(0);
    expect(result.resources).toEqual({ changedBeforeLaunch: [], changedAfterRun: [] });
  }, 60_000);

  it("does not apply the Codex refusal to a Claude Code run", async () => {
    const run = await buildRun();
    put(join(run.etc, orchestration, "SKILL.md"), "an older copy\n");
    put(join(run.home, ".agents", "skills", orchestration, "SKILL.md"), "an older copy\n");
    rerecord(run);
    const result = await withFakeClient<any>("record-env", () => h.runClient(values(run), launch(run)), run);
    expect(result.exitCode).toBe(0);
    expect(result.resources.changedAfterRun).toEqual([]);
  }, 60_000);

  it("refuses to launch a Codex run when a Codex skill source changed after prepare", async () => {
    const run = await buildRun();
    put(join(run.etc, "other", "SKILL.md"), "x");
    await expect(h.runClient(codexValues(run), launch(run))).rejects.toThrow('resourcesChanged: ["etcCodexSkills"]');
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
  });

  it("fails a Codex run whose recorded CODEX_HOME gained a bundled skill during the run", async () => {
    const run = await buildRun();
    mkdirSync(join(run.codexHome, "skills", ".system", "late"), { recursive: true });
    rerecord(run);
    const result = await withFakeClient<any>("mutate", () => h.runClient(codexValues(run), launch(run)), run, join(run.codexHome, "skills", ".system", "late", "SKILL.md"), "codex");
    expect(result.resources.changedAfterRun).toEqual(["codexHomeSkills"]);
    expect(result.acceptance.failures).toContain("resourcesChanged");
  }, 60_000);

  it("starts the Codex controller with the CODEX_HOME recorded at prepare, whatever the launching environment holds", async () => {
    const run = await buildRun();
    const other = join(run.root, "another-codex-home");
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = other;
    try {
      const result = await withFakeClient<any>("record-env", () => h.runClient(codexValues(run), launch(run)), run, undefined, "codex");
      expect(JSON.parse(readFileSync(join(run.root, "client-state.json"), "utf8"))).toEqual({ CODEX_HOME: run.codexHome });
      expect(result.resources).toEqual({ changedBeforeLaunch: [], changedAfterRun: [] });
      // the other directory was never bound: its skills do not change the run
      put(join(other, "skills", "late", "SKILL.md"), "x");
      expect(h.reanalyze(codexValues(run), { home: run.home, etcCodexSkills: run.etc, ancestorBoundary: run.root }).resources.changedAfterRun).toEqual([]);
    } finally { if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved; }
  }, 60_000);

  it("leaves the environment of a Claude Code controller as it was launched", async () => {
    const run = await buildRun();
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(run.root, "another-codex-home");
    try {
      await withFakeClient<any>("record-env", () => h.runClient(values(run), launch(run)), run);
      expect(JSON.parse(readFileSync(join(run.root, "client-state.json"), "utf8"))).toEqual({ CODEX_HOME: join(run.root, "another-codex-home") });
    } finally { if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved; }
  }, 60_000);

  it("refuses to launch while a bound resource is unbound, although its value did not change", async () => {
    const run = await buildRun();
    for (const name of ["a", "b", "c"]) put(join(run.home, ".agents", "skills", "skill", name), name);
    rerecord(run, { boundLimit: 1 });
    appendFileSync(join(run.home, ".agents", "skills", "skill", "a"), "changed\n");
    await expect(h.runClient(values(run), launch(run, { boundLimit: 1 }))).rejects.toThrow('resourcesUnbound: ["homeAgentsSkills"]');
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
    expect(existsSync(join(run.priv, "launches"))).toBe(false);
  });

  it("lets a reanalysis find a resource that became unbound after a clean run, and never pass it", async () => {
    const run = await buildRun();
    for (const name of ["a", "b"]) put(join(run.home, ".agents", "skills", "skill", name), name);
    rerecord(run);
    const clean = await withFakeClient<any>("record-env", () => h.runClient(values(run), launch(run)), run);
    expect(clean.unboundResources).toEqual([]);
    const again = h.reanalyze(values(run), { home: run.home, etcCodexSkills: run.etc, ancestorBoundary: run.root, boundLimit: 1 });
    expect(again.unboundResources).toEqual(["homeAgentsSkills"]);
    expect(again.acceptance.passed).toBe(false);
    expect(again.acceptance.failures).toContain("resourcesUnbound");
  }, 60_000);

  // The candidate's skill roots may be links: the content behind them is bound as well.
  const linkedRoots: Array<[string, string, string, string]> = [
    ["controller skill", "pi-session-orchestration", "codexControllerSkill", "codex"],
    ["implementation worker skill", "pi-session-implementation", "workerSkillImplementation", "claude"],
    ["review worker skill", "pi-session-review", "workerSkillReview", "claude"],
  ];
  it.each(linkedRoots)("refuses to launch when content behind a symlinked candidate %s root changed", async (_label, skillName, key, client) => {
    const run = await buildRun();
    const store = join(run.root, "skill-store", skillName);
    mkdirSync(join(run.root, "skill-store"), { recursive: true });
    const root = join(run.candidate, "skills", skillName);
    renameSync(root, store);
    symlinkSync(store, root);
    rerecord(run);
    // the Codex link in the controller directory points at the candidate's skill path, which is now a link itself
    expect(run.info.resources[key]).toMatch(/^[0-9a-f]{64}$/);
    appendFileSync(join(store, "SKILL.md"), "changed behind the link\n");
    await expect(h.runClient({ run: run.run, client, scenario: "parallel" }, launch(run))).rejects.toThrow(`resourcesChanged: ["${key}"]`);
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
    expect(existsSync(join(run.priv, "launches"))).toBe(false);
  });

  it("refuses to launch when a bound resource changed after prepare", async () => {
    const run = await buildRun();
    appendFileSync(join(run.candidate, "skills", "pi-session-review", "SKILL.md"), "x");
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow('resourcesChanged: ["workerSkillReview"]');
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
  });

  it("refuses to launch when an extension file changed after prepare, and records nothing", async () => {
    const run = await buildRun({ extensions: true });
    appendFileSync(join(run.agentDir, "npm", "node_modules", EXTENSION, "index.js"), "// changed\n");
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow(`resourcesChanged: ${JSON.stringify([`extension:${EXTENSION}`, "extensionNpmInstallation"])}`);
    expect(readdirSync(join(run.priv, "results"))).toEqual([]);
    expect(existsSync(join(run.priv, "launches"))).toBe(false);
  });

  it.each([
    ["a dependency file", (r: Awaited<ReturnType<typeof buildRun>>) => join(r.agentDir, "npm", "node_modules", "dep", "index.js")],
    ["the npm lockfile", (r: Awaited<ReturnType<typeof buildRun>>) => join(r.agentDir, "npm", "package-lock.json")],
  ])("refuses to launch when %s changed after prepare", async (_label, file) => {
    const run = await buildRun({ extensions: true });
    appendFileSync(file(run), "\n");
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow('resourcesChanged: ["extensionNpmInstallation"]');
  });

  it.each([
    ["an extension file", [`extension:${EXTENSION}`, "extensionNpmInstallation"], (r: Awaited<ReturnType<typeof buildRun>>) => join(r.agentDir, "npm", "node_modules", EXTENSION, "index.js")],
    ["a dependency file", ["extensionNpmInstallation"], (r: Awaited<ReturnType<typeof buildRun>>) => join(r.agentDir, "npm", "node_modules", "dep", "index.js")],
    ["the npm lockfile", ["extensionNpmInstallation"], (r: Awaited<ReturnType<typeof buildRun>>) => join(r.agentDir, "npm", "package-lock.json")],
  ])("fails the result with resourcesChanged when %s changed during the run", async (_label, expected, file) => {
    const run = await buildRun({ extensions: true });
    const result = await withFakeClient<any>("mutate", () => h.runClient(values(run), launch(run)), run, file(run));
    expect(result.resources).toEqual({ changedBeforeLaunch: [], changedAfterRun: expected });
    expect(result.acceptance.passed).toBe(false);
    expect(result.acceptance.failures).toContain("resourcesChanged");
    // a reanalysis finds the same drift and the original state alike
    expect(reanalyze(run).resources.changedAfterRun).toEqual(expected);
  }, 60_000);

  it.each([["claude", "cc"], ["codex", "cx"]])("runs the trio scenario for the %s client: three fixtures judged, a verdict that cannot pass without a transcript, and the result in the evidence", async (client, prefix) => {
    const run = await buildRun();
    const result = await withFakeClient<any>("record-env", () => h.runClient({ run: run.run, client, scenario: "trio" }, launch(run)), run, undefined, client);
    expect(result).toMatchObject({ client, scenario: "trio", exitCode: 0, timedOut: false });
    expect(result.analysisFailed).toBeUndefined();
    expect(Object.keys(result.oracle)).toEqual(["slug", "wait", "review"]);
    expect(result.oracle.review).toMatchObject({ onlyAllowedChanges: true, readOnlyInvariant: true });
    expect(result.transcript.sessionsStarted).toBe(0);
    expect(result.acceptance.passed).toBe(false);
    expect(result.acceptance.failures).toEqual(expect.arrayContaining(["sessionsNotStarted", "sessionAssociation", "noOverlap", "abortFailed", "neighborsNotRunningDuringAbort", "workerSkills"]));
    // the fixtures of the other scenarios are not part of this verdict
    expect(result.acceptance.failures).not.toContain("oracleMissing");
    expect(result.endState.fixtures).toEqual({ slug: expect.any(String), wait: expect.any(String), review: expect.any(String) });
    expect(readdirSync(join(run.priv, "results"))).toEqual([`${client}-trio.json`]);
    expect(JSON.parse(readFileSync(join(run.priv, "launches", `${client}-trio.json`), "utf8"))).toHaveProperty("launchedAt");
    const reanalysis = h.reanalyze({ run: run.run, client, scenario: "trio" }, { home: run.home, etcCodexSkills: run.etc, ancestorBoundary: run.root });
    expect(reanalysis.reanalysis.stateChanges).toEqual({ resources: [], fixtures: [] });
    expect(Object.keys(reanalysis.oracle)).toEqual(["slug", "wait", "review"]);
    const out = join(run.root, `evidence-${prefix}.json`);
    h.evidence({ run: run.run, out });
    const record = JSON.parse(readFileSync(out, "utf8"));
    expect(record.results.map((entry: { scenario: string }) => entry.scenario)).toEqual(["trio"]);
    expect(record.results[0].oracle.review.readOnlyInvariant).toBe(true);
    expect(record.launches).toEqual([{ label: `${client}-trio`, launchedAt: expect.any(String), hasResult: true }]);
    expect(record.reanalyses.map((entry: { file: string }) => entry.file)).toEqual([`${client}-trio-001`]);
  }, 60_000);

  it("fails a trio run in which the controller's client changed the review fixture", async () => {
    const run = await buildRun();
    const chunk = join(run.controller("claude"), "fixtures", "review", "src", "chunk.js");
    const result = await withFakeClient<any>("mutate", () => h.runClient({ run: run.run, client: "claude", scenario: "trio" }, launch(run)), run, chunk);
    expect(result.oracle.review.readOnlyInvariant).toBe(false);
    expect(result.acceptance.failures).toEqual(expect.arrayContaining(["review:changes", "review:readOnly"]));
  }, 60_000);

  it("refuses a scenario that is none of parallel, abort and trio", async () => {
    const run = await buildRun();
    await expect(h.runClient({ run: run.run, client: "claude", scenario: "quartet" }, launch(run))).rejects.toThrow("--scenario parallel|abort|trio");
    expect(existsSync(join(run.priv, "launches"))).toBe(false);
  });

  it("refuses to launch on a fixture that already differs from its baseline", async () => {
    const run = await buildRun();
    writeFileSync(join(run.controller("claude"), "fixtures", "stats", "stray.txt"), "x");
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow('fixturesChanged: ["stats"]');
  });

  it("records a resource that changed during the run, never passes it, and keeps the original result across reanalyses", async () => {
    const run = await buildRun();
    const resultPath = join(run.priv, "results", "claude-parallel.json");
    const result = await withFakeClient<any>("mutate", () => h.runClient(values(run), launch(run)), run);
    expect(result.resources).toEqual({ changedBeforeLaunch: [], changedAfterRun: ["controllerSkill"] });
    expect(result.acceptance.passed).toBe(false);
    expect(result.acceptance.failures).toContain("resourcesChanged");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    const original = readFileSync(resultPath, "utf8");
    // the original result is written once, never replaced
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow("already ran");
    expect(readFileSync(resultPath, "utf8")).toBe(original);

    const first = reanalyze(run);
    expect(readFileSync(resultPath, "utf8")).toBe(original);
    expect(readdirSync(join(run.priv, "reanalyses"))).toEqual(["claude-parallel-001.json"]);
    expect(first.reanalysis.stateChanges).toEqual({ resources: [], fixtures: [] });
    expect(first.endState).toBeUndefined();

    // a fixture changed after the original run: marked, cannot pass
    writeFileSync(join(run.controller("claude"), "fixtures", "stats", "after.txt"), "x");
    const second = reanalyze(run);
    expect(second.reanalysis.stateChanges.fixtures).toEqual(["stats"]);
    expect(second.acceptance.passed).toBe(false);
    expect(second.acceptance.failures).toContain("stateChangedSinceRun");
    // a bound resource changed after the original run
    appendFileSync(join(run.priv, "config.json"), " ");
    const third = reanalyze(run);
    expect(third.reanalysis.stateChanges.resources).toEqual(["runConfiguration"]);
    expect(third.resources.changedAfterRun).toContain("runConfiguration");
    expect(readFileSync(resultPath, "utf8")).toBe(original);
    expect(readdirSync(join(run.priv, "reanalyses"))).toEqual(["claude-parallel-001.json", "claude-parallel-002.json", "claude-parallel-003.json"]);

    // evidence: the original result, with reanalyses listed separately
    const out = join(run.root, "evidence.json");
    h.evidence({ run: run.run, out });
    const record = JSON.parse(readFileSync(out, "utf8"));
    expect(record.results).toHaveLength(1);
    expect(record.results[0].reanalysis).toBeUndefined();
    expect(record.reanalyses.map((entry: { file: string }) => entry.file)).toEqual(["claude-parallel-001", "claude-parallel-002", "claude-parallel-003"]);
    expect(record.resources.controllerSkill).toMatch(/^[0-9a-f]{64}$/);
    expect(record.extensions).toEqual([]);
    expect(record.profiles).toEqual(["accept-read", "accept-code", "accept-code-handshake"]);
    const text = readFileSync(out, "utf8");
    for (const secret of [run.info.token, run.run, run.candidate]) expect(text).not.toContain(secret);
  }, 60_000);

  it("keeps a failing result and the launch record when the worker deleted a file the oracle reads", async () => {
    const run = await buildRun();
    const slugTest = join(run.controller("claude"), "fixtures", "slug", "test", "slug.test.js");
    const result = await withFakeClient<any>("delete", () => h.runClient(values(run), launch(run)), run, slugTest);
    expect(result.analysisFailed).toBeUndefined();
    expect(result.oracle.slug.addedTest).toBe(false);
    // The file is in the slug scope, so only the missing test fails the run, not the scope check.
    expect(result.acceptance.failures).toContain("slug:followUp");
    expect(result.acceptance.passed).toBe(false);
    expect(readdirSync(join(run.priv, "results"))).toEqual(["claude-parallel.json"]);
    expect(readdirSync(join(run.priv, "launches"))).toEqual(["claude-parallel.json"]);
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow("already ran");
  }, 60_000);

  it("records a never-passing result, ends the run's processes and exits when a signal arrives during the analysis", async () => {
    const run = await buildRun();
    const signals = new EventEmitter();
    // The second SIGINT listener is the analysis guard; the first one belonged to the supervision. A microtask
    // queued at its registration runs before the continuation that would write the analysis result.
    let registrations = 0;
    signals.on("newListener", (event) => { if (event === "SIGINT" && ++registrations === 2) queueMicrotask(() => signals.emit("SIGINT")); });
    const exits: number[] = [];
    const result = await withFakeClient<any>("mutate", () => h.runClient(values(run), launch(run, { signals, exit: (code: number) => { exits.push(code); } })), run);
    expect(exits).toEqual([1]);
    expect(result).toMatchObject({ harnessAborted: true, abortSignal: "SIGINT", analysisFailed: true, exitCode: 0, timedOut: false });
    expect(result.acceptance).toEqual({ passed: false, failures: ["harnessAborted", "analysisFailed"] });
    expect(JSON.parse(readFileSync(join(run.priv, "results", "claude-parallel.json"), "utf8"))).toEqual(result);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    // A reanalysis of the unfinished result names the failed analysis itself, not only its side effects.
    expect(reanalyze(run).acceptance.failures).toContain("analysisFailed");
    await expect(h.runClient(values(run), launch(run))).rejects.toThrow("already ran");
  }, 60_000);

  it("keeps the supervision's classification in a result recorded after a signal during the analysis", async () => {
    const run = await buildRun();
    const signals = new EventEmitter();
    let registrations = 0;
    signals.on("newListener", (event) => { if (event === "SIGINT" && ++registrations === 2) queueMicrotask(() => signals.emit("SIGINT")); });
    const result = await withFakeClient<any>("ignore-term", () => h.runClient(values(run, { "timeout-min": "0.01" }), launch(run, { signals, exit: () => {} })), run);
    expect(result).toMatchObject({ timedOut: true, harnessAborted: true, abortSignal: "SIGINT", analysisFailed: true });
    expect(result.acceptance).toEqual({ passed: false, failures: ["timedOut", "harnessAborted", "analysisFailed"] });
  }, 60_000);

  it("records the signal that ended the supervision, not a later one during the analysis", async () => {
    const run = await buildRun();
    const signals = new EventEmitter();
    let registrations = 0;
    signals.on("newListener", (event) => {
      if (event !== "SIGINT") return;
      registrations += 1;
      // First registration: the supervision, which a SIGTERM ends. Second: the analysis guard, which a SIGINT hits.
      if (registrations === 1) setTimeout(() => signals.emit("SIGTERM"), 200);
      if (registrations === 2) queueMicrotask(() => signals.emit("SIGINT"));
    });
    const result = await withFakeClient<any>("ignore-term", () => h.runClient(values(run), launch(run, { signals, exit: () => {} })), run);
    expect(result).toMatchObject({ harnessAborted: true, abortSignal: "SIGTERM", analysisFailed: true, timedOut: false });
    expect(result.acceptance).toEqual({ passed: false, failures: ["harnessAborted", "analysisFailed"] });
  }, 60_000);

  it("lists every launch in the evidence and marks one that left no result", async () => {
    const run = await buildRun();
    await withFakeClient<any>("mutate", () => h.runClient(values(run), launch(run)), run);
    // An attempt whose harness died before it wrote a result leaves only its launch record.
    writeFileSync(join(run.priv, "launches", "claude-abort.json"), JSON.stringify({ launchedAt: "2026-10-12T20:00:00.000Z" }));
    const out = join(run.root, "evidence.json");
    h.evidence({ run: run.run, out });
    const record = JSON.parse(readFileSync(out, "utf8"));
    expect(record.launches).toEqual([
      { label: "claude-abort", launchedAt: "2026-10-12T20:00:00.000Z", hasResult: false },
      { label: "claude-parallel", launchedAt: expect.any(String), hasResult: true },
    ]);
    expect(record.results.map((result: { scenario: string }) => result.scenario)).toEqual(["parallel"]);
  }, 60_000);

  it("ends the CLI entry by itself with a non-zero exit when the client ignores SIGTERM and holds stdout open", async () => {
    const run = await buildRun();
    const bin = join(run.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nimport(${JSON.stringify(stubbornClient)});\n`, { mode: 0o755 });
    const statePath = join(run.root, "client-state.json");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_CLIENT_MODE: "ignore-term", FAKE_CLIENT_STATE: statePath };
    let processes: Recorded[] = [];
    try {
      const result = await runNode([cliDriver, run.home, run.etc, run.root, "run", "--run", run.run, "--client", "claude", "--scenario", "parallel", "--timeout-min", "0.05"], { env, limitMs: 60_000 });
      if (existsSync(statePath)) processes = recordedProcesses(statePath);
      expect(result.code, result.stderr).toBe(1);
      expect(result.wallMs).toBeLessThan(40_000);
      const stored = JSON.parse(readFileSync(join(run.priv, "results", "claude-parallel.json"), "utf8"));
      expect(stored).toMatchObject({ timedOut: true, spawnFailed: false, harnessAborted: false });
      expect(stored.acceptance.passed).toBe(false);
      expect(stored.acceptance.failures).toContain("timedOut");
      expect(JSON.parse(result.stdout).timedOut).toBe(true);
      expect(processes).toHaveLength(3);
      expect(stillAlive(processes)).toEqual([]);
      expect(result.stdout + result.stderr).not.toContain(run.run);
    } finally { killAll(processes); }
  }, 90_000);

  it("rejects an invalid --timeout-min on the CLI before doing anything", async () => {
    const result = await runNode([scriptPath, "run", "--run", "/nonexistent", "--client", "claude", "--scenario", "parallel", "--timeout-min", "NaN"], { limitMs: 15_000 });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--timeout-min");
  });

  it("does not run a subcommand when imported", () => {
    expect(typeof h.superviseProcess).toBe("function");
  });
});

// ---- D4: controlled extension support ------------------------------------------------------------
describe("extension allowlist", FIXTURE_RUN_TIMEOUT, () => {
  it("accepts only exact npm:<name>@<version> pins and reports names and versions", () => {
    expect(h.parseExtensionAllowlist(["npm:pi-cursor-sdk@0.5.3", "npm:@scope/ext@1.0.0-rc.1"])).toEqual([
      { spec: "npm:pi-cursor-sdk@0.5.3", name: "pi-cursor-sdk", version: "0.5.3" },
      { spec: "npm:@scope/ext@1.0.0-rc.1", name: "@scope/ext", version: "1.0.0-rc.1" },
    ]);
    const bad: unknown[] = [undefined, "npm:x@1.0.0", [], ["npm:x@^1.0.0"], ["npm:x@latest"], ["npm:x@1.0"], ["npm:x@1.0.0+build"], ["git+https://example.invalid/x.git"],
      ["./local"], ["x@1.0.0"], [7], ["npm:x@1.0.0", "npm:x@1.0.1"], Array.from({ length: 9 }, (_, i) => `npm:e${i}@1.0.0`)];
    for (const list of bad) expect(() => h.parseExtensionAllowlist(list), JSON.stringify(list)).toThrow(h.HarnessFailure);
  });

  it("points setup's Doctor at Pi's install only for an extension profile", () => {
    const base = ["HOME=/run/h", "PATH=/usr/bin", "PI_SESSION_MCP_CONFIG=/run/c.json"];
    expect(h.setupEnvironment("/run/h", "/usr/bin", "/run/c.json", false, {})).toEqual(base);
    expect(h.setupEnvironment("/run/h", "/usr/bin", "/run/c.json", true, { PI_CODING_AGENT_DIR: "/opt/pi-agent" })).toEqual([...base, "PI_CODING_AGENT_DIR=/opt/pi-agent"]);
    expect(h.setupEnvironment("/run/h", "/usr/bin", "/run/c.json", true, {})).toEqual([...base, `PI_CODING_AGENT_DIR=${join(homedir(), ".pi", "agent")}`]);
  });

  async function prepareFailure(profile: Record<string, unknown>, flags: Record<string, boolean>): Promise<string> {
    const run = await buildRun();
    const baseConfig = join(run.root, "base.json");
    writeFileSync(baseConfig, JSON.stringify({ executionProfiles: { source: profile } }));
    try { h.prepare({ candidate: run.candidate, "base-config": baseConfig, "from-profile": "source", ...flags }); } catch (error) { return (error as Error).message; }
    return "";
  }
  const base = { provider: "p", model: "m", thinkingLevel: "off", permissionProfile: "read-only", default: true };

  it("rejects a source profile with extensions unless --with-extensions is given", async () => {
    expect(await prepareFailure({ ...base, extensions: ["npm:x@1.0.0"] }, {})).toContain("--with-extensions");
  }, 60_000);
  it("rejects --with-extensions on a profile without extensions, invalid pins and MCP servers", async () => {
    expect(await prepareFailure(base, { "with-extensions": true })).toContain("needs a profile that has extensions");
    expect(await prepareFailure({ ...base, extensions: ["npm:x@^1.0.0"] }, { "with-extensions": true })).toContain("exact npm:<name>@<version>");
    expect(await prepareFailure({ ...base, extensions: ["npm:x@1.0.0"], mcpServers: {} }, { "with-extensions": true })).toContain("without MCP servers");
    expect(await prepareFailure({ ...base, mcpServers: {} }, {})).toContain("without MCP servers");
  }, 60_000);
});

// ---- D5: updatedAt liveness ----------------------------------------------------------------------
describe("updatedAt liveness", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const turnId = "22222222-2222-4222-8222-222222222222";
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  const info = { candidate: "/nowhere", token: "tok", version: "1", configFingerprint: "f" };
  const turn = (state: string, updated: number, extra: Record<string, unknown> = {}) => ({ ok: true, turn: { turnId, sessionId, state, startedAt: at(0), updatedAt: at(updated), ...extra } });
  const calls = (polls: Array<ReturnType<typeof turn>>) => [
    { tool: "pi_capabilities_get", input: {}, result: { ok: true, server: { version: "1" }, configuration: { fingerprint: "f" }, executionProfiles: [] } },
    { tool: "pi_session_start", input: {}, result: { ok: true, session: { id: sessionId, workspace: "cc-slug", executionProfile: "accept-code" } } },
    { tool: "pi_session_prompt", input: { sessionId, prompt: "p" }, result: turn("running", 0) },
    ...polls.map((result) => ({ tool: "pi_turn_get", input: { sessionId, turnId }, result })),
  ];

  it("counts running polls and notes whether updatedAt moved past startedAt before completion", () => {
    const analysis = h.analyze("claude", "parallel", calls([turn("running", 0), turn("running", 4), turn("running", 9), turn("completed", 12, { completedAt: at(12) })]), info, "");
    expect(analysis.sessions).toHaveLength(1);
    expect(analysis.sessions[0].turnLiveness).toEqual([{ runningPolls: 3, updatedAtAdvancedWhileRunning: true }]);
    expect(analysis.sessions[0].polls).toBe(4);
  });

  it("reports false when updatedAt stayed at startedAt while running, and for a turn that never was observed running", () => {
    const stuck = h.analyze("claude", "parallel", calls([turn("running", 0), turn("running", 0), turn("completed", 12, { completedAt: at(12) })]), info, "");
    expect(stuck.sessions[0].turnLiveness).toEqual([{ runningPolls: 2, updatedAtAdvancedWhileRunning: false }]);
    // An advance seen only on the completed record does not count: it is not "while running".
    const late = h.analyze("claude", "parallel", calls([turn("completed", 12, { completedAt: at(12) })]), info, "");
    expect(late.sessions[0].turnLiveness).toEqual([{ runningPolls: 0, updatedAtAdvancedWhileRunning: false }]);
  });
});
