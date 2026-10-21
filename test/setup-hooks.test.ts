import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import {
  buildWakeEntry, FileSetupHookInstaller, installWakeHook, runWakeHook, WAKE_BUDGET_MS, WAKE_HOOK_ALIAS, wakeEntryFingerprint, wakeSettingsPath,
  type HookScope, type WakeHookDependencies, type WakeHookRoots,
} from "../src/setup-hooks.js";
import { DurableOwnershipStore, isRecord, MemoryOwnershipStore, type OwnershipRecord } from "../src/setup-ownership.js";
import { SetupOrchestrator, type SetupClientAdapter } from "../src/setup.js";
import type { SetupOperation, SetupTarget } from "../src/setup-result.js";
import { currentSetupPlatform } from "../src/setup-platform.js";

afterAll(removeTemporaryRoots);

/** Every record the installer persists must pass the durable store's own validation. */
class CheckedStore extends MemoryOwnershipStore {
  override async put(record: OwnershipRecord): Promise<void> { expect(isRecord(record)).toBe(true); await super.put(record); }
}

async function fixture() {
  const root = await temporaryRoot("pi-setup-hooks-");
  const home = join(root, "home"); const cwd = join(root, "project"); const packageRoot = join(root, "pkg");
  await mkdir(home); await mkdir(cwd); await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "dist", "wake-main.js"), "// wake\n");
  const ownership = new CheckedStore();
  const roots: WakeHookRoots = { packageRoot, home, cwd, env: {}, nodePath: "/usr/bin/node" };
  const settings = (scope: HookScope): string => join(scope === "user" ? join(home, ".claude") : join(cwd, ".claude"), scope === "local" ? "settings.local.json" : "settings.json");
  const run = (operation: SetupOperation, options: { scope?: HookScope; enabled?: boolean; roots?: Partial<WakeHookRoots>; dependencies?: WakeHookDependencies } = {}) =>
    runWakeHook({ operation, scope: options.scope ?? "user", roots: { ...roots, ...options.roots }, enabled: options.enabled ?? true, ownership, ...(options.dependencies ? { dependencies: options.dependencies } : {}) });
  const entry = buildWakeEntry(roots);
  const seed = async (scope: HookScope, value: unknown, mode = 0o644): Promise<string> => {
    const path = settings(scope); await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { mode }); await chmod(path, mode); return path;
  };
  const format = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  const userTarget: SetupTarget = { client: "claude-code", scope: "user", alias: WAKE_HOOK_ALIAS };
  return { root, home, cwd, packageRoot, ownership, roots, settings, run, entry, seed, format, userTarget };
}
const foreign = { matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] };
const otherPackage = (entry: { hooks: readonly [{ command: string }] }) => ({ ...entry, hooks: [{ ...entry.hooks[0], command: "/usr/bin/node /opt/else/dist/wake-main.js --budget-ms 1800000" }] });

describe("wake hook entry and settings locations", () => {
  it("builds the canonical entry with a timeout that covers the budget", async () => {
    const f = await fixture();
    expect(f.entry).toEqual({
      matcher: "mcp__pi-session-mcp__pi_session_prompt|mcp__pi-session-mcp__pi_turn_get|mcp__pi-coding-.*__pi_session_prompt|mcp__pi-coding-.*__pi_turn_get",
      hooks: [{ type: "command", command: `/usr/bin/node ${f.packageRoot}/dist/wake-main.js --budget-ms ${WAKE_BUDGET_MS}`, timeout: Math.ceil(WAKE_BUDGET_MS / 1000) + 60, asyncRewake: true }],
    });
    expect(buildWakeEntry({ ...f.roots, budgetMs: 90_500 }).hooks[0]).toMatchObject({ command: expect.stringContaining("--budget-ms 90500"), timeout: 151 });
    expect(wakeEntryFingerprint(f.entry)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("derives the settings file per scope and honours CLAUDE_CONFIG_DIR for the user scope only", () => {
    expect(wakeSettingsPath("user", { home: "/h", env: {} })).toBe("/h/.claude/settings.json");
    expect(wakeSettingsPath("user", { home: "/h", env: { CLAUDE_CONFIG_DIR: "/c" } })).toBe("/c/settings.json");
    expect(wakeSettingsPath("user", { home: "/h", env: { CLAUDE_CONFIG_DIR: "" } })).toBe("/h/.claude/settings.json");
    expect(wakeSettingsPath("project", { home: "/h", env: { CLAUDE_CONFIG_DIR: "/c" }, projectRoot: "/p" })).toBe("/p/.claude/settings.json");
    expect(wakeSettingsPath("local", { home: "/h", env: {}, projectRoot: "/p" })).toBe("/p/.claude/settings.local.json");
    expect(() => wakeSettingsPath("user", { home: "/h", env: { CLAUDE_CONFIG_DIR: "relative" } })).toThrow();
  });
  it("writes each scope into its own file, using CLAUDE_CONFIG_DIR and the canonical project directory", async () => {
    const f = await fixture();
    const config = join(f.root, "config");
    expect(await f.run("apply", { roots: { env: { CLAUDE_CONFIG_DIR: config } } })).toEqual({ status: "ok", code: "hook_added" });
    expect(JSON.parse(await readFile(join(config, "settings.json"), "utf8"))).toEqual({ hooks: { PostToolUse: [f.entry] } });
    await expect(stat(join(f.home, ".claude"))).rejects.toThrow();
    for (const scope of ["project", "local"] as const) {
      expect(await f.run("apply", { scope })).toEqual({ status: "ok", code: "hook_added" });
      expect(JSON.parse(await readFile(f.settings(scope), "utf8"))).toEqual({ hooks: { PostToolUse: [f.entry] } });
    }
  });
  it("rejects a relative CLAUDE_CONFIG_DIR and paths that would need shell quoting", async () => {
    const f = await fixture();
    expect(await f.run("apply", { roots: { env: { CLAUDE_CONFIG_DIR: "relative" } } })).toEqual({ status: "failed", code: "settings_location_invalid" });
    for (const roots of [{ nodePath: "/opt/my node/bin/node" }, { packageRoot: "/opt/pkg $HOME" }, { packageRoot: "/opt/pkg'x" }, { nodePath: "node" }]) {
      expect(await f.run("apply", { roots })).toEqual({ status: "failed", code: "hook_path_unsafe" });
      expect(await f.run("dry-run", { roots })).toEqual({ status: "failed", code: "hook_path_unsafe" });
    }
    await expect(stat(join(f.home, ".claude"))).rejects.toThrow();
  });
});

describe("wake hook install", () => {
  it("creates an absent file and directory with mode 0600 and records ownership", async () => {
    const f = await fixture();
    expect(await f.run("dry-run")).toEqual({ status: "planned", code: "hook_add_planned" });
    await expect(stat(join(f.home, ".claude"))).rejects.toThrow();
    expect(await f.run("apply")).toEqual({ status: "ok", code: "hook_added" });
    const file = f.settings("user");
    expect(await readFile(file, "utf8")).toBe(f.format({ hooks: { PostToolUse: [f.entry] } }));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.home, ".claude"))).mode & 0o777).toBe(0o700);
    expect((await readdir(join(f.home, ".claude")))).toEqual(["settings.json"]);
    expect(await f.ownership.get(f.userTarget)).toMatchObject({ fingerprint: wakeEntryFingerprint(f.entry), previous: "absent", phase: "owned" });
  });
  it("preserves other content byte for byte except the insertion and keeps the file mode", async () => {
    const f = await fixture();
    const original = { model: "opus", permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [foreign], PostToolUse: [foreign] }, env: { A: "1" } };
    const file = await f.seed("user", original, 0o640);
    expect(await f.run("apply")).toEqual({ status: "ok", code: "hook_added" });
    expect(await readFile(file, "utf8")).toBe(f.format({ ...original, hooks: { PreToolUse: [foreign], PostToolUse: [foreign, f.entry] } }));
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });
  it("adds a missing hooks object after the existing keys", async () => {
    const f = await fixture();
    const file = await f.seed("project", { model: "opus" });
    await f.run("apply", { scope: "project" });
    expect(await readFile(file, "utf8")).toBe(f.format({ model: "opus", hooks: { PostToolUse: [f.entry] } }));
  });
  it("leaves the file untouched on a second apply", async () => {
    const f = await fixture();
    await f.run("apply");
    const file = f.settings("user"); const before = await stat(file); const bytes = await readFile(file, "utf8");
    expect(await f.run("apply")).toEqual({ status: "unchanged", code: "hook_already_equivalent" });
    expect(await f.run("dry-run")).toEqual({ status: "unchanged", code: "hook_already_equivalent" });
    expect(await readFile(file, "utf8")).toBe(bytes);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });
  it("never writes on a dry-run", async () => {
    const f = await fixture();
    const file = await f.seed("user", { hooks: { PostToolUse: [foreign] } });
    const before = await stat(file); const bytes = await readFile(file, "utf8");
    expect(await f.run("dry-run")).toEqual({ status: "planned", code: "hook_add_planned" });
    expect(await readFile(file, "utf8")).toBe(bytes);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(await f.ownership.get(f.userTarget)).toBeUndefined();
    expect((await readdir(join(f.home, ".claude")))).toEqual(["settings.json"]);
  });
  it("does not replace an unowned pi-session-mcp entry that differs", async () => {
    const f = await fixture();
    const original = { hooks: { PostToolUse: [otherPackage(f.entry)] } };
    const file = await f.seed("user", original);
    expect(await f.run("apply")).toEqual({ status: "divergent", code: "hook_divergent" });
    expect(await f.run("dry-run")).toEqual({ status: "divergent", code: "hook_divergent" });
    expect(await readFile(file, "utf8")).toBe(f.format(original));
    expect(await f.ownership.get(f.userTarget)).toBeUndefined();
  });
  it("treats an unowned identical entry as equivalent but not owned, and refuses duplicates", async () => {
    const f = await fixture();
    await f.seed("user", { hooks: { PostToolUse: [f.entry] } });
    expect(await f.run("apply")).toEqual({ status: "unchanged", code: "hook_already_equivalent" });
    expect(await f.ownership.get(f.userTarget)).toBeUndefined();
    expect(await f.run("verify")).toEqual({ status: "failed", code: "hook_not_owned" });
    expect(await f.run("remove")).toEqual({ status: "unchanged", code: "hook_not_owned" });
    await f.seed("user", { hooks: { PostToolUse: [f.entry, f.entry] } });
    expect(await f.run("apply")).toEqual({ status: "divergent", code: "hook_divergent" });
  });
  it("updates an entry it wrote itself after the package moved, in place", async () => {
    const f = await fixture();
    await f.seed("user", { hooks: { PostToolUse: [foreign] } });
    await f.run("apply");
    const moved = join(f.root, "pkg2"); await mkdir(join(moved, "dist"), { recursive: true });
    const next = buildWakeEntry({ ...f.roots, packageRoot: moved });
    await f.seed("user", { hooks: { PostToolUse: [f.entry, foreign] } });
    expect(await f.run("dry-run", { roots: { packageRoot: moved } })).toEqual({ status: "planned", code: "hook_update_planned" });
    expect(await f.run("apply", { roots: { packageRoot: moved } })).toEqual({ status: "ok", code: "hook_updated" });
    expect(await readFile(f.settings("user"), "utf8")).toBe(f.format({ hooks: { PostToolUse: [next, foreign] } }));
    expect(await f.ownership.get(f.userTarget)).toMatchObject({ fingerprint: wakeEntryFingerprint(next), phase: "owned" });
    expect((await f.ownership.get(f.userTarget))).not.toHaveProperty("replaces");
  });
  it("does not replace an owned entry the operator edited since", async () => {
    const f = await fixture();
    await f.run("apply");
    const edited = { ...f.entry, hooks: [{ ...f.entry.hooks[0], timeout: 5 }] };
    const file = await f.seed("user", { hooks: { PostToolUse: [edited] } });
    expect(await f.run("apply")).toEqual({ status: "divergent", code: "hook_divergent" });
    expect(await f.run("remove")).toEqual({ status: "divergent", code: "hook_divergent" });
    expect(await readFile(file, "utf8")).toBe(f.format({ hooks: { PostToolUse: [edited] } }));
    expect(await f.ownership.get(f.userTarget)).toBeDefined();
  });
  it("fails closed without writing on an unparseable or misshapen file", async () => {
    const f = await fixture();
    for (const content of ["{not json", "[]", "null", "", '"text"']) {
      const file = await f.seed("user", content);
      expect(await f.run("apply")).toEqual({ status: "failed", code: "settings_unparseable" });
      expect(await f.run("dry-run")).toEqual({ status: "failed", code: "settings_unparseable" });
      expect(await readFile(file, "utf8")).toBe(content);
    }
    for (const value of [{ hooks: [] }, { hooks: { PostToolUse: {} } }, { hooks: null }]) {
      const file = await f.seed("user", value);
      expect(await f.run("apply")).toEqual({ status: "failed", code: "settings_shape_invalid" });
      expect(await readFile(file, "utf8")).toBe(f.format(value));
    }
    expect(await f.ownership.get(f.userTarget)).toBeUndefined();
    expect((await readdir(join(f.home, ".claude")))).toEqual(["settings.json"]);
  });
  it("ignores PostToolUse entries of other shapes when looking for its own", async () => {
    const f = await fixture();
    const odd = [null, 3, "x", { hooks: "wake-main" }, { hooks: [null, { command: 7 }] }, { hooks: [{ command: "node /x/dist/wake-main.json" }] }];
    await f.seed("user", { hooks: { PostToolUse: odd } });
    expect(await f.run("apply")).toEqual({ status: "ok", code: "hook_added" });
    expect(JSON.parse(await readFile(f.settings("user"), "utf8")).hooks.PostToolUse).toEqual([...odd, f.entry]);
  });
});

describe("wake hook compare and swap", () => {
  it("retries once when the file changes between read and rename and keeps the other writer's content", async () => {
    const f = await fixture();
    const file = await f.seed("user", { model: "opus" });
    let calls = 0;
    const dependencies: WakeHookDependencies = { beforeCommit: async () => { calls += 1; if (calls === 1) await writeFile(file, f.format({ model: "opus", injected: true })); } };
    expect(await f.run("apply", { dependencies })).toEqual({ status: "ok", code: "hook_added" });
    expect(calls).toBe(2);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ model: "opus", injected: true, hooks: { PostToolUse: [f.entry] } });
    expect((await readdir(join(f.home, ".claude")))).toEqual(["settings.json"]);
  });
  it("re-evaluates on retry: a foreign pi-session-mcp entry that appears makes the result divergent", async () => {
    const f = await fixture();
    const file = await f.seed("user", {});
    let calls = 0;
    const injected = { hooks: { PostToolUse: [otherPackage(f.entry)] } };
    const dependencies: WakeHookDependencies = { beforeCommit: async () => { calls += 1; if (calls === 1) await writeFile(file, f.format(injected)); } };
    expect(await f.run("apply", { dependencies })).toEqual({ status: "divergent", code: "hook_divergent" });
    expect(await readFile(file, "utf8")).toBe(f.format(injected));
    // The pending record of the first attempt was settled away by the second read.
    expect(await f.ownership.get(f.userTarget)).toBeUndefined();
  });
  it("fails with settings_changed when the file changes again, leaves no temporary file and settles the pending record next run", async () => {
    const f = await fixture();
    const file = await f.seed("user", { model: "opus" });
    let calls = 0;
    const dependencies: WakeHookDependencies = { beforeCommit: async () => { calls += 1; await writeFile(file, f.format({ model: "opus", n: calls })); } };
    expect(await f.run("apply", { dependencies })).toEqual({ status: "failed", code: "settings_changed" });
    expect(calls).toBe(2);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ model: "opus", n: 2 });
    expect((await readdir(join(f.home, ".claude")))).toEqual(["settings.json"]);
    expect((await f.ownership.get(f.userTarget))?.phase).toBe("pending");
    expect(await f.run("apply")).toEqual({ status: "ok", code: "hook_added" });
    expect((await f.ownership.get(f.userTarget))?.phase).toBe("owned");
  });
  it("never replaces a file that appears while creating one", async () => {
    const f = await fixture();
    const file = f.settings("user");
    let calls = 0;
    const dependencies: WakeHookDependencies = { beforeCommit: async () => { calls += 1; if (calls === 1) await writeFile(file, f.format({ model: "late" })); } };
    expect(await f.run("apply", { dependencies })).toEqual({ status: "ok", code: "hook_added" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ model: "late", hooks: { PostToolUse: [f.entry] } });
  });
});

describe("wake hook location guard at commit", () => {
  it("writes nothing when .claude becomes a link between read and commit", async () => {
    const f = await fixture();
    await f.seed("project", { model: "opus" });
    const real = join(f.cwd, ".claude-moved");
    const dependencies: WakeHookDependencies = { beforeCommit: async () => { await rename(join(f.cwd, ".claude"), real); await symlink(real, join(f.cwd, ".claude")); } };
    expect(await f.run("apply", { scope: "project", dependencies })).toEqual({ status: "failed", code: "settings_location_invalid" });
    expect(await readFile(join(real, "settings.json"), "utf8")).toBe(f.format({ model: "opus" }));
    expect(await readdir(real)).toEqual(["settings.json"]);
  });
  it("writes nothing when .claude is replaced by another directory", async () => {
    const f = await fixture();
    await f.seed("local", { model: "opus" });
    const dependencies: WakeHookDependencies = { beforeCommit: async () => { await rename(join(f.cwd, ".claude"), join(f.cwd, ".claude-old")); await mkdir(join(f.cwd, ".claude")); } };
    expect(await f.run("apply", { scope: "local", dependencies })).toEqual({ status: "failed", code: "settings_changed" });
    expect(await readdir(join(f.cwd, ".claude"))).toEqual([]);
    expect(await readFile(join(f.cwd, ".claude-old", "settings.local.json"), "utf8")).toBe(f.format({ model: "opus" }));
  });
  it("writes nothing when a project settings file becomes a link to an identical copy", async () => {
    const f = await fixture();
    const file = await f.seed("local", { model: "opus" });
    const copy = join(f.root, "copy.json"); await writeFile(copy, f.format({ model: "opus" }));
    const dependencies: WakeHookDependencies = { beforeCommit: async () => { await rm(file); await symlink(copy, file); } };
    expect(await f.run("apply", { scope: "local", dependencies })).toEqual({ status: "failed", code: "settings_location_invalid" });
    expect(await readFile(copy, "utf8")).toBe(f.format({ model: "opus" }));
  });
  it("rejects a .claude that became a link during a retried attempt", async () => {
    const f = await fixture();
    await f.seed("project", { model: "opus" });
    const elsewhere = join(f.root, "elsewhere"); await mkdir(elsewhere);
    // The first attempt loses a compare-and-swap; the link appears during the retry.
    let calls = 0;
    const dependencies: WakeHookDependencies = { beforeCommit: async () => {
      calls += 1;
      if (calls === 1) { await writeFile(f.settings("project"), f.format({ model: "other" })); }
      if (calls === 2) { await rm(join(f.cwd, ".claude"), { recursive: true }); await symlink(elsewhere, join(f.cwd, ".claude")); }
    } };
    expect(await f.run("apply", { scope: "project", dependencies })).toEqual({ status: "failed", code: "settings_location_invalid" });
    expect(await readdir(elsewhere)).toEqual([]);
  });
  it("keeps following the operator's own linked user directory and detects its replacement", async () => {
    const f = await fixture();
    const dotfiles = join(f.root, "dotfiles"); await mkdir(dotfiles);
    await symlink(dotfiles, join(f.home, ".claude"));
    expect(await f.run("apply")).toEqual({ status: "ok", code: "hook_added" });
    expect(JSON.parse(await readFile(join(dotfiles, "settings.json"), "utf8")).hooks.PostToolUse).toEqual([f.entry]);
    const other = join(f.root, "other-dotfiles"); await mkdir(other);
    const dependencies: WakeHookDependencies = { beforeCommit: async () => { await rm(join(f.home, ".claude")); await symlink(other, join(f.home, ".claude")); } };
    expect(await f.run("remove", { dependencies })).toEqual({ status: "failed", code: "settings_changed" });
    expect(await readdir(other)).toEqual([]);
  });
});

describe("wake hook ownership recovery", () => {
  it("drops a pending record whose write never happened and installs on the next run", async () => {
    const f = await fixture();
    const crash: WakeHookDependencies = { checkpoint: (step) => { if (step === "pending-recorded") throw new Error("crash"); } };
    expect(await f.run("apply", { dependencies: crash })).toEqual({ status: "failed", code: "hook_install_failed" });
    expect((await f.ownership.get(f.userTarget))?.phase).toBe("pending");
    await expect(stat(f.settings("user"))).rejects.toThrow();
    expect(await f.run("dry-run")).toEqual({ status: "planned", code: "hook_add_planned" });
    expect((await f.ownership.get(f.userTarget))?.phase).toBe("pending");
    expect(await f.run("apply")).toEqual({ status: "ok", code: "hook_added" });
    expect((await f.ownership.get(f.userTarget))?.phase).toBe("owned");
  });
  it("settles a pending record whose write completed to owned without rewriting", async () => {
    const f = await fixture();
    const crash: WakeHookDependencies = { checkpoint: (step) => { if (step === "written") throw new Error("crash"); } };
    expect(await f.run("apply", { dependencies: crash })).toEqual({ status: "failed", code: "hook_install_failed" });
    expect((await f.ownership.get(f.userTarget))?.phase).toBe("pending");
    const file = f.settings("user"); const before = await stat(file);
    expect(await f.run("verify")).toEqual({ status: "failed", code: "hook_ownership_pending" });
    expect(await f.run("apply")).toEqual({ status: "ok", code: "hook_recovered" });
    expect((await f.ownership.get(f.userTarget))?.phase).toBe("owned");
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(await f.run("verify")).toEqual({ status: "ok", code: "hook_verified" });
  });
  it("returns an interrupted update to the owned old entry and then completes it", async () => {
    const f = await fixture();
    await f.run("apply");
    const moved = join(f.root, "pkg2"); await mkdir(join(moved, "dist"), { recursive: true });
    const crash: WakeHookDependencies = { checkpoint: (step) => { if (step === "pending-recorded") throw new Error("crash"); } };
    expect(await f.run("apply", { roots: { packageRoot: moved }, dependencies: crash })).toEqual({ status: "failed", code: "hook_install_failed" });
    const pending = await f.ownership.get(f.userTarget);
    expect(pending).toMatchObject({ phase: "pending", replaces: wakeEntryFingerprint(f.entry) });
    // Removal in this state still finds exactly the owned old entry.
    expect(await f.run("dry-run", { enabled: false })).toEqual({ status: "planned", code: "hook_remove_planned" });
    expect(await f.run("apply", { roots: { packageRoot: moved } })).toEqual({ status: "ok", code: "hook_updated" });
    expect(await f.ownership.get(f.userTarget)).toMatchObject({ phase: "owned", fingerprint: wakeEntryFingerprint(buildWakeEntry({ ...f.roots, packageRoot: moved })) });
  });
  it("settles a pending update that did write to the new entry", async () => {
    const f = await fixture();
    await f.run("apply");
    const moved = join(f.root, "pkg2"); await mkdir(join(moved, "dist"), { recursive: true });
    const crash: WakeHookDependencies = { checkpoint: (step) => { if (step === "written") throw new Error("crash"); } };
    await f.run("apply", { roots: { packageRoot: moved }, dependencies: crash });
    expect(await f.run("apply", { roots: { packageRoot: moved } })).toEqual({ status: "ok", code: "hook_recovered" });
    expect(await f.ownership.get(f.userTarget)).toMatchObject({ phase: "owned", fingerprint: wakeEntryFingerprint(buildWakeEntry({ ...f.roots, packageRoot: moved })) });
    expect(await f.ownership.get(f.userTarget)).not.toHaveProperty("replaces");
  });
  it("keeps records apart per project and per scope", async () => {
    const f = await fixture();
    const other = join(f.root, "other"); await mkdir(other);
    await f.run("apply", { scope: "local" });
    await f.run("apply", { scope: "local", roots: { cwd: other } });
    await f.run("apply", { scope: "project" });
    // Removing in one project leaves the others.
    expect(await f.run("remove", { scope: "local" })).toEqual({ status: "ok", code: "hook_removed" });
    expect(JSON.parse(await readFile(join(other, ".claude", "settings.local.json"), "utf8")).hooks.PostToolUse).toEqual([f.entry]);
    expect(JSON.parse(await readFile(f.settings("project"), "utf8")).hooks.PostToolUse).toEqual([f.entry]);
    expect(await f.run("remove", { scope: "local", roots: { cwd: other } })).toEqual({ status: "ok", code: "hook_removed" });
    expect(await f.run("remove", { scope: "project" })).toEqual({ status: "ok", code: "hook_removed" });
  });
});

describe("wake hook removal", () => {
  it("removes only its own entry and leaves every other byte", async () => {
    const f = await fixture();
    const original = { model: "opus", hooks: { PostToolUse: [foreign], Stop: [foreign] } };
    const file = await f.seed("user", original);
    await f.run("apply");
    expect(await f.run("remove")).toEqual({ status: "ok", code: "hook_removed" });
    expect(await readFile(file, "utf8")).toBe(f.format(original));
    expect(await f.ownership.get(f.userTarget)).toBeUndefined();
    expect(await f.run("remove")).toEqual({ status: "unchanged", code: "hook_not_owned" });
  });
  it("leaves an empty PostToolUse array when other content exists", async () => {
    const f = await fixture();
    const file = await f.seed("user", { model: "opus" });
    await f.run("apply");
    expect(await f.run("rollback")).toEqual({ status: "ok", code: "hook_removed" });
    expect(await readFile(file, "utf8")).toBe(f.format({ model: "opus", hooks: { PostToolUse: [] } }));
  });
  it("removes the keys it created but keeps the file", async () => {
    const f = await fixture();
    await f.run("apply");
    expect(await f.run("remove")).toEqual({ status: "ok", code: "hook_removed" });
    expect(await readFile(f.settings("user"), "utf8")).toBe("{}\n");
  });
  it("drops the record when the entry is already gone", async () => {
    const f = await fixture();
    await f.run("apply");
    await f.seed("user", { model: "opus" });
    expect(await f.run("remove")).toEqual({ status: "ok", code: "hook_absent" });
    expect(await f.ownership.get(f.userTarget)).toBeUndefined();
    expect(await readFile(f.settings("user"), "utf8")).toBe(f.format({ model: "opus" }));
  });
  it("refuses removal of an unparseable file and keeps the record", async () => {
    const f = await fixture();
    await f.run("apply");
    await f.seed("user", "{oops");
    expect(await f.run("remove")).toEqual({ status: "failed", code: "settings_unparseable" });
    expect(await f.ownership.get(f.userTarget)).toBeDefined();
  });
});

describe("wake hook and the configured delivery", () => {
  it("removes an owned hook on apply when delivery is off and reports it on a dry-run", async () => {
    const f = await fixture();
    const file = await f.seed("user", { hooks: { PostToolUse: [foreign] } });
    await f.run("apply");
    const bytes = await readFile(file, "utf8"); const before = await stat(file);
    expect(await f.run("dry-run", { enabled: false })).toEqual({ status: "planned", code: "hook_remove_planned" });
    expect(await readFile(file, "utf8")).toBe(bytes);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(await f.run("verify", { enabled: false })).toEqual({ status: "failed", code: "hook_delivery_off" });
    expect(await f.run("apply", { enabled: false })).toEqual({ status: "ok", code: "hook_removed" });
    expect(await readFile(file, "utf8")).toBe(f.format({ hooks: { PostToolUse: [foreign] } }));
    expect(await f.ownership.get(f.userTarget)).toBeUndefined();
    expect(await f.run("apply", { enabled: false })).toEqual({ status: "unchanged", code: "hook_not_enabled" });
    expect(await f.run("verify", { enabled: false })).toEqual({ status: "unchanged", code: "hook_not_enabled" });
  });
  it("leaves an unowned entry alone when delivery is off, and never creates a file", async () => {
    const f = await fixture();
    expect(await f.run("apply", { enabled: false })).toEqual({ status: "unchanged", code: "hook_not_enabled" });
    await expect(stat(join(f.home, ".claude"))).rejects.toThrow();
    const file = await f.seed("user", { hooks: { PostToolUse: [f.entry] } });
    expect(await f.run("apply", { enabled: false })).toEqual({ status: "unchanged", code: "hook_not_enabled" });
    expect(await readFile(file, "utf8")).toBe(f.format({ hooks: { PostToolUse: [f.entry] } }));
  });
});

describe("wake hook with delivery off and nothing owned", () => {
  it("does not look at settings that are unparseable, misshapen or linked", async () => {
    const f = await fixture();
    const elsewhere = join(f.root, "elsewhere"); await mkdir(elsewhere);
    for (const content of ["{not json", f.format({ hooks: [] }), f.format({ hooks: { PostToolUse: {} } })]) {
      const file = await f.seed("user", content);
      const before = await stat(file);
      for (const operation of ["dry-run", "apply", "verify"] as const) {
        expect(await f.run(operation, { enabled: false })).toEqual({ status: "unchanged", code: "hook_not_enabled" });
      }
      expect(await readFile(file, "utf8")).toBe(content);
      expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    }
    // A linked project settings directory is neither followed nor complained about.
    await symlink(elsewhere, join(f.cwd, ".claude"));
    for (const scope of ["project", "local"] as const) {
      for (const operation of ["dry-run", "apply", "verify"] as const) {
        expect(await f.run(operation, { scope, enabled: false })).toEqual({ status: "unchanged", code: "hook_not_enabled" });
      }
    }
    expect(await readdir(elsewhere)).toEqual([]);
  });
  it("still maintains an owned hook when delivery is off, even where settings are unreadable", async () => {
    const f = await fixture();
    await f.run("apply");
    await f.seed("user", "{oops");
    expect(await f.run("apply", { enabled: false })).toEqual({ status: "failed", code: "settings_unparseable" });
    expect(await f.run("verify", { enabled: false })).toEqual({ status: "failed", code: "settings_unparseable" });
  });
  it("keeps a setup run green and its exit code zero in every operation", async () => {
    const { f, orchestrator } = await orchestratedOff();
    await f.seed("user", "{not json");
    for (const operation of ["dry-run", "apply", "verify", "apply"] as const) {
      const output = await orchestrator.run({ operation, targets: [{ client: "codex", scope: "user", alias: "pi-session-mcp" }, { client: "claude-code", scope: "user", alias: "pi-session-mcp" }] });
      expect(output.exitCode).toBe(0);
      expect(output.findings.filter((finding) => finding.target.alias === WAKE_HOOK_ALIAS).map((finding) => finding.code)).toEqual(["hook_not_applicable", "hook_not_enabled"]);
    }
    expect(await readFile(f.settings("user"), "utf8")).toBe("{not json");
  });
});

describe("wake hook verify", () => {
  it("passes only for the canonical owned entry with its program present", async () => {
    const f = await fixture();
    expect(await f.run("verify")).toEqual({ status: "failed", code: "hook_missing" });
    await f.run("apply");
    expect(await f.run("verify")).toEqual({ status: "ok", code: "hook_verified" });
    await f.seed("user", { hooks: { PostToolUse: [otherPackage(f.entry)] } });
    expect(await f.run("verify")).toEqual({ status: "failed", code: "hook_not_equivalent" });
    await f.seed("user", { hooks: { PostToolUse: [f.entry] } });
    expect(await f.run("verify")).toEqual({ status: "ok", code: "hook_verified" });
    expect(await f.run("verify", { roots: { packageRoot: join(f.root, "pkg-missing") } })).toEqual({ status: "failed", code: "hook_not_equivalent" });
  });
  it("fails when the program is missing or not a file", async () => {
    const f = await fixture();
    await f.run("apply");
    const program = join(f.packageRoot, "dist", "wake-main.js");
    await rm(program);
    expect(await f.run("verify")).toEqual({ status: "failed", code: "hook_program_missing" });
    await mkdir(program);
    expect(await f.run("verify")).toEqual({ status: "failed", code: "hook_program_missing" });
  });
  it("does not write on verify", async () => {
    const f = await fixture();
    await f.run("apply");
    const before = await stat(f.settings("user"));
    await f.run("verify");
    expect((await stat(f.settings("user"))).mtimeMs).toBe(before.mtimeMs);
  });
});

describe("wake hook locations and links", () => {
  it("refuses a linked .claude directory or settings file in a project and writes nothing outside it", async () => {
    const f = await fixture();
    const elsewhere = join(f.root, "elsewhere"); await mkdir(elsewhere);
    await symlink(elsewhere, join(f.cwd, ".claude"));
    expect(await f.run("apply", { scope: "project" })).toEqual({ status: "failed", code: "settings_location_invalid" });
    expect(await readdir(elsewhere)).toEqual([]);
    const other = join(f.root, "other"); await mkdir(join(other, ".claude"), { recursive: true });
    await writeFile(join(elsewhere, "real.json"), "{}\n"); await symlink(join(elsewhere, "real.json"), join(other, ".claude", "settings.local.json"));
    expect(await f.run("apply", { scope: "local", roots: { cwd: other } })).toEqual({ status: "failed", code: "settings_location_invalid" });
    expect(await readFile(join(elsewhere, "real.json"), "utf8")).toBe("{}\n");
  });
  it("writes through a linked user settings file and keeps the link", async () => {
    const f = await fixture();
    const dotfiles = join(f.root, "dotfiles"); await mkdir(dotfiles); await mkdir(join(f.home, ".claude"));
    await writeFile(join(dotfiles, "settings.json"), f.format({ model: "opus" }));
    await symlink(join(dotfiles, "settings.json"), join(f.home, ".claude", "settings.json"));
    expect(await f.run("apply")).toEqual({ status: "ok", code: "hook_added" });
    expect((await lstat(join(f.home, ".claude", "settings.json"))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(join(dotfiles, "settings.json"), "utf8"))).toEqual({ model: "opus", hooks: { PostToolUse: [f.entry] } });
    expect(await f.run("remove")).toEqual({ status: "ok", code: "hook_removed" });
  });
  it("refuses a dangling user settings link", async () => {
    const f = await fixture();
    await mkdir(join(f.home, ".claude")); await symlink(join(f.root, "nowhere.json"), join(f.home, ".claude", "settings.json"));
    expect(await f.run("apply")).toEqual({ status: "failed", code: "settings_location_invalid" });
  });
});

describe("wake hook ownership records", () => {
  it("accepts exactly the hook record shapes", () => {
    const base = { fingerprint: "a".repeat(64), previous: "absent", phase: "owned", transactionId: "11111111-1111-4111-8111-111111111111" };
    const id = "0123456789abcdef";
    const target = (scope: string, alias: string) => ({ client: "claude-code", scope, alias });
    expect(isRecord({ ...base, target: target("user", WAKE_HOOK_ALIAS) })).toBe(true);
    expect(isRecord({ ...base, target: target("project", `${WAKE_HOOK_ALIAS}@${id}`) })).toBe(true);
    expect(isRecord({ ...base, target: target("local", `${WAKE_HOOK_ALIAS}@${id}`) })).toBe(true);
    expect(isRecord({ ...base, target: target("user", `${WAKE_HOOK_ALIAS}@${id}`) })).toBe(false);
    expect(isRecord({ ...base, target: target("local", WAKE_HOOK_ALIAS) })).toBe(false);
    expect(isRecord({ ...base, target: target("local", `${WAKE_HOOK_ALIAS}@${id.toUpperCase()}`) })).toBe(false);
    expect(isRecord({ ...base, target: { client: "codex", scope: "user", alias: WAKE_HOOK_ALIAS } })).toBe(false);
    expect(isRecord({ ...base, target: target("user", WAKE_HOOK_ALIAS), fingerprint: "v2:x" })).toBe(false);
    expect(isRecord({ ...base, phase: "pending", replaces: "b".repeat(64), target: target("user", WAKE_HOOK_ALIAS) })).toBe(true);
    expect(isRecord({ ...base, replaces: "b".repeat(64), target: target("user", WAKE_HOOK_ALIAS) })).toBe(false);
    expect(isRecord({ ...base, phase: "pending", replaces: "no", target: target("user", WAKE_HOOK_ALIAS) })).toBe(false);
  });
  it.skipIf(!currentSetupPlatform())("persists a path-free, command-free record in the durable store", async () => {
    const f = await fixture();
    const path = join(f.root, "state", "ownership.json");
    const store = new DurableOwnershipStore(path);
    for (const scope of ["user", "project", "local"] as const) {
      expect(await store.transaction((ownership) => runWakeHook({ operation: "apply", scope, roots: f.roots, enabled: true, ownership }))).toEqual({ status: "ok", code: "hook_added" });
    }
    const text = await readFile(path, "utf8");
    const records = JSON.parse(text) as OwnershipRecord[];
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(["fingerprint", "phase", "previous", "target", "transactionId"]);
      expect(record.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(record.target.alias).toMatch(/^hook:pi-session-mcp-wake(@[0-9a-f]{16})?$/);
      for (const value of [record.fingerprint, record.target.scope, record.target.alias, record.transactionId]) expect(value).not.toContain("/");
    }
    for (const forbidden of [f.root, f.packageRoot, "wake-main", "node", "settings"]) expect(text).not.toContain(forbidden);
    expect(await store.transaction((ownership) => runWakeHook({ operation: "verify", scope: "user", roots: f.roots, enabled: true, ownership }))).toEqual({ status: "ok", code: "hook_verified" });
  });
});

describe("installWakeHook for a later writer integration", () => {
  it("applies and dry-runs a local scope for a given working directory without a report path", async () => {
    const f = await fixture();
    const writer = join(f.root, "writer-1"); await mkdir(writer);
    const base = { scope: "local" as const, cwd: writer, home: f.home, env: {}, ownership: f.ownership, packageRoot: f.packageRoot, nodePath: "/usr/bin/node", delivery: true };
    expect(await installWakeHook({ ...base, apply: false })).toEqual({ target: { client: "claude-code", scope: "local", alias: WAKE_HOOK_ALIAS }, status: "planned", code: "hook_add_planned" });
    await expect(stat(join(writer, ".claude"))).rejects.toThrow();
    expect(await installWakeHook({ ...base, apply: true })).toMatchObject({ status: "ok", code: "hook_added" });
    expect(JSON.parse(await readFile(join(writer, ".claude", "settings.local.json"), "utf8"))).toEqual({ hooks: { PostToolUse: [f.entry] } });
    expect(await installWakeHook({ ...base, apply: true, delivery: false })).toMatchObject({ status: "ok", code: "hook_removed" });
  });
});

describe("wake hook in the setup orchestrator", () => {
  const registration = (client: string) => ({ client, scope: "user", alias: "pi-session-mcp" });
  async function orchestrated(delivery = true) {
    const f = await fixture();
    const registered = new Set<string>(); let failApply = false;
    const adapters: SetupClientAdapter[] = ["codex", "claude-code"].map((name) => ({
      name, supportedScopes: name === "codex" ? ["user"] : ["user", "local", "project"],
      async inspect(target) { return registered.has(`${target.client}:${target.scope}`) ? { state: "equivalent", fingerprint: "a".repeat(64) } : { state: "absent" }; },
      async apply(target) { if (failApply) throw new Error("registration failed"); registered.add(`${target.client}:${target.scope}`); },
      async remove(target) { registered.delete(`${target.client}:${target.scope}`); },
      async verify() { return { ok: true, code: "mcp_verified" }; },
    }));
    const hooks = new FileSetupHookInstaller({ ...f.roots, delivery: async () => delivery });
    const orchestrator = new SetupOrchestrator({ adapters, ownership: f.ownership, intendedFingerprint: "a".repeat(64), hooks });
    return { f, registered, orchestrator, failRegistration: () => { failApply = true; } };
  }
  const summary = (output: Awaited<ReturnType<SetupOrchestrator["run"]>>) => output.findings.map((finding) => `${finding.target.client}/${finding.target.scope}/${finding.target.alias}:${finding.status}:${finding.code}`);

  it("reports the hook after the registration for claude-code and not applicable for codex", async () => {
    const { f, orchestrator } = await orchestrated();
    const dry = await orchestrator.run({ targets: [registration("codex"), registration("claude-code")] });
    expect(summary(dry)).toEqual([
      "codex/user/pi-session-mcp:absent:absent", `codex/user/${WAKE_HOOK_ALIAS}:unchanged:hook_not_applicable`,
      "claude-code/user/pi-session-mcp:absent:absent", `claude-code/user/${WAKE_HOOK_ALIAS}:planned:hook_add_planned`,
    ]);
    await expect(stat(join(f.home, ".claude"))).rejects.toThrow();
    const applied = await orchestrator.run({ operation: "apply", targets: [registration("codex"), registration("claude-code")] });
    expect(summary(applied)).toEqual([
      "codex/user/pi-session-mcp:ok:applied", `codex/user/${WAKE_HOOK_ALIAS}:unchanged:hook_not_applicable`,
      "claude-code/user/pi-session-mcp:ok:applied", `claude-code/user/${WAKE_HOOK_ALIAS}:ok:hook_added`,
    ]);
    expect(applied.exitCode).toBe(0);
    const again = await orchestrator.run({ operation: "apply", targets: [registration("claude-code")] });
    expect(summary(again)).toEqual(["claude-code/user/pi-session-mcp:unchanged:already_equivalent", `claude-code/user/${WAKE_HOOK_ALIAS}:unchanged:hook_already_equivalent`]);
    const verified = await orchestrator.run({ operation: "verify", targets: [registration("claude-code")] });
    expect(summary(verified)).toEqual(["claude-code/user/pi-session-mcp:ok:mcp_verified", `claude-code/user/${WAKE_HOOK_ALIAS}:ok:hook_verified`]);
  });
  it("does not touch settings when the registration fails", async () => {
    const { f, orchestrator, failRegistration } = await orchestrated();
    failRegistration();
    const output = await orchestrator.run({ operation: "apply", targets: [registration("claude-code")] });
    expect(summary(output)).toEqual(["claude-code/user/pi-session-mcp:failed:apply_failed_recovery_pending"]);
    expect(output.exitCode).toBe(1);
    await expect(stat(join(f.home, ".claude"))).rejects.toThrow();
  });
  it("fails the run on a divergent hook while the registration still succeeds", async () => {
    const { f, orchestrator } = await orchestrated();
    await f.seed("user", { hooks: { PostToolUse: [otherPackage(f.entry)] } });
    const output = await orchestrator.run({ operation: "apply", targets: [registration("claude-code")] });
    expect(summary(output)).toEqual(["claude-code/user/pi-session-mcp:ok:applied", `claude-code/user/${WAKE_HOOK_ALIAS}:divergent:hook_divergent`]);
    expect(output).toMatchObject({ status: "failed", exitCode: 1 });
  });
  it("removes the hook with the registration, also when the registration is already gone", async () => {
    const { f, orchestrator, registered } = await orchestrated();
    await orchestrator.run({ operation: "apply", targets: [registration("claude-code")] });
    const removed = await orchestrator.run({ operation: "remove", targets: [registration("claude-code")] });
    expect(summary(removed)).toEqual(["claude-code/user/pi-session-mcp:ok:removed", `claude-code/user/${WAKE_HOOK_ALIAS}:ok:hook_removed`]);
    expect(await readFile(f.settings("user"), "utf8")).toBe("{}\n");
    // Registration removed earlier (or by a crash) before the hook cleanup.
    await orchestrator.run({ operation: "apply", targets: [registration("claude-code")] });
    await f.ownership.delete(registration("claude-code"));
    registered.clear();
    const retried = await orchestrator.run({ operation: "rollback", targets: [registration("claude-code")] });
    expect(summary(retried)).toEqual(["claude-code/user/pi-session-mcp:ok:rolled_back", `claude-code/user/${WAKE_HOOK_ALIAS}:ok:hook_removed`]);
    expect(await f.ownership.get(f.userTarget)).toBeUndefined();
  });
  it("does not install while delivery is off, and verify stays green", async () => {
    const { f, orchestrator } = await orchestrated(false);
    const output = await orchestrator.run({ operation: "apply", targets: [registration("claude-code")] });
    expect(summary(output)).toEqual(["claude-code/user/pi-session-mcp:ok:applied", `claude-code/user/${WAKE_HOOK_ALIAS}:unchanged:hook_not_enabled`]);
    await expect(stat(join(f.home, ".claude"))).rejects.toThrow();
    expect((await orchestrator.run({ operation: "verify", targets: [registration("claude-code")] })).exitCode).toBe(0);
  });
  it("reports an unreadable configuration as a failed hook without touching settings", async () => {
    const f = await fixture();
    const adapters: SetupClientAdapter[] = [{ name: "claude-code", supportedScopes: ["user"], async inspect() { return { state: "absent" }; }, async apply() {}, async remove() {}, async verify() { return { ok: true, code: "mcp_verified" }; } }];
    const orchestrator = new SetupOrchestrator({ adapters, ownership: f.ownership, intendedFingerprint: "a".repeat(64), hooks: new FileSetupHookInstaller({ ...f.roots, delivery: async () => { throw new Error("bad config"); } }) });
    const output = await orchestrator.run({ targets: [registration("claude-code")] });
    expect(summary(output)).toEqual(["claude-code/user/pi-session-mcp:absent:absent", `claude-code/user/${WAKE_HOOK_ALIAS}:failed:hook_config_unreadable`]);
    await expect(stat(join(f.home, ".claude"))).rejects.toThrow();
  });
});

async function orchestratedOff() {
  const f = await fixture();
  const registered = new Set<string>();
  const adapters: SetupClientAdapter[] = ["codex", "claude-code"].map((name) => ({
    name, supportedScopes: name === "codex" ? ["user"] : ["user", "local", "project"],
    async inspect(target) { return registered.has(`${target.client}:${target.scope}`) ? { state: "equivalent", fingerprint: "a".repeat(64) } : { state: "absent" }; },
    async apply(target) { registered.add(`${target.client}:${target.scope}`); },
    async remove(target) { registered.delete(`${target.client}:${target.scope}`); },
    async verify() { return { ok: true, code: "mcp_verified" }; },
  }));
  const orchestrator = new SetupOrchestrator({ adapters, ownership: f.ownership, intendedFingerprint: "a".repeat(64), hooks: new FileSetupHookInstaller({ ...f.roots, delivery: async () => false }) });
  return { f, orchestrator };
}
