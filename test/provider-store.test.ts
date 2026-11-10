import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { loadProviderPolicy, loadRuntimeProviderPolicy, openProviderStore, providerSecretValues, refreshProviderRedactionValues, type ProviderPolicyRuntime, type ProviderPolicy } from "../src/provider-store.js";
import { type ProviderDefinition, ProviderStoreError } from "../src/provider-store-contract.js";
import { createModelCatalog } from "../src/model-catalog.js";
import { providerStoreCheck } from "../src/doctor.js";
import { Redactor } from "../src/history/redact.js";
import { lockWithFlock } from "../src/override-lock.js";
import { selectBoundaryCredentials, writeBoundaryCredentials, writeBoundaryProviders } from "../src/writer-credentials.js";

vi.mock("node:os", async original => { const actual = await original<typeof import("node:os")>(); return { ...actual, userInfo: vi.fn(actual.userInfo) }; });
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), lstat: vi.fn(actual.lstat) };
});
vi.mock("../src/model-catalog.js", async original => ({
  ...await original<typeof import("../src/model-catalog.js")>(),
  catalogBuiltInProviderIds: async (_create: unknown, factory: () => Promise<ProviderPolicy>) => {
    const ids = ["openai", "anthropic", ...Array.from({ length: 12 }, (_, n) => `p${n}`)];
    await (await factory()).apply({ getProviders: () => ids.map(id => ({ id })), registerProvider: () => {}, setRuntimeApiKey: async () => {} });
    return ids;
  },
}));
let home: string;
let directory: string;
const builtin = { builtInProviderIds: ["openai", "anthropic"] };
const definition: ProviderDefinition = { id: "custom", api: "openai-completions", baseUrl: "https://example.invalid/api", models: [{ id: "model", contextWindow: 4096, maxTokens: 1024, input: ["text"], reasoning: false }] };
const key = "sk-test-stored-synthetic";
beforeEach(async () => { home = await fs.mkdtemp(join(tmpdir(), "provider-store-")); directory = join(home, ".config", "pi-session-mcp", "providers"); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });
const store = () => openProviderStore({ home });
const policy = () => loadProviderPolicy({ home });
function runtime() {
  const definitions = new Map<string, Parameters<ProviderPolicyRuntime["registerProvider"]>[1]>();
  const keys = new Map<string, string>();
  return {
    getProviders: () => [...builtin.builtInProviderIds, ...definitions.keys()].map(id => ({ id })),
    getModels: (id: string) => definitions.get(id)?.models ?? [{ id: "model" }],
    registerProvider: vi.fn<ProviderPolicyRuntime["registerProvider"]>((id, config) => { definitions.set(id, config); }),
    setRuntimeApiKey: vi.fn<ProviderPolicyRuntime["setRuntimeApiKey"]>(async (id, value) => { keys.set(id, value); }),
    checkAuth: vi.fn(async (id: string) => keys.has(id) ? { type: "api_key" } : { type: "oauth" }),
    getAuth: vi.fn(async (id: string) => keys.get(id) ?? "inherited"),
  };
}

describe("provider store", () => {
  it("does not create files on read and defaults to inheritance", async () => {
    expect(await store().read()).toEqual({ definitions: [], sources: [] });
    expect((await policy()).source("openai")).toBe("inherit");
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("uses the account home rather than HOME or XDG_CONFIG_HOME", async () => {
    vi.mocked(userInfo).mockReturnValueOnce({ ...userInfo(), homedir: home });
    vi.stubEnv("HOME", join(home, "not-account")); vi.stubEnv("XDG_CONFIG_HOME", join(home, "not-config"));
    await openProviderStore().setKey("openai", key, builtin);
    expect(await fs.readFile(join(directory, "credentials.json"), "utf8")).toContain(key);
    await expect(fs.lstat(join(home, "not-account"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(join(home, "not-config"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rotates keys, removes to none, and restores inheritance only explicitly", async () => {
    await store().setKey("openai", key, builtin);
    const old = await policy();
    await store().setKey("openai", "sk-test-rotated", builtin);
    expect(old.boundaryCredentials(["openai"])).toEqual({ openai: { type: "api_key", key } });
    expect((await policy()).boundaryCredentials(["openai"])).toEqual({ openai: { type: "api_key", key: "sk-test-rotated" } });
    await store().removeKey("openai", builtin);
    expect((await policy()).blocked("openai")).toBe(true);
    await store().inherit("openai", builtin);
    expect((await policy()).source("openai")).toBe("inherit");
    expect((await fs.lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.lstat(join(directory, "credentials.json"))).mode & 0o777).toBe(0o600);
  });
  it.each(["", "has space", "tab\tkey", "line\nkey", "key\x00", "x".repeat(4097)])("rejects invalid key input without changing state", async invalid => {
    await store().setKey("openai", key, builtin);
    const before = await fs.readFile(join(directory, "credentials.json"), "utf8");
    await expect(store().setKey("openai", invalid, builtin)).rejects.toMatchObject({ code: "credential_invalid" });
    expect(await fs.readFile(join(directory, "credentials.json"), "utf8")).toBe(before);
  });
  it("serializes concurrent mutations without lost updates", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, n) => store().setKey(`p${n}`, `sk-test-${n}`, { builtInProviderIds: [`p${n}`] })));
    expect((await store().read()).sources).toHaveLength(12);
  });
  it.skipIf(process.platform !== "linux")("bounds lock contention and refuses a linked lock", async () => {
    await store().setKey("openai", key, builtin);
    const lock = await fs.open(join(directory, ".lock"), "r+");
    await lockWithFlock("/usr/bin/flock", lock.fd, 1000, undefined);
    try { await expect(store().removeKey("openai", builtin)).rejects.toMatchObject({ code: "provider_store_busy" }); }
    finally { await lock.close(); }
    await fs.unlink(join(directory, ".lock"));
    await fs.symlink(join(directory, "credentials.json"), join(directory, ".lock"));
    await expect(store().removeKey("openai", builtin)).rejects.toMatchObject({ code: "provider_store_unavailable" });
  });
  it("custom providers never inherit and keys are bound to the endpoint origin", async () => {
    await store().addProvider(definition, builtin);
    expect((await policy()).blocked("custom")).toBe(true);
    await expect(store().inherit("custom", builtin)).rejects.toMatchObject({ code: "provider_inherit_unsupported" });
    await store().setKey("custom", key, builtin);
    await fs.writeFile(join(directory, "providers.json"), JSON.stringify({ v: 1, providers: [{ ...definition, baseUrl: "https://changed.invalid" }] }));
    expect((await store().read()).sources[0]?.bindingValid).toBe(false);
    expect((await policy()).blocked("custom")).toBe(true);
    expect((await policy()).boundaryCredentials(["custom"])).toEqual({});
    await store().setKey("custom", "sk-test-rebound", builtin);
    expect((await policy()).blocked("custom")).toBe(false);
  });
  it("an interrupted removal grants nothing and can be completed by retry", async () => {
    await store().addProvider(definition, builtin); await store().setKey("custom", key, builtin);
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementationOnce(actual.rename).mockRejectedValueOnce(new Error(key));
    await expect(store().removeProvider("custom")).rejects.toEqual(new ProviderStoreError("provider_store_unavailable"));
    expect((await store().read()).definitions).toHaveLength(1);
    expect((await policy()).blocked("custom")).toBe(true);
    await store().removeProvider("custom");
    expect(await store().read()).toEqual({ definitions: [], sources: [] });
  });
  it("reports unknown builtin-style and none entries as orphans and grants neither", async () => {
    await store().setKey("openai", key, builtin);
    await fs.writeFile(join(directory, "credentials.json"), JSON.stringify({ v: 1, providers: { ghost: { source: "key", key, binding: "builtin:ghost" }, missing: { source: "none" } } }));
    expect((await store().read()).sources.map(s => s.bindingValid)).toEqual([false, false]);
    const p = await policy(); const r = runtime(); await p.apply(r);
    expect(r.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(p.boundaryCredentials(["ghost"])).toEqual({});
    expect(p.blocked("ghost")).toBe(true);
  });
  it("lets auth inherit delete an orphaned entry and nothing else", async () => {
    await store().setKey("openai", key, builtin);
    await fs.writeFile(join(directory, "credentials.json"), JSON.stringify({ v: 1, providers: { openai: { source: "key", key, binding: "builtin:openai" }, ghost: { source: "key", key: "sk-test-ghost", binding: "builtin:ghost" } } }));
    await store().inherit("ghost", builtin);
    expect((await store().read()).sources).toEqual([{ providerId: "openai", source: "key", bindingValid: true }]);
    await expect(store().inherit("never-stored", builtin)).rejects.toMatchObject({ code: "provider_unknown" });
    expect(await providerStoreCheck(home)).toMatchObject({ severity: "ok" });
  });
  it.each([0o277, 0o477, 0o777])("creates exact modes under the restrictive umask %o", async (mask) => {
    const previous = process.umask(mask);
    try {
      await store().setKey("openai", key, builtin);
      expect(process.umask()).toBe(mask);
    } finally { process.umask(previous); }
    expect((await fs.lstat(directory)).mode & 0o777).toBe(0o700);
    for (const name of ["credentials.json", ".lock"]) expect((await fs.lstat(join(directory, name))).mode & 0o777).toBe(0o600);
    expect((await policy()).source("openai")).toBe("key");
  });
  it.skipIf(process.getuid?.() === 0)("restores the umask when creating the store directory fails", async () => {
    const product = join(home, ".config", "pi-session-mcp");
    await fs.mkdir(product, { recursive: true, mode: 0o700 }); await fs.chmod(product, 0o500);
    const previous = process.umask(0o022);
    try {
      await expect(store().setKey("openai", key, builtin)).rejects.toMatchObject({ code: "provider_store_unavailable" });
      expect(process.umask()).toBe(0o022);
    } finally { process.umask(previous); await fs.chmod(product, 0o700); }
  });
  it("never changes the mode of a link that replaces the new store directory", async () => {
    await fs.mkdir(join(home, ".config", "pi-session-mcp"), { recursive: true, mode: 0o700 });
    const target = join(home, "unrelated"); await fs.mkdir(target, { mode: 0o755 }); await fs.chmod(target, 0o755);
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    let calls = 0;
    vi.mocked(fs.lstat).mockImplementation((async (path: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
      if (String(path) === directory && ++calls === 2) {
        const checked = await actual.lstat(path);
        await actual.rm(directory, { recursive: true }); await actual.symlink(target, directory);
        return checked;
      }
      return (actual.lstat as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.lstat);
    await expect(store().setKey("openai", key, builtin)).rejects.toMatchObject({ code: "provider_store_unavailable" });
    vi.mocked(fs.lstat).mockImplementation(actual.lstat);
    expect((await actual.stat(target)).mode & 0o777).toBe(0o755);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
  it("reads only the writer boundary when the writer guard is set", async () => {
    await store().setKey("openai", key, builtin);
    const agent = join(home, "boundary");
    await writeBoundaryCredentials(agent, {});
    await writeBoundaryProviders(agent, { v: 1, providers: [], sources: { openai: "none" } });
    vi.stubEnv("PI_SESSION_MCP_WRITER_GUARD", "1"); vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: home });
    expect((await loadRuntimeProviderPolicy()).blocked("openai")).toBe(true);
    vi.unstubAllEnvs();
    expect((await loadRuntimeProviderPolicy()).source("openai")).toBe("key");
  });
  it("ignores orphaned custom keys", async () => {
    await store().addProvider(definition, builtin); await store().setKey("custom", key, builtin);
    await fs.writeFile(join(directory, "providers.json"), JSON.stringify({ v: 1, providers: [] }));
    expect((await store().read()).sources[0]?.bindingValid).toBe(false);
    const p = await policy(); const r = runtime(); await p.apply(r);
    expect(r.setRuntimeApiKey).not.toHaveBeenCalled(); expect(p.boundaryCredentials(["custom"])).toEqual({});
  });
  it.each(["http://example.invalid", "https://u:p@example.invalid", "https://example.invalid?q=1", "https://example.invalid#x", "file:///tmp/model", "https://example.invalid?"])("rejects unsafe endpoint %s", async baseUrl => {
    await expect(store().addProvider({ ...definition, baseUrl }, builtin)).rejects.toMatchObject({ code: "provider_definition_invalid" });
  });
  it.each(["http://localhost:8080", "http://127.2.3.4:8080", "http://[::1]:8080"])("accepts loopback endpoint %s on the host", async baseUrl => {
    await store().addProvider({ ...definition, baseUrl }, builtin);
    expect((await store().read()).definitions).toHaveLength(1);
  });
  it("rejects unknown providers, conflicting definitions and malformed models", async () => {
    await expect(store().setKey("unknown", key, builtin)).rejects.toMatchObject({ code: "provider_unknown" });
    await expect(store().addProvider({ ...definition, id: "openai" }, builtin)).rejects.toMatchObject({ code: "provider_id_conflict" });
    await store().addProvider(definition, builtin);
    await expect(store().addProvider(definition, builtin)).rejects.toMatchObject({ code: "provider_id_conflict" });
    await expect(store().addProvider({ ...definition, models: [] }, builtin)).rejects.toMatchObject({ code: "provider_definition_invalid" });
  });
  it.each(["directory", "file", "symlink", "directory-link", "parent-link", "ownership", "schema"])("fails closed for invalid %s with no key or path in Doctor output", async kind => {
    await store().setKey("openai", key, builtin);
    const file = join(directory, "credentials.json");
    if (kind === "directory") await fs.chmod(directory, 0o755);
    if (kind === "file") await fs.chmod(file, 0o644);
    if (kind === "symlink") { await fs.rename(file, file + ".real"); await fs.symlink(file + ".real", file); }
    if (kind === "schema") await fs.writeFile(file, JSON.stringify({ v: 2, key }));
    if (kind === "directory-link") { await fs.rename(directory, directory + ".real"); await fs.symlink(directory + ".real", directory); }
    if (kind === "parent-link") { const parent = join(home, ".config"); await fs.rename(parent, parent + ".real"); await fs.symlink(parent + ".real", parent); }
    if (kind === "ownership") {
      const actual = await vi.importActual<typeof fs>("node:fs/promises");
      vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => { const s = await actual.lstat(...args); if (args[0] === file) s.uid = typeof s.uid === "bigint" ? s.uid + 1n : s.uid + 1; return s; }) as typeof fs.lstat);
    }
    await expect(policy()).rejects.toBeInstanceOf(ProviderStoreError);
    const result = await providerStoreCheck(home);
    expect(result.severity).toBe("error"); expect(JSON.stringify(result)).not.toContain(key); expect(JSON.stringify(result)).not.toContain(home);
  });
});

describe("provider runtime policy", () => {
  it("registers definitions without keys and overlays keys actually used by getAuth", async () => {
    await store().addProvider(definition, builtin); await store().setKey("custom", key, builtin);
    const r = runtime(); await (await policy()).apply(r);
    expect(r.registerProvider).toHaveBeenCalledWith("custom", expect.objectContaining({ baseUrl: definition.baseUrl }));
    expect(JSON.stringify(r.registerProvider.mock.calls)).not.toContain(key);
    expect(r.setRuntimeApiKey).toHaveBeenCalledWith("custom", key);
    expect(await r.getAuth("custom")).toBe(key);
    const catalog = await createModelCatalog(async () => runtime(), policy);
    expect(catalog.providers().find(p => p.id === "custom")).toMatchObject({ authConfigured: true, models: ["model"] });
    await store().removeKey("custom", builtin);
    const blockedRuntime = runtime();
    const blockedCatalog = await createModelCatalog(async () => blockedRuntime, policy);
    expect(blockedCatalog.providers().find(p => p.id === "custom")?.authConfigured).toBe(false);
    expect(blockedRuntime.checkAuth).not.toHaveBeenCalledWith("custom", expect.anything());
  });
  it("marks all catalog authentication unavailable when the store is unreadable", async () => {
    const r = runtime();
    const catalog = await createModelCatalog(async () => r, async () => { throw new ProviderStoreError("provider_store_invalid"); });
    expect(catalog.providers().every(p => !p.authConfigured)).toBe(true); expect(r.checkAuth).not.toHaveBeenCalled();
  });
  it("passes only selected keys and definitions across the writer boundary", async () => {
    await store().addProvider(definition, builtin); await store().setKey("custom", key, builtin);
    await store().setKey("openai", "sk-test-unrelated", builtin); await store().removeKey("anthropic", builtin);
    const p = await policy(); const selected = ["custom", "anthropic", "oauth"];
    const host = { oauth: { type: "oauth", access: "sk-test-access", refresh: "sk-test-refresh" }, anthropic: { type: "api_key", key: "sk-test-host" } };
    const boundary = { ...selectBoundaryCredentials(host, selected.filter(id => p.source(id) === "inherit")), ...p.boundaryCredentials(selected) };
    expect(boundary).toEqual({ custom: { type: "api_key", key }, oauth: { type: "oauth", access: "sk-test-access", refresh: "" } });
    const agent = join(home, "agent");
    await writeBoundaryCredentials(agent, boundary);
    await writeBoundaryProviders(agent, { v: 1, providers: p.definitions(selected), sources: Object.fromEntries(selected.map(id => [id, p.source(id)])) });
    const inner = await loadProviderPolicy({ writerAgentDirectory: agent });
    const r = runtime(); await inner.apply(r); expect(await r.getAuth("custom")).toBe(key); expect(inner.blocked("anthropic")).toBe(true);
    const manifest = await fs.readFile(join(agent, "provider-definitions.json"), "utf8"); expect(manifest).not.toContain(key);
    expect(JSON.stringify(boundary)).not.toContain("sk-test-unrelated"); expect(JSON.stringify(boundary)).not.toContain("sk-test-refresh");
  });
  it("redacts stored and rotated secrets without exposing them in snapshots or runtime errors", async () => {
    await store().setKey("openai", key, builtin); const p = await policy();
    const redactor = new Redactor({ knownValues: [], secretValues: providerSecretValues, pathRule: () => false });
    await store().setKey("openai", "sk-test-rotated-secret", builtin);
    refreshProviderRedactionValues({ home });
    const result = redactor.entry({ type: "custom", data: [key, "sk-test-rotated-secret"] }, new Map());
    expect(result.json).not.toContain(key); expect(result.json).not.toContain("sk-test-rotated-secret");
    expect(JSON.stringify(await store().read())).not.toContain(key);
    const r = runtime(); r.setRuntimeApiKey.mockRejectedValueOnce(new Error(key));
    await expect(p.apply(r)).rejects.toEqual(new ProviderStoreError("provider_store_unavailable"));
  });
});
