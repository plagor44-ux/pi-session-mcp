import { mkdir, open, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { allowedReadRoots, confinedOperations, confineToolPath, createConfinedReadOnlyTools, OUTSIDE_ROOTS_MESSAGE } from "../src/confined-tools.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

let base: string;
let workspace: string;
let outside: string;
let skillDir: string;
let roots: string[];
let tools: Record<string, ToolDefinition>;

const SECRET = "OUTSIDE-SECRET-CONTENT";

async function run(name: string, params: Record<string, unknown>): Promise<string> {
  const result = await tools[name]!.execute("call", params as never, undefined, undefined, undefined as never);
  return JSON.stringify(result.content);
}

beforeAll(async () => {
  base = await temporaryRoot("confined-tools-");
  workspace = join(base, "workspace");
  outside = join(base, "outside");
  skillDir = join(base, "skills", "review");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(workspace, "src", "a.txt"), "inside needle\n");
  await writeFile(join(outside, "secret.txt"), `${SECRET} needle\n`);
  await writeFile(join(skillDir, "SKILL.md"), "skill needle\n");
  await symlink(join(outside, "secret.txt"), join(workspace, "link-file"));
  await symlink(outside, join(workspace, "link-dir"));
  await mkdir(join(workspace, "mixed"), { recursive: true });
  await writeFile(join(workspace, "mixed", "own.txt"), "line before\nown needle\nline after\n");
  await symlink(join(outside, "secret.txt"), join(workspace, "mixed", "escape.txt"));
  const skill = { name: "review", description: "d", filePath: join(skillDir, "SKILL.md"), baseDir: skillDir } as unknown as Skill;
  roots = await allowedReadRoots(workspace, [skill]);
  tools = Object.fromEntries(createConfinedReadOnlyTools(workspace, roots).map((tool) => [tool.name, tool]));
  // Where rg and fd are not installed, as on the macOS runners, the SDK downloads them on first use. Do that here, so a slow download cannot use up a test's time limit.
  await run("grep", { pattern: "needle", path: "src" });
  await run("find", { pattern: "*.txt", path: "src" });
}, 300_000);

describe("allowedReadRoots", () => {
  it("returns real, deduplicated roots", async () => {
    const link = join(base, "ws-link");
    await symlink(workspace, link);
    const skill = (filePath: string): Skill => ({ name: "s", description: "d", filePath, baseDir: "" }) as unknown as Skill;
    const result = await allowedReadRoots(link, [skill(join(workspace, "SKILL.md")), skill(join(skillDir, "SKILL.md")), skill(join(skillDir, "OTHER.md"))]);
    expect(result).toEqual([workspace, skillDir]);
  });
});

describe("confineToolPath", () => {
  it("allows relative and absolute paths inside and the workspace itself", async () => {
    await expect(confineToolPath("src/a.txt", workspace, roots)).resolves.toBe(join(workspace, "src", "a.txt"));
    await expect(confineToolPath(join(workspace, "src"), workspace, roots)).resolves.toBe(join(workspace, "src"));
    await expect(confineToolPath(undefined, workspace, roots)).resolves.toBe(workspace);
    await expect(confineToolPath("", workspace, roots)).resolves.toBe(workspace);
    await expect(confineToolPath(".", workspace, roots)).resolves.toBe(workspace);
  });

  it("allows a missing path inside by its nearest existing ancestor", async () => {
    await expect(confineToolPath("src/new/deeper/file.txt", workspace, roots)).resolves.toBe(join(workspace, "src", "new", "deeper", "file.txt"));
  });

  it("allows a selected skill directory as an extra root", async () => {
    await expect(confineToolPath(join(skillDir, "SKILL.md"), workspace, roots)).resolves.toBe(join(skillDir, "SKILL.md"));
  });

  it("refuses escapes, outside paths, siblings with a shared prefix and symlinks, without echoing the path", async () => {
    for (const input of ["..", "../outside/secret.txt", join(outside, "secret.txt"), "/etc/passwd", `${workspace}-evil`, "link-file", "link-dir", "link-dir/secret.txt", "src/../../outside"]) {
      await expect(confineToolPath(input, workspace, roots), input).rejects.toThrow(new Error(OUTSIDE_ROOTS_MESSAGE));
    }
  });

  it("refuses arguments the SDK would rewrite and non-strings", async () => {
    const inputs: unknown[] = ["~", "~/x", "~other", "@src/a.txt", `file://${join(outside, "secret.txt")}`, "file:x", "a\0b", "src a.txt", "src a.txt", "src a.txt", "src　a.txt", 5, null, {}, ["x"]];
    for (const input of inputs) {
      await expect(confineToolPath(input, workspace, roots), String(input)).rejects.toThrow(OUTSIDE_ROOTS_MESSAGE);
    }
  });
});

describe("confined tools", () => {
  it("are named read, grep, find and ls", () => {
    expect(Object.keys(tools)).toEqual(["read", "grep", "find", "ls"]);
  });

  it("serve paths inside the workspace", async () => {
    expect(await run("read", { path: "src/a.txt" })).toContain("inside needle");
    expect(await run("read", { path: join(workspace, "src", "a.txt") })).toContain("inside needle");
    expect(await run("ls", { path: "src" })).toContain("a.txt");
    expect(await run("ls", {})).toContain("src/");
    expect(await run("grep", { pattern: "needle", path: "src" })).toContain("inside needle");
    expect(await run("find", { pattern: "*.txt", path: "src" })).toContain("a.txt");
  });

  it("serve a selected skill file", async () => {
    expect(await run("read", { path: join(skillDir, "SKILL.md") })).toContain("skill needle");
  });

  it("report the SDK's own not-found error for a missing path inside", async () => {
    await expect(run("read", { path: "src/missing.txt" })).rejects.toThrow(/ENOENT|not found|no such file/i);
    await expect(run("grep", { pattern: "x", path: "src/missing" })).rejects.toThrow(/not found/i);
    await expect(run("ls", { path: "src/missing" })).rejects.toThrow(/not found/i);
  });

  it.each([
    ["read", { path: "../outside/secret.txt" }],
    ["read", { path: "link-file" }],
    ["read", { path: "link-dir/secret.txt" }],
    ["read", { path: "/etc/hostname" }],
    ["read", { path: "~/.bashrc" }],
    ["read", { path: "@src/a.txt" }],
    ["grep", { pattern: "needle", path: "/etc" }],
    ["grep", { pattern: "needle", path: "link-dir" }],
    ["grep", { pattern: "needle", path: "link-file" }],
    ["grep", { pattern: "needle", path: ".." }],
    ["find", { pattern: "*", path: "/etc" }],
    ["find", { pattern: "*", path: "link-dir" }],
    ["find", { pattern: "*", path: ".." }],
    ["ls", { path: ".." }],
    ["ls", { path: "link-dir" }],
    ["ls", { path: "/" }],
    ["ls", { path: "src " }],
  ])("%s refuses %j", async (name, params) => {
    await expect(run(name, params)).rejects.toThrow(new Error(OUTSIDE_ROOTS_MESSAGE));
  });

  it("grep over a directory with an outward symlink returns no outside content", async () => {
    const output = await run("grep", { pattern: "needle", path: "." });
    expect(output).toContain("own needle");
    expect(output).not.toContain("line before");
    expect(output).not.toContain(SECRET);
    const listing = await run("grep", { pattern: "needle", path: "mixed" });
    expect(listing).toContain("own needle");
    expect(listing).not.toContain(SECRET);
    // Since SDK 1.5.1 `rg` emits the context lines itself; no hook sees the matched files.
    const context = await run("grep", { pattern: "needle", path: ".", context: 2 });
    expect(context).toContain("own needle");
    expect(context).toContain("line before");
    expect(context).toContain("line after");
    expect(context).not.toContain(SECRET);
  });

  it("find over the workspace does not descend into an outward symlink", async () => {
    const output = await run("find", { pattern: "secret.txt", path: "." });
    expect(output).not.toContain("outside");
    expect(output).not.toContain("link-dir/secret.txt");
  });

  it("re-checks the absolute path in the operations hooks", async () => {
    const ops = confinedOperations(roots);
    const inside = join(workspace, "src", "a.txt");
    const refused = new Error(OUTSIDE_ROOTS_MESSAGE);
    await expect(ops.read.readFile(inside)).resolves.toBeInstanceOf(Buffer);
    await expect(ops.read.access(inside)).resolves.toBeUndefined();
    await expect(ops.grep.isDirectory(join(workspace, "src"))).resolves.toBe(true);
    await expect(ops.ls.readdir(join(workspace, "src"))).resolves.toEqual(["a.txt"]);
    for (const path of [join(workspace, "link-file"), join(workspace, "link-dir"), join(outside, "secret.txt"), "/etc/hostname"]) {
      await expect(ops.read.readFile(path)).rejects.toThrow(refused);
      await expect(ops.read.access(path)).rejects.toThrow(refused);
      await expect(ops.read.detectImageMimeType(path)).rejects.toThrow(refused);
      await expect(ops.grep.isDirectory(path)).rejects.toThrow(refused);
      await expect(ops.ls.exists(path)).rejects.toThrow(refused);
      await expect(ops.ls.stat(path)).rejects.toThrow(refused);
      await expect(ops.ls.readdir(path)).rejects.toThrow(refused);
    }
  });

  /** An SDK tool with the hooks but without the execute wrapper: what the hooks alone achieve inside the SDK. */
  async function bare(name: "read" | "grep" | "ls", params: Record<string, unknown>, operations = confinedOperations(roots)): Promise<string> {
    const definition = name === "read" ? createReadToolDefinition(workspace, { operations: operations.read })
      : name === "grep" ? createGrepToolDefinition(workspace, { operations: operations.grep })
        : createLsToolDefinition(workspace, { operations: operations.ls });
    const result = await (definition as unknown as ToolDefinition).execute("call", params as never, undefined, undefined, undefined as never);
    return JSON.stringify(result.content);
  }

  it("the SDK tools hand the hooks the path they open, so the hooks alone refuse an outside path", async () => {
    await expect(bare("read", { path: "src/a.txt" })).resolves.toContain("inside needle");
    await expect(bare("read", { path: "link-file" })).rejects.toThrow(OUTSIDE_ROOTS_MESSAGE);
    await expect(bare("read", { path: join(outside, "secret.txt") })).rejects.toThrow(OUTSIDE_ROOTS_MESSAGE);
    await expect(bare("ls", { path: "link-dir" })).rejects.toThrow(OUTSIDE_ROOTS_MESSAGE);
    // The SDK's grep reports a refused search path as not found; no content comes back either way.
    await expect(bare("grep", { pattern: "needle", path: "link-dir" })).rejects.toThrow(/not found/i);
    await expect(bare("grep", { pattern: "needle", path: "link-file" })).rejects.toThrow(/not found/i);
  });

  it("refuses outside streams on first iteration without yielding a chunk", async () => {
    for (const path of [join(outside, "secret.txt"), join(workspace, "link-file")]) {
      const chunks: Uint8Array[] = [];
      const stream = confinedOperations(roots).read.createReadStream(path, {});
      const consume = async (): Promise<void> => { for await (const chunk of stream) chunks.push(chunk); };
      await expect(consume()).rejects.toThrow(new Error(OUTSIDE_ROOTS_MESSAGE));
      expect(chunks).toEqual([]);
    }
  });

  it("streams ranges with the same text as the guarded whole-file fallback", async () => {
    const operations = confinedOperations(roots);
    const readFile = vi.fn(operations.read.readFile);
    const params = { path: "mixed/own.txt", offset: 2, limit: 1 };
    const output = await bare("read", params, { ...operations, read: { ...operations.read, readFile } });
    const { createReadStream: _stream, ...fallback } = operations.read;
    const definition = createReadToolDefinition(workspace, { operations: fallback });
    const result = await definition.execute("call", params, undefined, undefined, undefined as never);
    expect(output).toEqual(JSON.stringify(result.content));
    expect(output).toContain("own needle");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("keeps images and non-streamable ranges on the guarded readFile hook", async () => {
    const image = join(workspace, "pixel.png");
    await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64"));
    for (const params of [{ path: image }, { path: "mixed/own.txt", limit: -1 }, { path: "mixed/own.txt", limit: 1.5 }]) {
      const operations = confinedOperations(roots);
      const readFile = vi.fn(operations.read.readFile);
      const createReadStream = vi.fn(operations.read.createReadStream);
      await bare("read", params, { ...operations, read: { ...operations.read, readFile, createReadStream } });
      expect(readFile).toHaveBeenCalledExactlyOnceWith(params.path === image ? image : join(workspace, params.path));
      expect(createReadStream).not.toHaveBeenCalled();
    }
  });

  it.each(["abort", "early return", "end"])("closes the real stream handle on %s", async (exit) => {
    const path = join(workspace, "mixed", "own.txt");
    const sample = await open(path, "r");
    const prototype = Object.getPrototypeOf(sample) as FileHandle;
    await sample.close();
    const original = prototype.createReadStream;
    const handles: FileHandle[] = [];
    const spy = vi.spyOn(prototype, "createReadStream").mockImplementation(function (this: FileHandle, options) {
      handles.push(this);
      return original.call(this, options);
    });
    try {
      const controller = new AbortController();
      const consume = async (): Promise<void> => {
        for await (const _chunk of confinedOperations(roots).read.createReadStream(path, { signal: controller.signal })) {
          if (exit === "early return") break;
          if (exit === "abort") controller.abort();
        }
      };
      if (exit === "abort") await expect(consume()).rejects.toMatchObject({ name: "AbortError" });
      else await consume();
      expect(handles).toHaveLength(1);
      expect(handles[0]!.fd).toBe(-1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("allowedReadRoots protected paths", () => {
  const skillAt = (directory: string): Skill => ({ name: "s", description: "d", filePath: join(directory, "SKILL.md"), baseDir: directory }) as unknown as Skill;
  let area: string;
  let home: string;
  let config: string;

  beforeAll(async () => {
    area = await temporaryRoot("confined-protected-");
    home = join(area, "home");
    config = join(home, ".config", "pi-session-mcp");
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await mkdir(join(home, "skills", "review"), { recursive: true });
    await mkdir(config, { recursive: true });
    await mkdir(join(area, "elsewhere", "cfg"), { recursive: true });
    for (const directory of [home, join(home, ".pi"), join(home, ".pi", "agent"), config, join(home, "skills", "review"), join(area, "elsewhere", "cfg")]) {
      await writeFile(join(directory, "SKILL.md"), "skill");
    }
  });

  const protectedPaths = (): string[] => [home, join(home, ".pi"), config];

  it.each([
    ["the home directory itself", () => home],
    ["a directory containing the home directory", () => area],
    ["the configuration directory", () => config],
    ["a directory containing the configuration directory", () => join(home, ".config")],
    ["the Pi agent directory's parent ~/.pi", () => join(home, ".pi")],
  ])("uses only the skill file as a root when the skill directory is %s", async (_name, directory) => {
    const skillDirectory = directory();
    await writeFile(join(skillDirectory, "SKILL.md"), "skill");
    const result = await allowedReadRoots(workspace, [skillAt(skillDirectory)], protectedPaths());
    expect(result).toEqual([workspace, join(skillDirectory, "SKILL.md")]);
    await expect(confineToolPath(join(skillDirectory, "SKILL.md"), workspace, result)).resolves.toBe(join(skillDirectory, "SKILL.md"));
    await expect(confineToolPath(join(skillDirectory, "other.txt"), workspace, result)).rejects.toThrow(OUTSIDE_ROOTS_MESSAGE);
  });

  it("never makes the provider store or anything containing it a root", async () => {
    const providers = join(config, "providers");
    await mkdir(join(providers, "nested"), { recursive: true });
    await writeFile(join(providers, "credentials.json"), "{}");
    await writeFile(join(providers, "SKILL.md"), "skill");
    await writeFile(join(providers, "nested", "SKILL.md"), "skill");
    const linked = join(area, "linked-skill"); await mkdir(linked, { recursive: true });
    await symlink(join(providers, "credentials.json"), join(linked, "SKILL.md"));
    for (const directory of [providers, join(providers, "nested"), config]) {
      // Without protected paths, as when the configuration lives elsewhere.
      const result = await allowedReadRoots(workspace, [skillAt(directory)], [], [providers]);
      expect(result).toEqual([workspace]);
      await expect(confineToolPath(join(providers, "credentials.json"), workspace, result)).rejects.toThrow(OUTSIDE_ROOTS_MESSAGE);
    }
    const result = await allowedReadRoots(workspace, [skillAt(linked)], protectedPaths(), [providers]);
    expect(result).toEqual([workspace, linked]);
    await expect(confineToolPath(join(linked, "SKILL.md"), workspace, result)).rejects.toThrow(OUTSIDE_ROOTS_MESSAGE);
  });

  it("refuses a workspace that is, contains or lies inside the provider store, also before it exists", async () => {
    const providers = join(config, "providers");
    await mkdir(join(providers, "inner"), { recursive: true });
    for (const candidate of [home, config, providers, join(providers, "inner")]) {
      await expect(allowedReadRoots(candidate, [], [], [providers])).rejects.toThrow(OUTSIDE_ROOTS_MESSAGE);
    }
    await expect(allowedReadRoots(home, [], [], [join(home, "absent", "providers")])).rejects.toThrow(OUTSIDE_ROOTS_MESSAGE);
    expect(await allowedReadRoots(workspace, [], [], [providers])).toEqual([workspace]);
  });

  it("keeps a skill directory below a protected path, and an unrelated one, as a root", async () => {
    for (const directory of [join(home, "skills", "review"), join(home, ".pi", "agent"), join(area, "elsewhere", "cfg")]) {
      expect(await allowedReadRoots(workspace, [skillAt(directory)], protectedPaths())).toEqual([workspace, directory]);
    }
  });

  it("does not expose the configuration file next to a skill named ./SKILL.md", async () => {
    await writeFile(join(config, "pi-session-mcp.json"), "{}");
    const result = await allowedReadRoots(workspace, [skillAt(config)], protectedPaths());
    await expect(confineToolPath(join(config, "pi-session-mcp.json"), workspace, result)).rejects.toThrow(OUTSIDE_ROOTS_MESSAGE);
  });

  it("treats a symlinked skill directory by its real path and ignores missing protected paths", async () => {
    const link = join(area, "home-link");
    await symlink(home, link);
    expect(await allowedReadRoots(workspace, [skillAt(link)], [...protectedPaths(), join(area, "does-not-exist")])).toEqual([workspace, join(home, "SKILL.md")]);
  });

  it("admits the real file of a symlinked skill file outside its directory", async () => {
    const catalog = join(area, "catalog", "review");
    await mkdir(catalog, { recursive: true });
    await symlink(join(home, "skills", "review", "SKILL.md"), join(catalog, "SKILL.md"));
    const result = await allowedReadRoots(workspace, [skillAt(catalog)], protectedPaths());
    expect(result).toEqual([workspace, catalog, join(home, "skills", "review", "SKILL.md")]);
    await expect(confineToolPath(join(catalog, "SKILL.md"), workspace, result)).resolves.toBe(join(home, "skills", "review", "SKILL.md"));
    await expect(confineToolPath(join(home, "skills", "review", "other.txt"), workspace, result)).rejects.toThrow(OUTSIDE_ROOTS_MESSAGE);
  });

  it("without protected paths every skill directory is a root", async () => {
    expect(await allowedReadRoots(workspace, [skillAt(home)])).toEqual([workspace, home]);
  });
});

describe("tool context and pattern arguments", () => {
  const withContext = async (name: string, params: Record<string, unknown>, cwd: string): Promise<string> => {
    const result = await tools[name]!.execute("call", params as never, undefined, undefined, { cwd } as never);
    return JSON.stringify(result.content);
  };

  it("resolves against the context cwd, as the SDK does, when it lies inside the roots", async () => {
    expect(await withContext("read", { path: "a.txt" }, join(workspace, "src"))).toContain("inside needle");
    expect(await withContext("ls", {}, join(workspace, "src"))).toContain("a.txt");
    expect(await withContext("grep", { pattern: "needle" }, join(workspace, "src"))).toContain("inside needle");
    expect(await withContext("find", { pattern: "*.txt" }, join(workspace, "src"))).toContain("a.txt");
  });

  it("refuses a context cwd that points outside the roots, for relative and default paths", async () => {
    const refused = new Error(OUTSIDE_ROOTS_MESSAGE);
    await expect(withContext("read", { path: "secret.txt" }, outside)).rejects.toThrow(refused);
    await expect(withContext("ls", {}, outside)).rejects.toThrow(refused);
    await expect(withContext("grep", { pattern: "needle" }, outside)).rejects.toThrow(refused);
    await expect(withContext("find", { pattern: "*" }, outside)).rejects.toThrow(refused);
    await expect(withContext("read", { path: "../../outside/secret.txt" }, join(workspace, "src"))).rejects.toThrow(refused);
  });

  it("grep globs with .. or absolute paths return nothing from outside", async () => {
    for (const glob of [`../outside/*.txt`, `../../outside/**`, `${outside}/**`, `${outside}/secret.txt`, "/**"]) {
      let output: string;
      try { output = await run("grep", { pattern: "needle", path: ".", glob }); } catch (error) { output = String(error); }
      expect(output, glob).not.toContain(SECRET);
    }
  });

  it("find patterns with .. or absolute paths return nothing from outside", async () => {
    for (const pattern of ["../outside/*", "../outside/secret.txt", `${outside}/*`, `${outside}/**`, "/etc/*", "../*"]) {
      let output: string;
      try { output = await run("find", { pattern, path: "." }); } catch (error) { output = String(error); }
      expect(output, pattern).not.toMatch(/secret\.txt|outside|passwd|hostname/);
    }
  });
});
