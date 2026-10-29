import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { h, FIXTURE_RUN_TIMEOUT, SLUG_OK, fixtureWithBaseline, compare, commitAll, buildRun, type Run, prepareRun } from "./multi-session-acceptance-fixtures.js";

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

// ---- #68: the handshake skill only for the slug task ----------------------------------------------------
describe("handshake profile split", () => {
  const info = { node: process.execPath, entry: "/entry.js", agentDir: "/agent" };
  const lineWith = (text: string, needle: string) => text.split("\n").find((line) => line.includes(needle)) ?? "";

  it("names the profile of each task in the controller prompt", () => {
    const text = h.command("claude", info, "/private", "/controller", { scenario: "parallel" }).args[1] as string;
    expect(lineWith(text, "- SLUG:")).toContain("`accept-code-handshake`");
    expect(lineWith(text, "- STATS:")).toContain("`accept-code`");
    expect(lineWith(text, "- STATS:")).not.toContain("accept-code-handshake");
    expect(lineWith(text, "Use the execution profile")).toContain("no other session uses `accept-code-handshake`");
    // the Codex controller gets the same task text
    const codex = h.command("codex", info, "/private", "/controller", { scenario: "parallel" }).args as string[];
    expect(codex.at(-1)).toContain("- SLUG: execution profile `accept-code-handshake`");
  });

  it("offers only accept-code to the tasks of the abort scenario", () => {
    for (const client of ["claude", "codex"]) {
      const args = h.command(client, info, "/private", "/controller", { scenario: "abort" }).args as string[];
      const text = (client === "claude" ? args[1] : args.at(-1)) as string;
      expect(text).toContain("Use the execution profile `accept-code` for every task.");
      expect(text).not.toContain("accept-code-handshake");
    }
  });

  it("mentions the handshake only in the parallel prompt, where SLUG and the handshake check name it", () => {
    for (const client of ["claude", "codex"]) {
      const args = h.command(client, info, "/private", "/controller", { scenario: "abort" }).args as string[];
      expect((client === "claude" ? args[1] : args.at(-1)) as string).not.toMatch(/handshake/i);
      const parallel = (client === "claude" ? h.command(client, info, "/private", "/controller", { scenario: "parallel" }).args[1] : (h.command(client, info, "/private", "/controller", { scenario: "parallel" }).args as string[]).at(-1)) as string;
      expect(lineWith(parallel, "- SLUG:")).toContain("`accept-code-handshake`");
      expect(parallel).toContain("The operator checks the handshake content; you only check that the file exists.");
      expect(parallel).toContain("complete the acceptance handshake");
      // the boundary sentence stays in both scenarios
      for (const text of [parallel, (client === "claude" ? args[1] : args.at(-1)) as string]) expect(text).toContain("Read files and run commands only inside ./fixtures");
    }
  });

  const capabilities = (code: string[] | undefined, handshake: string[] | undefined) => ({ tool: "pi_capabilities_get", input: {}, result: { ok: true, server: { version: "1" }, configuration: { fingerprint: "f" },
    executionProfiles: [{ alias: "accept-read", skills: ["review"] }, ...(code ? [{ alias: "accept-code", skills: code }] : []), ...(handshake ? [{ alias: "accept-code-handshake", skills: handshake }] : [])] } });
  const analysisInfo = { candidate: "/nowhere", token: "tok", version: "1", configFingerprint: "f" };

  it("reads the skills of both coding profiles from the capabilities the controller saw", () => {
    const seen = h.analyze("claude", "parallel", [capabilities(["implementation"], ["implementation", "handshake"])], analysisInfo, "");
    expect(seen.acceptCodeSkills).toEqual(["implementation"]);
    expect(seen.acceptCodeHandshakeSkills).toEqual(["implementation", "handshake"]);
    const missing = h.analyze("claude", "parallel", [capabilities(["implementation"], undefined)], analysisInfo, "");
    expect(missing.acceptCodeHandshakeSkills).toBeUndefined();
  });

  // A result that satisfies every criterion; each case below breaks exactly one thing.
  const check = (extra: Record<string, boolean> = {}) => ({ onlyAllowedChanges: true, changesWrittenDuringWorkerTurns: true, testsPass: true, businessChecks: true, ...extra });
  const session = (workspace: string, profile: string) => ({ workspace, profile, closed: true, turns: ["completed"] });
  const passing = (overrides: Record<string, unknown> = {}) => ({
    client: "claude", exitCode: 0, timedOut: false, spawnFailed: false, harnessAborted: false,
    resources: { changedAfterRun: [] }, unboundResources: [], processes: { serversObserved: 1, residualByRole: {} },
    transcript: {
      capabilitiesFirst: true, candidateConfirmed: true, acceptCodeSkills: ["implementation"], acceptCodeHandshakeSkills: ["implementation", "handshake"],
      structuralLeaks: 0, tokenInControllerPrompts: false, tokenInControllerTask: false, controllerTranscriptHasToken: false, privateMarkersInWorkerPrompts: false, controllerTouchedPrivate: false,
      sessionsStarted: 2, sessions: [session("cc-slug", "accept-code-handshake"), session("cc-stats", "accept-code")], firstTurnsOverlap: true, followUpCompleted: true,
      ...overrides,
    },
    oracle: { slug: check({ addedTest: true, handshake: true, handshakeWrittenDuringFollowUp: true }), stats: check() },
  });

  it("passes the skill criterion when both profiles offer exactly their skills and only slug used the handshake profile", () => {
    expect(h.evaluateAcceptance(passing(), "parallel")).toEqual({ passed: true, failures: [] });
  });

  it.each([
    ["a non-slug task on the handshake profile", { sessions: [session("cc-slug", "accept-code-handshake"), session("cc-stats", "accept-code-handshake")] }],
    ["the slug task on the profile without the handshake", { sessions: [session("cc-slug", "accept-code"), session("cc-stats", "accept-code")] }],
    ["a session on a profile that is neither coding profile", { sessions: [session("cc-slug", "accept-code-handshake"), session("cc-stats", "accept-read")] }],
    ["an accept-code profile that still offers the handshake", { acceptCodeSkills: ["implementation", "handshake"] }],
    ["an accept-code profile without the implementation skill", { acceptCodeSkills: [] }],
    ["a handshake profile without the handshake", { acceptCodeHandshakeSkills: ["implementation"] }],
    ["a handshake profile in another skill order", { acceptCodeHandshakeSkills: ["handshake", "implementation"] }],
    ["a handshake profile the controller never saw", { acceptCodeHandshakeSkills: undefined }],
  ])("fails the skill criterion for %s, and nothing else", (_label, overrides) => {
    expect(h.evaluateAcceptance(passing(overrides), "parallel")).toEqual({ passed: false, failures: ["workerSkills"] });
  });

  it("fails the skill criterion in the abort scenario when any task used the handshake profile", () => {
    const abort = (profiles: [string, string]) => ({ ...passing({ sessions: [session("cc-wait", profiles[0]), session("cc-range", profiles[1])], abortedTurn: true, abortOk: true, abortedBeforeClose: true, abortBeforeAbortedSeen: true, offTargetAborts: 0, neighborCompleted: true, abortWhileNeighborRunning: true }),
      oracle: { wait: { onlyAllowedChanges: true, changesWrittenDuringWorkerTurns: true, lateFileAbsent: true }, range: check() } });
    expect(h.evaluateAcceptance(abort(["accept-code", "accept-code"]), "abort")).toEqual({ passed: true, failures: [] });
    expect(h.evaluateAcceptance(abort(["accept-code", "accept-code-handshake"]), "abort").failures).toEqual(["workerSkills"]);
  });

  it("keeps the scope allowance for the handshake file strict: only the slug task may write it", () => {
    expect(h.ALLOWED_CHANGES).toEqual({ slug: ["src/slug.js", "test/slug.test.js", "HANDSHAKE.txt"], stats: ["src/stats.js"], wait: [], range: ["src/range.js"], review: [] });
  });
});

// ---- #71: the trio scenario: fixture, profiles and prompt -------------------------------------------------
describe("trio scenario: fixture and prompt", FIXTURE_RUN_TIMEOUT, () => {
  const info = { node: process.execPath, entry: "/entry.js", agentDir: "/agent" };
  const promptOf = (client: string, scenario: string): string => {
    const args = h.command(client, info, "/private", "/controller", { scenario }).args as string[];
    return (client === "claude" ? args[1] : args.at(-1)) as string;
  };
  const lineWith = (text: string, needle: string) => text.split("\n").find((line) => line.includes(needle)) ?? "";

  it("defines a finished review fixture that nobody may change", async () => {
    expect(Object.keys(h.FIXTURES.review).sort()).toEqual(["README.md", "package.json", "src/chunk.js", "test/chunk.test.js"]);
    expect(h.ALLOWED_CHANGES.review).toEqual([]);
    const { dir, baseline } = await fixtureWithBaseline("review");
    // finished: its own tests pass as committed, and the harness defines no business check for it
    const tests = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(tests.status, tests.stdout + tests.stderr).toBe(0);
    expect(h.BUSINESS_CHECKS.review).toBeUndefined();
    expect(compare(dir, baseline, "review")).toMatchObject({ ok: true, error: undefined, sources: { workingTree: 0, index: 0, head: 0 } });
  });

  it("names the profile and workspace alias of each session in the prompt of both clients", () => {
    for (const [client, prefix] of [["claude", "cc"], ["codex", "cx"]] as const) {
      const text = promptOf(client, "trio");
      expect(lineWith(text, "Use the execution profile")).toContain("`accept-code` for the SLUG and WAIT sessions and `accept-read` for the REVIEW session");
      expect(lineWith(text, "- SLUG:")).toContain(`execution profile \`accept-code\`, workspace alias \`${prefix}-slug\``);
      expect(lineWith(text, "- WAIT:")).toContain(`execution profile \`accept-code\`, workspace alias \`${prefix}-wait\``);
      expect(lineWith(text, "- WAIT:")).toContain("sleep 120 && echo late > LATE.txt");
      expect(lineWith(text, "- REVIEW:")).toContain(`execution profile \`accept-read\`, workspace alias \`${prefix}-review\``);
      expect(lineWith(text, "- REVIEW:")).toContain("must not change anything");
      expect(lineWith(text, "- REVIEW:")).toContain("enumerated review");
      expect(lineWith(text, "- REVIEW:")).toContain("one numbered finding per exported function, each with a line reference");
      expect(text).toContain("Read files and run commands only inside ./fixtures");
    }
  });

  it("starts REVIEW, SLUG and WAIT in that order before waiting, aborts WAIT about 5 seconds after its turn and closes all three sessions", () => {
    for (const client of ["claude", "codex"]) {
      const text = promptOf(client, "trio");
      expect(text).toContain("Start the first turns in this order, REVIEW, then SLUG, then WAIT, and start all three before waiting for any of them");
      expect(text.indexOf("- REVIEW:")).toBeLessThan(text.indexOf("- SLUG:"));
      expect(text.indexOf("- SLUG:")).toBeLessThan(text.indexOf("- WAIT:"));
      expect(text).toContain("About 5 seconds after the WAIT turn was accepted, abort the WAIT session with pi_session_abort while SLUG and REVIEW are still running.");
      expect(text).not.toContain("15 seconds");
      expect(text).toContain("an `abort_timeout` error is not a successful abort");
      expect(text).toContain("Verify SLUG yourself");
      expect(text).toContain("check that REVIEW changed nothing");
      expect(text).toContain("close all three sessions");
    }
  });

  it("does not mention the handshake, and offers the handshake profile to no session", () => {
    for (const client of ["claude", "codex"]) {
      const text = promptOf(client, "trio");
      expect(text).not.toMatch(/handshake/i);
      expect(text).not.toContain("accept-code-handshake");
      expect(text).not.toContain("follow-up");
    }
  });

  it("leaves the prompts of the other scenarios without trio wording", () => {
    for (const client of ["claude", "codex"]) {
      for (const scenario of ["parallel", "abort"]) {
        const text = promptOf(client, scenario);
        expect(text, scenario).not.toContain("accept-read");
        expect(text, scenario).not.toContain("REVIEW");
        expect(text, scenario).not.toContain("fixtures/review");
      }
      expect(promptOf(client, "abort")).toContain("Use the execution profile `accept-code` for every task.");
    }
  });

  it("prepares the review fixture, its baseline and its workspace alias for both clients, with the read-only profile unchanged", async () => {
    const run = await buildRun();
    const prepared = await prepareRun(run, { withExtensions: false, env: {} });
    const config = JSON.parse(readFileSync(join(prepared.priv, "config.json"), "utf8"));
    expect(config.executionProfiles["accept-read"]).toMatchObject({ permissionProfile: "read-only", default: true, skills: ["review"] });
    for (const [client, prefix] of [["claude", "cc"], ["codex", "cx"]] as const) {
      const dir = join(prepared.runDir, `controller-${client}`, "fixtures", "review");
      expect(join(prepared.priv, config.workspaces[`${prefix}-review`])).toBe(dir);
      expect(readdirSync(dir).sort()).toEqual([".git", "README.md", "package.json", "src", "test"]);
      const baseline = JSON.parse(readFileSync(join(prepared.priv, "baselines", client, "review.json"), "utf8"));
      expect(baseline.manifest.map((entry: { path: string }) => entry.path)).toEqual(Object.keys(h.FIXTURES.review).sort());
      expect(compare(dir, baseline, "review")).toMatchObject({ ok: true, sources: { workingTree: 0, index: 0, head: 0 } });
    }
  }, 60_000);
});

// ---- #71 review: every abort call of the abort scenario is judged ----------------------------------------------------
describe("abort scenario: every abort call is judged", () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const turnId = (n: number) => `10000000-0000-4000-8000-00000000000${n}`;
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  const analysisInfo = { candidate: "/nowhere", token: "tok", version: "1", configFingerprint: "f" };
  const abortAnalysis = (extra: Array<{ target: "wait" | "range" | "unknown"; code: string }>) => {
    const turn = (n: number, state: string, done: boolean, start: number, end: number) => ({ ok: true, turn: { turnId: turnId(n), sessionId: id(n), state, startedAt: at(start), updatedAt: at(start), ...(done ? { completedAt: at(end) } : {}) } });
    const target = (name: string) => (name === "wait" ? id(1) : name === "range" ? id(2) : "99999999-9999-4999-8999-999999999999");
    return h.analyze("claude", "abort", [
      { tool: "pi_capabilities_get", input: {}, result: { ok: true, server: { version: "1" }, configuration: { fingerprint: "f" }, executionProfiles: [{ alias: "accept-code", skills: ["implementation"] }] } },
      { tool: "pi_session_start", input: {}, result: { ok: true, session: { id: id(1), workspace: "cc-wait", executionProfile: "accept-code" } } },
      { tool: "pi_session_start", input: {}, result: { ok: true, session: { id: id(2), workspace: "cc-range", executionProfile: "accept-code" } } },
      { tool: "pi_session_prompt", input: { sessionId: id(1), prompt: "p" }, result: turn(1, "running", false, 0, 0) },
      { tool: "pi_session_prompt", input: { sessionId: id(2), prompt: "p" }, result: turn(2, "running", false, 1, 0) },
      ...extra.map(({ target: name, code }) => ({ tool: "pi_session_abort", input: { sessionId: target(name) }, result: code === "ok" ? { ok: true } : { ok: false, error: { code } } })),
      { tool: "pi_session_abort", input: { sessionId: id(1) }, result: { ok: true } },
      { tool: "pi_turn_get", input: { sessionId: id(1), turnId: turnId(1) }, result: turn(1, "aborted", true, 0, 16) },
      { tool: "pi_turn_get", input: { sessionId: id(2), turnId: turnId(2) }, result: turn(2, "completed", true, 1, 50) },
      { tool: "pi_session_close", input: { sessionId: id(1) }, result: { ok: true } },
      { tool: "pi_session_close", input: { sessionId: id(2) }, result: { ok: true } },
    ], analysisInfo, "");
  };
  const verdict = (analysis: Record<string, any>) => {
    const { turnIntervals: _intervals, ...facts } = analysis;
    const check = { onlyAllowedChanges: true, changesWrittenDuringWorkerTurns: true };
    return h.evaluateAcceptance({
      client: "claude", exitCode: 0, timedOut: false, spawnFailed: false, harnessAborted: false, resources: { changedAfterRun: [] }, unboundResources: [], processes: { serversObserved: 1, residualByRole: {} },
      transcript: { ...facts, acceptCodeSkills: ["implementation"], acceptCodeHandshakeSkills: ["implementation", "handshake"], structuralLeaks: 0, tokenInControllerPrompts: false, tokenInControllerTask: false, controllerTranscriptHasToken: false, privateMarkersInWorkerPrompts: false, controllerTouchedPrivate: false },
      oracle: { wait: { ...check, lateFileAbsent: true }, range: { ...check, testsPass: true, businessChecks: true } },
    }, "abort");
  };

  it("passes the single successful abort on the wait session", () => {
    const analysis = abortAnalysis([]);
    expect(analysis).toMatchObject({ abortOk: true, offTargetAborts: 0, abortResults: ["ok"] });
    expect(verdict(analysis)).toEqual({ passed: true, failures: [] });
  });

  it.each([
    ["an unknown_session abort before the successful abort", [{ target: "unknown" as const, code: "unknown_session" }], ["abortFailed", "offTargetAbort"]],
    ["an abort_timeout on the range neighbor", [{ target: "range" as const, code: "abort_timeout" }], ["abortFailed", "offTargetAbort"]],
    ["a successful abort on the range neighbor", [{ target: "range" as const, code: "ok" }], ["offTargetAbort"]],
    ["an abort_timeout on wait followed by the successful retry", [{ target: "wait" as const, code: "abort_timeout" }], ["abortFailed"]],
  ])("fails %s", (_label, extra, expected) => {
    expect(verdict(abortAnalysis(extra)).failures).toEqual(expected);
  });
});

// ---- #71: the trio scenario: transcript analysis, oracle and criteria ----------------------------------------------
describe("trio scenario: criteria", FIXTURE_RUN_TIMEOUT, () => {
  const ids = { slug: "00000000-0000-4000-8000-000000000001", wait: "00000000-0000-4000-8000-000000000002", review: "00000000-0000-4000-8000-000000000003" };
  const turnIds = { slug: "10000000-0000-4000-8000-000000000001", wait: "10000000-0000-4000-8000-000000000002", review: "10000000-0000-4000-8000-000000000003" };
  const profiles = { slug: "accept-code", wait: "accept-code", review: "accept-read" };
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  const analysisInfo = { candidate: "/nowhere", token: "tok", version: "1", configFingerprint: "f" };
  type Name = "slug" | "wait" | "review";
  interface Timeline { start: number; end: number; state: string }

  /** A synthetic transcript of a controller run: starts at 0, 1 and 2 s; the abort of wait at 17 s; slug and review end later. */
  function transcript(overrides: { turns?: Partial<Record<Name, Partial<Timeline>>>; abort?: Array<"ok" | "abort_timeout">; profile?: Partial<Record<Name, string>>; skipClose?: Name[]; capabilities?: Array<{ alias: string; skills: string[] }>; workspace?: Partial<Record<Name, string>>; extraAborts?: Array<{ target: Name | "unknown"; code: string }> } = {}) {
    const turns: Record<Name, Timeline> = {
      slug: { start: 0, end: 40, state: "completed" }, wait: { start: 1, end: 17, state: "aborted" }, review: { start: 2, end: 30, state: "completed" },
      ...Object.fromEntries(Object.entries(overrides.turns ?? {}).map(([name, value]) => [name, { ...({ slug: { start: 0, end: 40, state: "completed" }, wait: { start: 1, end: 17, state: "aborted" }, review: { start: 2, end: 30, state: "completed" } } as Record<string, Timeline>)[name], ...value }])),
    };
    const names: Name[] = ["slug", "wait", "review"];
    const turn = (name: Name, state: string, done: boolean) => ({ ok: true, turn: { turnId: turnIds[name], sessionId: ids[name], state, startedAt: at(turns[name].start), updatedAt: at(turns[name].start), ...(done ? { completedAt: at(turns[name].end) } : {}) } });
    const profile = (name: Name) => overrides.profile?.[name] ?? profiles[name];
    const calls: Array<Record<string, unknown>> = [
      { tool: "pi_capabilities_get", input: {}, result: { ok: true, server: { version: "1" }, configuration: { fingerprint: "f" }, executionProfiles: overrides.capabilities ?? [
        { alias: "accept-read", skills: ["review"] }, { alias: "accept-code", skills: ["implementation"] }, { alias: "accept-code-handshake", skills: ["implementation", "handshake"] }] } },
      ...names.map((name) => ({ tool: "pi_session_start", input: {}, result: { ok: true, session: { id: ids[name], workspace: overrides.workspace?.[name] ?? `cc-${name}`, executionProfile: profile(name) } } })),
      ...names.map((name) => ({ tool: "pi_session_prompt", input: { sessionId: ids[name], prompt: "p" }, result: turn(name, "running", false) })),
      // Aborts before the one on wait: on another session, or on an id that was never started.
      ...(overrides.extraAborts ?? []).map(({ target, code }) => ({ tool: "pi_session_abort", input: { sessionId: target === "unknown" ? "99999999-9999-4999-8999-999999999999" : ids[target] }, result: code === "ok" ? { ok: true } : { ok: false, error: { code } } })),
      ...(overrides.abort ?? ["ok"]).map((code) => ({ tool: "pi_session_abort", input: { sessionId: ids.wait }, result: code === "ok" ? { ok: true } : { ok: false, error: { code } } })),
      ...names.map((name) => ({ tool: "pi_turn_get", input: { sessionId: ids[name], turnId: turnIds[name] }, result: turn(name, turns[name].state, true) })),
      ...names.filter((name) => !overrides.skipClose?.includes(name)).map((name) => ({ tool: "pi_session_close", input: { sessionId: ids[name] }, result: { ok: true } })),
    ];
    return h.analyze("claude", "trio", calls, analysisInfo, "");
  }

  it("derives the facts of a clean trio run from the transcript", () => {
    const analysis = transcript();
    expect(analysis).toMatchObject({
      sessionsStarted: 3, firstTurnsOverlap: true, firstTurnsOverlapSeconds: 15, acceptReadSkills: ["review"], acceptCodeSkills: ["implementation"],
      abortedTurn: true, abortOk: true, offTargetAborts: 0, abortResults: ["ok"], abortedBeforeClose: true, abortBeforeAbortedSeen: true, abortWhileNeighborsRunning: true,
    });
    expect(analysis.sessions.map((session: { workspace: string; profile: string; closed: boolean; turns: string[] }) => [session.workspace, session.profile, session.closed, session.turns])).toEqual([
      ["cc-slug", "accept-code", true, ["completed"]], ["cc-wait", "accept-code", true, ["aborted"]], ["cc-review", "accept-read", true, ["completed"]],
    ]);
    expect(Object.keys(analysis.turnIntervals)).toEqual(["slug", "wait", "review"]);
  });

  it("does not overlap when one first turn started after another had ended", () => {
    // review starts 20 s in: after the abort of wait at 17 s
    const late = transcript({ turns: { review: { start: 20, end: 50 } } });
    expect(late.firstTurnsOverlap).toBe(false);
    expect(late.abortWhileNeighborsRunning).toBe(false);
  });

  it.each([
    ["slug ended before the abort", { slug: { end: 12 } }],
    ["review ended before the abort", { review: { end: 12 } }],
    ["review started after the abort", { review: { start: 18, end: 50 } }],
    ["slug started after the abort", { slug: { start: 18, end: 50 } }],
    ["the abort landed exactly when review ended", { review: { end: 17 } }],
  ])("sees the abort outside the running interval of a neighbor: %s", (_label, turns) => {
    expect(transcript({ turns }).abortWhileNeighborsRunning).toBe(false);
  });

  it("keeps an abort_timeout visible, also when a retry succeeded", () => {
    expect(transcript({ abort: ["abort_timeout", "ok"] })).toMatchObject({ abortOk: false, abortResults: ["abort_timeout", "ok"] });
    expect(transcript({ abort: ["abort_timeout"] })).toMatchObject({ abortOk: false });
    expect(transcript({ abort: [] })).toMatchObject({ abortOk: false, abortResults: [] });
  });

  // #71 review: every abort call is judged, also one on an unknown session or on a neighbor.
  it.each([
    ["an unknown_session abort before the successful wait abort", { extraAborts: [{ target: "unknown" as const, code: "unknown_session" }] }],
    ["an abort_timeout on the slug neighbor", { extraAborts: [{ target: "slug" as const, code: "abort_timeout" }] }],
    ["an abort_timeout on the review neighbor", { extraAborts: [{ target: "review" as const, code: "abort_timeout" }] }],
  ])("fails abortFailed and offTargetAbort in the trio for %s", (_label, overrides) => {
    const analysis = transcript(overrides);
    expect(analysis).toMatchObject({ abortOk: false, offTargetAborts: 1 });
    // the wait session itself saw one successful abort: the failed call is only visible through the transcript totals
    expect(analysis.abortResults).toEqual(["ok"]);
  });

  it("counts a successful abort on a neighbor as off target, without calling the abort failed", () => {
    expect(transcript({ extraAborts: [{ target: "review", code: "ok" }] })).toMatchObject({ abortOk: true, offTargetAborts: 1 });
  });

  it("counts every abort call, and still passes the single successful wait abort", () => {
    expect(transcript()).toMatchObject({ abortOk: true, offTargetAborts: 0 });
    expect(transcript({ extraAborts: [{ target: "unknown", code: "unknown_session" }, { target: "slug", code: "ok" }] })).toMatchObject({ abortOk: false, offTargetAborts: 2 });
  });

  it("reads the skills of accept-read from the capabilities the controller saw", () => {
    expect(transcript({ capabilities: [{ alias: "accept-read", skills: ["review", "implementation"] }] }).acceptReadSkills).toEqual(["review", "implementation"]);
    expect(transcript({ capabilities: [{ alias: "accept-code", skills: ["implementation"] }] }).acceptReadSkills).toBeUndefined();
  });

  it("leaves the facts of the other scenarios as they were", () => {
    for (const scenario of ["parallel", "abort"]) {
      const analysis = h.analyze("claude", scenario, [], analysisInfo, "");
      for (const key of ["acceptReadSkills", "abortWhileNeighborsRunning"]) expect(analysis, `${scenario} ${key}`).not.toHaveProperty(key);
    }
  });

  // ---- the verdict ----
  const sessionOf = (workspace: string, profile: string, turn = "completed", closed = true) => ({ workspace, profile, closed, turns: [turn] });
  const passingCheck = (extra: Record<string, unknown> = {}) => ({ onlyAllowedChanges: true, changesWrittenDuringWorkerTurns: true, ...extra });
  const trio = (overrides: Record<string, unknown> = {}, oracle: Record<string, unknown> = {}) => ({
    client: "claude", exitCode: 0, timedOut: false, spawnFailed: false, harnessAborted: false,
    resources: { changedAfterRun: [] }, unboundResources: [], processes: { serversObserved: 1, residualByRole: {} },
    transcript: {
      capabilitiesFirst: true, candidateConfirmed: true, acceptCodeSkills: ["implementation"], acceptCodeHandshakeSkills: ["implementation", "handshake"], acceptReadSkills: ["review"],
      structuralLeaks: 0, tokenInControllerPrompts: false, tokenInControllerTask: false, controllerTranscriptHasToken: false, privateMarkersInWorkerPrompts: false, controllerTouchedPrivate: false,
      sessionsStarted: 3, sessions: [sessionOf("cc-slug", "accept-code"), sessionOf("cc-wait", "accept-code", "aborted"), sessionOf("cc-review", "accept-read")], firstTurnsOverlap: true,
      abortedTurn: true, abortOk: true, offTargetAborts: 0, abortedBeforeClose: true, abortBeforeAbortedSeen: true, abortWhileNeighborsRunning: true,
      ...overrides,
    },
    oracle: {
      slug: passingCheck({ testsPass: true, businessChecks: true }), wait: passingCheck({ lateFileAbsent: true }), review: passingCheck({ readOnlyInvariant: true }),
      ...oracle,
    },
  });
  const failures = (result: unknown) => h.evaluateAcceptance(result, "trio").failures;

  it("passes a trio run in which every criterion holds", () => {
    expect(h.evaluateAcceptance(trio(), "trio")).toEqual({ passed: true, failures: [] });
  });

  it("passes a trio run that never needed the follow-up or the handshake fields", () => {
    expect(failures(trio())).toEqual([]);
    const slug = trio().oracle.slug as Record<string, unknown>;
    expect(slug).not.toHaveProperty("addedTest");
    expect(slug).not.toHaveProperty("handshake");
  });

  it("requires three started sessions", () => {
    expect(failures(trio({ sessionsStarted: 2, sessions: [sessionOf("cc-slug", "accept-code"), sessionOf("cc-wait", "accept-code", "aborted")] }))).toEqual(["sessionsNotStarted", "sessionAssociation", "firstTurnsNotCompleted"]);
    expect(failures(trio({ sessionsStarted: 4, sessions: [...(trio().transcript.sessions as unknown[]), sessionOf("cc-slug", "accept-code")] }))).toEqual(["sessionsNotStarted", "sessionAssociation"]);
  });

  it.each([
    ["the reviewer on another workspace alias", { sessions: [sessionOf("cc-slug", "accept-code"), sessionOf("cc-wait", "accept-code", "aborted"), sessionOf("cc-stats", "accept-code")] }, ["sessionAssociation", "firstTurnsNotCompleted"]],
    ["a writer on the reviewer's alias", { sessions: [sessionOf("cc-slug", "accept-code"), sessionOf("cc-review", "accept-code", "aborted"), sessionOf("cc-review", "accept-read")] }, ["workerSkills", "sessionAssociation", "firstTurnsNotCompleted"]],
    ["the other client's aliases", { sessions: [sessionOf("cx-slug", "accept-code"), sessionOf("cx-wait", "accept-code", "aborted"), sessionOf("cx-review", "accept-read")] }, ["workerSkills", "sessionAssociation", "firstTurnsNotCompleted"]],
    ["the reviewer on the coding profile", { sessions: [sessionOf("cc-slug", "accept-code"), sessionOf("cc-wait", "accept-code", "aborted"), sessionOf("cc-review", "accept-code")] }, ["workerSkills", "sessionAssociation"]],
    ["slug on the reading profile", { sessions: [sessionOf("cc-slug", "accept-read"), sessionOf("cc-wait", "accept-code", "aborted"), sessionOf("cc-review", "accept-read")] }, ["workerSkills", "sessionAssociation"]],
    ["wait on the reading profile", { sessions: [sessionOf("cc-slug", "accept-code"), sessionOf("cc-wait", "accept-read", "aborted"), sessionOf("cc-review", "accept-read")] }, ["workerSkills", "sessionAssociation"]],
    ["slug on the handshake profile", { sessions: [sessionOf("cc-slug", "accept-code-handshake"), sessionOf("cc-wait", "accept-code", "aborted"), sessionOf("cc-review", "accept-read")] }, ["workerSkills", "sessionAssociation"]],
    ["accept-read offering more than review", { acceptReadSkills: ["review", "implementation"] }, ["workerSkills"]],
    ["accept-read offering no skill", { acceptReadSkills: [] }, ["workerSkills"]],
    ["accept-read offering another skill", { acceptReadSkills: ["implementation"] }, ["workerSkills"]],
    ["an accept-read profile the controller never saw", { acceptReadSkills: undefined }, ["workerSkills"]],
    ["accept-code offering the handshake", { acceptCodeSkills: ["implementation", "handshake"] }, ["workerSkills"]],
  ])("fails association and skills for %s", (_label, overrides, expected) => {
    expect(failures(trio(overrides as Record<string, unknown>))).toEqual(expected);
  });

  it("fails when a session was not closed", () => {
    expect(failures(trio({ sessions: [sessionOf("cc-slug", "accept-code"), sessionOf("cc-wait", "accept-code", "aborted"), sessionOf("cc-review", "accept-read", "completed", false)] }))).toEqual(["sessionsNotClosed"]);
  });

  it.each([
    ["no common instant of the three first turns", { firstTurnsOverlap: false }, ["noOverlap"]],
    ["a first turn that is missing from the overlap fact", { firstTurnsOverlap: undefined }, ["noOverlap"]],
    ["a slug turn that did not complete", { sessions: [sessionOf("cc-slug", "accept-code", "failed"), sessionOf("cc-wait", "accept-code", "aborted"), sessionOf("cc-review", "accept-read")] }, ["firstTurnsNotCompleted"]],
    ["a review turn that did not complete", { sessions: [sessionOf("cc-slug", "accept-code"), sessionOf("cc-wait", "accept-code", "aborted"), sessionOf("cc-review", "accept-read", "aborted")] }, ["firstTurnsNotCompleted"]],
    ["a wait turn that was not aborted", { abortedTurn: false }, ["abortFailed"]],
    ["an abort that was not only successful", { abortOk: false }, ["abortFailed"]],
    ["an aborted state that close caused", { abortedBeforeClose: false }, ["abortOrder"]],
    ["an abort answered after the aborted state was seen", { abortBeforeAbortedSeen: false }, ["abortOrder"]],
    ["an abort outside the running intervals of the neighbors", { abortWhileNeighborsRunning: false }, ["neighborsNotRunningDuringAbort"]],
    ["an abort fact that is missing", { abortWhileNeighborsRunning: undefined }, ["neighborsNotRunningDuringAbort"]],
    ["an abort call on another session", { offTargetAborts: 1 }, ["offTargetAbort"]],
    ["an off-target abort fact that is missing", { offTargetAborts: undefined }, ["offTargetAbort"]],
  ])("fails %s", (_label, overrides, expected) => {
    expect(failures(trio(overrides as Record<string, unknown>))).toEqual(expected);
  });

  it("keeps the shared rules: residual processes, resources and unbound bindings", () => {
    expect(failures({ ...trio(), processes: { serversObserved: 1, residualByRole: { server: 1 } } })).toEqual(["residualProcesses"]);
    expect(failures({ ...trio(), resources: { changedAfterRun: ["runConfiguration"] } })).toEqual(["resourcesChanged"]);
    expect(failures({ ...trio(), unboundResources: ["homeAgentsSkills"] })).toEqual(["resourcesUnbound"]);
    expect(failures({ ...trio(), reanalysis: { stateChanges: { resources: [], fixtures: ["review"] } } })).toEqual(["stateChangedSinceRun"]);
  });

  it.each([
    ["a slug change outside the scope", { slug: passingCheck({ onlyAllowedChanges: false, testsPass: true, businessChecks: true }) }, ["slug:changes"]],
    ["a slug change written outside its turns", { slug: passingCheck({ changesWrittenDuringWorkerTurns: false, testsPass: true, businessChecks: true }) }, ["slug:attribution"]],
    ["slug tests that fail", { slug: passingCheck({ testsPass: false, businessChecks: true }) }, ["slug:tests"]],
    ["slug business checks that fail", { slug: passingCheck({ testsPass: true, businessChecks: false }) }, ["slug:tests"]],
    ["a wait change", { wait: passingCheck({ onlyAllowedChanges: false, lateFileAbsent: true }) }, ["wait:changes"]],
    ["a late file of wait", { wait: passingCheck({ lateFileAbsent: false }) }, ["wait:lateFile"]],
    ["a review fixture that changed", { review: passingCheck({ onlyAllowedChanges: false, readOnlyInvariant: false }) }, ["review:changes", "review:readOnly"]],
    ["a review fixture that changed in a way the path comparison misses", { review: passingCheck({ readOnlyInvariant: false }) }, ["review:readOnly"]],
    ["a review change attributed to no turn", { review: passingCheck({ changesWrittenDuringWorkerTurns: false, readOnlyInvariant: true }) }, ["review:attribution"]],
    ["a review oracle that is missing", { review: undefined }, ["oracleMissing"]],
  ])("keeps the oracles per task: %s", (_label, oracle, expected) => {
    const result = trio({}, oracle);
    if ("review" in oracle && oracle.review === undefined) delete (result.oracle as Record<string, unknown>).review;
    expect(failures(result)).toEqual(expected);
  });

  it("does not ask the slug task of the trio for a follow-up or the handshake, but still asks parallel", () => {
    expect(failures(trio())).not.toContain("slug:followUp");
    const parallel = { ...trio(), transcript: { ...trio().transcript, sessions: [sessionOf("cc-slug", "accept-code-handshake"), sessionOf("cc-stats", "accept-code")], sessionsStarted: 2, followUpCompleted: true },
      oracle: { slug: passingCheck({ testsPass: true, businessChecks: true }), stats: passingCheck({ testsPass: true, businessChecks: true }) } };
    expect(h.evaluateAcceptance(parallel, "parallel").failures).toEqual(["slug:followUp"]);
  });

  it("applies the trio rules to no other scenario: parallel and abort keep their rules", () => {
    const check = (extra: Record<string, unknown> = {}) => passingCheck({ testsPass: true, businessChecks: true, ...extra });
    // accept-read without the review skill, or never seen, does not matter outside the trio
    const parallel = (overrides: Record<string, unknown> = {}) => ({ ...trio(), transcript: { ...trio().transcript, acceptReadSkills: undefined, sessionsStarted: 2, followUpCompleted: true,
      sessions: [sessionOf("cc-slug", "accept-code-handshake"), sessionOf("cc-stats", "accept-code")], ...overrides },
    oracle: { slug: check({ addedTest: true, handshake: true, handshakeWrittenDuringFollowUp: true }), stats: check() } });
    expect(h.evaluateAcceptance(parallel(), "parallel")).toEqual({ passed: true, failures: [] });
    // the reviewer's profile stays forbidden for every session of parallel and abort
    expect(h.evaluateAcceptance(parallel({ sessions: [sessionOf("cc-slug", "accept-code-handshake"), sessionOf("cc-stats", "accept-read")] }), "parallel").failures).toEqual(["workerSkills"]);
    const abort = (overrides: Record<string, unknown> = {}) => ({ ...trio(), transcript: { ...trio().transcript, acceptReadSkills: undefined, sessionsStarted: 2, neighborCompleted: true, abortWhileNeighborRunning: true, offTargetAborts: 0,
      sessions: [sessionOf("cc-wait", "accept-code", "aborted"), sessionOf("cc-range", "accept-code")], ...overrides },
    oracle: { wait: passingCheck({ lateFileAbsent: true }), range: check() } });
    expect(h.evaluateAcceptance(abort(), "abort")).toEqual({ passed: true, failures: [] });
    expect(h.evaluateAcceptance(abort({ sessions: [sessionOf("cc-wait", "accept-code", "aborted"), sessionOf("cc-range", "accept-read")] }), "abort").failures).toEqual(["workerSkills"]);
    // a trio fact does not rescue or fail an abort run
    expect(h.evaluateAcceptance(abort({ abortWhileNeighborRunning: false }), "abort").failures).toEqual(["neighborNotRunningDuringAbort"]);
  });

  // ---- the analysis output feeds the verdict (D) ----
  /** The result of a run whose transcript facts come from `analyze`, with everything else clean. */
  const analyzed = (analysis: Record<string, any>, oracle: Record<string, unknown> = {}) => {
    const clean = trio();
    const { turnIntervals: _intervals, ...facts } = analysis;
    return { ...clean, transcript: { ...clean.transcript, ...facts }, oracle: { ...clean.oracle, ...oracle } };
  };

  it("passes the analysis of a clean trio transcript through the verdict", () => {
    expect(h.evaluateAcceptance(analyzed(transcript()), "trio")).toEqual({ passed: true, failures: [] });
  });

  it.each([
    ["the reviewer on cc-stats", { workspace: { review: "cc-stats" } }, ["workerSkills", "sessionAssociation", "firstTurnsNotCompleted", "noOverlap", "neighborsNotRunningDuringAbort"]],
    ["the reviewer on the coding profile", { profile: { review: "accept-code" } }, ["workerSkills", "sessionAssociation"]],
    ["a writer on the reading profile", { profile: { slug: "accept-read" } }, ["workerSkills", "sessionAssociation"]],
    ["an unclosed reviewer session", { skipClose: ["review"] as Array<"review"> }, ["sessionsNotClosed"]],
    ["an unknown_session abort before the wait abort", { extraAborts: [{ target: "unknown" as const, code: "unknown_session" }] }, ["abortFailed", "offTargetAbort"]],
    ["a neighbor abort answered abort_timeout", { extraAborts: [{ target: "slug" as const, code: "abort_timeout" }] }, ["abortFailed", "offTargetAbort"]],
    ["a successful abort on a neighbor", { extraAborts: [{ target: "review" as const, code: "ok" }] }, ["offTargetAbort"]],
  ])("fails the verdict of the analysis for %s", (_label, overrides, expected) => {
    expect(h.evaluateAcceptance(analyzed(transcript(overrides)), "trio").failures).toEqual(expected);
  });

  // ---- the read-only invariance oracle, on real fixtures ----
  const reviewOracle = (run: Run) => h.oracle(run.controller("claude"), "trio", run.info, {}, run.baselineOf("claude"));
  const reviewDir = (run: Run) => join(run.controller("claude"), "fixtures", "review");

  it("judges the three fixtures of the trio, with the follow-up and handshake checks for no one", async () => {
    const run = await buildRun();
    const out = reviewOracle(run);
    expect(Object.keys(out)).toEqual(["slug", "wait", "review"]);
    expect(out.review).toEqual({ onlyAllowedChanges: true, baselineError: undefined, changedFiles: 0, changeSources: { workingTree: 0, index: 0, head: 0 }, changesWrittenDuringWorkerTurns: true, readOnlyInvariant: true });
    expect(out.slug).not.toHaveProperty("handshake");
    expect(out.slug).not.toHaveProperty("addedTest");
    expect(out.wait.lateFileAbsent).toBe(true);
    // slug is still unimplemented here, so its tests and business checks fail, as before
    expect(out.slug).toMatchObject({ onlyAllowedChanges: true, testsPass: false, businessChecks: false });
    expect(out.review).not.toHaveProperty("testsPass");
  });

  // #71 review: the slug task of the trio has no follow-up and no handshake, so its scope is src/slug.js alone.
  it("narrows the slug scope of the trio to src/slug.js and leaves every other scope as it was", () => {
    expect(h.allowedChanges("slug", "trio")).toEqual(["src/slug.js"]);
    expect(h.allowedChanges("slug", "parallel")).toEqual(["src/slug.js", "test/slug.test.js", "HANDSHAKE.txt"]);
    for (const [task, scenario] of [["stats", "parallel"], ["wait", "abort"], ["range", "abort"], ["wait", "trio"], ["review", "trio"]] as const) expect(h.allowedChanges(task, scenario), `${task} ${scenario}`).toEqual(h.ALLOWED_CHANGES[task]);
  });

  it.each([
    ["src/slug.js", true, true],
    ["test/slug.test.js", false, true],
    ["HANDSHAKE.txt", false, true],
    ["README.md", false, false],
  ])("judges a slug change to %s: trio allows it %s, parallel allows it %s", async (file, inTrio, inParallel) => {
    const run = await buildRun();
    const slug = join(run.controller("claude"), "fixtures", "slug");
    writeFileSync(join(slug, file), file === "src/slug.js" ? SLUG_OK : "changed by the worker\n");
    // attribution is not under test here: the change counts as written during a worker turn
    const now = Date.now();
    const intervals = { slug: [[new Date(now - 60_000).toISOString(), new Date(now + 60_000).toISOString()]] };
    expect(h.oracle(run.controller("claude"), "trio", run.info, intervals, run.baselineOf("claude")).slug.onlyAllowedChanges, "trio").toBe(inTrio);
    expect(h.oracle(run.controller("claude"), "parallel", run.info, intervals, run.baselineOf("claude")).slug.onlyAllowedChanges, "parallel").toBe(inParallel);
  });

  const mutations: Array<[string, (dir: string) => void]> = [
    ["a changed file in the working tree", (dir) => appendFileSync(join(dir, "src", "chunk.js"), "// reviewed\n")],
    ["a changed README", (dir) => writeFileSync(join(dir, "README.md"), "thawed\n")],
    ["an untracked file", (dir) => writeFileSync(join(dir, "REVIEW.md"), "findings\n")],
    ["an untracked dotfile", (dir) => writeFileSync(join(dir, ".review-notes"), "x")],
    ["a deleted file", (dir) => rmSync(join(dir, "test", "chunk.test.js"))],
    ["a mode change", (dir) => chmodSync(join(dir, "src", "chunk.js"), 0o755)],
    ["a change that exists only in the index", (dir) => { writeFileSync(join(dir, "NOTES.md"), "x"); h.git(dir, "add", "NOTES.md"); rmSync(join(dir, "NOTES.md")); }],
    ["a staged change whose working tree was restored", (dir) => { const file = join(dir, "src", "chunk.js"); const original = readFileSync(file); appendFileSync(file, "// x\n"); h.git(dir, "add", "src/chunk.js"); writeFileSync(file, original); }],
    ["a commit whose files were restored in the tree and the index", (dir) => { appendFileSync(join(dir, "src", "chunk.js"), "// x\n"); commitAll(dir, "review"); h.git(dir, "revert", "--no-commit", "HEAD"); }],
    ["an empty commit", (dir) => h.git(dir, "commit", "-q", "--allow-empty", "-m", "empty")],
    ["an amended base commit with the same tree", (dir) => h.git(dir, "commit", "-q", "--amend", "-m", "amended")],
    ["an empty directory", (dir) => mkdirSync(join(dir, "notes"))],
    ["an empty directory below an existing one", (dir) => mkdirSync(join(dir, "src", "cache"))],
  ];

  it.each(mutations)("fails the read-only invariance for %s", async (label, mutate) => {
    const run = await buildRun();
    mutate(reviewDir(run));
    const out = reviewOracle(run);
    expect(out.review.readOnlyInvariant, label).toBe(false);
    const verdict = h.evaluateAcceptance({ ...trio(), oracle: { slug: passingCheck({ testsPass: true, businessChecks: true }), wait: passingCheck({ lateFileAbsent: true }), review: out.review } }, "trio");
    expect(verdict.failures, label).toContain("review:readOnly");
  });

  // One fixture build per case.
  it.each([
    ["the .git directory is missing", (run: Run) => { rmSync(join(reviewDir(run), ".git"), { recursive: true }); }, "gitMissing", true],
    ["the baseline cannot be read", () => {}, "baselineUnreadable", false],
  ])("fails the read-only invariance when %s", async (_label, damage, error, useBaseline) => {
    const run = await buildRun();
    damage(run);
    const baselineOf = useBaseline ? run.baselineOf("claude") : () => undefined;
    expect(h.oracle(run.controller("claude"), "trio", run.info, {}, baselineOf).review).toMatchObject({ readOnlyInvariant: false, onlyAllowedChanges: false, baselineError: error });
  });

  it("reports an untouched fixture, and one the reviewer only read, as unchanged", async () => {
    const run = await buildRun();
    const dir = reviewDir(run);
    // reading and running git read commands leaves nothing behind
    readFileSync(join(dir, "src", "chunk.js"), "utf8");
    h.git(dir, "status", "--short");
    h.git(dir, "log", "--oneline");
    expect(reviewOracle(run).review.readOnlyInvariant).toBe(true);
  });
});
