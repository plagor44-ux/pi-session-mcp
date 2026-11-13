import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCodingReadTool, localReadOperations } from "../src/read-operations.js";
import { createPhase0ResourceLoader } from "../src/sdk-pi-adapter.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

let workspace: string;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");

/** A black 8-bit RGB PNG of the given size. */
function blackPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  // Each row is the filter byte 0 followed by its pixels.
  const rows = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

beforeAll(async () => {
  workspace = join(await temporaryRoot("read-operations-"), "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.txt"), "first line\nsecond line\nthird line\n");
  await writeFile(join(workspace, "pixel.png"), PNG);
  await writeFile(join(workspace, "wide.png"), blackPng(2400, 2));
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

  // A session builds its built-in `read` with the image resizing of its settings; this definition keeps the
  // factory default. The session settings of this server must select the same, or a large image would differ.
  it("resizes a large image as the built-in of the server's sessions does", async () => {
    const params = { path: "wide.png" };
    const read = (definition: unknown): Promise<unknown> => settled(execute(definition as ToolDefinition, params));
    // The image is large enough for the setting to change the result.
    expect(await read(createReadToolDefinition(workspace, { autoResizeImages: true })))
      .not.toEqual(await read(createReadToolDefinition(workspace, { autoResizeImages: false })));
    const { settingsManager } = await createPhase0ResourceLoader(workspace);
    const builtIn = await read(createReadToolDefinition(workspace, { autoResizeImages: settingsManager.getImageAutoResize() }));
    expect(await read(createCodingReadTool(workspace))).toEqual(builtIn);
  });
});
