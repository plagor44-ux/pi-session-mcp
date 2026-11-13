import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCodingReadTool, localReadOperations } from "../src/read-operations.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

let workspace: string;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");

beforeAll(async () => {
  workspace = join(await temporaryRoot("read-operations-"), "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.txt"), "first line\nsecond line\nthird line\n");
  await writeFile(join(workspace, "pixel.png"), PNG);
});

describe("localReadOperations", () => {
  it.each(["before the call", "while the file opens"])("refuses a signal aborted %s without creating a stream", async (when) => {
    const path = join(workspace, "notes.txt");
    const sample = await open(path, "r");
    const prototype = Object.getPrototypeOf(sample) as FileHandle;
    await sample.close();
    const controller = new AbortController();
    const originalStat = prototype.stat;
    const opened: FileHandle[] = [];
    const stat = vi.spyOn(prototype, "stat").mockImplementation(async function (this: FileHandle, options) {
      opened.push(this);
      const stats = await originalStat.call(this, options);
      // The abort lands after the file is open and before its stream exists.
      if (when === "while the file opens") controller.abort();
      return stats;
    });
    const createReadStream = vi.spyOn(prototype, "createReadStream");
    if (when === "before the call") controller.abort();
    try {
      const consume = async (): Promise<void> => {
        for await (const _chunk of localReadOperations().createReadStream(path, { signal: controller.signal })) { /* no chunk is expected */ }
      };
      await expect(consume()).rejects.toMatchObject({ name: "AbortError" });
      // A stream created with an aborted signal raises a second, uncaught AbortError: none may be created.
      expect(createReadStream).not.toHaveBeenCalled();
      expect(opened).toHaveLength(when === "before the call" ? 0 : 1);
      expect(opened.every((handle) => handle.fd === -1)).toBe(true);
    } finally {
      stat.mockRestore();
      createReadStream.mockRestore();
    }
  });
});

describe("createCodingReadTool", () => {
  type Execute = (...args: unknown[]) => Promise<unknown>;
  const execute = (definition: ToolDefinition, params: Record<string, unknown>): Promise<unknown> =>
    (definition.execute as unknown as Execute)("call", params, undefined, undefined, undefined);
  const settled = (result: Promise<unknown>): Promise<unknown> =>
    result.then((value) => ({ value }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));

  // The SDK's own read over its default operations is the reference: the coding read only adds the abort guard.
  it.each([
    ["a whole text file", { path: "notes.txt" }],
    ["a streamed line range", { path: "notes.txt", offset: 2, limit: 1 }],
    ["a range read whole", { path: "notes.txt", limit: -1 }],
    ["an image", { path: "pixel.png" }],
    ["a missing file", { path: "missing.txt" }],
  ])("reads %s as the SDK's default read does", async (_name, params) => {
    const reference = await settled(execute(createReadToolDefinition(workspace) as unknown as ToolDefinition, params));
    const coding = await settled(execute(createCodingReadTool(workspace), params));
    expect(coding).toEqual(reference);
  });
});
