import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, ModelRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedExecutionProfile } from "../src/execution-profile.js";
import { SdkPiSessionAdapter } from "../src/sdk-pi-adapter.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

let root: string;
let workspace: string;
let savedAgentDir: string | undefined;
const disposers: Array<() => void | Promise<void>> = [];
beforeEach(async () => {
  root = await temporaryRoot("readonly-context-");
  workspace = join(root, "workspace");
  await mkdir(workspace);
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "empty-agent");
  await mkdir(process.env.PI_CODING_AGENT_DIR);
});
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});
afterAll(removeTemporaryRoots);

async function harness(permissionProfile: ResolvedExecutionProfile["permissionProfile"] = "read-only", withExtension = false) {
  const faux = fauxProvider();
  let providerContext = "";
  faux.setResponses([(context) => { providerContext = JSON.stringify(context); return fauxAssistantMessage("ok"); }]);
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  let loader: ResourceLoader | undefined;
  const extensionPath = join(root, "extension.mjs");
  if (withExtension) await writeFile(extensionPath, "export default function () {}\n");
  const adapter = new SdkPiSessionAdapter({
    modelRuntimeFactory: async () => runtime,
    resolveExtension: async () => extensionPath,
    extensionSdk: {
      createServices: async (options) => {
        const services = await createAgentSessionServices(options);
        loader = services.resourceLoader;
        return services;
      },
      createSessionFromServices: createAgentSessionFromServices,
      createRuntime: createAgentSessionRuntime,
    },
    createSession: async (options) => {
      loader = options.resourceLoader;
      return createAgentSession(options);
    },
  });
  const model = faux.getModel();
  const handle = await adapter.create({ cwd: workspace, executionProfile: {
    alias: "context-test", permissionProfile, provider: model.provider, model: model.id, thinkingLevel: "off",
    ...(withExtension ? { extensions: [{ spec: "npm:context-test-extension@1.0.0", name: "context-test-extension", version: "1.0.0" }] } : {}),
  } });
  disposers.push(() => handle.dispose());
  return { handle, loader: loader!, context: () => providerContext, calls: () => faux.state.callCount };
}

function contents(loader: ResourceLoader): string {
  return loader.getAgentsFiles().agentsFiles.map((file) => file.content).join("\n");
}

describe("read-only context file confinement", () => {
  it("excludes outside-symlink content from the first provider context while keeping inside instructions", async () => {
    await writeFile(join(root, "outside.txt"), "SYNTHETIC_OUTSIDE_CONTEXT");
    await symlink(join(root, "outside.txt"), join(workspace, "AGENTS.md"));
    const child = join(workspace, "child");
    await mkdir(child);
    await writeFile(join(child, "AGENTS.md"), "SYNTHETIC_INSIDE_CONTEXT");
    workspace = child;
    const test = await harness();
    expect(await test.handle.prompt("Say ok", () => undefined)).toEqual({ status: "completed", assistantText: "ok" });
    expect(test.calls()).toBe(1);
    expect(test.context()).toContain("SYNTHETIC_INSIDE_CONTEXT");
    expect(test.context()).not.toContain("SYNTHETIC_OUTSIDE_CONTEXT");
  });

  it.each(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"])("filters outside symlinks named %s", async (name) => {
    await writeFile(join(root, "outside.txt"), "SYNTHETIC_OUTSIDE_CONTEXT");
    await symlink(join(root, "outside.txt"), join(workspace, name));
    const { loader } = await harness();
    expect(contents(loader)).not.toContain("SYNTHETIC_OUTSIDE_CONTEXT");
  });

  it("fails closed when an outside AGENTS.override.md shadows a valid AGENTS.md", async () => {
    // The SDK takes the first existing name per directory; the filter drops it and loads nothing else.
    await writeFile(join(root, "outside.txt"), "SYNTHETIC_OUTSIDE_CONTEXT");
    await symlink(join(root, "outside.txt"), join(workspace, "AGENTS.override.md"));
    await writeFile(join(workspace, "AGENTS.md"), "SYNTHETIC_INSIDE_CONTEXT");
    const { loader } = await harness();
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  });

  it("keeps a symlink resolving inside the canonical workspace and filters again on reload", async () => {
    await writeFile(join(workspace, "instructions.txt"), "SYNTHETIC_INSIDE_CONTEXT");
    await symlink(join(workspace, "instructions.txt"), join(workspace, "AGENTS.md"));
    // Exercise a workspace whose path itself is a symlink.
    await symlink(workspace, join(root, "workspace-link"));
    workspace = join(root, "workspace-link");
    const { loader } = await harness();
    expect(contents(loader)).toContain("SYNTHETIC_INSIDE_CONTEXT");
    await writeFile(join(root, "AGENTS.md"), "SYNTHETIC_ANCESTOR_CONTEXT");
    await loader.reload();
    expect(contents(loader)).toContain("SYNTHETIC_INSIDE_CONTEXT");
    expect(contents(loader)).not.toContain("SYNTHETIC_ANCESTOR_CONTEXT");
  });

  it("filters the extension loader before its first provider request and after reload", async () => {
    await writeFile(join(root, "outside.txt"), "SYNTHETIC_OUTSIDE_CONTEXT");
    await symlink(join(root, "outside.txt"), join(workspace, "AGENTS.md"));
    const test = await harness("read-only", true);
    expect(contents(test.loader)).not.toContain("SYNTHETIC_OUTSIDE_CONTEXT");
    await test.loader.reload();
    expect(contents(test.loader)).not.toContain("SYNTHETIC_OUTSIDE_CONTEXT");
    expect(await test.handle.prompt("Say ok", () => undefined)).toEqual({ status: "completed", assistantText: "ok" });
    expect(test.calls()).toBe(1);
    expect(test.context()).not.toContain("SYNTHETIC_OUTSIDE_CONTEXT");
  });

  it("drops a dangling context symlink", async () => {
    await symlink(join(workspace, "missing.txt"), join(workspace, "AGENTS.md"));
    const { loader } = await harness();
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  });

  it.each(["read-only", "coding"] as const)("handles ancestor context for %s profiles", async (permission) => {
    await writeFile(join(root, "AGENTS.md"), "SYNTHETIC_ANCESTOR_CONTEXT");
    const { loader } = await harness(permission);
    expect(contents(loader).includes("SYNTHETIC_ANCESTOR_CONTEXT")).toBe(permission === "coding");
  });

  it("keeps linked worktree instructions but excludes the containing main repository", async () => {
    const main = join(root, "main");
    await mkdir(main);
    execFileSync("git", ["init", "--quiet", main]);
    execFileSync("git", ["-C", main, "-c", "user.name=Context Test", "-c", "user.email=context@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
    workspace = join(main, "worktrees", "linked");
    execFileSync("git", ["-C", main, "worktree", "add", "--quiet", "-b", "linked", workspace]);
    await writeFile(join(main, "AGENTS.md"), "SYNTHETIC_MAIN_CONTEXT");
    await writeFile(join(workspace, "AGENTS.md"), "SYNTHETIC_WORKTREE_CONTEXT");
    const { loader } = await harness();
    expect(contents(loader)).toContain("SYNTHETIC_WORKTREE_CONTEXT");
    expect(contents(loader)).not.toContain("SYNTHETIC_MAIN_CONTEXT");
  });
});
