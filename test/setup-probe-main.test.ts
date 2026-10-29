import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorResult } from "../src/doctor.js";
import type { SetupOrchestrator } from "../src/setup.js";
import { FakeAdapter } from "./fake-adapter.js";

const catalog = async () => ({ providers: () => [{ id: "example-provider", authConfigured: true, models: ["m-small"] }] });
const doctor = async (): Promise<DoctorResult> => ({ schemaVersion: 1, ok: true, checks: [], exitCode: 0 });

describe("setup probe entry", () => {
  let root: string;
  let configPath: string;
  let output: string[];
  const originalConfig = process.env.PI_SESSION_MCP_CONFIG;
  const originalWrite = process.stdout.write;
  const originalEnd = process.stdout.end;
  const originalConsole = { log: console.log, info: console.info, debug: console.debug };
  let exitListeners: ((code: number) => void)[];

  beforeEach(async () => {
    vi.resetModules();
    exitListeners = process.listeners("exit");
    output = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk)); return true;
    }) as typeof process.stdout.write);
    root = await mkdtemp(join(tmpdir(), "setup-probe-main-test-"));
    configPath = join(root, "candidate.json");
    await writeFile(configPath, JSON.stringify({ workspaces: {}, executionProfiles: {
      review: { default: true, permissionProfile: "read-only", provider: "example-provider", model: "m-small", thinkingLevel: "off" },
    } }));
  });
  afterEach(async () => {
    // The entry deliberately installs a process-wide guard; undo it between isolated imports.
    for (const listener of process.listeners("exit")) if (!exitListeners.includes(listener)) process.removeListener("exit", listener);
    vi.restoreAllMocks();
    process.stdout.write = originalWrite;
    process.stdout.end = originalEnd;
    Object.assign(console, originalConsole);
    vi.doUnmock("../src/setup-probe-main.js");
    if (originalConfig === undefined) delete process.env.PI_SESSION_MCP_CONFIG;
    else process.env.PI_SESSION_MCP_CONFIG = originalConfig;
    await rm(root, { recursive: true, force: true });
  });

  it("lists models as JSON", async () => {
    const { runListModels } = await import("../src/setup-probe-main.js");
    expect(await runListModels(true, { catalog })).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output.join(""))).toMatchObject({ schemaVersion: 1, status: "ok", providers: [{ id: "example-provider" }], exitCode: 0 });
  });

  it("requires a configuration for probes", async () => {
    delete process.env.PI_SESSION_MCP_CONFIG;
    const { main } = await import("../src/setup-main.js");
    expect(await main(["--probe-profile", "review", "--json"])).toBe(1);
    expect(JSON.parse(output.join(""))).toMatchObject({ status: "failed", refusal: "config_required", exitCode: 1 });
  });

  it("keeps the report intact when a profile writes to stdout", async () => {
    const { runProbe } = await import("../src/setup-probe-main.js");
    const adapter = new FakeAdapter();
    adapter.plans = [{ synchronous: true, assistantText: "PONG" }];
    const create = adapter.create.bind(adapter);
    vi.spyOn(adapter, "create").mockImplementation(async (input) => {
      process.stdout.write("noise"); console.log("noise");
      return create(input);
    });
    expect(await runProbe({ profiles: ["review"], apply: true }, true, configPath, new AbortController().signal, { catalog, doctor, adapter: async () => adapter })).toBe(0);
    expect(output).toHaveLength(1);
    expect(output.join("")).not.toContain("noise");
    expect(JSON.parse(output.join(""))).toMatchObject({ status: "ok", findings: [{ code: "probe_passed" }] });
    expect(adapter.handles[0]?.disposed).toBe(true);
    const { stdoutGuard } = await import("../src/stdout-guard-install.js");
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    stdoutGuard.flush();
  });

  it("reports contain no paths", async () => {
    const { runProbe } = await import("../src/setup-probe-main.js");
    expect(await runProbe({ profiles: ["review"], apply: false }, true, configPath, new AbortController().signal, { catalog, doctor })).toBe(0);
    expect(output.join("")).not.toContain(root);
    expect(output.join("")).not.toMatch(/\/tmp\/|\/home\/|candidate\.json/);
    expect(JSON.parse(output.join(""))).toMatchObject({ status: "planned" });
  });

  it("fails closed when catalog creation rejects", async () => {
    const { runListModels, runProbe } = await import("../src/setup-probe-main.js");
    const unavailable = async (): Promise<never> => { throw new Error(configPath); };
    expect(await runListModels(true, { catalog: unavailable })).toBe(1);
    expect(JSON.parse(output.join(""))).toMatchObject({ status: "failed", code: "catalog_unavailable" });
    output.length = 0;
    expect(await runProbe({ profiles: ["review"], apply: false }, true, configPath, new AbortController().signal, { catalog: unavailable, doctor })).toBe(1);
    expect(JSON.parse(output.join(""))).toMatchObject({ status: "failed", refusal: "catalog_unavailable" });
    expect(output.join("")).not.toContain(configPath);
  });

  it("maps unexpected probe failures to a sanitized refusal", async () => {
    const { runProbe } = await import("../src/setup-probe-main.js");
    expect(await runProbe({ profiles: ["review"], apply: false }, true, configPath, new AbortController().signal, {
      catalog, doctor: async () => { throw new Error(configPath); },
    })).toBe(1);
    expect(JSON.parse(output.join(""))).toMatchObject({ status: "failed", refusal: "operation_failed" });
    expect(output.join("")).not.toContain(configPath);
  });

  it("dispatches the catalog without a configuration", async () => {
    delete process.env.PI_SESSION_MCP_CONFIG;
    const entry = await import("../src/setup-probe-main.js");
    vi.doMock("../src/setup-probe-main.js", () => ({ runListModels: (json: boolean) => entry.runListModels(json, { catalog }) }));
    const { main } = await import("../src/setup-main.js");
    expect(await main(["--list-models", "--json"])).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ status: "ok", providers: [{ id: "example-provider" }] });
  });

  it.each([{ name: "SIGINT", code: 130 }, { name: "SIGTERM", code: 143 }] as const)("feeds $name to the probe and maps its exit code", async ({ name, code }) => {
    const entry = await import("../src/setup-probe-main.js");
    const adapter = new FakeAdapter();
    let runningSignal: AbortSignal | undefined;
    vi.doMock("../src/setup-probe-main.js", () => ({ runProbe: (...args: Parameters<typeof entry.runProbe>) => {
      runningSignal = args[3];
      return entry.runProbe(args[0], args[1], args[2], args[3], { catalog, doctor, adapter: async () => adapter });
    } }));
    process.env.PI_SESSION_MCP_CONFIG = configPath;
    const { main } = await import("../src/setup-main.js");
    const running = main(["--probe-profile", "review", "--apply", "--json"]);
    await vi.waitFor(() => expect(adapter.handles[0]?.preflight).toBeDefined());
    process.emit(name);
    expect(await running).toBe(code);
    expect(runningSignal?.aborted).toBe(true);
    expect(adapter.handles[0]).toMatchObject({ aborted: 1, disposed: true });
    expect(JSON.parse(output.join(""))).toMatchObject({ status: "failed", refusal: "operation_interrupted", exitCode: code });
  });

  it("ordinary setup runs do not load the probe entry", async () => {
    let imports = 0;
    vi.doMock("../src/setup-probe-main.js", () => { imports += 1; return {}; });
    process.env.PI_SESSION_MCP_CONFIG = configPath;
    const { main } = await import("../src/setup-main.js");
    const createSetup = vi.fn(async () => ({ run: async () => ({ schemaVersion: 1, operation: "dry-run", status: "planned", findings: [], exitCode: 0 }) }) as unknown as SetupOrchestrator);
    expect(await main(["--target", "codex:user:pi-session-mcp", "--dry-run"], { createSetup })).toBe(0);
    expect(createSetup).toHaveBeenCalledOnce();
    expect(imports).toBe(0);
  });
});
