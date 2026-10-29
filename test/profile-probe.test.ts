import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { DoctorCheck, DoctorResult } from "../src/doctor.js";
import { PiSessionCreationError } from "../src/pi-adapter.js";
import { PROBE_DEADLINES, PROBE_PROMPT, isPong, runProfileProbe, type ProbeDependencies } from "../src/profile-probe.js";
import { formatProbeHuman } from "../src/setup-probe-result.js";
import { FakeAdapter, FakeHandle } from "./fake-adapter.js";

describe("profile probe", () => {
  let root: string;
  let adapter: FakeAdapter;
  let deps: ProbeDependencies;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "profile-probe-test-"));
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ workspaces: {}, executionProfiles: {
      review: { default: true, permissionProfile: "read-only", provider: "example-provider", model: "m-small", thinkingLevel: "off" },
      code: { default: false, permissionProfile: "coding", provider: "example-provider", model: "m-small", thinkingLevel: "off" },
    } }));
    const config = await loadConfig(configPath);
    adapter = new FakeAdapter();
    let directories = 0;
    deps = {
      configPath, loadConfig: vi.fn(async () => config),
      doctor: vi.fn(async (): Promise<DoctorResult> => ({ schemaVersion: 1, ok: true, checks: [], exitCode: 0 })),
      catalog: vi.fn(async () => ({ providers: () => [{ id: "example-provider", authConfigured: true, models: ["m-small"] }] })),
      adapter: vi.fn(async () => adapter), makeTempDir: vi.fn(async () => join(root, `session-${++directories}`)),
      removeDir: vi.fn(async () => undefined),
    };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const request = { profiles: ["review"], apply: true };

  it("plans offline without starting a session", async () => {
    const report = await runProfileProbe({ ...request, apply: false }, deps);
    expect(report).toMatchObject({ status: "planned", exitCode: 0, findings: [{ code: "probe_planned", providerTurn: false }] });
    expect(deps.adapter).not.toHaveBeenCalled();
    expect(PROBE_PROMPT).toBe("Reply with exactly the word PONG and nothing else.");
    expect(PROBE_DEADLINES).toEqual({ startMs: 60_000, turnMs: 120_000, cleanupMs: 10_000 });
  });

  it("reports offline failures in order", async () => {
    const cases = [
      { profiles: ["missing"], providers: [], code: "probe_profile_unknown" },
      { profiles: ["review"], providers: [], code: "probe_provider_unknown" },
      { profiles: ["review"], providers: [{ id: "example-provider", models: [], authConfigured: false }], code: "probe_model_unknown" },
      { profiles: ["review"], providers: [{ id: "example-provider", models: ["m-small"], authConfigured: false }], code: "probe_auth_missing" },
    ];
    for (const item of cases) {
      const report = await runProfileProbe({ profiles: item.profiles, apply: true }, { ...deps, catalog: async () => ({ providers: () => item.providers }) });
      expect(report).toMatchObject({ status: "failed", exitCode: 1, findings: [{ code: item.code, providerTurn: false }] });
    }
    expect(deps.adapter).not.toHaveBeenCalled();
  });

  it("passes a PONG reply", async () => {
    adapter.plans = [{ synchronous: true, assistantText: " pong. " }];
    const report = await runProfileProbe(request, deps);
    expect(report).toMatchObject({ status: "ok", exitCode: 0, findings: [{ code: "probe_passed", providerTurn: true, durationMs: expect.any(Number) }] });
    expect(adapter.handles[0]?.disposed).toBe(true);
    expect(deps.removeDir).toHaveBeenCalledWith(adapter.createInputs[0]?.cwd);
    expect(formatProbeHuman(report)).toBe("review: ok (probe_passed)\nprovider turns: 1, usage: unknown\n");
    expect(isPong("PONG.. ")).toBe(false);
  });

  it("never reports the reply text", async () => {
    adapter.plans = [{ synchronous: true, assistantText: "/home/user/.pi/agent/auth.json sk-abcdefghijklmnop" }];
    const report = await runProfileProbe(request, deps);
    expect(report.findings[0]?.code).toBe("probe_unexpected_reply");
    expect(JSON.stringify(report) + formatProbeHuman(report)).not.toMatch(/\/home\/|sk-/);
  });

  it("maps start refusals without a provider turn", async () => {
    adapter.plans = [{ creationError: new PiSessionCreationError("unknown_model") }];
    const report = await runProfileProbe(request, deps);
    expect(report.findings[0]).toMatchObject({ code: "probe_start_failed", startCode: "unknown_model", providerTurn: false });
    expect(deps.removeDir).toHaveBeenCalledOnce();
    adapter.plans = [{ creationError: new Error("private details") }];
    expect((await runProfileProbe(request, deps)).findings[0]).toMatchObject({
      code: "probe_start_failed", startCode: "pi_session_creation_failed", providerTurn: false,
    });
    adapter.plans = [{ accepted: false }];
    expect((await runProfileProbe(request, deps)).findings[0]).toMatchObject({
      code: "probe_turn_failed", providerTurn: false,
    });
  });

  it("times out a silent turn and continues", async () => {
    adapter.plans = [{}, { synchronous: true, assistantText: "PONG" }];
    const report = await runProfileProbe({ profiles: ["review", "code"], apply: true }, {
      ...deps, deadlines: { ...PROBE_DEADLINES, turnMs: 20 } as unknown as typeof PROBE_DEADLINES,
    });
    expect(report).toMatchObject({ status: "failed", exitCode: 1 });
    expect(report.findings.map((finding) => finding.code)).toEqual(["probe_timeout", "probe_passed"]);
    expect(adapter.handles[0]).toMatchObject({ aborted: 1, disposed: true });
    expect(deps.removeDir).toHaveBeenCalledTimes(2);
  });

  it("disposes a session whose start finishes after its deadline", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const late = { create: async (input: Parameters<FakeAdapter["create"]>[0]) => { await gate; return adapter.create(input); } };
    const report = await runProfileProbe(request, {
      ...deps, adapter: async () => late, deadlines: { ...PROBE_DEADLINES, startMs: 20 } as unknown as typeof PROBE_DEADLINES,
    });
    expect(report.findings[0]).toMatchObject({ code: "probe_timeout", providerTurn: false });
    expect(deps.removeDir).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(adapter.handles[0]).toMatchObject({ disposed: true }));
    expect(adapter.handles[0]?.preflight).toBeUndefined();
  });

  it("still disposes and removes the directory when abort and dispose throw", async () => {
    adapter.plans = [{}];
    const throwing = { create: async (input: Parameters<FakeAdapter["create"]>[0]) => {
      const handle = await adapter.create(input) as FakeHandle;
      handle.abortError = new Error("abort failed");
      handle.disposeError = new Error("dispose failed");
      return handle;
    } };
    const report = await runProfileProbe(request, {
      ...deps, adapter: async () => throwing, deadlines: { ...PROBE_DEADLINES, turnMs: 20 } as unknown as typeof PROBE_DEADLINES,
    });
    expect(report.findings[0]).toMatchObject({ code: "probe_timeout" });
    expect(adapter.handles[0]).toMatchObject({ aborted: 1, disposeCalls: 1 });
    expect(deps.removeDir).toHaveBeenCalledOnce();
  });

  it("aborts and cleans up on interrupt", async () => {
    const controller = new AbortController();
    const running = runProfileProbe({ profiles: ["review", "code"], apply: true }, { ...deps, signal: controller.signal });
    await vi.waitFor(() => expect(adapter.handles[0]?.preflight).toBeDefined());
    controller.abort();
    const report = await running;
    expect(report).toMatchObject({ refusal: "operation_interrupted", exitCode: 130 });
    expect(adapter.handles[0]).toMatchObject({ aborted: 1, disposed: true });
    expect(adapter.createInputs).toHaveLength(1);
    expect(deps.removeDir).toHaveBeenCalledOnce();
  });

  it("gates on global and own Doctor errors only", async () => {
    const doctor = (checks: DoctorCheck[]) => async (): Promise<DoctorResult> => ({ schemaVersion: 1, ok: false, checks, exitCode: 1 });
    for (const check of [
      { id: "config_invalid", severity: "error", subject: "configuration" },
      { id: "extension_missing", severity: "error", subject: "review:pkg" },
    ] satisfies DoctorCheck[]) {
      const report = await runProfileProbe(request, { ...deps, doctor: doctor([check, check]) });
      expect(report).toMatchObject({ refusal: "doctor_failed", exitCode: 1, findings: [], doctor: { blocking: [check.id] } });
    }
    expect(deps.catalog).not.toHaveBeenCalled();
    expect(deps.adapter).not.toHaveBeenCalled();
    const report = await runProfileProbe({ ...request, apply: false }, { ...deps, doctor: doctor([
      { id: "extension_missing", severity: "error", subject: "other:pkg" },
      { id: "workspace_gitfile", severity: "warning", subject: "review" },
    ]) });
    expect(report).toMatchObject({ status: "planned", doctor: { blocking: [], other: ["extension_missing", "workspace_gitfile"] } });
  });

  it("probes each alias once in request order", async () => {
    adapter.plans = [{ synchronous: true, assistantText: "PONG" }, { synchronous: true, assistantText: "PONG" }];
    const report = await runProfileProbe({ profiles: ["code", "review", "code"], apply: true }, deps);
    expect(report.findings.map((finding) => finding.profile)).toEqual(["code", "review"]);
    expect(adapter.createInputs.map((input) => input.executionProfile.alias)).toEqual(["code", "review"]);
    expect(new Set(adapter.createInputs.map((input) => input.cwd)).size).toBe(2);
  });
});
