import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

const root = fileURLToPath(new URL("..", import.meta.url));
// What Vitest's default include would collect, as a test on the file name.
const DEFAULT_TEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
// The configured include, test/**/*.test.{ts,mjs}, as a test on a repository-relative path.
const COLLECTED = /^test\/(?:.+\/)?[^/]+\.test\.(?:ts|mjs)$/;

/** The tracked files, or undefined outside a Git checkout such as an exported archive. */
function trackedFiles(): string[] | undefined {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return undefined;
  const files = result.stdout.split("\0").filter(Boolean);
  // A directory inside a foreign repository lists nothing of this project.
  return files.includes("vitest.config.ts") ? files : undefined;
}

const tracked = trackedFiles();

describe("test discovery", () => {
  it("collects only the test files below test/", () => {
    expect(config.test?.include).toEqual(["test/**/*.test.{ts,mjs}"]);
  });

  // Narrowing the include must not hide a test: a tracked file that the default
  // pattern would have run, but the configured one does not, fails here.
  it.skipIf(tracked === undefined)("leaves no tracked test file uncollected", () => {
    const uncollected = (tracked ?? []).filter((file) => DEFAULT_TEST_NAME.test(file) && !COLLECTED.test(file));
    expect(uncollected).toEqual([]);
  });
});
