import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "./client-adapters/types.js";
import type { ContainerSettings } from "./execution-modes.js";
import { configSchema } from "./config.js";
import { renderWrapper } from "./writer-wrapper.js";
import { builtinSkillName } from "./skill-catalog.js";
import { BOUNDARY_GIT, BoundaryError, IMAGE_PULL_TIMEOUT_MS, isSafeRefName, resolveImage, throwawayArgs, verifyCloneLayout } from "./writer-boundary.js";
import { readWriterState, writerEventDeliveryEnabled, writerName, writerPaths, writeWriterState, WriterStateError, type WriterState } from "./writer-state.js";

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
  // The writer's own configuration is the single source of event delivery for the boundary: launch reads it.
  const rendered = { ...(raw.events === undefined ? {} : { events: raw.events }), workspaces: { [alias]: clonePath }, executionProfiles, ...(Object.keys(skillCatalog).length === 0 ? {} : { skillCatalog }) };
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
async function collectGit(ctx: WriterContext, args: readonly string[]): Promise<string | undefined> {
  try { return await git(ctx, args); } catch { throw new LifecycleError("writer_collect_failed"); }
}
function shortBranch(ref: string): string {
  const short = ref.startsWith("refs/heads/") ? ref.slice(11)
    : ref.startsWith("refs/remotes/") ? ref.slice(13).split("/").slice(1).join("/") : ref;
  if (!isSafeRefName(short)) throw new LifecycleError("base_ref_invalid");
  return short;
}
async function resolveBase(ctx: WriterContext, requested?: string) {
  let ref = requested ?? await git(ctx, ["symbolic-ref", "refs/remotes/origin/HEAD"], true) ?? "refs/heads/main";
  if (!isSafeRefName(ref) || ref === "HEAD" || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref)) throw new LifecycleError("base_ref_invalid");
  if (!ref.startsWith("refs/")) {
    const resolved = await git(ctx, ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", ref], true);
    if (!resolved?.startsWith("refs/heads/")) throw new LifecycleError("base_ref_invalid");
    ref = resolved;
  }
  if (!/^refs\/heads\/.+/.test(ref) && !/^refs\/remotes\/[^/]+\/.+/.test(ref)) throw new LifecycleError("base_ref_invalid");
  if (!isSafeRefName(ref)) throw new LifecycleError("base_ref_invalid");
  const short = shortBranch(ref);
  const commit = await git(ctx, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new LifecycleError("writer_base_unavailable");
  return { ref, short, commit };
}
async function baseBundle(ctx: WriterContext, paths: ReturnType<typeof writerPaths>, ref: string): Promise<void> {
  await rm(join(paths.bundles, "base.bundle"), { force: true });
  await git(ctx, ["bundle", "create", join(paths.bundles, "base.bundle"), ref]);
  await chmod(join(paths.bundles, "base.bundle"), 0o600);
}
async function cloneFromBundle(ctx: WriterContext, paths: ReturnType<typeof writerPaths>, imageId: string, base: { ref: string; short: string; commit: string }, remote: string | undefined): Promise<void> {
  // Clone only auto-fetches refs/heads; fetch the exact bundled ref before checkout.
  const script = `set -eu\nexport GIT_CONFIG_NOSYSTEM=1\n${BOUNDARY_GIT} clone --no-hardlinks /bundles/base.bundle "$1"\ncd "$1"\n${BOUNDARY_GIT} fetch --no-tags /bundles/base.bundle "$5"\n${BOUNDARY_GIT} checkout -B "$2" "$3"\nif [ -n "$4" ]; then ${BOUNDARY_GIT} remote set-url origin "$4"; else ${BOUNDARY_GIT} remote remove origin; fi`;
  const clone = await ctx.runner.run("podman", throwawayArgs(paths, imageId, { clone: "rw", bundles: true }, script, [paths.clone, base.short, base.commit, remote ?? "", base.ref]), AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS));
  if (clone.exitCode !== 0) throw new LifecycleError("writer_clone_failed");
  await verifyCloneLayout(paths.clone);
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
    const base = await resolveBase(ctx, input.baseRef);
    const { ref, short, commit } = base;
    const imageId = await resolveImage(ctx.runner, settings.image, true);
    const remote = await git(ctx, ["remote", "get-url", "origin"], true);
    if (remote && /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/.test(remote)) throw new LifecycleError("remote_url_refused");
    if (existing && existing.phase !== "provisioning") {
      const equal = existing.imageId === imageId && existing.lifecycle === settings.lifecycle && existing.network === settings.network
        && existing.cache === settings.cache && JSON.stringify(existing.profiles) === JSON.stringify(settings.profiles)
        && JSON.stringify(existing.providers) === JSON.stringify(providers)
        && await writerEventDeliveryEnabled(paths.config) === (config.events?.delivery === "spool")
        && (input.baseRef === undefined || (existing.base.ref === `refs/heads/${short}` && existing.base.commit === commit));
      return { code: equal ? "writer_unchanged" : "writer_settings_changed", status: equal ? "unchanged" : "failed" };
    }
    if (!existing && !restart) {
      try { restart = (await readdir(paths.root)).length > 0; } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    if (restart || existing?.phase === "provisioning") await rm(paths.root, { recursive: true, force: true });
    for (const path of [paths.root, paths.clone, paths.config, paths.agent, paths.bundles, ...(settings.cache === "go" ? [paths.go] : [])]) await privateDirectory(path);
    const state: WriterState = {
      schemaVersion: 1, alias: ctx.alias, index, phase: "provisioning", lifecycle: settings.lifecycle,
      profiles: [...settings.profiles], providers, network: settings.network, cache: settings.cache, imageId,
      base: { ref: `refs/heads/${short}`, commit },
    };
    await writeWriterState(ctx.home, name, state);
    await baseBundle(ctx, paths, ref);
    await cloneFromBundle(ctx, paths, imageId, base, remote);
    await jsonFile(join(paths.config, "pi-session-mcp.json"), config);
    await jsonFile(join(paths.config, "execution-modes.json"), { schemaVersion: 1, workspaces: { [ctx.alias]: { mode: "host", acceptHostWrites: true } } });
    await jsonFile(join(paths.config, "writer-guard.json"), { schemaVersion: 1, workspace: ctx.alias, baseRef: state.base.ref, baseCommit: commit });
    await jsonFile(join(paths.agent, "auth.json"), {});
    await writeFile(paths.wrapper, renderWrapper(ctx.nodePath, ctx.releaseRoot, name), { mode: 0o700, flag: "wx" });
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

async function requiredState(ctx: WriterContext, name: string): Promise<WriterState> {
  const state = await readWriterState(ctx.home, name);
  if (!state || state.alias !== ctx.alias) throw new LifecycleError("writer_state_invalid");
  return state;
}
async function writerBase(ctx: WriterContext, name: string, state: WriterState, requested?: string) {
  if (requested !== undefined) return resolveBase(ctx, requested);
  // State normalizes remote branches to local heads. The original source ref remains
  // in the single-ref base bundle, including when no corresponding host head exists.
  const heads = await git(ctx, ["bundle", "list-heads", join(writerPaths(ctx.home, name).bundles, "base.bundle")], true);
  const match = /^(?:[0-9a-f]{40}|[0-9a-f]{64}) (refs\/(?:heads\/.+|remotes\/[^/]+\/.+))$/.exec(heads ?? "");
  const source = match?.[1];
  if (source && isSafeRefName(source) && shortBranch(source) === shortBranch(state.base.ref)) return resolveBase(ctx, source);
  return resolveBase(ctx, state.base.ref);
}
async function requireCollected(ctx: WriterContext, name: string, state: WriterState, discard: boolean): Promise<void> {
  if (discard) return;
  const work = await inspectWork(ctx, name);
  if (!work.baseline && state.collected?.digest !== work.digest) throw new LifecycleError("writer_uncollected");
}
async function refreshPrivateFiles(ctx: WriterContext, name: string, state: WriterState): Promise<void> {
  const paths = writerPaths(ctx.home, name);
  for (const path of [join(paths.config, "writer-guard.json"), join(paths.agent, "auth.json")]) await rm(path, { force: true });
  await jsonFile(join(paths.config, "writer-guard.json"), { schemaVersion: 1, workspace: ctx.alias, baseRef: state.base.ref, baseCommit: state.base.commit });
  await jsonFile(join(paths.agent, "auth.json"), {});
}

export type CollectOutcome = WriterOutcome & {
  refs: readonly string[];
  refused: number;
  findings: readonly { code: "ref_name_refused" }[];
};
export async function collectWriter(ctx: WriterContext, name: string): Promise<CollectOutcome> {
  const refs: string[] = [], findings: { code: "ref_name_refused" }[] = [];
  try {
    const paths = writerPaths(ctx.home, name);
    // Check redirects before inspecting or running any Git command on the clone.
    await verifyCloneLayout(paths.clone);
    const { collected: previous, ...state } = await requiredState(ctx, name);
    // Only this attempt's complete export may authorize a subsequent reset/recreate.
    if (previous !== undefined) await writeWriterState(ctx.home, name, state);
    const bundle = join(paths.bundles, "collect.bundle");
    await rm(bundle, { force: true });
    try {
      const script = `set -eu
export GIT_CONFIG_NOSYSTEM=1
${BOUNDARY_GIT} init --bare /tmp/scratch
export GIT_ALTERNATE_OBJECT_DIRECTORIES="$1/.git/objects"
${BOUNDARY_GIT} for-each-ref --format='%(refname) %(objectname)' refs/heads | while read -r ref commit; do
  if [ "$ref" != "$2" ] || [ "$commit" != "$3" ]; then
    ${BOUNDARY_GIT} --git-dir=/tmp/scratch update-ref "$ref" "$commit"
  fi
done
cp .git/index /tmp/index
export GIT_INDEX_FILE=/tmp/index GIT_OBJECT_DIRECTORY=/tmp/scratch/objects
${BOUNDARY_GIT} add -A
tree=$(${BOUNDARY_GIT} write-tree)
if [ "$tree" != "$(${BOUNDARY_GIT} rev-parse 'HEAD^{tree}')" ]; then
  export GIT_AUTHOR_NAME=pi-writer GIT_AUTHOR_EMAIL=pi-writer@example.invalid
  export GIT_COMMITTER_NAME=pi-writer GIT_COMMITTER_EMAIL=pi-writer@example.invalid
  commit=$(printf '%s\\n' 'WIP collected by pi-session-mcp' | ${BOUNDARY_GIT} commit-tree "$tree" -p HEAD)
  branch=$(${BOUNDARY_GIT} symbolic-ref --short HEAD || printf '%s' "$4")
  if ${BOUNDARY_GIT} --git-dir=/tmp/scratch show-ref --verify --quiet "refs/heads/$branch-wip"; then
    printf '%s\\n' ref_name_refused
  else
    ${BOUNDARY_GIT} --git-dir=/tmp/scratch update-ref "refs/heads/$branch-wip" "$commit"
  fi
fi
if [ -z "$(${BOUNDARY_GIT} --git-dir=/tmp/scratch for-each-ref --format='%(refname)')" ]; then
  printf '%s\\n' nothing_to_collect
else
  ${BOUNDARY_GIT} --git-dir=/tmp/scratch bundle create /bundles/collect.bundle --all
fi`;
      const result = await ctx.runner.run("podman", throwawayArgs(paths, state.imageId, { clone: "ro", bundles: true }, script, [paths.clone, state.base.ref, state.base.commit, shortBranch(state.base.ref)]), AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS));
      if (result.exitCode !== 0) throw new LifecycleError("writer_collect_failed");
      const messages = result.stdout.split("\n");
      for (const message of messages) if (message === "ref_name_refused") findings.push({ code: "ref_name_refused" });
      if (!messages.includes("nothing_to_collect")) {
        await collectGit(ctx, ["bundle", "verify", bundle]);
        const heads = await collectGit(ctx, ["bundle", "list-heads", bundle]);
        for (const line of heads?.split("\n") ?? []) {
          if (!line.trim()) continue;
          const match = /^(?:[0-9a-f]{40}|[0-9a-f]{64}) (refs\/heads\/(.+))$/.exec(line.trim());
          if (!match || !isSafeRefName(match[1]!) || !isSafeRefName(match[2]!)) {
            findings.push({ code: "ref_name_refused" });
            continue;
          }
          const source = match[1]!, destination = `refs/remotes/writer-${name}/${match[2]!}`;
          await collectGit(ctx, ["fetch", "--no-tags", "--end-of-options", bundle, `+${source}:${destination}`]);
          refs.push(destination);
        }
      }
      if (findings.length > 0) {
        return { status: "failed", code: "writer_collect_incomplete", refs, refused: findings.length, findings };
      }
      const work = await inspectWork(ctx, name);
      await writeWriterState(ctx.home, name, { ...state, collected: { digest: work.digest, at: new Date().toISOString() } });
      return { status: "ok", code: refs.length === 0 ? "nothing_to_collect" : "writer_collected", refs, refused: findings.length, findings };
    } finally { await rm(bundle, { force: true }); }
  } catch (error) { return { ...failure(error), refs, refused: findings.length, findings }; }
}

async function recreate(ctx: WriterContext, name: string, state: WriterState, base: { ref: string; short: string; commit: string }): Promise<WriterOutcome> {
  const paths = writerPaths(ctx.home, name);
  const remote = await git(ctx, ["remote", "get-url", "origin"], true);
  if (remote && /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/.test(remote)) throw new LifecycleError("remote_url_refused");
  await baseBundle(ctx, paths, base.ref);
  const { collected: _collected, ...retained } = state;
  const next = { ...retained, base: { ref: `refs/heads/${base.short}`, commit: base.commit } };
  await writeWriterState(ctx.home, name, { ...next, phase: "provisioning" });
  for (const path of [paths.clone, paths.agent]) {
    await rm(path, { recursive: true, force: true });
    await privateDirectory(path);
  }
  await cloneFromBundle(ctx, paths, state.imageId, base, remote);
  await refreshPrivateFiles(ctx, name, next);
  await writeWriterState(ctx.home, name, next);
  if (!(await inspectWork(ctx, name)).baseline) throw new LifecycleError("writer_recreate_failed");
  return { status: "ok", code: "writer_recreated" };
}
export async function recreateWriter(ctx: WriterContext, name: string, opts: { discard: boolean }): Promise<WriterOutcome> {
  try {
    const state = await requiredState(ctx, name);
    await requireCollected(ctx, name, state, opts.discard);
    return await recreate(ctx, name, state, await writerBase(ctx, name, state));
  } catch (error) { return failure(error); }
}

export async function resetWriter(ctx: WriterContext, name: string, opts: { discard: boolean; baseRef?: string }): Promise<WriterOutcome> {
  try {
    const state = await requiredState(ctx, name);
    const base = await writerBase(ctx, name, state, opts.baseRef);
    await requireCollected(ctx, name, state, opts.discard);
    const paths = writerPaths(ctx.home, name);
    await verifyCloneLayout(paths.clone);
    await baseBundle(ctx, paths, base.ref);
    const script = `set -eu
export GIT_CONFIG_NOSYSTEM=1
${BOUNDARY_GIT} checkout -f --detach
${BOUNDARY_GIT} fetch --no-tags /bundles/base.bundle "+$1:$1"
${BOUNDARY_GIT} checkout -f -B "$2" "$3"
${BOUNDARY_GIT} reset --hard "$3"
${BOUNDARY_GIT} for-each-ref --format='%(refname)' refs/heads | while read -r ref; do
  if [ "$ref" != "refs/heads/$2" ]; then ${BOUNDARY_GIT} update-ref -d "$ref"; fi
done
${BOUNDARY_GIT} stash clear
${BOUNDARY_GIT} clean -fd`;
    const result = await ctx.runner.run("podman", throwawayArgs(paths, state.imageId, { clone: "rw", bundles: true }, script, [base.ref, base.short, base.commit]), AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS));
    if (result.exitCode !== 0) throw new LifecycleError("writer_reset_failed");
    const next = { ...state, base: { ref: `refs/heads/${base.short}`, commit: base.commit } };
    await refreshPrivateFiles(ctx, name, next);
    await writeWriterState(ctx.home, name, next);
    try {
      await verifyCloneLayout(paths.clone);
      if (!(await inspectWork(ctx, name)).baseline) throw new LifecycleError("writer_reset_failed");
    } catch { return await recreate(ctx, name, next, base); }
    const { collected: _collected, ...cleared } = next;
    await writeWriterState(ctx.home, name, cleared);
    return { status: "ok", code: "writer_reset" };
  } catch (error) { return failure(error); }
}

export async function finishWriter(ctx: WriterContext, name: string): Promise<WriterOutcome> {
  try {
    const state = await requiredState(ctx, name);
    const collected = await collectWriter(ctx, name);
    if (collected.status === "failed") return collected;
    return state.lifecycle === "ephemeral" ? await recreateWriter(ctx, name, { discard: false }) : await resetWriter(ctx, name, { discard: false });
  } catch (error) { return failure(error); }
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
