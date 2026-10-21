import { fork, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import type { SetupResult } from "../src/setup-result.js";
import { SKILL_BASES_FILE } from "../src/skill-customize.js";
import { SKILL_BASES_LOCK_FILE } from "../src/override-lock.js";
import { readSkillTree } from "../src/skill-library.js";
import { compileServerEntry } from "./compiled-entry.js";
import { waitForBlockedWaiter } from "./lock-wait.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

/**
 * The bases file is a read-modify-write record shared by separate `pi-session-mcp-setup`
 * processes. These tests run real child processes against a compiled build and force the overlap
 * with IPC signals from inside the critical section: no sleep orders anything.
 */

const HARNESS = fileURLToPath(new URL("./fixtures/customize-child.mjs", import.meta.url));
const STEP_TIMEOUT_MS = 20_000;
const linux = process.platform === "linux";

afterAll(removeTemporaryRoots);

interface ChildSpec {
  readonly name: string;
  readonly configPath: string;
  readonly packageRoot: string;
  readonly afterLock?: "pause" | "hang" | "fail";
  readonly beforeBasesRename?: "pause" | "hang" | "fail";
  readonly patchRename?: "pause" | "hang" | "fail";
  readonly lockTimeoutMs?: number;
}

type ChildMessage = { readonly type: "at"; readonly point: string } | { readonly type: "result"; readonly result: SetupResult };

/** One `customizeSkill` run in its own process. */
class CustomizeChild {
  private readonly process: ChildProcess;
  private readonly messages: ChildMessage[] = [];
  private readonly listeners: (() => void)[] = [];
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;

  constructor(module: string, spec: ChildSpec) {
    const { name, configPath, packageRoot, ...rest } = spec;
    this.process = fork(HARNESS, [JSON.stringify({ module, request: { name, configPath, packageRoot, apply: true }, ...rest })], { execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] });
    this.process.on("message", (message) => { this.messages.push(message as ChildMessage); this.listeners.splice(0).forEach((listener) => listener()); });
    this.exited = new Promise((resolve) => this.process.once("exit", (code, signal) => { resolve({ code, signal }); this.listeners.splice(0).forEach((listener) => listener()); }));
  }

  private async next<T extends ChildMessage>(match: (message: ChildMessage) => message is T): Promise<T> {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (true) {
      const found = this.messages.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("child step timed out");
      await new Promise<void>((resolve) => { this.listeners.push(resolve); setTimeout(resolve, 200); });
    }
  }

  async reached(point: string): Promise<void> { await this.next((message): message is Extract<ChildMessage, { type: "at" }> => message.type === "at" && message.point === point); }
  resume(): void { this.process.send({ type: "continue" }); }
  async result(): Promise<SetupResult> { return (await this.next((message): message is Extract<ChildMessage, { type: "result" }> => message.type === "result")).result; }
  kill(signal: NodeJS.Signals): void { this.process.kill(signal); }
}

async function fixture() {
  const root = await temporaryRoot("pi-skill-concurrency-");
  const packageRoot = join(root, "package");
  for (const name of ["alpha", "beta"]) {
    await mkdir(join(packageRoot, "skills", name, "refs"), { recursive: true });
    await writeFile(join(packageRoot, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Shipped ${name}.\n---\n`);
    await writeFile(join(packageRoot, "skills", name, "refs", "a.md"), `reference ${name}`);
  }
  const configDirectory = join(root, "config");
  await mkdir(configDirectory);
  const configPath = join(configDirectory, "config.json");
  await writeFile(configPath, "{}");
  const override = join(configDirectory, "skills");
  const bases = async () => JSON.parse(await readFile(join(override, SKILL_BASES_FILE), "utf8")) as { schemaVersion: number; bases: Record<string, string> };
  const spec = (name: string, rest: Partial<ChildSpec> = {}): ChildSpec => ({ name, configPath, packageRoot, ...rest });
  return { root, packageRoot, configPath, override, bases, spec };
}

const code = (result: SetupResult): string => result.findings[0]!.code;

describe.skipIf(!linux)("skill customization across processes", () => {
  let module: string;
  beforeAll(async () => { module = join(dirname(await compileServerEntry()), "skill-customize.js"); }, 180_000);

  const run = (spec: ChildSpec) => new CustomizeChild(module, spec);

  /**
   * Run A (alpha) stops inside its critical section after the bases content is written and before
   * it replaces the file; run B (beta) then starts. With the lock, B queues behind A.
   */
  async function overlap(fx: Awaited<ReturnType<typeof fixture>>, mode: "hook" | "rename", entry: string = module) {
    const hold = mode === "hook" ? { beforeBasesRename: "pause" as const } : { patchRename: "pause" as const };
    const first = new CustomizeChild(entry, fx.spec("alpha", hold));
    await first.reached("beforeBasesRename");
    const second = new CustomizeChild(entry, fx.spec("beta"));
    return { first, second };
  }

  for (const mode of ["hook", "rename"] as const) {
    it(`keeps both bases when two processes customize different skills at the same time (${mode} seam)`, async () => {
      const fx = await fixture();
      const { first, second } = await overlap(fx, mode);
      await waitForBlockedWaiter(join(fx.override, SKILL_BASES_LOCK_FILE));
      first.resume();
      const [one, two] = [await first.result(), await second.result()];
      expect(one).toMatchObject({ status: "ok", exitCode: 0 });
      expect(two).toMatchObject({ status: "ok", exitCode: 0 });
      expect([code(one), code(two)]).toEqual(["skill_customized", "skill_customized"]);
      const recorded = await fx.bases();
      expect(recorded.schemaVersion).toBe(2);
      expect(Object.keys(recorded.bases)).toEqual(["alpha", "beta"]);
      for (const name of ["alpha", "beta"]) {
        expect((await readSkillTree(join(fx.override, name))).fingerprint).toBe((await readSkillTree(join(fx.packageRoot, "skills", name))).fingerprint);
        expect(recorded.bases[name]).toBe((await readSkillTree(join(fx.packageRoot, "skills", name))).fingerprint);
      }
      expect((await readdir(fx.override)).sort()).toEqual([SKILL_BASES_FILE, SKILL_BASES_LOCK_FILE, "alpha", "beta"]);
    });
  }

  it("reports the doctor warnings for both skills once their shipped originals change", async () => {
    const fx = await fixture();
    const { first, second } = await overlap(fx, "hook");
    await waitForBlockedWaiter(join(fx.override, SKILL_BASES_LOCK_FILE));
    first.resume();
    await first.result();
    await second.result();
    const config = async () => ({
      workspaces: new Map(), workspaceModes: new Map(), executionProfiles: new Map(), defaultExecutionProfile: "none",
      configuration: { fingerprint: `sha256:${"0".repeat(64)}` as `sha256:${string}`, reloadPolicy: "restart-required" as const },
      eventDelivery: "off" as const,
      skillOverrideDirectory: fx.override,
    });
    const outdated = async () => (await runDoctor({ packageRoot: fx.packageRoot, loadConfig: config })).checks.filter((check) => check.id === "skill_override_outdated");
    expect(await outdated()).toEqual([
      { id: "skill_override_outdated", severity: "ok", subject: "skill:alpha" },
      { id: "skill_override_outdated", severity: "ok", subject: "skill:beta" },
    ]);
    for (const name of ["alpha", "beta"]) await writeFile(join(fx.packageRoot, "skills", name, "SKILL.md"), `changed ${name}`);
    expect(await outdated()).toEqual(["alpha", "beta"].map((name) => ({
      id: "skill_override_outdated", severity: "warning", subject: `skill:${name}`,
      remediation: `review the changed shipped skill, then run pi-session-mcp-setup --apply --customize-skill ${name}`,
    })));
  });

  it("makes concurrent runs for the same skill idempotent", async () => {
    const fx = await fixture();
    const first = run(fx.spec("alpha", { beforeBasesRename: "pause" }));
    await first.reached("beforeBasesRename");
    const second = run(fx.spec("alpha"));
    await waitForBlockedWaiter(join(fx.override, SKILL_BASES_LOCK_FILE));
    first.resume();
    const outcomes = [await first.result(), await second.result()];
    expect(outcomes.map(code)).toEqual(["skill_customized", "skill_override_current"]);
    expect(outcomes.map((outcome) => outcome.findings[0]!.status)).toEqual(["ok", "unchanged"]);
    expect(Object.keys((await fx.bases()).bases)).toEqual(["alpha"]);
    expect((await readdir(fx.override)).sort()).toEqual([SKILL_BASES_FILE, SKILL_BASES_LOCK_FILE, "alpha"]);
    expect((await readSkillTree(join(fx.override, "alpha"))).fingerprint).toBe((await readSkillTree(join(fx.packageRoot, "skills", "alpha"))).fingerprint);
  });

  it("releases the lock when the holder is killed inside the critical section", async () => {
    const fx = await fixture();
    const holder = run(fx.spec("alpha", { beforeBasesRename: "pause" }));
    await holder.reached("beforeBasesRename");
    holder.kill("SIGKILL");
    expect(await holder.exited).toMatchObject({ signal: "SIGKILL" });
    // The killed run left a copy without a base; the next run completes that customization.
    const next = await run(fx.spec("alpha", { lockTimeoutMs: 10_000 })).result();
    expect(next).toMatchObject({ status: "ok", exitCode: 0 });
    expect(code(next)).toBe("skill_customized");
    expect(Object.keys((await fx.bases()).bases)).toEqual(["alpha"]);
    const other = await run(fx.spec("beta", { lockTimeoutMs: 10_000 })).result();
    expect(code(other)).toBe("skill_customized");
    expect(Object.keys((await fx.bases()).bases)).toEqual(["alpha", "beta"]);
  });

  it("fails with skill_customize_lock_busy when the holder hangs", async () => {
    const fx = await fixture();
    const holder = run(fx.spec("alpha", { afterLock: "hang" }));
    await holder.reached("afterLock");
    const started = Date.now();
    const blocked = await run(fx.spec("beta", { lockTimeoutMs: 300 })).result();
    expect(blocked).toMatchObject({ status: "failed", exitCode: 1 });
    expect(code(blocked)).toBe("skill_customize_lock_busy");
    expect(Date.now() - started).toBeLessThan(10_000);
    // Nothing of the blocked run exists, and the hanging holder has not written either.
    expect((await readdir(fx.override)).sort()).toEqual([SKILL_BASES_LOCK_FILE]);
    holder.kill("SIGKILL");
    await holder.exited;
  });

  const baseBuild = process.env.PI_SESSION_MCP_BASE_BUILD;
  /**
   * Red-before evidence: PI_SESSION_MCP_BASE_BUILD names the compiled output directory of the
   * unmodified base commit. The same scenario then loses the base of the run that finished first.
   */
  it.skipIf(baseBuild === undefined)("loses a base on the unmodified implementation (red-before evidence)", async () => {
    const fx = await fixture();
    const entry = join(baseBuild!, "skill-customize.js");
    const { first, second } = await overlap(fx, "rename", entry);
    // The base has no lock: the second run completes while the first is stopped before its rename.
    expect(code(await second.result())).toBe("skill_customized");
    first.resume();
    expect(code(await first.result())).toBe("skill_customized");
    expect(Object.keys((await fx.bases()).bases)).toEqual(["alpha"]);
    expect((await readSkillTree(join(fx.override, "beta"))).files.length).toBeGreaterThan(0);
  });
});
