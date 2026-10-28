import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { CommandRunner } from "./client-adapters/types.js";
import { BoundaryError } from "./writer-boundary.js";
import type { writerPaths } from "./writer-state.js";

type WriterPaths = ReturnType<typeof writerPaths>;
export const FENCE_STOP_TIMEOUT_MS = 20_000;
const containersSchema = z.array(z.object({ Id: z.string().min(1), Names: z.array(z.string()) }));

export function writerContainerName(name: string): string { return `pi-writer-${name}`; }
export function writerLabel(name: string): string { return `pi-session-mcp.writer=${name}`; }

/** The caller holds the lease; no writer data may change until both inventories are empty. */
export async function ensureWriterAbsent(
  runner: CommandRunner, paths: WriterPaths, name: string,
  options: { leaseFd: number; stopTimeoutMs?: number },
): Promise<void> {
  try {
    const timeoutMs = options.stopTimeoutMs ?? FENCE_STOP_TIMEOUT_MS;
    if (process.platform !== "linux" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new BoundaryError("writer_fenced");
    const deadline = performance.now() + timeoutMs;
    const remaining = (): number => {
      const left = Math.ceil(deadline - performance.now());
      if (left <= 0) throw new BoundaryError("writer_fenced");
      return left;
    };
    const podman = async (args: readonly string[]): Promise<string> => {
      const result = await runner.run("podman", args, AbortSignal.timeout(remaining()), { inheritFds: [options.leaseFd] });
      remaining();
      if (result.exitCode !== 0 || result.stderr === "output_limit") throw new BoundaryError("writer_fenced");
      return result.stdout;
    };
    const list = async (filter: string) => containersSchema.parse(JSON.parse(await podman(["ps", "-a", "--filter", filter, "--format", "json"])));
    const removed = new Set<string>();
    for (;;) {
      const labelled = await list(`label=${writerLabel(name)}`);
      // Podman's volume filter matches the mount destination; every writer container, old releases
      // included, mounts the clone at its own host path, so this also finds unlabelled ones.
      const mounted = await list(`volume=${paths.clone}`);
      const ids = new Set([...labelled, ...mounted].map((container) => container.Id));
      if (ids.size === 0) return;
      for (const id of ids) {
        if (removed.has(id)) continue;
        await podman(["rm", "-f", "-t", String(Math.ceil(remaining() / 1000)), id]);
        removed.add(id);
      }
      await delay(Math.min(100, remaining()));
    }
  } catch { throw new BoundaryError("writer_fenced"); }
}
