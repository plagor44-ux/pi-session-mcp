import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  acceptanceFingerprint, currentAcceptanceFingerprint, readWriterState, WRITER_NAME_PATTERN, writerName,
  writerEventDeliveryEnabled, writerPaths, writerRegistrationName, writersRoot, writeWriterState, WriterStateError,
  type WriterState,
} from "../src/writer-state.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { PACKAGE_VERSION } from "../src/package-metadata.js";
import { wrapperDigest } from "../src/writer-wrapper.js";

afterAll(removeTemporaryRoots);

const state: WriterState = {
  schemaVersion: 1, alias: "pi-session-mcp", index: 2, phase: "ready", launch: "legacy",
  lifecycle: "persistent", profiles: ["code"], network: "pasta", cache: "none", tags: "none", clean: "untracked",
  providers: [{ provider: "example-provider", model: "example-model" }],
  imageId: "a".repeat(64), base: { ref: "refs/heads/main", commit: "b".repeat(40) },
  acceptance: { fingerprint: `sha256:${"c".repeat(64)}`, verdict: "pass", network: "limited", at: "2026-01-01T00:00:00Z" },
  collected: { digest: `sha256:${"d".repeat(64)}`, at: "2026-01-01T00:00:00Z" },
};
const name = "pi-session-mcp-w2";

it("launch defaults to legacy and does not change the acceptance fingerprint", async () => {
  const home = await temporaryRoot("writer-launch-state-");
  const { launch: _launch, ...legacy } = state;
  await writeWriterState(home, name, legacy);
  expect((await readWriterState(home, name))!.launch).toBe("legacy");
  const wrapper = writerPaths(home, name).wrapper;
  await writeFile(wrapper, "wrapper");
  expect(await currentAcceptanceFingerprint(wrapper, state, "5.4.0"))
    .toBe(await currentAcceptanceFingerprint(wrapper, { ...state, launch: "relay" }, "5.4.0"));
  await writeWriterState(home, name, { ...state, launch: "relay" });
  expect((await readWriterState(home, name))!.launch).toBe("relay");
  await expect(writeWriterState(home, name, { ...state, launch: "invalid" } as unknown as WriterState)).rejects.toThrow(WriterStateError);
});
it("defaults legacy state tags without changing acceptance", async () => {
  const home = await temporaryRoot("writer-tags-");
  await writeWriterState(home, name, state);
  const path = writerPaths(home, name).state;
  const { tags: _tags, ...legacy } = state;
  await writeFile(path, JSON.stringify(legacy));
  expect((await readWriterState(home, name))!.tags).toBe("none");
  const wrapper = writerPaths(home, name).wrapper;
  await writeFile(wrapper, "wrapper");
  expect(await currentAcceptanceFingerprint(wrapper, state, "5.4.0"))
    .toBe(await currentAcceptanceFingerprint(wrapper, { ...state, tags: "reachable" }, "5.4.0"));
});
it("defaults legacy clean, round-trips all, and does not change acceptance", async () => {
  const home = await temporaryRoot("writer-clean-");
  await writeWriterState(home, name, state);
  const { clean: _clean, ...legacy } = state;
  await writeFile(writerPaths(home, name).state, JSON.stringify(legacy));
  expect((await readWriterState(home, name))!.clean).toBe("untracked");
  const wrapper = writerPaths(home, name).wrapper;
  await writeFile(wrapper, "wrapper");
  expect(await currentAcceptanceFingerprint(wrapper, state, "5.4.0"))
    .toBe(await currentAcceptanceFingerprint(wrapper, { ...state, clean: "all" }, "5.4.0"));
  await writeWriterState(home, name, { ...state, clean: "all" });
  expect((await readWriterState(home, name))!.clean).toBe("all");
});
it("derives validated writer names and registrations", () => {
  expect(writerName("pi-session-mcp", 2)).toBe(name);
  expect(writerName("a".repeat(64), 16)).toMatch(WRITER_NAME_PATTERN);
  expect(writerRegistrationName(name)).toBe(`pi-coding-${name}`);
  for (const index of [0, 17, 1.5, NaN]) expect(() => writerName("a", index)).toThrow(WriterStateError);
  for (const alias of ["../a", "X", "", "a".repeat(65)]) expect(() => writerName(alias, 1)).toThrow(WriterStateError);
  for (const invalid of ["x-w0", "x-w17", "X-w1", "../a-w1"]) {
    expect(WRITER_NAME_PATTERN.test(invalid)).toBe(false);
    expect(() => writerRegistrationName(invalid)).toThrow(WriterStateError);
    expect(() => writerPaths("/home/example", invalid)).toThrow(WriterStateError);
  }
});

it("derives the private writer layout", () => {
  const home = "/home/example";
  const root = join(home, ".local/state/pi-session-mcp/writers", name);
  expect(writersRoot(home)).toBe(join(home, ".local/state/pi-session-mcp/writers"));
  expect(writerPaths(home, name)).toEqual({
    root, clone: join(root, "clone"), agent: join(root, "agent"), bundles: join(root, "bundles"),
    config: join(root, "config"), events: join(root, "events"), go: join(root, "go"), uv: join(root, "uv"), npm: join(root, "npm"), wrapper: join(root, "wrapper.sh"), state: join(root, "state.json"), acceptanceFailure: join(root, "acceptance-failure.json"),
  });
});

it("round-trips every configured cache kind", async () => {
  const home = await temporaryRoot("pi-writer-state-");
  for (const cache of ["none", "go", "uv", "npm"] as const) {
    await writeWriterState(home, name, { ...state, cache });
    expect((await readWriterState(home, name))?.cache).toBe(cache);
  }
  await expect(writeWriterState(home, name, { ...state, cache: "other" } as unknown as WriterState)).rejects.toThrow();
});

it("round-trips and atomically replaces private state without temporary leftovers", async () => {
  const home = await temporaryRoot("pi-writer-state-");
  await writeWriterState(home, name, state);
  expect(await readWriterState(home, name)).toEqual(state);
  const paths = writerPaths(home, name);
  expect((await lstat(paths.state)).mode & 0o777).toBe(0o600);
  expect((await lstat(paths.root)).mode & 0o777).toBe(0o700);
  await writeWriterState(home, name, { ...state, phase: "not_ready" });
  expect((await readWriterState(home, name))?.phase).toBe("not_ready");
  expect(await readdir(paths.root)).toEqual(["state.json"]);
  expect(JSON.stringify(state).replace(state.base.ref, "")).not.toContain("/");
});

it("returns undefined only for an absent file", async () => {
  const home = await temporaryRoot("pi-writer-state-");
  expect(await readWriterState(home, name)).toBeUndefined();
});

it("returns undefined when the file vanishes between lstat and open", async () => {
  const home = await temporaryRoot("pi-writer-state-");
  await writeWriterState(home, name, state);
  const mock = vi.spyOn(fsPromises, "open").mockRejectedValueOnce(Object.assign(new Error("vanished"), { code: "ENOENT" }));
  syncBuiltinESMExports();
  try { expect(await readWriterState(home, name)).toBeUndefined(); } finally { mock.mockRestore(); syncBuiltinESMExports(); }
});

it.each(["EACCES", "EPERM", "EIO", "EMFILE"])("classifies %s as unreadable, not invalid", async (code) => {
  const home = await temporaryRoot("pi-writer-state-");
  await writeWriterState(home, name, state);
  for (const method of ["lstat", "open"] as const) {
    const mock = vi.spyOn(fsPromises, method).mockRejectedValueOnce(Object.assign(new Error("private"), { code }));
    syncBuiltinESMExports();
    try { await expect(readWriterState(home, name)).rejects.toMatchObject({ code: "writer_state_unreadable" }); } finally { mock.mockRestore(); syncBuiltinESMExports(); }
  }
  expect(await readWriterState(home, name)).toEqual(state);
});

describe("state validation", () => {
  it.each([
    ["unknown key", { ...state, SECRET_SENTINEL: true }],
    ["path alias", { ...state, alias: "../SECRET_SENTINEL" }],
    ["wrong identity", { ...state, index: 1 }],
    ["schema version", { ...state, schemaVersion: 2 }],
    ["image", { ...state, imageId: "node" }],
    ["invalid clean", { ...state, clean: "bogus" }],
    ["commit", { ...state, base: { ...state.base, commit: "bad" } }],
    ["nested unknown key", { ...state, base: { ...state.base, SECRET_SENTINEL: true } }],
    ["path profile", { ...state, profiles: ["../SECRET_SENTINEL"] }],
    ["empty profiles", { ...state, profiles: [] }],
    ["invalid provider", { ...state, providers: [{ provider: "../SECRET_SENTINEL", model: "m" }] }],
    ["duplicate providers", { ...state, providers: [state.providers[0], state.providers[0]] }],
    ["empty model", { ...state, providers: [{ provider: "example", model: "" }] }],
    ["long model", { ...state, providers: [{ provider: "example", model: "m".repeat(201) }] }],
  ])("rejects %s with a sanitized error", async (_label, raw) => {
    const home = await temporaryRoot("pi-writer-state-");
    const paths = writerPaths(home, name);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.state, JSON.stringify(raw));
    await expect(readWriterState(home, name)).rejects.toMatchObject({ name: "WriterStateError", code: "writer_state_invalid" });
    await expect(writeWriterState(home, name, raw as WriterState)).rejects.toThrow(WriterStateError);
    expect(await readFile(paths.state, "utf8")).toBe(JSON.stringify(raw));
    try { await readWriterState(home, name); } catch (error) {
      expect(String(error)).not.toContain("SECRET_SENTINEL");
      expect(JSON.stringify(error)).not.toContain("SECRET_SENTINEL");
    }
  });

  it("accepts boundary provider/model values and 64-hex commits", async () => {
    const home = await temporaryRoot("pi-writer-state-");
    const value = { ...state, providers: [{ provider: "a".repeat(64), model: "m".repeat(200) }], base: { ...state.base, commit: "f".repeat(64) } };
    await writeWriterState(home, name, value);
    expect(await readWriterState(home, name)).toEqual(value);
  });

  it("rejects invalid JSON, directories, and symlinks", async () => {
    const home = await temporaryRoot("pi-writer-state-");
    const paths = writerPaths(home, name);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.state, "SECRET_SENTINEL invalid JSON");
    await expect(readWriterState(home, name)).rejects.toMatchObject({ code: "writer_state_invalid" });
    const other = writerPaths(home, "a-w1");
    await mkdir(other.state, { recursive: true });
    await expect(readWriterState(home, "a-w1")).rejects.toMatchObject({ code: "writer_state_invalid" });
    const linked = writerPaths(home, "b-w1");
    await mkdir(linked.root, { recursive: true });
    await symlink(paths.state, linked.state);
    await expect(readWriterState(home, "b-w1")).rejects.toMatchObject({ code: "writer_state_invalid" });
  });
});

it("fingerprints canonical key-sorted JSON and includes Podman version", () => {
  const input = { wrapperDigest: "wrapper", packageVersion: "1.0.0", imageId: "a".repeat(64), podmanVersion: "5.0.0", network: "pasta", cache: "none" };
  const reordered = { cache: input.cache, network: input.network, podmanVersion: input.podmanVersion, imageId: input.imageId, packageVersion: input.packageVersion, wrapperDigest: input.wrapperDigest };
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))));
  expect(acceptanceFingerprint(input)).toBe(`sha256:${createHash("sha256").update(canonical).digest("hex")}`);
  expect(acceptanceFingerprint(input)).toBe(acceptanceFingerprint(reordered));
  expect(acceptanceFingerprint(input)).not.toBe(acceptanceFingerprint({ ...input, podmanVersion: "5.1.0" }));
  expect(new Set(["none", "go", "uv", "npm"].map((cache) => acceptanceFingerprint({ ...input, cache }))).size).toBe(4);
});

it.each([
  [{ events: { delivery: "spool" }, workspaces: {} }, true],
  [{ workspaces: {} }, false],
  [{ events: {} }, false],
  [{ events: { delivery: "off" } }, false],
  [{ events: { delivery: "spool", extra: true } }, false],
  [{ events: [{ delivery: "spool" }] }, false],
  [{ events: null }, false],
  [[], false],
  [null, false],
])("reads event delivery from the writer configuration %j as %s", async (config, enabled) => {
  const directory = await temporaryRoot("pi-writer-delivery-");
  await writeFile(join(directory, "pi-session-mcp.json"), JSON.stringify(config));
  expect(await writerEventDeliveryEnabled(directory)).toBe(enabled);
});
it("treats a missing, malformed or linked writer configuration as delivery disabled", async () => {
  const directory = await temporaryRoot("pi-writer-delivery-");
  expect(await writerEventDeliveryEnabled(directory)).toBe(false);
  await writeFile(join(directory, "pi-session-mcp.json"), "{not json");
  expect(await writerEventDeliveryEnabled(directory)).toBe(false);
  const other = await temporaryRoot("pi-writer-delivery-");
  await writeFile(join(other, "real.json"), JSON.stringify({ events: { delivery: "spool" } }));
  await symlink(join(other, "real.json"), join(other, "pi-session-mcp.json"));
  expect(await writerEventDeliveryEnabled(other)).toBe(false);
});

describe("acceptance fingerprint and event delivery", () => {
  const input = { wrapperDigest: "wrapper", packageVersion: "1.0.0", imageId: "a".repeat(64), podmanVersion: "5.0.0", network: "pasta", cache: "none" };
  it("leaves a fingerprint without delivery unchanged and changes it only for an enabled delivery", () => {
    const legacy = JSON.stringify({ cache: "none", imageId: input.imageId, network: "pasta", packageVersion: "1.0.0", podmanVersion: "5.0.0", wrapperDigest: "wrapper" });
    expect(acceptanceFingerprint(input)).toBe(`sha256:${createHash("sha256").update(legacy).digest("hex")}`);
    expect(acceptanceFingerprint({ ...input, eventDelivery: false })).toBe(acceptanceFingerprint(input));
    expect(acceptanceFingerprint({ ...input, eventDelivery: true })).not.toBe(acceptanceFingerprint(input));
    expect(acceptanceFingerprint({ ...input, eventDelivery: true })).toBe(acceptanceFingerprint({ ...input, eventDelivery: true }));
  });
  it("reads delivery from the configuration next to the wrapper", async () => {
    const home = await temporaryRoot("pi-writer-fingerprint-");
    const paths = writerPaths(home, name);
    await mkdir(paths.config, { recursive: true });
    await writeFile(paths.wrapper, "wrapper");
    const plain = await currentAcceptanceFingerprint(paths.wrapper, state, "5.4.0");
    // Without a configuration, and with delivery off, the fingerprint is the one an earlier release computed.
    expect(plain).toBe(acceptanceFingerprint({ wrapperDigest: wrapperDigest("wrapper"), packageVersion: PACKAGE_VERSION, imageId: state.imageId, podmanVersion: "5.4.0", network: state.network, cache: state.cache }));
    await writeFile(join(paths.config, "pi-session-mcp.json"), JSON.stringify({ events: { delivery: "off" } }));
    expect(await currentAcceptanceFingerprint(paths.wrapper, state, "5.4.0")).toBe(plain);
    await writeFile(join(paths.config, "pi-session-mcp.json"), JSON.stringify({ events: { delivery: "spool" } }));
    const enabled = await currentAcceptanceFingerprint(paths.wrapper, state, "5.4.0");
    expect(enabled).not.toBe(plain);
    expect(enabled).toBe(acceptanceFingerprint({ wrapperDigest: wrapperDigest("wrapper"), packageVersion: PACKAGE_VERSION, imageId: state.imageId, podmanVersion: "5.4.0", network: state.network, cache: state.cache, eventDelivery: true }));
  });
});
