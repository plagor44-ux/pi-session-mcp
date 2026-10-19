import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  acceptanceFingerprint, readWriterState, WRITER_NAME_PATTERN, writerName,
  writerPaths, writerRegistrationName, writersRoot, writeWriterState, WriterStateError,
  type WriterState,
} from "../src/writer-state.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const state: WriterState = {
  schemaVersion: 1, alias: "pi-session-mcp", index: 2, phase: "ready",
  lifecycle: "persistent", profiles: ["code"], network: "pasta", cache: "none",
  providers: [{ provider: "example-provider", model: "example-model" }],
  imageId: "a".repeat(64), base: { ref: "refs/heads/main", commit: "b".repeat(40) },
  acceptance: { fingerprint: `sha256:${"c".repeat(64)}`, verdict: "pass", network: "limited", at: "2026-01-01T00:00:00Z" },
  collected: { digest: `sha256:${"d".repeat(64)}`, at: "2026-01-01T00:00:00Z" },
};
const name = "pi-session-mcp-w2";

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
    config: join(root, "config"), go: join(root, "go"), wrapper: join(root, "wrapper.sh"), state: join(root, "state.json"),
  });
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
});
