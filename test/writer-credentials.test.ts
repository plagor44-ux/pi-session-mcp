import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWarmupConfig, expiresWithin, REFRESH_INTERVAL_MS, REFRESH_THRESHOLD_MINUTES, refreshHostLogin, selectBoundaryCredentials, writeBoundaryCredentials } from "../src/writer-credentials.js";
import { writersRoot } from "../src/writer-state.js";
import { configSchema } from "../src/config.js";

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
    expect(REFRESH_THRESHOLD_MINUTES).toBe(2);
    expect(REFRESH_INTERVAL_MS).toBe(60_000);
  });

  it("writes only state-selected OAuth profiles and a private empty workspace", async () => {
    const home = await temporary();
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ ...host, second: { type: "oauth" } }));
    const path = await ensureWarmupConfig(home, [
      { provider: "anthropic", model: "key-model" }, { provider: "second", model: "second-model" },
      { provider: "openai", model: "state-model" }, { provider: "cursor", model: "cursor-model" },
    ]);
    expect(path).toBe(join(writersRoot(home), ".warmup", "config.json"));
    const config = JSON.parse(await readFile(path!, "utf8"));
    expect(configSchema.safeParse(config).success).toBe(true);
    expect(Object.values(config.executionProfiles)).toEqual([
      { provider: "second", model: "second-model", permissionProfile: "read-only", thinkingLevel: "off", default: true },
      { provider: "openai", model: "state-model", permissionProfile: "read-only", thinkingLevel: "off", default: false },
    ]);
    expect(config.workspaces).toEqual({ warmup: join(writersRoot(home), ".warmup", "empty") });
    expect((await stat(config.workspaces.warmup)).mode & 0o777).toBe(0o700);
    expect((await stat(path!)).mode & 0o777).toBe(0o600);
  });

  it("writes nothing when no selected OAuth credentials exist, including a missing host file", async () => {
    const home = await temporary();
    expect(await ensureWarmupConfig(home, [{ provider: "openai", model: "model" }])).toBeUndefined();
    await expect(stat(writersRoot(home))).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(join(home, ".pi", "agent", "auth.json"), JSON.stringify(host));
    expect(await ensureWarmupConfig(home, [{ provider: "anthropic", model: "model" }])).toBeUndefined();
    await expect(stat(writersRoot(home))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fakeServer(source: string) {
  const root = await temporary();
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "main.js"), source);
  return root;
}

describe("host login warmup", () => {
  it("only initializes, starts and closes a session using the supplied config", async () => {
    const root = await fakeServer(`
      const fs = require('node:fs');
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        fs.appendFileSync(process.env.PI_SESSION_MCP_CONFIG, line + '\\n');
        if (m.id) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.id===2?{structuredContent:{session:{id:'session-1'}}}:{}})+'\\n');
      });
    `);
    const config = join(root, "frames");
    await refreshHostLogin({ nodePath: process.execPath, releaseRoot: root, warmupConfig: config, timeoutMs: 2000 });
    const frames = (await readFile(config, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(frames.map((frame) => frame.params?.name ?? frame.method)).toEqual([
      "initialize", "notifications/initialized", "pi_session_start", "pi_session_close",
    ]);
    expect(frames[2].params.arguments).toEqual({ workspace: "warmup" });
    expect(frames[3].params.arguments).toEqual({ sessionId: "session-1" });
  });

  it("terminates an unresponsive server within the timeout", async () => {
    const root = await fakeServer("setInterval(() => {}, 1000);");
    await expect(refreshHostLogin({ nodePath: process.execPath, releaseRoot: root, warmupConfig: "unused", timeoutMs: 100 })).rejects.toThrow("warmup");
  });

  it("kills a server that traps SIGTERM after the grace period", async () => {
    const root = await fakeServer("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    const started = Date.now();
    await expect(refreshHostLogin({ nodePath: process.execPath, releaseRoot: root, warmupConfig: "unused", timeoutMs: 500 })).rejects.toThrow("warmup");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
    expect(Date.now() - started).toBeLessThan(4500);
  });

  it("rejects tool errors without sending a model request", async () => {
    const root = await fakeServer(`
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (m.id) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.id===2?{isError:true}:{}})+'\\n');
      });
    `);
    await expect(refreshHostLogin({ nodePath: process.execPath, releaseRoot: root, warmupConfig: "unused", timeoutMs: 2000 })).rejects.toThrow("warmup");
  });

  it("handles spawn failures", async () => {
    await expect(refreshHostLogin({ nodePath: "/nonexistent/node", releaseRoot: "unused", warmupConfig: "unused", timeoutMs: 100 })).rejects.toThrow("warmup");
  });
});
