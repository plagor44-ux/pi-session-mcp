import type { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { containerRuntimeUsable } from "../src/container-runtime.js";

type Callback = (error: (Error & { killed?: boolean; signal?: string; code?: unknown }) | null, stdout: string, stderr: string) => void;
type Outcome = { error?: Error & { killed?: boolean; signal?: string; code?: unknown }; stdout?: string };

const timeout = (): Outcome => ({ error: Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL", code: null }), stdout: "" });
const failure = (): Outcome => ({ error: Object.assign(new Error("exit 1"), { code: 1 }), stdout: "" });
const answer = (stdout: string): Outcome => ({ stdout });

function fake(...outcomes: Outcome[]) {
  const calls: { file: string; args: readonly string[]; options: { timeout?: number } }[] = [];
  const run = vi.fn((file: string, args: readonly string[], options: { timeout?: number }, callback: Callback) => {
    calls.push({ file, args, options });
    const outcome = outcomes[calls.length - 1] ?? failure();
    callback(outcome.error ?? null, outcome.stdout ?? "", "");
  });
  return { calls, run: run as unknown as typeof execFile };
}

describe("containerRuntimeUsable retry (#229)", () => {
  it("retries once after a timeout and accepts the second answer, each attempt bounded by 10 s", async () => {
    const { calls, run } = fake(timeout(), answer("true\n"));
    expect(await containerRuntimeUsable({ execFile: run })).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.options.timeout)).toEqual([10_000, 10_000]);
    expect(calls[1]).toMatchObject({ file: "podman", args: ["info", "--format", "{{.Host.Security.Rootless}}"] });
  });

  it("stays unusable after two timeouts and does not try a third time", async () => {
    const { calls, run } = fake(timeout(), timeout(), answer("true"));
    expect(await containerRuntimeUsable({ execFile: run })).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("passes an injected timeout to each attempt", async () => {
    const { calls, run } = fake(timeout(), timeout());
    await containerRuntimeUsable({ execFile: run, timeoutMs: 25 });
    expect(calls.map((call) => call.options.timeout)).toEqual([25, 25]);
  });

  it.each([
    ["an error", failure()],
    ["an error that still printed true", { ...failure(), stdout: "true" }],
    ["a missing binary", { error: Object.assign(new Error("spawn podman ENOENT"), { code: "ENOENT" }), stdout: "" }],
    ["an exceeded output cap", { error: Object.assign(new Error("maxBuffer"), { killed: true, signal: "SIGKILL", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), stdout: "" }],
    ["a wrong answer", answer("false")],
    ["an unexpected answer", answer("true extra")],
  ] as const)("does not retry after %s", async (_label, outcome) => {
    const { calls, run } = fake(outcome, answer("true"));
    expect(await containerRuntimeUsable({ execFile: run })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a usable answer", async () => {
    const { calls, run } = fake(answer("true"), answer("false"));
    expect(await containerRuntimeUsable({ execFile: run })).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("returns false when execFile throws", async () => {
    const run = vi.fn(() => { throw new Error("boom"); }) as unknown as typeof execFile;
    expect(await containerRuntimeUsable({ execFile: run })).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
