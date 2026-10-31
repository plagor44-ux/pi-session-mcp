import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import {
  codingAllowed, EXECUTION_MODES_FILE, executionModesPath, executionModesSchema, isShortBranchName,
  loadExecutionModes, resolveExecutionModes,
} from "../src/execution-modes.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const aliases = new Set(["a", "b"]);
const profiles = new Map<string, { readonly permissionProfile: "read-only" | "coding"; readonly provider: string }>([
  ["code", { permissionProfile: "coding", provider: "example-provider" }],
  ["review", { permissionProfile: "read-only", provider: "example-provider" }],
  ["cursor-code", { permissionProfile: "coding", provider: "cursor" }],
]);
const modes = (workspaces: Record<string, unknown>) => ({ schemaVersion: 1, workspaces });

function expectInvalid(raw: unknown): void {
  let thrown: unknown;
  try { resolveExecutionModes(raw, aliases, profiles); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(ConfigError);
  expect(thrown).toMatchObject({ code: "invalid_execution_modes", message: "Execution modes file is invalid" });
  expect(JSON.stringify(thrown)).not.toContain("SECRET_SENTINEL");
  expect(String(thrown)).not.toContain("SECRET_SENTINEL");
}

describe("resolveExecutionModes", () => {
  it("validates snapshot sources after resolving all entries", () => {
    for (const source of [{ mode: "host", acceptHostWrites: true }, { mode: "container", profiles: ["code"] }]) {
      const entry = resolveExecutionModes(modes({ a: { mode: "snapshot", source: "b" }, b: source }), aliases, profiles).get("a")!;
      expect(entry).toEqual({ mode: "snapshot", snapshot: { source: "b" } });
      expect(codingAllowed(entry, true)).toBe(false);
    }
    for (const workspaces of [
      { a: { mode: "snapshot", source: "missing" } },
      { a: { mode: "snapshot", source: "a" } },
      { a: { mode: "snapshot", source: "b" } },
      { a: { mode: "snapshot", source: "b" }, b: { mode: "read-only" } },
      { a: { mode: "snapshot", source: "b" }, b: { mode: "snapshot", source: "a" } },
      { a: { mode: "snapshot", source: "b", extra: true }, b: { mode: "host", acceptHostWrites: true } },
    ]) expectInvalid(modes(workspaces));
  });
  it("round-trips optional limits without adding unset fields", () => {
    for (const limits of [{}, { cpus: 0.01 }, { cpus: 1024, cpuShares: 262144, memory: "9999999g" }]) {
      const raw = modes({ a: { mode: "container", profiles: ["code"], ...limits } });
      const parsed = executionModesSchema.parse(JSON.parse(JSON.stringify(executionModesSchema.parse(raw))));
      const settings = resolveExecutionModes(parsed, aliases, profiles).get("a")!.container!;
      for (const key of ["cpus", "cpuShares", "memory"]) {
        if (key in limits) expect(settings).toHaveProperty(key);
        else expect(settings).not.toHaveProperty(key);
      }
    }
  });
  it.each([{ cpus: 0 }, { cpus: 1.001 }, { cpus: 0.00000000001 }, { cpus: 1025 }, { cpuShares: 1 }, { cpuShares: 262145 }, { cpuShares: 2.5 }, { memory: "0m" }, { memory: "512M" }])("rejects invalid limits %j", (limits) => {
    expectInvalid(modes({ a: { mode: "container", profiles: ["code"], ...limits } }));
  });
  it("fills every missing alias with unset", () => {
    expect([...resolveExecutionModes(modes({}), aliases, profiles)]).toEqual([
      ["a", { mode: "unset" }], ["b", { mode: "unset" }],
    ]);
  });

  it("resolves container defaults", () => {
    const loaded = resolveExecutionModes(modes({ a: { mode: "container", profiles: ["code"] } }), aliases, profiles);
    expect(loaded.get("a")).toEqual({ mode: "container", container: {
      writers: 1, lifecycle: "persistent", profiles: ["code"], image: "node", network: "pasta", cache: "none", tags: "none", clean: "untracked",
    } });
    expect(loaded.get("b")).toEqual({ mode: "unset" });
  });

  it("preserves explicit container settings and snapshots them immutably", () => {
    const raw = modes({ a: { mode: "container", profiles: ["code"], writers: 16, lifecycle: "ephemeral", image: "a".repeat(64), network: "none", cache: "go" } });
    const loaded = resolveExecutionModes(raw, aliases, profiles);
    const entry = loaded.get("a")!;
    expect(entry.container).toEqual({ writers: 16, lifecycle: "ephemeral", profiles: ["code"], image: "a".repeat(64), network: "none", cache: "go", tags: "none", clean: "untracked" });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.container)).toBe(true);
    expect(Object.isFrozen(entry.container?.profiles)).toBe(true);
    expect(() => (loaded as Map<string, unknown>).set("a", {})).toThrow();
  });

  it.each(["untracked", "all"] as const)("accepts the explicit clean setting %s", (clean) => {
    const raw = modes({ a: { mode: "container", profiles: ["code"], clean } });
    expect(resolveExecutionModes(raw, aliases, profiles).get("a")?.container?.clean).toBe(clean);
    expect(executionModesSchema.parse(raw).workspaces.a).toMatchObject({ clean });
  });

  it.each(["none", "go", "uv", "npm"] as const)("accepts the explicit cache kind %s", (cache) => {
    const raw = modes({ a: { mode: "container", profiles: ["code"], cache } });
    expect(resolveExecutionModes(raw, aliases, profiles).get("a")?.container?.cache).toBe(cache);
  });

  it.each(["node", "a".repeat(64)])("accepts image %s", (image) => {
    expect(resolveExecutionModes(modes({ a: { mode: "container", profiles: ["code"], image } }), aliases, profiles).get("a")?.container?.image).toBe(image);
  });

  it("accepts base main and dev", () => {
    for (const base of ["main", "dev"]) {
      const loaded = resolveExecutionModes(modes({ a: { mode: "container", profiles: ["code"], base } }), aliases, profiles);
      expect(loaded.get("a")?.container?.base).toBe(base);
    }
  });

  it("accepts acknowledged host and read-only modes", () => {
    expect([...resolveExecutionModes(modes({ a: { mode: "host", acceptHostWrites: true }, b: { mode: "read-only" } }), aliases, profiles)])
      .toEqual([["a", { mode: "host" }], ["b", { mode: "read-only" }]]);
  });

  it.each([
    ["unknown alias", modes({ SECRET_SENTINEL: { mode: "read-only" } })],
    ["missing host acknowledgment", modes({ a: { mode: "host" } })],
    ["false host acknowledgment", modes({ a: { mode: "host", acceptHostWrites: false } })],
    ["missing profiles", modes({ a: { mode: "container" } })],
    ...["latest", "a".repeat(65), "A".repeat(64)].map((image) => [`invalid image ${image}`, modes({ a: { mode: "container", profiles: ["code"], image } })] as const),
    ["invalid clean", modes({ a: { mode: "container", profiles: ["code"], clean: "bogus" } })],
    ["invalid tags", modes({ a: { mode: "container", profiles: ["code"], tags: "all" } })],
    ["invalid cache", modes({ a: { mode: "container", profiles: ["code"], cache: "all" } })],
    ["empty profiles", modes({ a: { mode: "container", profiles: [] } })],
    ["unknown profile", modes({ a: { mode: "container", profiles: ["SECRET_SENTINEL"] } })],
    ["read-only profile", modes({ a: { mode: "container", profiles: ["review"] } })],
    ["cursor profile", modes({ a: { mode: "container", profiles: ["cursor-code"] } })],
    ...[0, 17, 1.5].map((writers) => [`writers ${writers}`, modes({ a: { mode: "container", profiles: ["code"], writers } })] as const),
    ...["refs/heads/main", "HEAD", "a".repeat(40), "B".repeat(64), "../x", "", `a${"b".repeat(200)}`, "main.lock"]
      .map((base) => [`base ${base.length > 20 ? `${base.length} characters` : base || "empty"}`, modes({ a: { mode: "container", profiles: ["code"], base } })] as const),
    ["unknown root key", { ...modes({}), SECRET_SENTINEL: true }],
    ["unknown container key", modes({ a: { mode: "container", profiles: ["code"], SECRET_SENTINEL: true } })],
    ["unknown host key", modes({ a: { mode: "host", acceptHostWrites: true, SECRET_SENTINEL: true } })],
    ["unknown read-only key", modes({ a: { mode: "read-only", SECRET_SENTINEL: true } })],
    ["unsupported schema version", { schemaVersion: 2, workspaces: {} }],
  ] satisfies ReadonlyArray<readonly [string, unknown]>)("rejects %s with a sanitized ConfigError", (_name, raw) => { expectInvalid(raw); });

  it("leaves base unset for an existing container entry that has none", () => {
    const loaded = resolveExecutionModes(modes({ a: { mode: "container", profiles: ["code"] } }), aliases, profiles);
    expect(loaded.get("a")?.container?.base).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(loaded.get("a")?.container, "base")).toBe(false);
  });

  it("exports the strict file schema with defaults", () => {
    expect(executionModesSchema.parse(modes({ a: { mode: "container", profiles: ["code"] } })).workspaces.a)
      .toMatchObject({ writers: 1, lifecycle: "persistent", image: "node", network: "pasta", cache: "none" });
  });
});

describe("loadExecutionModes", () => {
  it("uses the configuration directory and a stable filename", () => {
    expect(EXECUTION_MODES_FILE).toBe("execution-modes.json");
    expect(executionModesPath(join("config dir", "custom.json"))).toBe(join("config dir", "execution-modes.json"));
  });

  it("defaults to unset when the file is absent", async () => {
    const root = await temporaryRoot("pi-session-mcp-modes-");
    expect([...await loadExecutionModes(join(root, "config.json"), aliases, profiles)])
      .toEqual([["a", { mode: "unset" }], ["b", { mode: "unset" }]]);
  });

  it("loads an existing container entry without a base", async () => {
    const root = await temporaryRoot("pi-session-mcp-modes-");
    await writeFile(join(root, EXECUTION_MODES_FILE), JSON.stringify(modes({ a: { mode: "container", profiles: ["code"] } })));
    const loaded = await loadExecutionModes(join(root, "config.json"), aliases, profiles);
    expect(loaded.get("a")?.mode).toBe("container");
    expect(loaded.get("a")?.container?.base).toBeUndefined();
  });

  it("rejects invalid JSON with a sanitized ConfigError", async () => {
    const root = await temporaryRoot("pi-session-mcp-modes-");
    await writeFile(join(root, EXECUTION_MODES_FILE), "SECRET_SENTINEL invalid JSON");
    await expect(loadExecutionModes(join(root, "config.json"), aliases, profiles))
      .rejects.toMatchObject({ name: "ConfigError", code: "invalid_execution_modes", message: "Execution modes file is invalid" });
  });

  it("does not treat an unreadable file as absent", async () => {
    const root = await temporaryRoot("pi-session-mcp-modes-");
    await mkdir(join(root, EXECUTION_MODES_FILE));
    await expect(loadExecutionModes(join(root, "config.json"), aliases, profiles))
      .rejects.toMatchObject({ code: "invalid_execution_modes" });
  });

  it("attaches validated modes when loading configuration", async () => {
    const root = await temporaryRoot("pi-session-mcp-modes-");
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ workspaces: { a: "." }, executionProfiles: {
      review: { default: true, permissionProfile: "read-only", provider: "example-provider", model: "model", thinkingLevel: "off" },
      code: { default: false, permissionProfile: "coding", provider: "example-provider", model: "model", thinkingLevel: "off" },
    } }));
    await writeFile(join(root, EXECUTION_MODES_FILE), JSON.stringify(modes({ a: { mode: "container", profiles: ["code"] } })));
    expect((await loadConfig(path)).workspaceModes.get("a")?.mode).toBe("container");
    await writeFile(join(root, EXECUTION_MODES_FILE), JSON.stringify(modes({ a: { mode: "container", profiles: ["review"] } })));
    await expect(loadConfig(path)).rejects.toMatchObject({ code: "invalid_execution_modes" });
  });
});

describe("isShortBranchName", () => {
  it.each(["main", "dev", "feat/157-t5-default-base", "a".repeat(200)])("accepts %s", (base) => {
    expect(isShortBranchName(base)).toBe(true);
  });

  it.each(["HEAD", "refs/heads/main", "a".repeat(40), "A".repeat(64), "../x", "", `a${"b".repeat(200)}`, "main.lock", "x//y", "x/", "/x"])("rejects %s", (base) => {
    expect(isShortBranchName(base)).toBe(false);
  });
});

it.each([
  ["unset", false, true], ["host", false, true], ["container", false, false], ["read-only", false, false],
  ["unset", true, true], ["host", true, true], ["container", true, true], ["read-only", true, false],
] as const)("codingAllowed(%s, %s) is %s", (mode, relay, allowed) => {
  expect(codingAllowed({ mode }, relay)).toBe(allowed);
});
