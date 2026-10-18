import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "./client-adapters/types.js";
import type { ContainerSettings } from "./execution-modes.js";
import { configSchema } from "./config.js";
import { builtinSkillName } from "./skill-catalog.js";
import { BOUNDARY_GIT, BoundaryError, IMAGE_PULL_TIMEOUT_MS, isSafeRefName, resolveImage, throwawayArgs, verifyCloneLayout } from "./writer-boundary.js";
import { readWriterState, writerName, writerPaths, writeWriterState, WriterStateError, type WriterState } from "./writer-state.js";

export interface WriterContext {
  home: string;
  releaseRoot: string;
  nodePath: string;
  runner: CommandRunner;
  checkout: string;
  alias: string;
}
export type WriterOutcome = { code: string; status: "ok" | "planned" | "unchanged" | "failed" };

class LifecycleError extends Error {
  constructor(readonly code: string) { super(code); }
}
function failure(error: unknown): WriterOutcome {
  return { status: "failed", code: error instanceof LifecycleError || error instanceof BoundaryError || error instanceof WriterStateError ? error.code : "writer_operation_failed" };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new LifecycleError("container_profile_unsupported");
  return value as Record<string, unknown>;
}

export function renderContainedConfig(alias: string, clonePath: string, rawConfig: unknown, selected: readonly string[]) {
  if (selected.length === 0 || selected.includes("boundary-read-only")) throw new LifecycleError("container_profile_unsupported");
  const raw = record(rawConfig), profiles = record(raw.executionProfiles);
  const skillCatalog: Record<string, string> = {};
  const executionProfiles = Object.fromEntries(selected.map((name) => {
    const profile = record(Object.hasOwn(profiles, name) ? profiles[name] : undefined);
    if (profile.extensions !== undefined || profile.mcpServers !== undefined || profile.default !== false || profile.permissionProfile !== "coding") {
      throw new LifecycleError("container_profile_unsupported");
    }
    if (profile.skills !== undefined) {
      if (!Array.isArray(profile.skills)) throw new LifecycleError("container_profile_unsupported");
      for (const skill of profile.skills) {
        const catalog = record(raw.skillCatalog);
        const value = typeof skill === "string" && Object.hasOwn(catalog, skill) ? catalog[skill] : undefined;
        if (typeof value !== "string" || builtinSkillName(value) === undefined) throw new LifecycleError("container_profile_unsupported");
        Object.defineProperty(skillCatalog, skill, { value, enumerable: true, configurable: true, writable: true });
      }
    }
    return [name, { ...profile }];
  }));
  const first = executionProfiles[selected[0]!]!;
  executionProfiles["boundary-read-only"] = {
    default: true, permissionProfile: "read-only", provider: first.provider,
    model: first.model, thinkingLevel: first.thinkingLevel,
  };
  const rendered = { workspaces: { [alias]: clonePath }, executionProfiles, ...(Object.keys(skillCatalog).length === 0 ? {} : { skillCatalog }) };
  const parsed = configSchema.safeParse(rendered);
  if (!parsed.success) throw new LifecycleError("container_profile_unsupported");
  // Validate with the real schema without normalizing or resolving the raw profile objects.
  return rendered as typeof parsed.data;
}

// CommandRunner has no per-call environment option. Hooks are disabled even for injected runners.
async function git(ctx: WriterContext, args: readonly string[], optional = false): Promise<string | undefined> {
  const result = await ctx.runner.run("git", ["-c", "core.hooksPath=/dev/null", "-C", ctx.checkout, ...args], AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS));
  if (result.exitCode !== 0) {
    if (optional) return undefined;
    throw new LifecycleError("writer_base_unavailable");
  }
  return result.stdout.trim();
}
function shortBranch(ref: string): string {
  const short = ref.startsWith("refs/heads/") ? ref.slice(11)
    : ref.startsWith("refs/remotes/") ? ref.slice(13).split("/").slice(1).join("/") : ref;
  if (!isSafeRefName(short)) throw new LifecycleError("writer_base_unavailable");
  return short;
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
async function jsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

export async function provisionWriter(ctx: WriterContext, input: {
  index: number; settings: ContainerSettings; baseRef?: string; rawConfig: unknown;
}): Promise<WriterOutcome> {
  try {
    const { index, settings } = input;
    const name = writerName(ctx.alias, index), paths = writerPaths(ctx.home, name);
    let existing: WriterState | undefined, restart = false;
    try { existing = await readWriterState(ctx.home, name); } catch (error) {
      if (!(error instanceof WriterStateError) || error.code !== "writer_state_invalid") throw error;
      restart = true;
    }
    const config = renderContainedConfig(ctx.alias, paths.clone, input.rawConfig, settings.profiles);
    const selected = settings.profiles.map((alias) => config.executionProfiles[alias]!);
    const providers = selected.filter((profile, i, all) => all.findIndex((other) => other.provider === profile.provider) === i)
      .map(({ provider, model }) => ({ provider, model }));
    const imageId = await resolveImage(ctx.runner, settings.image, true);
    const ref = input.baseRef ?? await git(ctx, ["symbolic-ref", "refs/remotes/origin/HEAD"], true) ?? "refs/heads/main";
    if (!isSafeRefName(ref)) throw new LifecycleError("writer_base_unavailable");
    const short = shortBranch(ref);
    const commit = await git(ctx, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    if (!commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new LifecycleError("writer_base_unavailable");
    const remote = await git(ctx, ["remote", "get-url", "origin"], true);
    if (remote && /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/.test(remote)) throw new LifecycleError("remote_url_refused");
    if (existing && existing.phase !== "provisioning") {
      const equal = existing.imageId === imageId && existing.lifecycle === settings.lifecycle && existing.network === settings.network
        && existing.cache === settings.cache && JSON.stringify(existing.profiles) === JSON.stringify(settings.profiles)
        && JSON.stringify(existing.providers) === JSON.stringify(providers)
        && (input.baseRef === undefined || (existing.base.ref === `refs/heads/${short}` && existing.base.commit === commit));
      return { code: equal ? "writer_unchanged" : "writer_settings_changed", status: equal ? "unchanged" : "failed" };
    }
    if (restart || existing?.phase === "provisioning") await rm(paths.root, { recursive: true, force: true });
    for (const path of [paths.root, paths.clone, paths.config, paths.agent, paths.bundles, ...(settings.cache === "go" ? [paths.go] : [])]) await privateDirectory(path);
    const state: WriterState = {
      schemaVersion: 1, alias: ctx.alias, index, phase: "provisioning", lifecycle: settings.lifecycle,
      profiles: [...settings.profiles], providers, network: settings.network, cache: settings.cache, imageId,
      base: { ref: `refs/heads/${short}`, commit },
    };
    await writeWriterState(ctx.home, name, state);
    await git(ctx, ["bundle", "create", join(paths.bundles, "base.bundle"), ref]);
    await chmod(join(paths.bundles, "base.bundle"), 0o600);
    // Clone only auto-fetches refs/heads; origin/HEAD may instead select a refs/remotes ref.
    // Fetch the exact bundled ref as well so that its commit is present before checkout.
    const script = `set -eu\nexport GIT_CONFIG_NOSYSTEM=1\n${BOUNDARY_GIT} clone --no-hardlinks /bundles/base.bundle "$1"\ncd "$1"\n${BOUNDARY_GIT} fetch --no-tags /bundles/base.bundle "$5"\n${BOUNDARY_GIT} checkout -B "$2" "$3"\nif [ -n "$4" ]; then ${BOUNDARY_GIT} remote set-url origin "$4"; else ${BOUNDARY_GIT} remote remove origin; fi`;
    const clone = await ctx.runner.run("podman", throwawayArgs(paths, imageId, { clone: "rw", bundles: true }, script, [paths.clone, short, commit, remote ?? "", ref]), AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS));
    if (clone.exitCode !== 0) throw new LifecycleError("writer_clone_failed");
    await verifyCloneLayout(paths.clone);
    await jsonFile(join(paths.config, "pi-session-mcp.json"), config);
    await jsonFile(join(paths.config, "execution-modes.json"), { schemaVersion: 1, workspaces: { [ctx.alias]: { mode: "host", acceptHostWrites: true } } });
    await jsonFile(join(paths.config, "writer-guard.json"), { schemaVersion: 1, workspace: ctx.alias, baseRef: state.base.ref, baseCommit: commit });
    await jsonFile(join(paths.agent, "auth.json"), {});
    await writeWriterState(ctx.home, name, { ...state, phase: "not_ready" });
    return { code: "writer_provisioned", status: "ok" };
  } catch (error) { return failure(error); }
}

export async function inspectWork(ctx: WriterContext, name: string): Promise<{
  baseline: boolean; digest: string; branches: readonly { name: string; commit: string }[]; dirty: boolean;
}> {
  const state = await readWriterState(ctx.home, name);
  if (!state || state.alias !== ctx.alias) throw new LifecycleError("writer_state_invalid");
  const paths = writerPaths(ctx.home, name);
  await verifyCloneLayout(paths.clone);
  const script = `set -eu\nexport GIT_CONFIG_NOSYSTEM=1\ncp .git/index /tmp/index\nmkdir /tmp/objects\nexport GIT_INDEX_FILE=/tmp/index GIT_OBJECT_DIRECTORY=/tmp/objects GIT_ALTERNATE_OBJECT_DIRECTORIES="$1/.git/objects"\n${BOUNDARY_GIT} add -A\n${BOUNDARY_GIT} rev-parse --verify HEAD\n${BOUNDARY_GIT} for-each-ref --format='%(refname) %(objectname)' refs/heads refs/stash\n${BOUNDARY_GIT} write-tree\n${BOUNDARY_GIT} rev-parse 'HEAD^{tree}'\n${BOUNDARY_GIT} rev-parse "$2^{tree}"`;
  const result = await ctx.runner.run("podman", throwawayArgs(paths, state.imageId, { clone: "ro", bundles: false }, script, [paths.clone, state.base.commit]), AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS));
  if (result.exitCode !== 0) throw new LifecycleError("writer_inspect_failed");
  const lines = result.stdout.trim().split("\n");
  const hash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  const head = lines.shift(), baseTree = lines.pop(), headTree = lines.pop(), tree = lines.pop();
  if (![head, baseTree, headTree, tree].every((value) => value !== undefined && hash.test(value))) throw new LifecycleError("writer_inspect_failed");
  const refs = lines.map((line) => {
    const [name, commit, extra] = line.split(" ");
    if (!name || !isSafeRefName(name) || !commit || !hash.test(commit) || extra !== undefined || !(name.startsWith("refs/heads/") || name === "refs/stash")) throw new LifecycleError("writer_inspect_failed");
    return { name, commit };
  });
  return {
    baseline: head === state.base.commit && refs.length === 1 && refs[0]!.name === state.base.ref && refs[0]!.commit === state.base.commit && tree === baseTree,
    dirty: tree !== headTree, branches: refs.filter(({ name }) => name.startsWith("refs/heads/")),
    digest: `sha256:${createHash("sha256").update(result.stdout).digest("hex")}`,
  };
}

export async function removeWriter(ctx: WriterContext, name: string, opts: { discard: boolean }): Promise<WriterOutcome> {
  try {
    const paths = writerPaths(ctx.home, name);
    const state = await readWriterState(ctx.home, name);
    if (!state || state.alias !== ctx.alias) throw new LifecycleError("writer_state_invalid");
    if (!opts.discard) {
      const work = await inspectWork(ctx, name);
      if (!work.baseline && state.collected?.digest !== work.digest) throw new LifecycleError("writer_uncollected");
    }
    await rm(paths.root, { recursive: true, force: true });
    return { code: "writer_removed", status: "ok" };
  } catch (error) { return failure(error); }
}
