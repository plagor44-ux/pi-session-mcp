// Plain-JS child for the multi-process test. It implements the ledger lock protocol by hand
// (exclusive create of run.json.lock, read, modify, temp file, fsync, rename, unlink) and imports nothing from the project.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const [dir, childId, countText] = process.argv.slice(2);
const run = join(dir, "run.json");
const lock = join(dir, "run.json.lock");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (let i = 0; i < Number(countText); i++) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { closeSync(openSync(lock, "wx", 0o600)); break; } catch (e) {
      if (e.code !== "EEXIST" || Date.now() > deadline) throw e;
      sleep(1 + Math.floor(Math.random() * 4));
    }
  }
  try {
    const ledger = JSON.parse(readFileSync(run, "utf8"));
    ledger.appliedEventIds.push(`${childId}-${i}`);
    ledger.revision += 1;
    const tmp = join(dir, `.tmp-${childId}-${i}`);
    const fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, JSON.stringify(ledger, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, run);
  } finally {
    unlinkSync(lock);
  }
}
