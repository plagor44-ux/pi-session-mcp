import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/client-adapters/types.js";
import { BOUNDARY_GIT, podmanInfo, resolveImage, throwawayArgs } from "../src/writer-boundary.js";
import { writerPaths } from "../src/writer-state.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

const execute = promisify(execFile);
const runner: CommandRunner = {
  async run(command, args, signal) {
    try {
      const result = await execute(command, [...args], { signal, timeout: 30_000, maxBuffer: 32_768 });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch {
      return { exitCode: 1, stdout: "", stderr: "command_failed" };
    }
  },
};
const info = await podmanInfo(runner);
let imageId: string | undefined;
if (info.usable) {
  try { imageId = await resolveImage(runner, "node", false); } catch { console.warn("image not present"); }
} else console.warn("podman unavailable: rootless Podman probe failed");
afterAll(removeTemporaryRoots);

describe.skipIf(!info.usable || !imageId)("Podman throwaway boundary", () => {
  it("runs Git in the locally accepted image without provider access", async () => {
    const paths = writerPaths(await temporaryRoot("pi-boundary-podman-"), "repo-w1");
    await mkdir(paths.clone, { recursive: true });
    const result = await runner.run("podman", throwawayArgs(paths, imageId!, { clone: "ro", bundles: false }, `${BOUNDARY_GIT} --version`, []), AbortSignal.timeout(30_000));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version /);
  });
});
