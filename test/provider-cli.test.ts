import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runProviderCli } from "../src/provider-cli.js";
import { ProviderStoreError, type ProviderStore } from "../src/provider-store-contract.js";
import type { PiAuthMode } from "../src/provider-sign-in.js";

const catalogs = vi.hoisted(() => ({ createModelCatalog: vi.fn(), createCredentialFreeModelCatalog: vi.fn() }));
// Only the default catalog factories are replaced; the tests that inject a catalog never reach them.
vi.mock("../src/model-catalog.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/model-catalog.js")>(), ...catalogs }));

function fixture() {
  let out = "", err = "";
  const store: ProviderStore = {
    read: vi.fn(async () => ({ sources: [], definitions: [] })),
    setKey: vi.fn(async () => {}), removeKey: vi.fn(async () => {}), inherit: vi.fn(async () => {}),
    addProvider: vi.fn(async () => {}), removeProvider: vi.fn(async () => {}),
  };
  const catalog = async () => ({ providers: () => [{ id: "openai", authConfigured: true, models: [] }] });
  const run = (args: string[], extra: Partial<Parameters<typeof runProviderCli>[1]> = {}) => runProviderCli(args, { store, catalog, stdout: t => { out += t; }, stderr: t => { err += t; }, ...extra });
  return { store, run, output: () => out + err, stdout: () => out, stderr: () => err };
}
const terminal = () => Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
const storedKey = { sources: [{ providerId: "openai", source: "key" as const, bindingValid: true }], definitions: [] };
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
  it("refuses --stdin on a terminal, where the key would echo", async () => {
    const f = fixture();
    const stream = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
    expect(await f.run(["auth", "set", "openai", "--stdin"], { input: stream })).toBe(64);
    expect(f.output()).toContain("usage_invalid"); expect(stream.setRawMode).not.toHaveBeenCalled(); expect(f.store.setKey).not.toHaveBeenCalled();
  });
  it("reports an unloadable selected configuration as config_invalid and keeps the provider", async () => {
    const f = fixture();
    const loadConfig = vi.fn(async () => { throw new Error("/private/path is broken"); }) as unknown as typeof import("../src/config.js").loadConfig;
    expect(await f.run(["remove", "openai"], { configPath: "/private/path", loadConfig })).toBe(1);
    expect(f.output()).toContain("config_invalid"); expect(f.output()).not.toContain("/private/path"); expect(f.store.removeProvider).not.toHaveBeenCalled();
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
  it("says that terminal input is hidden and that a new key was stored", async () => {
    const f = fixture();
    const stream = terminal();
    const result = f.run(["auth", "set", "openai"], { input: stream });
    await new Promise(resolve => setImmediate(resolve)); stream.write("sk-test-SENTINEL\r");
    expect(await result).toBe(0);
    expect(f.stderr()).toBe("Enter the key for openai (input is hidden): \nopenai: key stored\n");
    expect(f.stdout()).toBe("ok\n");
  });
  it("announces a stored key before the prompt and reports its replacement", async () => {
    const f = fixture(); vi.mocked(f.store.read).mockResolvedValue(storedKey);
    const stream = terminal();
    const result = f.run(["auth", "set", "openai"], { input: stream });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.stderr()).toBe("A key is already stored for openai. A new key replaces it; an empty entry keeps it.\nEnter the key for openai (input is hidden): ");
    stream.write("sk-test-SENTINEL\r");
    expect(await result).toBe(0);
    expect(f.stderr()).toMatch(/\nopenai: key replaced\n$/); expect(f.stderr()).not.toContain("key stored");
    expect(f.store.setKey).toHaveBeenCalledOnce(); expect(f.output()).not.toContain("sk-test-SENTINEL");
  });
  it("keeps a stored key on an empty entry", async () => {
    const f = fixture(); vi.mocked(f.store.read).mockResolvedValue(storedKey);
    const stream = terminal();
    const result = f.run(["auth", "set", "openai"], { input: stream });
    await new Promise(resolve => setImmediate(resolve)); stream.write("\r");
    expect(await result).toBe(4);
    expect(f.store.setKey).not.toHaveBeenCalled();
    expect(f.stderr()).toContain("A key is already stored for openai."); expect(f.stderr()).toContain("credential_invalid");
    expect(f.stderr()).not.toContain("key replaced"); expect(f.stdout()).toBe("");
  });
  it("adds no terminal text to the --stdin path, even over a stored key", async () => {
    const f = fixture(); vi.mocked(f.store.read).mockResolvedValue(storedKey);
    expect(await f.run(["auth", "set", "openai", "--stdin"], { input: Readable.from(["sk-test-SENTINEL\n"]) })).toBe(0);
    expect(f.stderr()).toBe(""); expect(f.stdout()).toBe("ok\n");
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
  it("restores the catalog over Pi's credential store for list only, by default (#304)", async () => {
    const identities = { providers: () => [{ id: "openai", authConfigured: false, models: [], signIn: true as const }] };
    catalogs.createModelCatalog.mockResolvedValue(identities);
    catalogs.createCredentialFreeModelCatalog.mockResolvedValue(identities);
    const loadConfig = vi.fn(async () => ({ executionProfiles: new Map() })) as unknown as typeof import("../src/config.js").loadConfig;
    const cases: readonly (readonly [readonly string[], Partial<Parameters<typeof runProviderCli>[1]>])[] = [
      [["list"], {}],
      [["list", "--json"], {}],
      [["add", "local", "--api", "openai-completions", "--base-url", "https://example.invalid/v1", "--model", "m1"], {}],
      [["remove", "openai"], { configPath: "/private/path", loadConfig }],
      [["auth", "set", "openai", "--stdin"], { input: Readable.from(["sk-test-SENTINEL\n"]) }],
      [["auth", "remove", "openai"], {}],
      [["auth", "inherit", "openai"], {}],
      [["auth", "login", "openai"], { input: terminal(), stderrTerminal: true, runPi: async () => 0 }],
      [["auth", "logout", "openai"], { runPi: async () => 0 }],
    ];
    for (const [args, extra] of cases) {
      catalogs.createModelCatalog.mockClear(); catalogs.createCredentialFreeModelCatalog.mockClear();
      const list = args[0] === "list";
      expect(await runProviderCli(args, { store: fixture().store, stdout: () => {}, stderr: () => {}, ...extra }), args.join(" ")).toBe(0);
      expect(catalogs.createModelCatalog, args.join(" ")).toHaveBeenCalledTimes(list ? 1 : 0);
      expect(catalogs.createCredentialFreeModelCatalog, args.join(" ")).toHaveBeenCalledTimes(list ? 0 : 1);
    }
  });
});

const signInCatalog = async () => ({ providers: () => [{ id: "openai", authConfigured: false, models: [], signIn: true as const }, { id: "deepseek", authConfigured: false, models: [] }] });
const sourceOf = (source: "none" | "key") => ({ sources: [{ providerId: "openai", source, bindingValid: true }], definitions: [] });
const ANNOUNCE = 'Signing in to openai through Pi. Where Pi suggests "pi auth login", run "pi-session-mcp-provider auth login".\n';
const KEY_STORED = 'A key is stored for openai and takes precedence over a sign-in. "pi-session-mcp-provider auth inherit openai" drops the key; "pi-session-mcp-provider auth remove openai" disables the provider.\n';
/** A provider CLI on two terminals whose Pi child exits with `status`. */
function signInFixture(status = 0) {
  const f = fixture();
  const runPi = vi.fn<(args: readonly string[], mode: PiAuthMode) => Promise<number>>(async () => status);
  const run = (args: string[], extra: Partial<Parameters<typeof runProviderCli>[1]> = {}) => f.run(args, { catalog: signInCatalog, input: terminal(), stderrTerminal: true, runPi, ...extra });
  return { ...f, runPi, run };
}
const order = (mock: { mock: { invocationCallOrder: number[] } }): number => mock.mock.invocationCallOrder[0]!;

describe("provider CLI account sign-in", () => {
  it("refuses auth login without terminals on stdin and stderr", async () => {
    const f = signInFixture();
    expect(await f.run(["auth", "login", "openai"], { input: Readable.from([]) })).toBe(64);
    expect(await f.run(["auth", "login", "openai"], { stderrTerminal: false })).toBe(64);
    expect(f.stderr()).toBe("usage_invalid\nusage_invalid\n");
    expect(f.store.read).not.toHaveBeenCalled(); expect(f.runPi).not.toHaveBeenCalled();
  });
  it("rejects malformed login and logout arguments", async () => {
    const f = signInFixture();
    for (const args of [["auth", "login"], ["auth", "logout"], ["auth", "login", "openai", "--browser"], ["auth", "login", "openai", "--no-browser", "x"], ["auth", "logout", "openai", "--no-browser"], ["auth", "login", "bad id"]]) {
      expect(await f.run(args), args.join(" ")).toBe(64);
    }
    expect(f.runPi).not.toHaveBeenCalled(); expect(f.store.read).not.toHaveBeenCalled();
  });
  it("refuses unknown, operator-defined and key-only providers before Pi runs", async () => {
    const f = signInFixture();
    vi.mocked(f.store.read).mockResolvedValue({ sources: [], definitions: [{ id: "custom", api: "openai-completions", baseUrl: "https://example.test", models: [] }] });
    for (const action of ["login", "logout"]) {
      expect(await f.run(["auth", action, "nope"])).toBe(3);
      expect(await f.run(["auth", action, "custom"])).toBe(4);
      expect(await f.run(["auth", action, "deepseek"])).toBe(4);
    }
    expect(f.stderr()).toBe("provider_unknown\nsign_in_unsupported\nsign_in_unsupported\n".repeat(2));
    expect(f.runPi).not.toHaveBeenCalled(); expect(f.store.removeKey).not.toHaveBeenCalled(); expect(f.store.inherit).not.toHaveBeenCalled();
  });
  it("refuses a sign-in while a stored key is the source and says how to change it", async () => {
    const f = signInFixture(); vi.mocked(f.store.read).mockResolvedValue(sourceOf("key"));
    expect(await f.run(["auth", "login", "openai"])).toBe(4);
    expect(f.stderr()).toBe(KEY_STORED + "provider_key_stored\n");
    expect(f.stdout()).toBe(""); expect(f.runPi).not.toHaveBeenCalled();
  });
  it("announces the sign-in and runs Pi's own sign-in with the terminal streams", async () => {
    const f = signInFixture();
    expect(await f.run(["auth", "login", "openai"])).toBe(0);
    expect(f.runPi).toHaveBeenLastCalledWith(["auth", "login", "openai"], "terminal");
    expect(await f.run(["auth", "login", "openai", "--no-browser"])).toBe(0);
    expect(f.runPi).toHaveBeenLastCalledWith(["auth", "login", "openai", "--no-browser"], "terminal");
    expect(f.stderr()).toBe(ANNOUNCE + ANNOUNCE); expect(f.stdout()).toBe("ok\nok\n");
    expect(f.store.inherit).not.toHaveBeenCalled();
  });
  it("enables Pi authentication after a successful sign-in of a provider set to none, only from none", async () => {
    const f = signInFixture(); vi.mocked(f.store.read).mockResolvedValue(sourceOf("none"));
    expect(await f.run(["auth", "login", "openai"])).toBe(0);
    // The store checks the source under its lock (test/provider-store.test.ts); a second read here would race.
    expect(f.store.read).toHaveBeenCalledOnce();
    expect(f.store.inherit).toHaveBeenCalledWith("openai", { builtInProviderIds: ["openai", "deepseek"] }, "none");
    expect(order(vi.mocked(f.store.inherit))).toBeGreaterThan(order(f.runPi));
    expect(f.stdout()).toBe("ok\n");
  });
  it("fails closed when Pi's sign-in does not exit with 0", async () => {
    const failed = signInFixture(1);
    const rejected = signInFixture(); rejected.runPi.mockRejectedValue(new Error("spawn failed"));
    for (const f of [failed, rejected]) {
      vi.mocked(f.store.read).mockResolvedValue(sourceOf("none"));
      expect(await f.run(["auth", "login", "openai"])).toBe(1);
      expect(f.stderr()).toBe(ANNOUNCE + "sign_in_failed\n"); expect(f.stdout()).toBe("");
      expect(f.store.inherit).not.toHaveBeenCalled(); expect(f.store.read).toHaveBeenCalledOnce();
    }
  });
  it("reports provider_store_unavailable when the source cannot change after Pi signed in", async () => {
    const busy = signInFixture(); vi.mocked(busy.store.inherit).mockRejectedValue(new ProviderStoreError("provider_store_busy"));
    const invalid = signInFixture(); vi.mocked(invalid.store.inherit).mockRejectedValue(new ProviderStoreError("provider_store_invalid"));
    // An error that would map to 3 elsewhere stays 1 here: Pi has already run.
    const unknown = signInFixture(); vi.mocked(unknown.store.inherit).mockRejectedValue(new ProviderStoreError("provider_unknown"));
    for (const f of [busy, invalid, unknown]) {
      vi.mocked(f.store.read).mockResolvedValue(sourceOf("none"));
      expect(await f.run(["auth", "login", "openai"])).toBe(1);
      expect(f.stderr()).toBe(ANNOUNCE + "provider_store_unavailable\n"); expect(f.stdout()).toBe("");
    }
  });
  it("signs out by setting none before Pi deletes its entry", async () => {
    const f = signInFixture();
    expect(await f.run(["auth", "logout", "openai"])).toBe(0);
    expect(f.store.removeKey).toHaveBeenCalledWith("openai", { builtInProviderIds: ["openai", "deepseek"] }, "inherit");
    expect(f.runPi).toHaveBeenCalledWith(["auth", "logout", "openai"], "silent");
    expect(order(vi.mocked(f.store.removeKey))).toBeLessThan(order(f.runPi));
    expect(f.stdout()).toBe("ok\n"); expect(f.stderr()).toBe("");
  });
  it("signs out without changing a none or key source", async () => {
    for (const source of ["none", "key"] as const) {
      const f = signInFixture(); vi.mocked(f.store.read).mockResolvedValue(sourceOf(source));
      expect(await f.run(["auth", "logout", "openai"])).toBe(0);
      expect(f.store.removeKey).not.toHaveBeenCalled(); expect(f.store.inherit).not.toHaveBeenCalled();
      expect(f.runPi).toHaveBeenCalledWith(["auth", "logout", "openai"], "silent");
    }
  });
  it("does not run Pi when the none write fails", async () => {
    const f = signInFixture(); vi.mocked(f.store.removeKey).mockRejectedValue(new ProviderStoreError("provider_store_busy"));
    expect(await f.run(["auth", "logout", "openai"])).toBe(1);
    expect(f.stderr()).toContain("provider_store_busy"); expect(f.runPi).not.toHaveBeenCalled(); expect(f.stdout()).toBe("");
  });
  it("reports sign_out_failed and keeps none when Pi's sign-out fails", async () => {
    const failed = signInFixture(1);
    const rejected = signInFixture(); rejected.runPi.mockRejectedValue(new Error("spawn failed"));
    for (const f of [failed, rejected]) {
      expect(await f.run(["auth", "logout", "openai"])).toBe(1);
      expect(f.stderr()).toBe("sign_out_failed\n"); expect(f.stdout()).toBe("");
      expect(f.store.removeKey).toHaveBeenCalledOnce(); expect(f.store.inherit).not.toHaveBeenCalled();
    }
  });
  it("signs out without a terminal", async () => {
    const f = signInFixture(); vi.mocked(f.store.read).mockResolvedValue(sourceOf("none"));
    expect(await f.run(["auth", "logout", "openai"], { input: Readable.from([]), stderrTerminal: false })).toBe(0);
    expect(f.runPi).toHaveBeenCalledWith(["auth", "logout", "openai"], "silent"); expect(f.stdout()).toBe("ok\n");
  });
});
