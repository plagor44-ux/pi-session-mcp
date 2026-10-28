import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Skill, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  await writeFile(join(workspace, "mixed", "own.txt"), "own needle\n");
  await symlink(join(outside, "secret.txt"), join(workspace, "mixed", "escape.txt"));
  const skill = { name: "review", description: "d", filePath: join(skillDir, "SKILL.md"), baseDir: skillDir } as unknown as Skill;
  roots = await allowedReadRoots(workspace, [skill]);
  tools = Object.fromEntries(createConfinedReadOnlyTools(workspace, roots).map((tool) => [tool.name, tool]));
});

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
    expect(output).not.toContain(SECRET);
    const listing = await run("grep", { pattern: "needle", path: "mixed" });
    expect(listing).toContain("own needle");
    expect(listing).not.toContain(SECRET);
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
      await expect(ops.read.detectImageMimeType!(path)).rejects.toThrow(refused);
      await expect(ops.grep.isDirectory(path)).rejects.toThrow(refused);
      await expect(ops.grep.readFile(path)).rejects.toThrow(refused);
      await expect(ops.ls.exists(path)).rejects.toThrow(refused);
      await expect(ops.ls.stat(path)).rejects.toThrow(refused);
      await expect(ops.ls.readdir(path)).rejects.toThrow(refused);
    }
  });
});
