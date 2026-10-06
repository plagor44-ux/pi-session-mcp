import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Temporary roots created by one test file, removed together in `afterAll`.
 *
 * `mkdtemp` leaves its directory behind unless the test removes it. Tests that
 * only clean up on their success path keep leaving directories in the system
 * temp directory whenever an assertion fails, and a suite run accumulates them.
 * Registration plus a single `afterAll` removal makes cleanup independent of
 * how a test ends.
 *
 * Module state is per test file: Vitest isolates each file in its own module
 * graph, so two files cannot remove each other's roots.
 */
const roots: string[] = [];

export async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

export async function removeTemporaryRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
