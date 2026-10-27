import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { changeExecutionMode, type ModeRequest } from "../src/setup-modes.js";
import { executionModesPath } from "../src/execution-modes.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
async function fixture() {
  const root = await temporaryRoot("pi-session-mcp-setup-modes-");
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ workspaces: { a: ".", b: "." }, executionProfiles: {
    review: { default: true, permissionProfile: "read-only", provider: "example", model: "model", thinkingLevel: "off" },
    code: { default: false, permissionProfile: "coding", provider: "example", model: "model", thinkingLevel: "off" },
    cursor: { default: false, permissionProfile: "coding", provider: "cursor", model: "model", thinkingLevel: "off" },
  } }));
  return { config, path: executionModesPath(config) };
}
const request = (overrides: Partial<ModeRequest> = {}): ModeRequest => ({ alias: "a", mode: "read-only", acceptHostWrites: false, apply: false, ...overrides });
const probe = (usable: boolean) => ({ containerRuntime: async () => usable });
describe("setup execution modes", () => {
  it("allows writer preflight to refuse before a mode write or reconciliation", async () => {
    const { config, path } = await fixture();
    let after = false;
    const output = await changeExecutionMode(config, request({ apply: true }), {
      beforeWrite: async () => ({ schemaVersion: 1, operation: "apply", status: "failed", exitCode: 1, findings: [{ target: { client: "writer", scope: "a", alias: "a-w1" }, status: "failed", code: "writer_uncollected" }] }),
      afterChange: async (value) => { after = true; return value; },
    });
    expect(output.findings[0]?.code).toBe("writer_uncollected");
    expect(after).toBe(false);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("plans without creating a modes file or lock", async () => {
    const { config, path } = await fixture();
    expect(await changeExecutionMode(config, request())).toMatchObject({ status: "planned", exitCode: 0, findings: [{ code: "mode_planned", target: { client: "modes", scope: "workspace", alias: "a" } }] });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires an explicit host acknowledgment", async () => {
    const { config, path } = await fixture();
    expect(await changeExecutionMode(config, request({ mode: "host", apply: true }))).toMatchObject({ exitCode: 1, findings: [{ code: "host_ack_required" }] });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("applies acknowledged host and reports the restart requirement", async () => {
    const { config, path } = await fixture();
    expect(await changeExecutionMode(config, request({ mode: "host", acceptHostWrites: true, apply: true }))).toMatchObject({ exitCode: 0, findings: [{ code: "mode_applied" }, { code: "controllers_restart_required", status: "ok" }] });
    expect(JSON.parse(await readFile(path, "utf8")).workspaces.a).toEqual({ mode: "host", acceptHostWrites: true });
  });
  it.each([undefined, []])("requires explicit container profiles before probing the runtime (%j)", async (profiles) => {
    for (const apply of [false, true]) {
      const { config, path } = await fixture();
      let probes = 0;
      const dependencies = { containerRuntime: async () => { probes++; return false; } };
      expect(await changeExecutionMode(config, request({ mode: "container", container: profiles === undefined ? {} : { profiles }, apply }), dependencies)).toMatchObject({
        status: "failed", exitCode: 1, findings: [{ code: "container_profiles_required", status: "failed" }],
      });
      expect(probes).toBe(0);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it.each([undefined, []])("requires profiles for a proposed container after a successful probe (%j)", async (profiles) => {
    for (const apply of [false, true]) {
      const { config, path } = await fixture();
      expect(await changeExecutionMode(config, { alias: "a", acceptHostWrites: false, container: profiles === undefined ? {} : { profiles }, apply }, probe(true))).toMatchObject({
        status: "failed", exitCode: 1, findings: [{ code: "container_profiles_required", status: "failed" }],
      });
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("refuses an unavailable runtime and writes container defaults when usable", async () => {
    const { config, path } = await fixture();
    const input = request({ mode: "container", container: { profiles: ["code"] }, apply: true });
    expect(await changeExecutionMode(config, input, probe(false))).toMatchObject({ exitCode: 1, findings: [{ code: "container_runtime_unavailable" }] });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await changeExecutionMode(config, input, probe(true))).exitCode).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8")).workspaces.a).toEqual({ mode: "container", profiles: ["code"], writers: 1, lifecycle: "persistent", image: "node", network: "pasta", cache: "none" });
  });
  it("records the Go toolchain cache in a container entry", async () => {
    const { config, path } = await fixture();
    const input = request({ mode: "container", container: { profiles: ["code"], cache: "go" }, apply: true });
    expect((await changeExecutionMode(config, input, probe(true))).exitCode).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8")).workspaces.a.cache).toBe("go");
  });
  it("records the uv and npm cache in a container entry", async () => {
    const { config, path } = await fixture();
    const input = request({ mode: "container", container: { profiles: ["code"], cache: "uv" }, apply: true });
    expect((await changeExecutionMode(config, input, probe(true))).exitCode).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8")).workspaces.a.cache).toBe("uv");
  });
  it("chooses container only when usable and never falls back to host", async () => {
    const { config } = await fixture();
    const input: ModeRequest = { alias: "a", acceptHostWrites: false, apply: false, container: { profiles: ["code"] } };
    expect(await changeExecutionMode(config, input, probe(false))).toMatchObject({ exitCode: 1, findings: [{ code: "mode_choice_required" }] });
    expect(await changeExecutionMode(config, input, probe(true))).toMatchObject({ status: "planned", findings: [{ code: "mode_planned" }] });
  });
  it("rejects unknown aliases and sanitizes invalid aliases", async () => {
    const { config } = await fixture();
    expect(await changeExecutionMode(config, request({ alias: "missing" }))).toMatchObject({ exitCode: 1, findings: [{ code: "alias_unknown" }] });
    expect(JSON.stringify(await changeExecutionMode(config, request({ alias: "/SECRET/path" })))).not.toContain("/SECRET/path");
  });
  it.each(["SECRET invalid JSON", JSON.stringify({ schemaVersion: 1, workspaces: { b: { mode: "host" } } })])("never rewrites an invalid existing file", async (bytes) => {
    const { config, path } = await fixture();
    await writeFile(path, bytes);
    expect(await changeExecutionMode(config, request({ apply: true }))).toMatchObject({ exitCode: 1, findings: [{ code: "modes_file_invalid" }] });
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
  it("preserves other entries and identical file bytes and mtime", async () => {
    const { config, path } = await fixture();
    await writeFile(path, JSON.stringify({ schemaVersion: 1, workspaces: { b: { mode: "read-only" } } }));
    const input = request({ apply: true });
    expect((await changeExecutionMode(config, input)).exitCode).toBe(0);
    const before = await stat(path); const bytes = await readFile(path, "utf8");
    expect(await changeExecutionMode(config, input)).toMatchObject({ findings: [{ code: "mode_unchanged" }] });
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect(JSON.parse(bytes).workspaces.b).toEqual({ mode: "read-only" });
  });
  it("serializes concurrent updates for different repositories", async () => {
    const { config, path } = await fixture();
    const outputs = await Promise.all([
      changeExecutionMode(config, request({ alias: "a", apply: true })),
      changeExecutionMode(config, request({ alias: "b", apply: true })),
    ]);
    expect(outputs.map((output) => output.exitCode)).toEqual([0, 0]);
    expect(JSON.parse(await readFile(path, "utf8")).workspaces).toEqual({ a: { mode: "read-only" }, b: { mode: "read-only" } });
  });
  it("preserves omitted defaults in other container entries", async () => {
    const { config, path } = await fixture();
    await writeFile(path, JSON.stringify({ schemaVersion: 1, workspaces: { b: { mode: "container", profiles: ["code"] } } }));
    expect((await changeExecutionMode(config, request({ apply: true }))).exitCode).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8")).workspaces.b).toEqual({ mode: "container", profiles: ["code"] });
  });
  it.each([[], ["review"], ["cursor"], ["missing"]])("validates selected profiles %j before writing", async (...profiles) => {
    const { config, path } = await fixture();
    expect((await changeExecutionMode(config, request({ mode: "container", container: { profiles: profiles as string[] }, apply: true }), probe(true))).exitCode).toBe(1);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
