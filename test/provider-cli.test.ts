import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runProviderCli } from "../src/provider-cli.js";
import { ProviderStoreError, type ProviderStore } from "../src/provider-store-contract.js";

function fixture() {
  let out = "", err = "";
  const store: ProviderStore = {
    read: vi.fn(async () => ({ sources: [], definitions: [] })),
    setKey: vi.fn(async () => {}), removeKey: vi.fn(async () => {}), inherit: vi.fn(async () => {}),
    addProvider: vi.fn(async () => {}), removeProvider: vi.fn(async () => {}),
  };
  const catalog = async () => ({ providers: () => [{ id: "openai", authConfigured: true, models: [] }] });
  const run = (args: string[], extra: Partial<Parameters<typeof runProviderCli>[1]> = {}) => runProviderCli(args, { store, catalog, stdout: t => { out += t; }, stderr: t => { err += t; }, ...extra });
  return { store, run, output: () => out + err };
}
describe("provider CLI", () => {
  it("lists safe metadata only in human and JSON modes", async () => {
    const f = fixture();
    for (const args of [["list"], ["list", "--json"]]) expect(await f.run(args)).toBe(0);
    expect(f.output()).toContain('"id": "openai"');
    expect(f.output()).not.toContain("sk-test-SENTINEL");
  });
  it("reads stdin, never prints the key or a path, and rejects extra arguments", async () => {
    const f = fixture();
    expect(await f.run(["auth", "set", "openai", "--stdin"], { input: Readable.from(["sk-test-SENTINEL\n"]) })).toBe(0);
    expect(f.store.setKey).toHaveBeenCalledWith("openai", "sk-test-SENTINEL", { builtInProviderIds: ["openai"] });
    expect(await f.run(["auth", "set", "openai", "sk-test-SENTINEL"])).toBe(64);
    expect(f.output()).not.toContain("sk-test-SENTINEL"); expect(f.output()).not.toContain("/home/");
  });
  it("cancels raw input without touching the store, restores mode, and refuses closed or non-tty input", async () => {
    const f = fixture();
    const stream = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
    const result = f.run(["auth", "set", "openai"], { input: stream });
    await new Promise(resolve => setImmediate(resolve)); stream.write("sk-test-SENTINEL\u0003");
    expect(await result).toBe(4); expect(stream.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(f.store.setKey).not.toHaveBeenCalled(); expect(f.output()).not.toContain("sk-test-SENTINEL");
    expect(await f.run(["auth", "set", "openai"], { input: Readable.from([]) })).toBe(64);
    const closed = new PassThrough(); closed.destroy();
    expect(await f.run(["auth", "set", "openai", "--stdin"], { input: closed })).toBe(4);
  });
  it("accepts hidden terminal input and invokes auth operations", async () => {
    const f = fixture();
    const stream = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
    const result = f.run(["auth", "set", "openai"], { input: stream });
    await new Promise(resolve => setImmediate(resolve)); stream.write("sk-test-SENTINEL\r");
    expect(await result).toBe(0); expect(stream.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(await f.run(["auth", "remove", "openai"])).toBe(0);
    expect(await f.run(["auth", "inherit", "openai"])).toBe(0);
    expect(f.store.removeKey).toHaveBeenCalledOnce(); expect(f.store.inherit).toHaveBeenCalledOnce();
    expect(f.output()).not.toContain("sk-test-SENTINEL");
  });
  it("lists custom providers and bound key status without their endpoint", async () => {
    const f = fixture();
    vi.mocked(f.store.read).mockResolvedValue({ sources: [{ providerId: "custom", source: "key", bindingValid: false }], definitions: [{ id: "custom", api: "openai-completions", baseUrl: "https://private.example", models: [] }] });
    expect(await f.run(["list", "--json"])).toBe(0);
    expect(f.output()).toContain('"kind":"custom"'); expect(f.output()).toContain('"bindingValid":false'); expect(f.output()).not.toContain("private.example");
  });
  it("checks definitions before writing", async () => {
    const f = fixture();
    const args = (api: string, url: string) => ["add", "custom", "--api", api, "--base-url", url, "--model", "m"];
    for (const [api, url] of [["bad", "https://example.test"], ["openai-completions", "http://example.test"], ["openai-completions", "https://user:pass@example.test"], ["openai-completions", "not-url"]]) expect(await f.run(args(api!, url!))).toBe(4);
    expect(await f.run(args("openai-completions", "http://localhost:8080"))).toBe(0);
    expect(f.store.addProvider).toHaveBeenCalledOnce();
  });
  it("refuses to remove a referenced provider", async () => {
    const f = fixture();
    const loadConfig = vi.fn(async () => ({ executionProfiles: new Map([["p", { provider: "openai" }]]) })) as unknown as typeof import("../src/config.js").loadConfig;
    expect(await f.run(["remove", "openai"], { configPath: "/private/path", loadConfig })).toBe(1);
    expect(f.output()).toContain("provider_in_use"); expect(f.output()).not.toContain("/private/path"); expect(f.store.removeProvider).not.toHaveBeenCalled();
  });
  it("maps store errors to fixed exit codes", async () => {
    for (const [code, exit] of [["provider_unknown", 3], ["credential_invalid", 4], ["provider_store_busy", 1]] as const) {
      const f = fixture(); vi.mocked(f.store.removeKey).mockRejectedValue(new ProviderStoreError(code));
      expect(await f.run(["auth", "remove", "openai"])).toBe(exit); expect(f.output()).toContain(code);
    }
  });
});
