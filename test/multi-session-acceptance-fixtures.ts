import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryRoot } from "./temporary-roots.js";

// The maintainer script is plain ESM without declarations; the tests use its exports untyped on purpose.
export const scriptUrl = new URL("../scripts/multi-session-acceptance.mjs", import.meta.url);
export const scriptPath = fileURLToPath(scriptUrl);
export const h: Record<string, any> = await import(/* @vite-ignore */ scriptUrl.href);
export const fixtureDir = fileURLToPath(new URL("./fixtures/multi-session-acceptance/", import.meta.url));
export const driverPath = join(fixtureDir, "supervise-driver.mjs");
export const stubbornClient = join(fixtureDir, "stubborn-client.mjs");
export const cliDriver = join(fixtureDir, "cli-driver.mjs");
export const setupStub = join(fixtureDir, "setup-stub.mjs");
export const skillHeaderDriver = join(fixtureDir, "skill-header-driver.mjs");
// The harness reads /proc and refuses to run elsewhere, so its supervision and run paths are tested on Linux only.
export const notLinux = process.platform !== "linux";

export interface Recorded { pid: number; start: string }
export const readState = (path: string): { leader: Recorded; children: Recorded[] } => JSON.parse(readFileSync(path, "utf8"));
export const recordedProcesses = (path: string): Recorded[] => { const state = readState(path); return [state.leader, ...state.children]; };
export const stillAlive = (list: Recorded[]): Recorded[] => list.filter((p) => h.alive(p));
export const killAll = (list: Recorded[]): void => { for (const p of stillAlive(list)) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } } };

/**
 * Suites that build a fixture run (`buildRun`) create several Git repositories per test. On macOS CI
 * runners that exceeded Vitest's 5 s default, so these suites get a larger budget.
 */
export const FIXTURE_RUN_TIMEOUT = { timeout: 30_000 };

/** Spawns a Node child and resolves with its exit code, or null when it had to be killed after `limitMs`. */
export function runNode(args: string[], options: { env?: NodeJS.ProcessEnv; limitMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; wallMs: number }> {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), options.limitMs);
    child.on("close", (code) => { clearTimeout(watchdog); done({ code, stdout, stderr, wallMs: Date.now() - started }); });
  });
}

// ---- D2: changes against a fixed fixture baseline ------------------------------------------------
export const SLUG_OK = "export function slugify(text) {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\");\n}\n";
export const STATS_OK = "export function mean(values) {\n  if (values.length === 0) throw new RangeError(\"empty\");\n  return values.reduce((sum, value) => sum + value, 0) / values.length;\n}\nexport function median(values) {\n  if (values.length === 0) throw new RangeError(\"empty\");\n  const sorted = [...values].sort((a, b) => a - b);\n  const mid = sorted.length >> 1;\n  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;\n}\n";
export const RANGE_OK = "export function range(start, end, step = 1) {\n  if (step <= 0) throw new RangeError(\"step\");\n  const out = [];\n  for (let value = start; value < end; value += step) out.push(value);\n  return out;\n}\n";

export async function fixtureWithBaseline(task: string) {
  const dir = join(await temporaryRoot(`msa-fixture-${task}-`), "fixture");
  mkdirSync(dir, { recursive: true });
  h.writeFixture(dir, h.FIXTURES[task]);
  return { dir, baseline: h.captureBaseline(dir) };
}
export const compare = (dir: string, baseline: unknown, task: string) => h.compareToBaseline(dir, baseline, h.ALLOWED_CHANGES[task]);
export const commitAll = (dir: string, message: string) => { h.git(dir, "add", "-A"); h.git(dir, "commit", "-q", "-m", message); };

// ---- synthetic run layout ------------------------------------------------------------------------
export const EXTENSION = "pi-test-ext";
export const put = (path: string, content: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
/**
 * A synthetic prepared run. `home` and `agentDir` live inside the temporary root, so no test reads the operator's
 * home or Pi directory; `context` is what the harness needs to recompute the bound resources.
 */
export async function buildRun({ extensions = false }: { extensions?: boolean } = {}) {
  const root = realpathSync(await temporaryRoot("msa-run-"));
  const home = join(root, "home");
  const agentDir = join(root, "pi-agent");
  const codexHome = join(root, "codex-home");
  const etc = join(root, "etc-codex-skills");
  mkdirSync(home, { recursive: true });
  const candidate = join(root, "candidate");
  const run = join(root, "run");
  const priv = join(run, "private");
  put(join(candidate, "package.json"), "{ \"version\": \"0.0.0-test\" }\n");
  put(join(candidate, "dist", "main.js"), "// stub entry\n");
  put(join(candidate, "dist", "other.js"), "// stub module\n");
  for (const name of ["pi-session-orchestration", "pi-session-implementation", "pi-session-review"]) put(join(candidate, "skills", name, "SKILL.md"), `# ${name}\n`);
  if (extensions) {
    put(join(agentDir, "npm", "package.json"), `{ "dependencies": { "${EXTENSION}": "1.0.0" } }\n`);
    put(join(agentDir, "npm", "package-lock.json"), "{ \"lockfileVersion\": 3 }\n");
    put(join(agentDir, "npm", "node_modules", EXTENSION, "package.json"), `{ "name": "${EXTENSION}", "version": "1.0.0", "pi": { "extensions": ["index.js"] } }\n`);
    put(join(agentDir, "npm", "node_modules", EXTENSION, "index.js"), "export default () => {};\n");
    put(join(agentDir, "npm", "node_modules", "dep", "index.js"), "export const dep = 1;\n");
  }
  put(join(priv, "config.json"), "{ \"workspaces\": {} }\n");
  put(join(priv, "claude-mcp.json"), "{ \"mcpServers\": {} }\n");
  put(join(priv, "skills", "acceptance-handshake", "SKILL.md"), "# handshake\n");
  for (const dir of ["transcripts", "results", "reanalyses"]) mkdirSync(join(priv, dir), { recursive: true });
  for (const client of ["claude", "codex"]) {
    for (const task of Object.keys(h.FIXTURES)) {
      const dir = join(run, `controller-${client}`, "fixtures", task);
      mkdirSync(dir, { recursive: true });
      h.writeFixture(dir, h.FIXTURES[task]);
      mkdirSync(join(priv, "baselines", client), { recursive: true });
      writeFileSync(join(priv, "baselines", client, `${task}.json`), `${JSON.stringify(h.captureBaseline(dir), null, 2)}\n`);
    }
  }
  put(join(run, "controller-claude", ".claude", "skills", "pi-session-orchestration", "SKILL.md"), "# pi-session-orchestration\n");
  mkdirSync(join(run, "controller-codex", ".agents", "skills"), { recursive: true });
  symlinkSync(join(candidate, "skills", "pi-session-orchestration"), join(run, "controller-codex", ".agents", "skills", "pi-session-orchestration"));
  const token = "ACCEPTANCE-TOKEN-0123456789";
  const extensionList = extensions ? [{ name: EXTENSION, version: "1.0.0" }] : [];
  const context = { home, agentDir, codexHome, etcCodexSkills: etc, ancestorBoundary: root, extensions: extensionList };
  const info = {
    runId: "skills-test", candidate, entry: join(candidate, "dist", "main.js"), node: process.execPath, token, version: "0.0.0-test",
    sourceClean: true, entrySha256: "x", distSha256: h.distTreeSha256(candidate), harnessSha256: h.HARNESS_SHA256, configFingerprint: "sha256:test",
    claudeSkillSetup: { exitCode: 0, codes: [], installedAsCopy: true, matchesShipped: true },
    profile: { from: "p", provider: "synthetic", model: "m", thinkingLevel: "off" }, extensions: extensionList, agentDir, codexHome, preparedAt: new Date().toISOString(),
    controllerSkills: h.controllerSkillRecord(run, candidate),
    resources: h.computeResources(run, candidate, context),
  };
  writeFileSync(join(priv, "run.json"), `${JSON.stringify(info, null, 2)}\n`);
  return {
    root, candidate, run, priv, info, home, agentDir, codexHome, etc, context,
    controller: (client: string) => join(run, `controller-${client}`),
    baselineOf: (client: string) => (task: string) => JSON.parse(readFileSync(join(priv, "baselines", client, `${task}.json`), "utf8")),
  };
}

// ---- #67: every Codex skill source ----------------------------------------------------------------
export type Run = Awaited<ReturnType<typeof buildRun>>;
export const sources: Array<[string, string, (r: Run) => string]> = [
  ["codexHomeSkills", "$CODEX_HOME/skills", (r) => join(r.codexHome, "skills")],
  ["homeAgentsSkills", "the home's .agents/skills", (r) => join(r.home, ".agents", "skills")],
  ["etcCodexSkills", "/etc/codex/skills", (r) => r.etc],
  ["codexAncestorSkills", ".agents/skills of an ancestor of the controller directory", (r) => join(r.root, ".agents", "skills")],
  ["codexAncestorSkills", ".agents/skills of the run directory", (r) => join(r.run, ".agents", "skills")],
];
/** The prepared state includes whatever the test placed before this call, as if it had been there at prepare. */
export const rerecord = (r: Run, extra: Record<string, unknown> = {}) => {
  r.info.resources = h.computeResources(r.run, r.candidate, { ...r.context, ...extra });
  writeFileSync(join(r.priv, "run.json"), `${JSON.stringify(r.info, null, 2)}\n`);
};
export const orchestration = "pi-session-orchestration";
export const codexValues = (r: Run) => ({ run: r.run, client: "codex", scenario: "parallel" });

// Controller skills that are not a direct child of the source, or that are only declared by their name.
export const variants: Array<[string, string, (r: Run) => void]> = [
  ["a differing copy under the hidden .system directory of $CODEX_HOME", "codexHomeSkills", (r) => put(join(r.codexHome, "skills", ".system", orchestration, "SKILL.md"), "an older copy\n")],
  ["a differing copy nested below another skill", "homeAgentsSkills", (r) => put(join(r.home, ".agents", "skills", "bundle", "nested", orchestration, "SKILL.md"), "an older copy\n")],
  ["a differently named directory declaring the name", "etcCodexSkills", (r) => put(join(r.etc, "renamed", "SKILL.md"), `---\nname: ${orchestration}\ndescription: x\n---\nolder\n`)],
  ["a differently named directory declaring the quoted name", "codexAncestorSkills", (r) => put(join(r.root, ".agents", "skills", "renamed", "SKILL.md"), `---\nname: "${orchestration}"\n---\nolder\n`)],
  ["a plain name followed by a comment", "etcCodexSkills", (r) => put(join(r.etc, "commented", "SKILL.md"), `---\nname: ${orchestration} # the orchestrator\n---\nolder\n`)],
  ["a quoted name followed by a comment", "homeAgentsSkills", (r) => put(join(r.home, ".agents", "skills", "commented", "SKILL.md"), `---\nname: '${orchestration}'   # the orchestrator\n---\nolder\n`)],
  ["a name that cannot be determined (unterminated quote)", "codexHomeSkills", (r) => put(join(r.codexHome, "skills", "odd", "SKILL.md"), `---\nname: "${orchestration}\n---\nx\n`)],
  ["a name that cannot be determined (block scalar)", "codexAncestorSkills", (r) => put(join(r.root, ".agents", "skills", "odd", "SKILL.md"), `---\nname: >-\n  ${orchestration}\n---\nx\n`)],
  ["a uniformly indented header", "etcCodexSkills", (r) => put(join(r.etc, "indented", "SKILL.md"), `---\n  name: ${orchestration}\n  description: x\n---\nolder\n`)],
  ["a flow-mapping header", "homeAgentsSkills", (r) => put(join(r.home, ".agents", "skills", "flow", "SKILL.md"), `---\n{name: ${orchestration}, description: x}\n---\nolder\n`)],
  ["a sequence header", "codexHomeSkills", (r) => put(join(r.codexHome, "skills", "seq", "SKILL.md"), `---\n- ${orchestration}\n---\nolder\n`)],
  ["a symlinked copy that differs", "homeAgentsSkills", (r) => { put(join(r.root, "other-copy", "SKILL.md"), "other\n"); mkdirSync(join(r.home, ".agents", "skills"), { recursive: true }); symlinkSync(join(r.root, "other-copy"), join(r.home, ".agents", "skills", orchestration)); }],
  ["a differently named symlink to a copy that declares the name and differs", "codexHomeSkills", (r) => { put(join(r.root, "declared-copy", "SKILL.md"), `---\nname: ${orchestration}\n---\nolder\n`); mkdirSync(join(r.codexHome, "skills"), { recursive: true }); symlinkSync(join(r.root, "declared-copy"), join(r.codexHome, "skills", "alias")); }],
];

/** Runs the real `prepare` against a synthetic candidate with a stand-in setup and a fake `claude`; nothing leaves the temporary root. */
export async function prepareRun(run: Run, { withExtensions, env, context = {} }: { withExtensions: boolean; env: Record<string, string>; context?: Record<string, unknown> }) {
  copyFileSync(setupStub, join(run.candidate, "dist", "setup-main.js"));
  const bin = join(run.root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const baseConfig = join(run.root, "base.json");
  writeFileSync(baseConfig, JSON.stringify({ executionProfiles: { source: { provider: "p", model: "m", thinkingLevel: "off", permissionProfile: "read-only", default: true, ...(withExtensions ? { extensions: [`npm:${EXTENSION}@1.0.0`] } : {}) } } }));
  const savedPath = process.env.PATH; const write = process.stdout.write.bind(process.stdout);
  let printed = "";
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  process.stdout.write = ((chunk: string) => { printed += chunk; return true; }) as typeof process.stdout.write;
  try {
    h.prepare({ candidate: run.candidate, "base-config": baseConfig, "from-profile": "source", "work-dir": join(run.root, "work"), ...(withExtensions ? { "with-extensions": true } : {}) },
      { env, home: run.home, temporaryDirs: [], etcCodexSkills: run.etc, ancestorBoundary: run.root, ...context });
  } finally { process.stdout.write = write; if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; }
  const runDir = printed.trim();
  const priv = join(runDir, "private");
  const info = JSON.parse(readFileSync(join(priv, "run.json"), "utf8"));
  return { runDir, priv, info, setupEnv: JSON.parse(readFileSync(join(runDir, "setup-env.json"), "utf8")) };
}
