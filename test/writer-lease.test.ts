import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chown, mkdir, open, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { afterAll, describe, expect, it } from "vitest";
import { acquireWriterLease, adoptInheritedLease, writerLeasePath } from "../src/writer-lease.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);
const name = "example-w1";
const busy = { code: "writer_busy" };
const unavailable = { code: "writer_lease_unavailable" };

async function holder(home: string): Promise<ChildProcess> {
  const path = writerLeasePath(home, name);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { openSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const fd = openSync(process.argv[1], 'a+', 0o600);
    if (spawnSync('/usr/bin/flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status !== 0) process.exit(1);
    process.stdout.write('ready');
    process.stdin.resume();
  `, path], { stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "exit").then(([code]) => { throw new Error(`lease holder exited with ${String(code)}`); });
  await Promise.race([once(child.stdout!, "data"), exit]);
  exit.catch(() => undefined);
  return child;
}
async function stop(child: ChildProcess): Promise<void> {
  const exited = once(child, "exit");
  child.stdin!.end();
  await exited;
}

describe.skipIf(process.platform !== "linux")("writer lease", () => {
  it("creates the lease directory 0700 and file 0600 and never deletes the file on release", async () => {
    const home = await temporaryRoot("pi-lease-");
    const lease = await acquireWriterLease(home, name, { waitMs: 0 });
    const path = writerLeasePath(home, name);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    const original = await stat(path);
    expect(original.mode & 0o777).toBe(0o600);
    await lease.release();
    await lease.release();
    expect((await stat(path)).ino).toBe(original.ino);
  });

  it("creates exact modes under a restrictive umask", async () => {
    const home = await temporaryRoot("pi-lease-");
    // Existing parents, as on a used machine; the umask then narrows only what the lease creates.
    await mkdir(join(home, ".local", "state", "pi-session-mcp"), { recursive: true, mode: 0o700 });
    const previous = process.umask(0o277);
    let lease;
    try { lease = await acquireWriterLease(home, name, { waitMs: 0 }); } finally { process.umask(previous); }
    const path = writerLeasePath(home, name);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await lease.release();
  });
  it("second non-blocking acquire in another process fails with writer_busy", async () => {
    const home = await temporaryRoot("pi-lease-");
    const child = await holder(home);
    try { await expect(acquireWriterLease(home, name, { waitMs: 0 })).rejects.toMatchObject(busy); }
    finally { await stop(child); }
    await (await acquireWriterLease(home, name, { waitMs: 0 })).release();
  });

  it("bounded wait returns writer_busy after waitMs", async () => {
    const home = await temporaryRoot("pi-lease-");
    const child = await holder(home);
    try {
      const start = Date.now();
      await expect(acquireWriterLease(home, name, { waitMs: 200 })).rejects.toMatchObject(busy);
      expect(Date.now() - start).toBeGreaterThanOrEqual(200);
      expect(Date.now() - start).toBeLessThan(2000);
    } finally { await stop(child); }
  });

  it("refuses a symlink, a directory or an unsafe-mode file at the lease path with writer_lease_unavailable", async () => {
    const home = await temporaryRoot("pi-lease-");
    const path = writerLeasePath(home, name);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const other = join(home, "other");
    await writeFile(other, "", { mode: 0o600 });
    await symlink(other, path);
    await expect(acquireWriterLease(home, name, { waitMs: 0 })).rejects.toMatchObject(unavailable);
    await unlink(path);
    await mkdir(path);
    await expect(acquireWriterLease(home, name, { waitMs: 0 })).rejects.toMatchObject(unavailable);
    const badMode = writerLeasePath(home, "example-w3");
    await writeFile(badMode, "", { mode: 0o644 });
    await expect(acquireWriterLease(home, "example-w3", { waitMs: 0 })).rejects.toMatchObject(unavailable);
  });

  it.skipIf(process.getuid!() !== 0)("refuses a foreign-owner file at the lease path with writer_lease_unavailable", async () => {
    const home = await temporaryRoot("pi-lease-");
    await (await acquireWriterLease(home, name, { waitMs: 0 })).release();
    await chown(writerLeasePath(home, name), 65534, 65534);
    await expect(acquireWriterLease(home, name, { waitMs: 0 })).rejects.toMatchObject(unavailable);
  });

  it("refuses an untrusted flock binary with writer_lease_unavailable", async () => {
    const home = await temporaryRoot("pi-lease-");
    await expect(acquireWriterLease(home, name, { waitMs: 0, isTrustedBinary: () => false })).rejects.toMatchObject(unavailable);
  });

  it("adoptInheritedLease accepts a descriptor of the lease file that holds the lock", async () => {
    const home = await temporaryRoot("pi-lease-");
    await (await acquireWriterLease(home, name, { waitMs: 0 })).release();
    const fd = openSync(writerLeasePath(home, name), "r+");
    expect(spawnSync("/usr/bin/flock", ["-n", "3"], { stdio: ["ignore", "ignore", "ignore", fd] }).status).toBe(0);
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore", fd] });
    const adopted = await adoptInheritedLease(home, name, fd);
    try {
      await adopted.release();
      await adopted.release();
      await expect(acquireWriterLease(home, name, { waitMs: 0 })).rejects.toMatchObject(busy);
    } finally { await stop(child); await adopted.release(); }
    await (await acquireWriterLease(home, name, { waitMs: 0 })).release();
  });

  it("rejects a descriptor of another file, or an unlocked descriptor, with writer_lease_unavailable", async () => {
    const home = await temporaryRoot("pi-lease-");
    await (await acquireWriterLease(home, name, { waitMs: 0 })).release();
    const unlocked = await open(writerLeasePath(home, name), "r+");
    const other = await open(join(home, "other"), "w+", 0o600);
    try {
      await expect(adoptInheritedLease(home, name, unlocked.fd)).rejects.toMatchObject(unavailable);
      await expect(adoptInheritedLease(home, name, other.fd)).rejects.toMatchObject(unavailable);
    } finally { await unlocked.close(); await other.close(); }
  });

  it("lock survives the death of the flock helper and ends with the last descriptor", async () => {
    const home = await temporaryRoot("pi-lease-");
    const lease = await acquireWriterLease(home, name, { waitMs: 0 });
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); process.stdin.resume()"], { stdio: ["pipe", "pipe", "ignore", lease.fd] });
    await once(child.stdout!, "data");
    await lease.release();
    try { await expect(acquireWriterLease(home, name, { waitMs: 0 })).rejects.toMatchObject(busy); }
    finally { await stop(child); }
    const fd = openSync(writerLeasePath(home, name), "r+");
    try { expect(spawnSync("/usr/bin/flock", ["-n", "3"], { stdio: ["ignore", "ignore", "ignore", fd] }).status).toBe(0); }
    finally { closeSync(fd); }
  });

  it("aborts a bounded wait without releasing another holder's lock", async () => {
    const home = await temporaryRoot("pi-lease-");
    const child = await holder(home);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      await expect(acquireWriterLease(home, name, { waitMs: 2000, signal: controller.signal })).rejects.toMatchObject(unavailable);
      await expect(acquireWriterLease(home, name, { waitMs: 0 })).rejects.toMatchObject(busy);
    } finally { clearTimeout(timer); await stop(child); }
  });

  it("rejects invalid names, unsupported filesystems, aborted signals and invalid waits", async () => {
    const home = await temporaryRoot("pi-lease-");
    expect(() => writerLeasePath(home, "../bad")).toThrow();
    await expect(acquireWriterLease(home, name, { waitMs: 0, readStatfs: async () => ({ type: 0 }) })).rejects.toMatchObject(unavailable);
    await expect(acquireWriterLease(home, name, { waitMs: 0, signal: AbortSignal.abort() })).rejects.toMatchObject(unavailable);
    await expect(acquireWriterLease(home, name, { waitMs: -1 })).rejects.toMatchObject(unavailable);
  });
});
