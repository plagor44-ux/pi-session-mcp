/**
 * The opt-in Go module cache of the sandboxed shell (#243) against the real bubblewrap, systemd-run and Go
 * toolchain. Skipped unless the sandbox probe passes and `/usr/bin/go` exists. Every module, proxy and cache
 * here is synthetic: a file proxy built in the test fills a separate module cache, never the operator's own.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSandboxedBashOperations, probeSandbox, sandboxBinaryTrusted, SANDBOX_GO_MODULE_CACHE, SANDBOX_UNAVAILABLE_MESSAGE,
  type SandboxSelection,
} from "../src/sandbox-shell.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const run = promisify(execFile);
const GO = "/usr/bin/go";
const probeRoot = await temporaryRoot("go-cache-probe-");
const available = sandboxBinaryTrusted() && existsSync(GO) && await probeSandbox(probeRoot);

/** A stored (uncompressed) zip archive, enough for a Go module zip. */
function storedZip(files: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const DEP_MOD = "module example.invalid/dep\n\ngo 1.22\n";
const DEP_GO = "package dep\n\nfunc Answer() int { return 42 }\n";
const MAIN_MOD = "module example.invalid/main\n\ngo 1.22\n\nrequire example.invalid/dep v1.0.0\n";
const MAIN_GO = 'package main\n\nimport (\n\t"fmt"\n\n\t"example.invalid/dep"\n)\n\nfunc main() { fmt.Println(dep.Answer()) }\n';
const MAIN_TEST = 'package main\n\nimport (\n\t"testing"\n\n\t"example.invalid/dep"\n)\n\nfunc TestAnswer(t *testing.T) {\n\tif dep.Answer() != 42 {\n\t\tt.Fatal("wrong answer")\n\t}\n}\n';

/** Host-side Go with only the synthetic file proxy; never the operator's module cache or the network. */
function hostGoEnv(root: string, cache: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin", HOME: join(root, "host-home"), GOENV: "off", GOMODCACHE: cache, GOCACHE: join(root, "host-gocache"),
    GOPROXY: `file://${join(root, "proxy")}`, GOSUMDB: "off", GOFLAGS: "-mod=mod -modcacherw", GOTOOLCHAIN: "local",
  };
}

async function snapshot(root: string): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const info = await lstat(path);
      const meta = `${(info.mode & 0o7777).toString(8)} ${info.mtimeMs}`;
      if (info.isDirectory()) { entries.push(`d ${meta} ${name}`); await walk(path, name); }
      else if (info.isSymbolicLink()) entries.push(`l ${meta} ${name} -> ${await readlink(path)}`);
      else entries.push(`f ${meta} ${info.size} ${name} ${createHash("sha256").update(await readFile(path)).digest("hex")}`);
    }
  };
  await walk(root, "");
  return entries.sort();
}

type Run = { ok: true; exitCode: number | null; output: string } | { ok: false; error: Error; output: string };

async function sandbox(workspace: string, command: string, selection?: SandboxSelection, env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  let output = "";
  try {
    const { exitCode } = await createSandboxedBashOperations(workspace, {}, selection).exec(command, workspace, {
      onData: (data) => { output += data.toString(); }, env, timeout: 120,
    });
    return { ok: true, exitCode, output };
  } catch (error) {
    return { ok: false, error: error as Error, output };
  }
}

function succeeded(result: Run): { exitCode: number | null; output: string } {
  if (!result.ok) throw new Error(`sandbox call failed: ${result.error.message}`);
  return result;
}

// Each test runs several real sandbox commands, some of them a Go build; the 5 s default is too short under load (#240).
describe.skipIf(!available)("Go module cache in the real sandbox", { timeout: 120_000 }, () => {
  let root: string;
  let cache: string;
  let main: string;
  let selection: SandboxSelection;
  let cacheBefore: string[];
  let hostFilesBefore: string[];
  const home = homedir();
  const protection = { home, secretPaths: [join(home, ".pi")] };

  beforeAll(async () => {
    root = await temporaryRoot("go-cache-real-");
    cache = join(root, "modcache");
    main = join(root, "main");
    const proxy = join(root, "proxy", "example.invalid", "dep", "@v");
    await mkdir(proxy, { recursive: true });
    await writeFile(join(proxy, "list"), "v1.0.0\n");
    await writeFile(join(proxy, "v1.0.0.info"), '{"Version":"v1.0.0","Time":"2026-01-01T00:00:00Z"}\n');
    await writeFile(join(proxy, "v1.0.0.mod"), DEP_MOD);
    await writeFile(join(proxy, "v1.0.0.zip"), storedZip([
      { name: "example.invalid/dep@v1.0.0/go.mod", data: Buffer.from(DEP_MOD) },
      { name: "example.invalid/dep@v1.0.0/dep.go", data: Buffer.from(DEP_GO) },
    ]));
    await mkdir(main);
    await writeFile(join(main, "go.mod"), MAIN_MOD);
    await writeFile(join(main, "main.go"), MAIN_GO);
    await writeFile(join(main, "main_test.go"), MAIN_TEST);
    // Fill the synthetic cache and write go.sum on the host, from the file proxy only.
    await run(GO, ["mod", "tidy"], { cwd: main, env: hostGoEnv(root, cache) });
    expect(await readFile(join(main, "go.sum"), "utf8")).toContain("example.invalid/dep v1.0.0 h1:");
    // A symlink inside the cache that points at a sentinel outside it.
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "sentinel.txt"), "outside-sentinel\n");
    await symlink(join(root, "outside", "sentinel.txt"), join(cache, "escape"));
    selection = { goModuleCache: cache, protection };
    cacheBefore = await snapshot(cache);
    hostFilesBefore = await snapshot(main);
  }, 120_000);

  it("cannot resolve the dependency without the opt-in, and the network stays unreachable", async () => {
    const { exitCode, output } = succeeded(await sandbox(main, "go build ./... 2>&1"));
    expect(exitCode).not.toBe(0);
    expect(output).toContain("example.invalid/dep");
    expect(output).toMatch(/dial tcp|lookup|connect|network/);
  });

  it("runs go test, go vet and go build offline with the opt-in", async () => {
    const { exitCode, output } = succeeded(await sandbox(main, "set -e; go test ./... 2>&1; echo VET; go vet ./... 2>&1; echo BUILD; go build ./... 2>&1; echo DONE", selection));
    expect(output).toMatch(/ok\s+example\.invalid\/main/);
    expect(output).toContain("DONE");
    expect(exitCode).toBe(0);
  });

  it("sets the fixed Go environment and ignores inherited Go variables", async () => {
    const hostile = { ...process.env, GOPROXY: "https://proxy.example.invalid", GOMODCACHE: "/elsewhere", GOENV: join(root, "go.env"), GOTOOLCHAIN: "go1.99.0", GOFLAGS: "-mod=mod", GOSUMDB: "sum.example.invalid" };
    const { exitCode, output } = succeeded(await sandbox(main, "go env GOMODCACHE GOCACHE GOPROXY GOSUMDB GOTOOLCHAIN GOFLAGS; printenv GOENV", selection, hostile));
    expect(exitCode).toBe(0);
    expect(output.split("\n").slice(0, 7)).toEqual([SANDBOX_GO_MODULE_CACHE, "/tmp/go-build", "off", "off", "local", "", "off"]);
  });

  it("mounts the cache read-only", async () => {
    const { exitCode, output } = succeeded(await sandbox(main, `touch ${SANDBOX_GO_MODULE_CACHE}/written 2>&1; echo "touch=$?"; mkdir ${SANDBOX_GO_MODULE_CACHE}/cache/download/new 2>&1; echo "mkdir=$?"`, selection));
    expect(exitCode).toBe(0);
    expect(output).toContain("Read-only file system");
    expect(output).toMatch(/touch=[1-9]/);
    expect(output).toMatch(/mkdir=[1-9]/);
  });

  it("shows neither the cache's siblings, nor what its symlinks point at, nor the home directory", async () => {
    const { exitCode, output } = succeeded(await sandbox(main, [
      `cat ${SANDBOX_GO_MODULE_CACHE}/escape 2>/dev/null && echo ESCAPE-READ`,
      `test -e '${join(root, "outside")}' && echo OUTSIDE-VISIBLE`,
      `test -e '${cache}' && echo SOURCE-VISIBLE`,
      `test -e '${home}' && echo HOME-VISIBLE`,
      "echo CHECKED",
    ].join("; "), selection));
    expect(exitCode).toBe(0);
    expect(output).toContain("CHECKED");
    expect(output).not.toMatch(/ESCAPE-READ|OUTSIDE-VISIBLE|SOURCE-VISIBLE|HOME-VISIBLE|outside-sentinel/);
  });

  it("refuses a module that is not in the cache without downloading it", async () => {
    const other = join(root, "missing-module");
    await cp(main, other, { recursive: true });
    await writeFile(join(other, "go.mod"), `${MAIN_MOD}require example.invalid/absent v1.0.0\n`);
    await writeFile(join(other, "absent.go"), 'package main\n\nimport _ "example.invalid/absent"\n');
    const { exitCode, output } = succeeded(await sandbox(other, "go build ./... 2>&1", selection));
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/GOPROXY=off|missing go\.sum entry/);
  });

  it("refuses a newer toolchain instead of downloading one", async () => {
    const other = join(root, "newer-toolchain");
    await cp(main, other, { recursive: true });
    await writeFile(join(other, "go.mod"), MAIN_MOD.replace("go 1.22", "go 1.99"));
    const { exitCode, output } = succeeded(await sandbox(other, "go build ./... 2>&1", selection));
    expect(exitCode).not.toBe(0);
    expect(output).toContain("GOTOOLCHAIN=local");
  });

  it("verifies go.sum against the cache although GOSUMDB is off", async () => {
    const { exitCode, output } = succeeded(await sandbox(main, "sed -i 's/ h1:./ h1:A/' go.sum && go build ./... 2>&1", selection));
    expect(exitCode).not.toBe(0);
    expect(output).toContain("checksum mismatch");
  });

  it("does not rewrite go.mod or go.sum: a missing go.sum entry fails", async () => {
    const { exitCode, output } = succeeded(await sandbox(main, "rm go.sum && go build ./... 2>&1; test -e go.sum && echo SUM-RECREATED; echo END", selection));
    expect(exitCode).toBe(0);
    expect(output).toContain("missing go.sum entry");
    expect(output).not.toContain("SUM-RECREATED");
  });

  it("re-resolves a symlinked source on every command and refuses an unsuitable target", async () => {
    const link = join(root, "cache-link");
    await symlink(cache, link);
    const linked = { goModuleCache: link, protection };
    const first = succeeded(await sandbox(main, "go build ./... 2>&1 && echo LINKED-OK", linked));
    expect(first.output).toContain("LINKED-OK");
    await unlink(link);
    await symlink(join(root, "outside"), link);
    const refused = await sandbox(main, "echo SHOULD-NOT-RUN", linked);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toBe(SANDBOX_UNAVAILABLE_MESSAGE);
    expect(refused.output).toBe("");
    expect(await probeSandbox(main, {}, undefined, linked)).toBe(false);
    await unlink(link);
    await symlink(home, link);
    expect(await probeSandbox(main, {}, undefined, linked)).toBe(false);
  });

  it("mounts the directory it checked when the source is swapped after the check", async () => {
    const secret = join(root, "secret");
    await mkdir(join(secret, "cache", "download"), { recursive: true });
    await writeFile(join(secret, "SECRET-MARK"), "secret\n");
    const link = join(root, "race-link");
    await symlink(cache, link);
    const guarded = { goModuleCache: link, protection: { home, secretPaths: [...protection.secretPaths, secret] } };
    let swapped = false;
    // The Git directory lookup runs after the cache was opened and checked, and before the spawn.
    const swap = async (): Promise<undefined> => { await unlink(link); await symlink(secret, link); swapped = true; return undefined; };
    let output = "";
    const { exitCode } = await createSandboxedBashOperations(main, { gitCommonDir: swap }, guarded).exec(
      "test -e /go/pkg/mod/SECRET-MARK && echo LEAKED; test -d /go/pkg/mod/cache/download/example.invalid && echo ORIGINAL",
      main, { onData: (data) => { output += data.toString(); }, env: process.env, timeout: 120 },
    );
    expect(swapped).toBe(true);
    expect(exitCode).toBe(0);
    expect(output).toContain("ORIGINAL");
    expect(output).not.toContain("LEAKED");
    // The next run checks the swapped target and refuses it.
    expect(await probeSandbox(main, {}, undefined, guarded)).toBe(false);
  });

  it("fails the probe for a missing cache and passes it for the valid one", async () => {
    expect(await probeSandbox(main, {}, undefined, selection)).toBe(true);
    expect(await probeSandbox(main, {}, undefined, { goModuleCache: join(root, "absent"), protection })).toBe(false);
  });

  it("leaves the cache and the host module files unchanged", async () => {
    expect(await snapshot(cache)).toEqual(cacheBefore);
    expect(await snapshot(main)).toEqual(hostFilesBefore);
    await rm(join(root, "host-gocache"), { recursive: true, force: true });
  });
});
