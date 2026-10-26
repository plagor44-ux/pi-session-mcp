import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expiresWithin, REFRESH_INTERVAL_MS, REFRESH_THRESHOLD_MINUTES, refreshHostCredential, selectBoundaryCredentials, selectedOAuthProviders, writeBoundaryCredentials } from "../src/writer-credentials.js";

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "writer-credentials-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const host = {
  openai: { type: "oauth", access: "ACCESS", refresh: "SECRET_REFRESH", expires: 1_800_000_000 },
  anthropic: { type: "api_key", key: "API_KEY" },
  cursor: { type: "oauth", refresh: "SECRET_REFRESH" },
  other: { type: "unknown", key: "NO" },
};

describe("boundary credentials", () => {
  it("copies selected credentials without refresh authority or host mutation", () => {
    const before = JSON.stringify(host);
    expect(selectBoundaryCredentials(host, ["openai", "anthropic", "cursor", "other", "missing"])).toEqual({
      openai: { ...host.openai, refresh: "" }, anthropic: host.anthropic,
    });
    expect(selectBoundaryCredentials(host, ["anthropic"])).toEqual({ anthropic: host.anthropic });
    expect(JSON.stringify(host)).toBe(before);
    for (const invalid of [undefined, null, "not json", [], 42]) expect(selectBoundaryCredentials(invalid, ["openai"])).toEqual({});
  });

  it("names the selected providers that hold an OAuth credential", () => {
    expect(selectedOAuthProviders(host, ["openai", "anthropic", "cursor", "other", "missing"])).toEqual(["openai"]);
    expect(selectedOAuthProviders("not json", ["openai"])).toEqual([]);
  });

  it("writes auth.json atomically at 0600 without changing host bytes or mtime", async () => {
    const home = await temporary();
    const hostPath = join(home, "host.json");
    await writeFile(hostPath, JSON.stringify(host));
    const before = await stat(hostPath);
    const bytes = await readFile(hostPath, "utf8");
    const agent = join(home, "agent");
    await mkdir(agent);
    await writeFile(join(agent, "auth.json"), "old", { mode: 0o644 });
    await writeBoundaryCredentials(agent, selectBoundaryCredentials(JSON.parse(bytes), ["openai"]));
    const copied = await readFile(join(agent, "auth.json"), "utf8");
    expect(copied).not.toContain("SECRET_REFRESH");
    expect(JSON.parse(copied).openai.access).toBe("ACCESS");
    expect((await stat(join(agent, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(hostPath, "utf8")).toBe(bytes);
    expect((await stat(hostPath)).mtimeMs).toBe(before.mtimeMs);
    const missing = await readFile(join(home, "absent"), "utf8").catch(() => undefined);
    expect(selectBoundaryCredentials(missing, ["openai"])).toEqual({});
  });

  it("checks both expiry units, expired and invalid expiries, and selected OAuth only", () => {
    const now = 1_800_000_000_000;
    for (const expires of [now + 120_000, (now + 120_000) / 1000, now - 1, undefined, "bad", NaN]) {
      expect(expiresWithin({ openai: { type: "oauth", expires } }, ["openai"], 2, now)).toBe(true);
    }
    expect(expiresWithin({ openai: { type: "oauth", expires: now + 120_001 } }, ["openai"], 2, now)).toBe(false);
    expect(expiresWithin(host, ["anthropic", "cursor", "missing"], 2, now)).toBe(false);
    expect(expiresWithin("not json", ["openai"], 2, now)).toBe(false);
    expect(REFRESH_INTERVAL_MS).toBe(60_000);
  });

  it("keeps the threshold above the SDK's five-minute OAuth window plus one interval", () => {
    // The Pi SDK refreshes only inside its own five-minute window (its documented
    // default minimum validity); the host warm-up must fire earlier than that.
    expect(REFRESH_THRESHOLD_MINUTES).toBe(10);
    expect(REFRESH_THRESHOLD_MINUTES * 60_000).toBeGreaterThan(5 * 60_000 + REFRESH_INTERVAL_MS);
  });
});

describe("host credential refresh", () => {
  it("asks the SDK for the requested validity and never writes the file itself", async () => {
    const home = await temporary();
    const getAuth = vi.fn(async (_provider: string, _overrides?: { minOAuthValidityMs?: number; signal?: AbortSignal }) => undefined);
    await refreshHostCredential(
      { authPath: join(home, ".pi", "agent", "auth.json"), provider: "openai", minOAuthValidityMs: 600_000, timeoutMs: 20_000 },
      async () => ({ getAuth }),
    );
    expect(getAuth).toHaveBeenCalledTimes(1);
    expect(getAuth.mock.calls[0]![0]).toBe("openai");
    expect(getAuth.mock.calls[0]![1]).toMatchObject({ minOAuthValidityMs: 600_000, signal: expect.any(AbortSignal) });
    await expect(stat(join(home, ".pi", "agent", "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns within the timeout when the SDK does not answer", async () => {
    const home = await temporary();
    const started = Date.now();
    await expect(refreshHostCredential(
      { authPath: join(home, "auth.json"), provider: "openai", minOAuthValidityMs: 600_000, timeoutMs: 100 },
      async () => ({ getAuth: () => new Promise(() => {}) }),
    )).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  it("loads the real SDK without writing to stdout or to an auth file that holds nothing to refresh", async () => {
    // The wrapper's stdout is the client's MCP channel; the default runtime must stay silent there (#142).
    const root = await temporary();
    const authPath = join(root, "auth.json");
    const bytes = JSON.stringify({ deepseek: { type: "api_key", key: "API_KEY" } });
    await writeFile(authPath, bytes, { mode: 0o600 });
    const stdout = vi.spyOn(process.stdout, "write");
    try {
      await refreshHostCredential({ authPath, provider: "openai", minOAuthValidityMs: 600_000, timeoutMs: 20_000 }).catch(() => undefined);
      expect(stdout).not.toHaveBeenCalled();
    } finally { stdout.mockRestore(); }
    expect(await readFile(authPath, "utf8")).toBe(bytes);
  });
});
