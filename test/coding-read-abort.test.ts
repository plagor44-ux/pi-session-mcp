/**
 * #298: a real coding session on the faux provider (the session's own `read` tool, a real file) is
 * aborted after `read` checked its signal and before the file's stream exists: while it detects the
 * image type, or while it opens the file for the stream. The abort must end the turn, never the
 * server: no stream may be created on the aborted signal, so no `error` event goes without a listener.
 */
import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProviderPolicy } from "../src/provider-store.js";
import { SdkPiSessionAdapter } from "../src/sdk-pi-adapter.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

let savedAgentDir: string | undefined;
beforeEach(() => { savedAgentDir = process.env.PI_CODING_AGENT_DIR; });
afterEach(() => {
  vi.restoreAllMocks();
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});
afterAll(removeTemporaryRoots);

describe("coding session read abort (#298)", () => {
  // `read` sniffs the image type through `FileHandle.read` and opens the file for its stream through `FileHandle.stat`.
  it.each([
    ["detects the image type", "read"],
    ["opens the file for its stream", "stat"],
  ] as const)("ends the turn and creates no stream on the aborted signal when the abort lands while read %s", async (_window, hook) => {
    const root = await temporaryRoot("coding-read-abort-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "notes.txt"), "first line\nsecond line\n");
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    await mkdir(process.env.PI_CODING_AGENT_DIR);

    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const model = faux.getModel();
    const adapter = new SdkPiSessionAdapter({
      modelRuntimeFactory: async () => runtime,
      // An empty provider store below a temporary home, so the operator's store never reaches the test.
      providerPolicyFactory: () => loadProviderPolicy({ home: join(root, "home") }),
    });
    const handle = await adapter.create({ cwd: workspace, executionProfile: {
      alias: "coding-test", permissionProfile: "coding", provider: model.provider, model: model.id, thinkingLevel: "off",
    } });

    const sample = await open(join(workspace, "notes.txt"), "r");
    const prototype = Object.getPrototypeOf(sample) as FileHandle;
    await sample.close();
    const original = prototype[hook] as (...args: unknown[]) => Promise<unknown>;
    const originalCreateReadStream = prototype.createReadStream;
    let aborting: Promise<void> | undefined;
    const window = vi.spyOn(prototype, hook).mockImplementation(async function (this: FileHandle, ...args: unknown[]) {
      const result = await original.apply(this, args);
      // The abort lands after read checked its signal and before the file's stream exists.
      aborting ??= handle.abort();
      return result;
    } as never);
    const abortedAtCreation: boolean[] = [];
    const createReadStream = vi.spyOn(prototype, "createReadStream").mockImplementation(function (this: FileHandle, options) {
      abortedAtCreation.push(options?.signal?.aborted === true);
      return originalCreateReadStream.call(this, options);
    });
    const uncaught: unknown[] = [];
    const collect = (error: unknown): void => { uncaught.push(error); };
    process.on("uncaughtException", collect);
    try {
      const outcome = await handle.prompt("Read notes.txt", () => undefined);
      await aborting;
      // An `error` event without a listener is raised from a later tick; give it the time to surface.
      for (let tick = 0; tick < 10; tick++) await new Promise((resolve) => setImmediate(resolve));
      expect(aborting).toBeDefined();
      expect.soft(abortedAtCreation).not.toContain(true);
      expect.soft(uncaught).toEqual([]);
      expect.soft(outcome).toEqual({ status: "aborted" });
      // The second response was never requested: the abort ended the run at the tool call.
      expect.soft(faux.state.callCount).toBe(1);
    } finally {
      process.off("uncaughtException", collect);
      window.mockRestore();
      createReadStream.mockRestore();
      await handle.dispose();
    }
  }, 30_000);
});
