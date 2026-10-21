import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLedger } from "../eval/bridge/ledger.js";
import { LedgerStore } from "../eval/bridge/ledger-store.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

// Separate file: the pid write can only be made to fail by wrapping node:fs/promises for the whole module.
const failing = vi.hoisted(() => ({ pidWrite: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (path: Parameters<typeof real.open>[0], ...rest: unknown[]) => {
      const handle = await (real.open as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof real.open>>>)(path, ...rest);
      if (failing.pidWrite && String(path).endsWith("run.json.lock")) handle.writeFile = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
      return handle;
    },
  };
});
afterAll(removeTemporaryRoots);

describe("ledger lock file", () => {
  it("removes the lock it created when writing the pid fails, so the next writer is not blocked", async () => {
    const dir = await temporaryRoot("bridge-ledger-lock-");
    const store = new LedgerStore(dir, { lockRetryMs: 5, lockTimeoutMs: 200 });
    await store.init(createLedger({ runId: "run-lock", controllerLabel: "ctl", at: "2026-10-21T10:00:00.000Z" }));
    failing.pidWrite = true;
    await expect(store.apply([])).rejects.toMatchObject({ code: "ledger_unreadable" });
    expect(existsSync(join(dir, "run.json.lock"))).toBe(false);
    failing.pidWrite = false;
    await expect(store.apply([])).resolves.toMatchObject({ outcomes: [] });
  });
});
