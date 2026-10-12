import { readFile, stat } from "node:fs/promises";

/**
 * Linux only. Waits until a process is queued on the kernel lock of this file (a `->` entry in
 * `/proc/locks`): the proof that a run is blocked on the lock, not merely started.
 */
export async function waitForBlockedWaiter(lockPath: string): Promise<void> {
  const inode = (await stat(lockPath)).ino;
  const waiting = new RegExp(`->.*:${inode}\\s`);
  const deadline = Date.now() + 20_000;
  while (!waiting.test(await readFile("/proc/locks", "utf8"))) {
    if (Date.now() > deadline) throw new Error("no process is waiting for the lock");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

