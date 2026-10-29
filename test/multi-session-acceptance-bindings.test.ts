import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, cpSync, ftruncateSync, openSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { h, skillHeaderDriver, FIXTURE_RUN_TIMEOUT, EXTENSION, put, buildRun, type Run, sources, rerecord, orchestration, variants, prepareRun } from "./multi-session-acceptance-fixtures.js";

// Removing the temporary roots can exceed the default 10 s hook timeout on slow macOS runners (#125).
afterAll(removeTemporaryRoots, 120_000);

// Safety net: a launch that a test expects to be refused must never reach a real client or a model. Stand-ins
// named `claude` and `codex` come first on PATH for the whole file; tests that need a working client put their own before them.
let pathBeforeGuard: string | undefined;
beforeAll(async () => {
  const guard = join(await temporaryRoot("msa-guard-"), "bin");
  mkdirSync(guard, { recursive: true });
  for (const name of ["claude", "codex"]) writeFileSync(join(guard, name), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  pathBeforeGuard = process.env.PATH;
  process.env.PATH = `${guard}:${pathBeforeGuard ?? ""}`;
});
afterAll(() => { if (pathBeforeGuard === undefined) delete process.env.PATH; else process.env.PATH = pathBeforeGuard; });

// ---- D3: bound resources and preserved findings --------------------------------------------------
describe("bound resources", FIXTURE_RUN_TIMEOUT, () => {
  it("records a digest for every resource the acceptance relies on", async () => {
    const run = await buildRun();
    expect(Object.keys(run.info.resources).sort()).toEqual([
      "candidateBuild", "claudeMcpConfiguration", "codexAncestorSkills", "codexControllerSkill", "codexHomeSkills", "controllerSkill", "etcCodexSkills",
      "extensionNpmInstallation", "fixtureBaselines", "handshakeSkill", "harness", "homeAgentsSkills",
      "operatorClaudeSkill", "operatorCodexSkill", "overrideDirectory", "runConfiguration", "workerSkillImplementation", "workerSkillReview",
    ]);
    // A Codex skill source that does not exist is a stable value, not a failure.
    expect(run.info.resources).toMatchObject({ codexHomeSkills: "missing", homeAgentsSkills: "missing", etcCodexSkills: "missing" });
    expect(run.info.resources.codexAncestorSkills).toMatch(/^[0-9a-f]{64}$/);
    // Without extensions the extension binding is one stable value, whatever sits in the agent directory.
    expect(run.info.resources.extensionNpmInstallation).toBe("none");
    expect(h.changedResources(run.info.resources, h.computeResources(run.run, run.candidate, run.context))).toEqual([]);
  });

  const cases: Array<[string, string[], (r: Awaited<ReturnType<typeof buildRun>>) => void]> = [
    ["the installed Claude Code controller skill", ["controllerSkill"], (r) => appendFileSync(join(r.run, "controller-claude", ".claude", "skills", "pi-session-orchestration", "SKILL.md"), "x")],
    ["an added file in the controller skill copy", ["controllerSkill"], (r) => writeFileSync(join(r.run, "controller-claude", ".claude", "skills", "pi-session-orchestration", "extra.md"), "x")],
    ["the candidate skill the Codex link points to", ["codexControllerSkill"], (r) => appendFileSync(join(r.candidate, "skills", "pi-session-orchestration", "SKILL.md"), "x")],
    ["the Codex link target", ["codexControllerSkill"], (r) => { const link = join(r.run, "controller-codex", ".agents", "skills", "pi-session-orchestration"); rmSync(link); symlinkSync(join(r.candidate, "skills", "pi-session-review"), link); }],
    ["the shipped implementation worker skill", ["workerSkillImplementation"], (r) => appendFileSync(join(r.candidate, "skills", "pi-session-implementation", "SKILL.md"), "x")],
    ["the shipped review worker skill", ["workerSkillReview"], (r) => appendFileSync(join(r.candidate, "skills", "pi-session-review", "SKILL.md"), "x")],
    ["the handshake skill", ["handshakeSkill", "overrideDirectory"], (r) => appendFileSync(join(r.priv, "skills", "acceptance-handshake", "SKILL.md"), "x")],
    ["another file in the override directory", ["overrideDirectory"], (r) => writeFileSync(join(r.priv, "skills", "other.md"), "x")],
    ["the run configuration", ["runConfiguration"], (r) => appendFileSync(join(r.priv, "config.json"), " ")],
    ["the Claude Code MCP configuration", ["claudeMcpConfiguration"], (r) => appendFileSync(join(r.priv, "claude-mcp.json"), " ")],
    ["a fixture baseline", ["fixtureBaselines"], (r) => appendFileSync(join(r.priv, "baselines", "claude", "slug.json"), " ")],
    ["the candidate build", ["candidateBuild"], (r) => appendFileSync(join(r.candidate, "dist", "other.js"), "// changed\n")],
    ["a skill added to $CODEX_HOME/skills", ["codexHomeSkills"], (r) => put(join(r.codexHome, "skills", "other", "SKILL.md"), "x")],
    ["a bundled .system skill of $CODEX_HOME", ["codexHomeSkills"], (r) => put(join(r.codexHome, "skills", ".system", "bundled", "SKILL.md"), "x")],
    ["a skill added to the home's .agents/skills", ["homeAgentsSkills"], (r) => put(join(r.home, ".agents", "skills", "other", "SKILL.md"), "x")],
    ["a skill added to /etc/codex/skills", ["etcCodexSkills"], (r) => put(join(r.etc, "other", "SKILL.md"), "x")],
    ["a skill added to .agents/skills of an ancestor of the controller directory", ["codexAncestorSkills"], (r) => put(join(r.root, ".agents", "skills", "other", "SKILL.md"), "x")],
    ["a skill added to .agents/skills of the run directory", ["codexAncestorSkills"], (r) => put(join(r.run, ".agents", "skills", "other", "SKILL.md"), "x")],
  ];
  it("binds the operator's own controller skill copies, which a client could load instead", async () => {
    const run = await buildRun();
    const home = join(run.root, "home");
    const personal = join(home, ".claude", "skills", "pi-session-orchestration");
    expect(h.operatorControllerSkills(home)).toEqual({ operatorClaudeSkill: "missing", operatorCodexSkill: "missing" });
    mkdirSync(personal, { recursive: true });
    writeFileSync(join(personal, "SKILL.md"), "operator copy\n");
    const recorded = h.computeResources(run.run, run.candidate, { ...run.context, home });
    appendFileSync(join(personal, "SKILL.md"), "edited\n");
    expect(h.changedResources(recorded, h.computeResources(run.run, run.candidate, { ...run.context, home }))).toEqual(["operatorClaudeSkill"]);
  });

  it("names every source that holds a differing controller skill, and also refuses a copy with an extra file", async () => {
    const run = await buildRun();
    cpSync(join(run.candidate, "skills", orchestration), join(run.etc, orchestration), { recursive: true });
    writeFileSync(join(run.etc, orchestration, "extra.md"), "x");
    put(join(run.codexHome, "skills", orchestration, "SKILL.md"), "other\n");
    expect(h.differingCodexControllerSkills(run.run, run.candidate, run.context)).toEqual(["codexHomeSkills", "etcCodexSkills"]);
  });

  it.each(variants)("finds %s", async (_label, name, place) => {
    const run = await buildRun();
    place(run);
    expect(h.differingCodexControllerSkills(run.run, run.candidate, run.context)).toEqual([name]);
  });

  const header = (...lines: string[]) => `---\n${lines.join("\n")}\n---\nbody\n`;
  it.each([
    ["a plain name", header("name: pi-session-orchestration"), { status: "named", name: "pi-session-orchestration" }],
    ["a plain name with a comment", header("name: pi-session-orchestration # the orchestrator"), { status: "named", name: "pi-session-orchestration" }],
    ["a double-quoted name with a comment", header('name: "pi-session-orchestration" # c'), { status: "named", name: "pi-session-orchestration" }],
    ["a single-quoted name with a comment", header("name: 'pi-session-orchestration' \t# c"), { status: "named", name: "pi-session-orchestration" }],
    ["a double-quoted name with an escape", header('name: "pi-session\\u002dorchestration"'), { status: "named", name: "pi-session-orchestration" }],
    ["a single-quoted name with a doubled quote", header("name: 'it''s'"), { status: "named", name: "it's" }],
    ["a hash that is part of a plain scalar", header("name: pi-session-orchestration#v2"), { status: "named", name: "pi-session-orchestration#v2" }],
    ["a hash inside quotes", header('name: "a # b"'), { status: "named", name: "a # b" }],
    ["a name among other keys", header("description: x", "name: other", "metadata:", "  name: pi-session-orchestration"), { status: "named", name: "other" }],
    ["no name key", header("description: x"), { status: "none" }],
    ["a uniformly indented mapping with the name", header("  description: x", "  name: pi-session-orchestration"), { status: "named", name: "pi-session-orchestration" }],
    ["a uniformly indented mapping with a quoted, commented name", header("    description: x", '    "name": "pi-session-orchestration" # c'), { status: "named", name: "pi-session-orchestration" }],
    ["a uniformly indented mapping without a name", header("  description: x", "  metadata:", "    name: pi-session-orchestration"), { status: "none" }],
    ["a column-zero mapping whose nested metadata holds a flow name", header("description: x", "metadata: { name: pi-session-orchestration }"), { status: "none" }],
    ["a column-zero mapping whose nested block holds the name", header("metadata:", "    name: pi-session-orchestration", "description: x"), { status: "none" }],
    ["an empty header", "---\n# only a comment\n---\nbody\n", { status: "none" }],
    ["a flow mapping header", header("{name: pi-session-orchestration, description: x}"), { status: "indeterminate" }],
    ["a flow sequence header", header("[pi-session-orchestration]"), { status: "indeterminate" }],
    ["a sequence header", header("- name: pi-session-orchestration"), { status: "indeterminate" }],
    ["a bare scalar header", header("pi-session-orchestration"), { status: "indeterminate" }],
    ["a dedent below the top-level indentation", header("  description: x", "name: pi-session-orchestration"), { status: "indeterminate" }],
    ["a tab as indentation", header("\tname: pi-session-orchestration"), { status: "indeterminate" }],
    ["a multi-line value under an indented mapping", header("  name: pi-session", "    -orchestration"), { status: "indeterminate" }],
    ["a nested name only", header("metadata:", "  name: pi-session-orchestration"), { status: "none" }],
    ["no frontmatter", "# pi-session-orchestration\n", { status: "none" }],
    ["an unterminated quote", header('name: "pi-session-orchestration'), { status: "indeterminate" }],
    ["text after the closing quote", header('name: "pi-session-orchestration" more'), { status: "indeterminate" }],
    ["a comment glued to the closing quote", header("name: 'x'# c"), { status: "indeterminate" }],
    ["a bad escape", header('name: "a\\qb"'), { status: "indeterminate" }],
    ["a block scalar", header("name: |", "  pi-session-orchestration"), { status: "indeterminate" }],
    ["a folded scalar", header("name: >-", "  pi-session-orchestration"), { status: "indeterminate" }],
    ["a multi-line plain scalar", header("name: pi-session", "  -orchestration"), { status: "indeterminate" }],
    ["an empty value", header("name:"), { status: "indeterminate" }],
    ["only a comment as value", header("name: # pi-session-orchestration"), { status: "indeterminate" }],
    ["a flow sequence", header("name: [pi-session-orchestration]"), { status: "indeterminate" }],
    ["an alias", header("name: *anchor"), { status: "indeterminate" }],
    ["a mapping indicator inside a plain scalar", header("name: a: b"), { status: "indeterminate" }],
    ["a duplicate key", header("name: a", "name: pi-session-orchestration"), { status: "indeterminate" }],
    ["frontmatter that never closes", "---\nname: pi-session-orchestration\n", { status: "indeterminate" }],
  ])("reads the name of %s as YAML does", (_label, text, expected) => {
    expect(h.skillNameFromHeader(text)).toEqual(expected);
  });

  const mkfifo = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); expect(spawnSync("mkfifo", [path]).status).toBe(0); };

  /** One discovery function in its own process under a 5 s watchdog: a blocking read fails here instead of hanging the worker. */
  const inChild = (mode: string, argument: string) => {
    const started = Date.now();
    const child = spawnSync(process.execPath, [skillHeaderDriver, mode, argument], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    expect(child.error?.message ?? "", `${mode} must finish within the watchdog (a blocking read of a FIFO would not)`).toBe("");
    expect(child.status, child.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    return JSON.parse(child.stdout);
  };

  it("reports a FIFO named SKILL.md as indeterminate without opening it, and refuses the source", async () => {
    const run = await buildRun();
    mkfifo(join(run.etc, "pipe", "SKILL.md"));
    expect(inChild("find", run.etc)).toEqual({ found: [], sentinel: "indeterminate" });
    expect(inChild("header", join(run.etc, "pipe", "SKILL.md"))).toEqual({ indeterminate: true });
    expect(inChild("differing", JSON.stringify({ run: run.run, candidate: run.candidate, context: run.context }))).toEqual(["etcCodexSkills"]);
  }, 30_000);

  it("reports a link named SKILL.md that leads to a FIFO, or nowhere, as indeterminate", async () => {
    const run = await buildRun();
    mkfifo(join(run.root, "elsewhere", "pipe"));
    mkdirSync(join(run.etc, "linked-pipe"), { recursive: true });
    symlinkSync(join(run.root, "elsewhere", "pipe"), join(run.etc, "linked-pipe", "SKILL.md"));
    expect(inChild("find", run.etc).sentinel).toBe("indeterminate");
    const dangling = await buildRun();
    mkdirSync(join(dangling.etc, "gone"), { recursive: true });
    symlinkSync(join(dangling.root, "no-such-file"), join(dangling.etc, "gone", "SKILL.md"));
    expect(inChild("find", dangling.etc).sentinel).toBe("indeterminate");
  }, 30_000);

  it("reads a SKILL.md through a link to a regular file, and only its first 16 KiB", async () => {
    const run = await buildRun();
    put(join(run.root, "real-skill-file"), `---\nname: ${orchestration}\n---\nbody\n`);
    mkdirSync(join(run.etc, "via-link"), { recursive: true });
    symlinkSync(join(run.root, "real-skill-file"), join(run.etc, "via-link", "SKILL.md"));
    expect(h.findControllerSkills(run.etc).found).toEqual([join(run.etc, "via-link")]);
    // A sparse file larger than readFileSync can load: only the header is read, so the declared name is found.
    const big = join(run.etc, "big-skill", "SKILL.md");
    put(big, `---\nname: ${orchestration}\ndescription: x\n---\n`);
    const fd = openSync(big, "r+");
    try { ftruncateSync(fd, 3 * 1024 ** 3); } finally { closeSync(fd); }
    const found = h.findControllerSkills(join(run.etc, "big-skill", ".."), { limit: 100 });
    expect(found.found).toContain(join(run.etc, "big-skill"));
    expect(h.readSkillHeader(big).text).toHaveLength(16_384);
  }, 20_000);

  it("allows an equal symlinked copy, an equal copy under another name and unrelated skills", async () => {
    const run = await buildRun();
    cpSync(join(run.candidate, "skills", orchestration), join(run.root, "equal-copy"), { recursive: true });
    mkdirSync(join(run.home, ".agents", "skills"), { recursive: true });
    symlinkSync(join(run.root, "equal-copy"), join(run.home, ".agents", "skills", orchestration));
    mkdirSync(join(run.codexHome, "skills", ".system"), { recursive: true });
    symlinkSync(join(run.candidate, "skills", orchestration), join(run.codexHome, "skills", ".system", orchestration));
    put(join(run.etc, "unrelated", "SKILL.md"), "---\nname: something-else\n---\n");
    expect(h.differingCodexControllerSkills(run.run, run.candidate, run.context)).toEqual([]);
  });

  it("searches a source with link cycles to the end, and fails closed when a source cannot be searched completely", async () => {
    const run = await buildRun();
    put(join(run.etc, "a", "SKILL.md"), "x\n");
    symlinkSync(run.etc, join(run.etc, "a", "loop"));
    expect(h.findControllerSkills(run.etc)).toEqual({ found: [], sentinel: undefined });
    expect(h.findControllerSkills(run.etc, { limit: 1 }).sentinel).toBe("tooLarge");
    expect(h.findControllerSkills(join(run.root, "no-such-source"))).toEqual({ found: [], sentinel: undefined });
  });

  it("allows an equal copy of the controller skill, and none, in every source", async () => {
    const run = await buildRun();
    expect(h.differingCodexControllerSkills(run.run, run.candidate, run.context)).toEqual([]);
    for (const [, , dir] of sources) cpSync(join(run.candidate, "skills", orchestration), join(dir(run), orchestration), { recursive: true });
    expect(h.differingCodexControllerSkills(run.run, run.candidate, run.context)).toEqual([]);
  });

  it("ignores skills other than the controller skill when deciding on a refusal", async () => {
    const run = await buildRun();
    for (const [, , dir] of sources) put(join(dir(run), "unrelated", "SKILL.md"), "x\n");
    expect(h.differingCodexControllerSkills(run.run, run.candidate, run.context)).toEqual([]);
  });

  it("resolves CODEX_HOME once from the environment, its home form or the default", async () => {
    const run = await buildRun();
    const link = join(run.root, "codex-link");
    mkdirSync(run.codexHome, { recursive: true });
    symlinkSync(run.codexHome, link);
    expect(h.resolveCodexHome({ CODEX_HOME: link }, run.home)).toBe(run.codexHome);
    expect(h.resolveCodexHome({ CODEX_HOME: "~/elsewhere" }, run.home)).toBe(join(run.home, "elsewhere"));
    expect(h.resolveCodexHome({}, run.home)).toBe(join(run.home, ".codex"));
  });

  it("reads only inside the test's temporary root: every skill source the harness computes lies there", async () => {
    const run = await buildRun({ extensions: true });
    const everything = Object.values(h.codexSkillSources(run.run, run.context)).flat() as string[];
    expect(everything).toHaveLength(5);
    for (const dir of [...everything, run.home, run.agentDir, run.codexHome, run.etc]) expect(h.inside(dir, run.root), dir).toBe(true);
    // the search stops at the boundary, which is the last ancestor listed; without one it runs up to the file system root
    expect(h.codexAncestorSkillDirs(join(run.run, "controller-codex"), run.root).at(-1)).toBe(join(run.root, ".agents", "skills"));
    expect(h.codexAncestorSkillDirs(join(run.run, "controller-codex")).at(-1)).toBe(join("/", ".agents", "skills"));
    expect(h.codexSkillSources(run.run, { ...run.context, ancestorBoundary: undefined }).codexAncestorSkills.some((dir: string) => !h.inside(dir, run.root))).toBe(true);
  });

  it("records per client the controller skill kind and its digest without paths", async () => {
    const run = await buildRun();
    const tree = h.boundTreeSha256(join(run.candidate, "skills", orchestration));
    expect(run.info.controllerSkills).toEqual({
      claude: { kind: "installed", treeSha256: h.boundTreeSha256(join(run.run, "controller-claude", ".claude", "skills", orchestration)) },
      codex: { kind: "linked", treeSha256: tree },
    });
    expect(JSON.stringify(run.info.controllerSkills)).not.toContain(run.root);
    // a link that points elsewhere is not recorded as the candidate's skill
    const link = join(run.run, "controller-codex", ".agents", "skills", orchestration);
    rmSync(link);
    symlinkSync(join(run.candidate, "skills", "pi-session-review"), link);
    expect(h.controllerSkillRecord(run.run, run.candidate).codex).toEqual({ kind: "linked", treeSha256: "wrongTarget" });
  });

  it.each(cases)("reports %s by name", async (_label, expected, mutate) => {
    const run = await buildRun();
    mutate(run);
    expect(h.changedResources(run.info.resources, h.computeResources(run.run, run.candidate, run.context))).toEqual(expected);
  });
});

// ---- #66: the loaded extension package contents -----------------------------------------------------
describe("extension package binding", FIXTURE_RUN_TIMEOUT, () => {
  const packageKey = `extension:${EXTENSION}`;
  const npm = (r: Run) => join(r.agentDir, "npm");
  const mutations: Array<[string, string[], (r: Run) => void]> = [
    ["a file of the extension package", [packageKey, "extensionNpmInstallation"], (r) => appendFileSync(join(npm(r), "node_modules", EXTENSION, "index.js"), "// changed\n")],
    ["a file added to the extension package", [packageKey, "extensionNpmInstallation"], (r) => writeFileSync(join(npm(r), "node_modules", EXTENSION, "extra.js"), "x")],
    ["a dependency file", ["extensionNpmInstallation"], (r) => appendFileSync(join(npm(r), "node_modules", "dep", "index.js"), "// changed\n")],
    ["the npm manifest", ["extensionNpmInstallation"], (r) => appendFileSync(join(npm(r), "package.json"), " ")],
    ["the npm lockfile", ["extensionNpmInstallation"], (r) => appendFileSync(join(npm(r), "package-lock.json"), " ")],
  ];

  it("binds each extension package and the npm installation under path-free keys", async () => {
    const run = await buildRun({ extensions: true });
    expect(Object.keys(run.info.resources).filter((name) => name.startsWith("extension")).sort()).toEqual([packageKey, "extensionNpmInstallation"]);
    expect(run.info.resources[packageKey]).toMatch(/^[0-9a-f]{64}$/);
    expect(run.info.resources.extensionNpmInstallation).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(run.info.resources)).not.toContain(run.agentDir);
  });

  it.each(mutations)("reports %s by name", async (_label, expected, mutate) => {
    const run = await buildRun({ extensions: true });
    mutate(run);
    expect(h.changedResources(run.info.resources, h.computeResources(run.run, run.candidate, run.context))).toEqual(expected);
  });

  it("binds the real package root when the package is a link, so a change behind the link is reported", async () => {
    const run = await buildRun({ extensions: true });
    const source = join(run.root, "extension-source");
    const installed = join(npm(run), "node_modules", EXTENSION);
    renameSync(installed, source);
    symlinkSync(source, installed);
    const recorded = h.computeResources(run.run, run.candidate, run.context);
    appendFileSync(join(source, "index.js"), "// changed behind the link\n");
    // the package root is bound by its real path, and the npm installation now binds the content behind the link too
    expect(h.changedResources(recorded, h.computeResources(run.run, run.candidate, run.context))).toEqual([packageKey, "extensionNpmInstallation"]);
  });

  it("reports an extension package that is gone as missing", async () => {
    const run = await buildRun({ extensions: true });
    rmSync(join(npm(run), "node_modules", EXTENSION), { recursive: true });
    const now = h.computeResources(run.run, run.candidate, run.context);
    expect(now[packageKey]).toBe("missing");
    expect(h.changedResources(run.info.resources, now)).toContain(packageKey);
  });

  it("resolves the agent directory once from the environment, its home form or the SDK default", async () => {
    const run = await buildRun({ extensions: true });
    const link = join(run.root, "agent-link");
    symlinkSync(run.agentDir, link);
    expect(h.resolveAgentDirectory({ PI_CODING_AGENT_DIR: link }, run.home)).toBe(run.agentDir);
    expect(h.resolveAgentDirectory({ PI_CODING_AGENT_DIR: "~/custom-agent" }, run.home)).toBe(join(run.home, "custom-agent"));
    expect(h.resolveAgentDirectory({}, run.home)).toBe(join(run.home, ".pi", "agent"));
    expect(h.resolveAgentDirectory({ PI_CODING_AGENT_DIR: "" }, run.home)).toBe(join(run.home, ".pi", "agent"));
  });
});

// ---- #66, #67: content behind links -------------------------------------------------------------------
describe("binding digest", FIXTURE_RUN_TIMEOUT, () => {
  const recompute = (r: Run) => h.computeResources(r.run, r.candidate, r.context);

  it("invalidates the run when a file changes behind a linked dependency outside the npm installation", async () => {
    const run = await buildRun({ extensions: true });
    const outside = join(run.root, "outside-dep");
    put(join(outside, "index.js"), "export const outside = 1;\n");
    symlinkSync(outside, join(run.agentDir, "npm", "node_modules", "linked-dep"));
    rerecord(run);
    expect(h.changedResources(run.info.resources, recompute(run))).toEqual([]);
    appendFileSync(join(outside, "index.js"), "// changed behind the link\n");
    expect(h.changedResources(run.info.resources, recompute(run))).toEqual(["extensionNpmInstallation"]);
  });

  it("invalidates the extension too when its own package links to content outside", async () => {
    const run = await buildRun({ extensions: true });
    const vendor = join(run.root, "vendor");
    put(join(vendor, "lib.js"), "export const lib = 1;\n");
    symlinkSync(vendor, join(run.agentDir, "npm", "node_modules", EXTENSION, "vendor"));
    rerecord(run);
    appendFileSync(join(vendor, "lib.js"), "// changed\n");
    expect(h.changedResources(run.info.resources, recompute(run))).toEqual([`extension:${EXTENSION}`, "extensionNpmInstallation"]);
  });

  it("invalidates the run when a file changes behind a linked skill in the home's .agents/skills", async () => {
    const run = await buildRun();
    const outside = join(run.root, "outside-skill");
    put(join(outside, "SKILL.md"), "---\nname: linked\n---\n");
    mkdirSync(join(run.home, ".agents", "skills"), { recursive: true });
    symlinkSync(outside, join(run.home, ".agents", "skills", "linked"));
    rerecord(run);
    appendFileSync(join(outside, "SKILL.md"), "changed\n");
    expect(h.changedResources(run.info.resources, recompute(run))).toEqual(["homeAgentsSkills"]);
  });

  // One fixture build per source, so no case approaches the default timeout on a slow runner (#70).
  it.each(sources)("binds a linked skill in %s (%s)", async (name, _label, dir) => {
    const run = await buildRun();
    const outside = join(run.root, "outside-skill");
    put(join(outside, "SKILL.md"), "x\n");
    mkdirSync(dir(run), { recursive: true });
    symlinkSync(outside, join(dir(run), "linked"));
    rerecord(run);
    appendFileSync(join(outside, "SKILL.md"), "changed\n");
    expect(h.changedResources(run.info.resources, recompute(run)), name).toEqual([name]);
  });

  it("notices a dangling link that starts to resolve", async () => {
    const run = await buildRun({ extensions: true });
    const later = join(run.root, "later-dep");
    symlinkSync(later, join(run.agentDir, "npm", "node_modules", "later"));
    rerecord(run);
    put(join(later, "index.js"), "x");
    expect(h.changedResources(run.info.resources, recompute(run))).toEqual(["extensionNpmInstallation"]);
  });

  it("terminates on link cycles, outside and inside the root, and is stable", async () => {
    const run = await buildRun({ extensions: true });
    const npm = join(run.agentDir, "npm");
    const outside = join(run.root, "outside-cycle");
    put(join(outside, "a.js"), "a");
    symlinkSync(outside, join(outside, "self"));
    symlinkSync(npm, join(outside, "back-to-root"));
    symlinkSync(outside, join(npm, "node_modules", "cycle"));
    symlinkSync(npm, join(npm, "node_modules", "dep", "up"));
    const first = h.boundTreeSha256(npm);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(h.boundTreeSha256(npm)).toBe(first);
    // content behind the cycle is still bound
    appendFileSync(join(outside, "a.js"), "b");
    expect(h.boundTreeSha256(npm)).not.toBe(first);
  });

  it("needs only the text of a link that resolves inside the root", async () => {
    const run = await buildRun({ extensions: true });
    const npm = join(run.agentDir, "npm");
    symlinkSync("dep", join(npm, "node_modules", "alias"));
    const withAlias = h.boundTreeSha256(npm);
    expect(h.boundTreeSha256(npm)).toBe(withAlias);
    // the target is hashed as part of the root, once
    appendFileSync(join(npm, "node_modules", "dep", "index.js"), "// c\n");
    expect(h.boundTreeSha256(npm)).not.toBe(withAlias);
    // retargeting the link inside the root is a change as well
    const before = h.boundTreeSha256(npm);
    rmSync(join(npm, "node_modules", "alias"));
    symlinkSync(join("..", "node_modules", EXTENSION), join(npm, "node_modules", "alias"));
    expect(h.boundTreeSha256(npm)).not.toBe(before);
  });

  it("ends with a sentinel, never with an exception, for missing, wrong, unreadable and oversized trees", async () => {
    const root = realpathSync(await temporaryRoot("msa-bound-"));
    expect(h.boundTreeSha256(join(root, "nothing"))).toBe("missing");
    put(join(root, "file"), "x");
    expect(h.boundTreeSha256(join(root, "file"))).toBe("notDirectory");
    for (const name of ["a", "b", "c"]) put(join(root, "big", name), name);
    expect(h.boundTreeSha256(join(root, "big"), { limit: 2 })).toBe("tooLarge");
    expect(h.boundTreeSha256(join(root, "big"), { limit: 3 })).toMatch(/^[0-9a-f]{64}$/);
    symlinkSync(join(root, "gone"), join(root, "dangling-top"));
    expect(h.boundTreeSha256(join(root, "dangling-top"))).toMatch(/^[0-9a-f]{64}$/);
    if (process.getuid?.() !== 0) {
      put(join(root, "locked", "inner", "f"), "x");
      chmodSync(join(root, "locked", "inner"), 0);
      try { expect(h.boundTreeSha256(join(root, "locked"))).toBe("unreadable"); } finally { chmodSync(join(root, "locked", "inner"), 0o700); }
    }
  });
});

// ---- #66, #67: a binding that is not complete binds nothing -----------------------------------------
describe("incomplete bindings", FIXTURE_RUN_TIMEOUT, () => {
  const notRoot = process.getuid?.() !== 0;
  const threeFiles = (dir: string) => { for (const name of ["a", "b", "c"]) put(join(dir, "skill", name), name); };

  it("treats only unreadable and tooLarge as incomplete, and keeps the determinate values legitimate", () => {
    expect(h.unboundResources({ a: "unreadable", b: "x", c: "missing" }, { a: "unreadable", b: "tooLarge", c: "none", d: "notDirectory", e: "0".repeat(64) })).toEqual(["a", "b"]);
    expect(h.unboundResources({ a: "missing", b: "none" }, { a: "missing", b: "none", c: "notDirectory", d: "unset" })).toEqual([]);
    expect(h.unboundResources(undefined, { a: "tooLarge" })).toEqual(["a"]);
  });

  // One fixture build per source (#70). The two extension keys are composed of the npm installation and its package;
  // every case checks them as well, because the run has an extension in each.
  const extensionKeys = ["extensionNpmInstallation", `extension:${EXTENSION}`];
  it.each(sources.slice(0, 4))("keeps an incomplete value visible in %s (%s), also in the composed keys", async (name, _label, dir) => {
    const run = await buildRun({ extensions: true });
    threeFiles(dir(run));
    const now = h.computeResources(run.run, run.candidate, { ...run.context, boundLimit: 1 });
    for (const key of [...extensionKeys, name]) expect(now[key], key).toBe("tooLarge");
    expect(h.unboundResources(run.info.resources, now)).toEqual([...extensionKeys, name].sort());
  });

  // The per-source cases above each build one run; the aggregate needs no build: all six keys incomplete at once.
  it("lists all four Codex sources and both extension keys when every one of them is incomplete", () => {
    const keys = ["codexHomeSkills", "homeAgentsSkills", "etcCodexSkills", "codexAncestorSkills", "extensionNpmInstallation", `extension:${EXTENSION}`];
    const digest = "0".repeat(64);
    const recorded = Object.fromEntries([...keys.map((key) => [key, digest]), ["controllerSkill", digest], ["runConfiguration", digest]]);
    const current = Object.fromEntries([...keys.map((key, index) => [key, index % 2 === 0 ? "tooLarge" : "unreadable"]), ["controllerSkill", digest], ["runConfiguration", digest]]);
    expect(h.unboundResources(recorded, current)).toEqual([...keys].sort());
    // a recorded value that is incomplete counts as well, whatever the current one says
    expect(h.unboundResources(Object.fromEntries(keys.map((key) => [key, "tooLarge"])), Object.fromEntries(keys.map((key) => [key, digest])))).toEqual([...keys].sort());
  });

  it.skipIf(!notRoot)("keeps an unreadable controller skill visible in the Codex link key", async () => {
    const run = await buildRun();
    const skill = join(run.candidate, "skills", "pi-session-orchestration");
    put(join(skill, "inner", "f"), "x");
    chmodSync(join(skill, "inner"), 0);
    try {
      const now = h.computeResources(run.run, run.candidate, run.context);
      expect(now.codexControllerSkill).toBe("unreadable");
      expect(h.unboundResources(run.info.resources, now)).toEqual(expect.arrayContaining(["codexControllerSkill"]));
    } finally { chmodSync(join(skill, "inner"), 0o700); }
  });

  it("an incomplete value stays equal while the content under it changes, and still cannot pass", async () => {
    const run = await buildRun();
    threeFiles(join(run.home, ".agents", "skills"));
    rerecord(run, { boundLimit: 1 });
    expect(run.info.resources.homeAgentsSkills).toBe("tooLarge");
    appendFileSync(join(run.home, ".agents", "skills", "skill", "a"), "changed under an incomplete binding\n");
    const now = h.computeResources(run.run, run.candidate, { ...run.context, boundLimit: 1 });
    expect(h.changedResources(run.info.resources, now)).toEqual([]);
    expect(h.unboundResources(run.info.resources, now)).toEqual(["homeAgentsSkills"]);
  });

  const passing = () => ({
    client: "claude", exitCode: 0, timedOut: false, spawnFailed: false, harnessAborted: false, resources: { changedAfterRun: [] }, unboundResources: [] as string[],
    processes: { serversObserved: 1, residualByRole: {} },
    transcript: { capabilitiesFirst: true, candidateConfirmed: true, acceptCodeSkills: ["implementation"], acceptCodeHandshakeSkills: ["implementation", "handshake"],
      structuralLeaks: 0, tokenInControllerPrompts: false, tokenInControllerTask: false, controllerTranscriptHasToken: false, privateMarkersInWorkerPrompts: false, controllerTouchedPrivate: false,
      sessionsStarted: 2, sessions: [{ workspace: "cc-slug", profile: "accept-code-handshake", closed: true, turns: ["completed"] }, { workspace: "cc-stats", profile: "accept-code", closed: true, turns: ["completed"] }], firstTurnsOverlap: true, followUpCompleted: true },
    oracle: { slug: { onlyAllowedChanges: true, changesWrittenDuringWorkerTurns: true, testsPass: true, businessChecks: true, addedTest: true, handshake: true, handshakeWrittenDuringFollowUp: true },
      stats: { onlyAllowedChanges: true, changesWrittenDuringWorkerTurns: true, testsPass: true, businessChecks: true } },
  });

  it("adds resourcesUnbound to the verdict for an unbound resource, or for a result that does not say", () => {
    expect(h.evaluateAcceptance(passing(), "parallel")).toEqual({ passed: true, failures: [] });
    expect(h.evaluateAcceptance({ ...passing(), unboundResources: ["homeAgentsSkills"] }, "parallel")).toEqual({ passed: false, failures: ["resourcesUnbound"] });
    const silent: Record<string, unknown> = passing();
    delete silent.unboundResources;
    expect(h.evaluateAcceptance(silent, "parallel").failures).toEqual(["resourcesUnbound"]);
  });

  async function prepareFails(context: Record<string, unknown>, place: (run: Run) => void): Promise<string> {
    const run = await buildRun();
    place(run);
    try { await prepareRun(run, { withExtensions: false, env: {}, context }); } catch (error) { return (error as Error).message; }
    return "";
  }

  it("refuses to prepare a run whose bound source is too large to bind, naming the key", async () => {
    const message = await prepareFails({ boundLimit: 1 }, (run) => threeFiles(join(run.home, ".agents", "skills")));
    expect(message).toContain('"homeAgentsSkills"');
    expect(message).toContain("cannot be read completely");
  }, 60_000);

  it.skipIf(!notRoot)("refuses to prepare a run whose bound source is unreadable, naming the key", async () => {
    let locked = "";
    try {
      const message = await prepareFails({}, (run) => { locked = join(run.home, ".agents", "skills", "locked"); put(join(locked, "f"), "x"); chmodSync(locked, 0); });
      expect(message).toContain('"homeAgentsSkills"');
    } finally { if (locked) chmodSync(locked, 0o700); }
  }, 60_000);
});

// ---- #66: prepare passes the bound agent directory to the server of both clients ---------------------
describe("prepare binds the agent directory", FIXTURE_RUN_TIMEOUT, () => {
  it("gives both clients' servers the resolved PI_CODING_AGENT_DIR and binds the extension contents", async () => {
    const run = await buildRun({ extensions: true });
    const link = join(run.root, "agent-link");
    symlinkSync(run.agentDir, link);
    // Codex skill sources with content, so that a prepare which read other directories would record other digests.
    put(join(run.etc, "present", "SKILL.md"), "x\n");
    put(join(run.root, ".agents", "skills", "present", "SKILL.md"), "x\n");
    // The environment names a link; the prepared run records and passes the real directory.
    const prepared = await prepareRun(run, { withExtensions: true, env: { PI_CODING_AGENT_DIR: link, CODEX_HOME: join(run.root, "prepared-codex-home") } });
    expect(prepared.info.agentDir).toBe(run.agentDir);
    // CODEX_HOME is resolved once and recorded privately; the bound Codex skill sources use it
    expect(prepared.info.codexHome).toBe(join(run.root, "prepared-codex-home"));
    // prepare reads the injected system skills and stops the ancestor search at the injected boundary
    expect(prepared.info.resources.etcCodexSkills).toBe(h.boundTreeSha256(run.etc));
    expect(prepared.info.resources.etcCodexSkills).toMatch(/^[0-9a-f]{64}$/);
    for (const dir of Object.values(h.codexSkillSources(prepared.runDir, { ...run.context, codexHome: prepared.info.codexHome })).flat() as string[]) expect(h.inside(dir, run.root), dir).toBe(true);
    const claudeServer = JSON.parse(readFileSync(join(prepared.priv, "claude-mcp.json"), "utf8")).mcpServers["pi-candidate"];
    expect(claudeServer.env).toEqual({ PI_SESSION_MCP_CONFIG: join(prepared.priv, "config.json"), PI_CODING_AGENT_DIR: run.agentDir });
    const codexArgs: string[] = h.command("codex", prepared.info, prepared.priv, join(prepared.runDir, "controller-codex"), { scenario: "parallel" }).args;
    expect(codexArgs).toContain(`mcp_servers.pi-candidate.env={PI_SESSION_MCP_CONFIG=${JSON.stringify(join(prepared.priv, "config.json"))},PI_CODING_AGENT_DIR=${JSON.stringify(run.agentDir)}}`);
    // setup's Doctor looks at the same directory
    expect(prepared.setupEnv.PI_CODING_AGENT_DIR).toBe(run.agentDir);
    expect(prepared.info.extensions).toEqual([{ name: EXTENSION, version: "1.0.0" }]);
    expect(Object.keys(prepared.info.resources).filter((name) => name.startsWith("extension")).sort()).toEqual([`extension:${EXTENSION}`, "extensionNpmInstallation"]);
    expect(h.changedResources(prepared.info.resources, h.computeResources(prepared.runDir, prepared.info.candidate, { home: run.home, etcCodexSkills: run.etc, ancestorBoundary: run.root, agentDir: prepared.info.agentDir, codexHome: prepared.info.codexHome, extensions: prepared.info.extensions }))).toEqual([]);
    // the recorded directory is private: the evidence names neither it nor the run
    const out = join(run.root, "evidence.json");
    h.evidence({ run: prepared.runDir, out });
    const text = readFileSync(out, "utf8");
    for (const secret of [run.agentDir, prepared.info.codexHome, run.root, prepared.info.token]) expect(text).not.toContain(secret);
    expect(JSON.parse(text).resources.extensionNpmInstallation).toBe(prepared.info.resources.extensionNpmInstallation);
    // per client: the kind of controller skill and its digest
    const shipped = h.boundTreeSha256(join(run.candidate, "skills", orchestration));
    expect(JSON.parse(text).controllerSkills).toEqual({ claude: { kind: "installed", treeSha256: shipped }, codex: { kind: "linked", treeSha256: shipped } });
  }, 60_000);

  it("passes the default agent directory to both clients without extensions and binds nothing of it", async () => {
    const run = await buildRun();
    const prepared = await prepareRun(run, { withExtensions: false, env: {} });
    const expected = join(run.home, ".pi", "agent");
    expect(prepared.info.agentDir).toBe(expected);
    expect(prepared.info.codexHome).toBe(join(run.home, ".codex"));
    expect(JSON.parse(readFileSync(join(prepared.priv, "claude-mcp.json"), "utf8")).mcpServers["pi-candidate"].env.PI_CODING_AGENT_DIR).toBe(expected);
    const codexArgs: string[] = h.command("codex", prepared.info, prepared.priv, join(prepared.runDir, "controller-codex"), { scenario: "parallel" }).args;
    expect(codexArgs.find((arg) => arg.startsWith("mcp_servers.pi-candidate.env="))).toContain(`PI_CODING_AGENT_DIR=${JSON.stringify(expected)}`);
    expect(prepared.info.resources.extensionNpmInstallation).toBe("none");
    expect(Object.keys(prepared.info.resources).filter((name) => name.startsWith("extension:"))).toEqual([]);
    // two coding profiles: the handshake skill is offered only on the second
    const profiles = JSON.parse(readFileSync(join(prepared.priv, "config.json"), "utf8")).executionProfiles;
    expect(Object.keys(profiles).sort()).toEqual(["accept-code", "accept-code-handshake", "accept-read"]);
    expect(profiles["accept-code"]).toMatchObject({ permissionProfile: "coding", default: false, skills: ["implementation"] });
    expect(profiles["accept-code-handshake"]).toMatchObject({ permissionProfile: "coding", default: false, skills: ["implementation", "handshake"] });
    expect(profiles["accept-read"]).toMatchObject({ default: true, skills: ["review"] });
    const { skills: _a, permissionProfile: _b, default: _c, ...codeProfile } = profiles["accept-code"];
    const { skills: _d, permissionProfile: _e, default: _f, ...handshakeProfile } = profiles["accept-code-handshake"];
    expect(handshakeProfile).toEqual(codeProfile);
    expect(prepared.setupEnv.PI_CODING_AGENT_DIR).toBeNull();
  }, 60_000);
});
