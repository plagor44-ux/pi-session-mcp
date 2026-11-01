import { rm } from "node:fs/promises";
import { join } from "node:path";
import { BOUNDARY_GIT, IMAGE_PULL_TIMEOUT_MS, throwawayArgs, verifyCloneLayout } from "./writer-boundary.js";
import type { WriterContext, WriterOutcome } from "./writer-lifecycle.js";
import { readWriterState, writerPaths } from "./writer-state.js";

export const RECOVERY_SLOT_CAP = 10_000;
export type RecoveryFinding = WriterOutcome & { slot?: number };
export type RecoveryOutcome = RecoveryFinding & { warnings?: RecoveryFinding[] };

// Git's quoted, line-delimited listing is decoded only to construct NUL-delimited index-info.
// The manifest always contains the original, unmodified ls-files -u -z bytes.
export const RECOVERY_SCRIPT = String.raw`set -eu
export LC_ALL=C GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=pi-writer GIT_AUTHOR_EMAIL=pi-writer@example.invalid
export GIT_COMMITTER_NAME=pi-writer GIT_COMMITTER_EMAIL=pi-writer@example.invalid
g() { BOUNDARY_COMMAND -c core.attributesFile=/dev/null -c core.quotePath=true "$@"; }
# Refuse configuration indirection before any command that might invoke a driver.
if g config --local --no-includes --get-regexp '^(filter\.|include)' > /tmp/config-keys; then exit 1; else [ "$?" = 1 ] || exit 1; fi
g init --bare -q /tmp/scratch
export GIT_OBJECT_DIRECTORY=/tmp/scratch/objects GIT_ALTERNATE_OBJECT_DIRECTORIES="$1/.git/objects"
# Copy the index using Git's binary-safe blob I/O; the image needs no utility runtime.
index_blob=$(g hash-object -w --no-filters "$1/.git/index")
g cat-file blob "$index_blob" > /tmp/original-index
export GIT_INDEX_FILE=/tmp/original-index
g ls-files -u -z > /tmp/unmerged
[ -s /tmp/unmerged ] || { echo nothing_to_recover; exit 0; }
g ls-files -u > /tmp/quoted
head=$(g rev-parse --verify HEAD)
printf '%s\n' "$head" > /tmp/head
# Decode Git C quoting without eval, preserving trailing newlines with a sentinel.
decode() {
  case "$1" in
    \"*) rest=@{1#\"}; rest=@{rest%\"};;
    *) printf '%s' "$1"; return;;
  esac
  while [ -n "$rest" ]; do
    char=@{rest%"@{rest#?}"}; rest=@{rest#?}
    if [ "$char" = '\' ]; then
      char=@{rest%"@{rest#?}"}; rest=@{rest#?}
      case "$char" in
        [0-7]) a=@{rest%"@{rest#?}"}; rest=@{rest#?}; b=@{rest%"@{rest#?}"}; rest=@{rest#?}; printf '%b' "\\0$char$a$b";;
        '"') printf '"';;
        '\') printf '\\';;
        *) printf '%b' "\\$char";;
      esac
    else printf '%s' "$char"; fi
  done
}
save() {
  tree=$(g write-tree)
  g ls-tree -r "$tree" > /tmp/tree-entries
  while IFS=' ' read -r mode rest; do
    [ "$mode" != 160000 ] || { echo writer_recover_unsupported; exit 0; }
  done < /tmp/tree-entries
  oid=$(g commit-tree "$tree" -p "$head" -m "recovery $1")
  g --git-dir=/tmp/scratch update-ref "refs/heads/recovery/$1" "$oid"
}
: > /tmp/removals
for s in 1 2 3; do : > "/tmp/stage$s"; done
while IFS= read -r record; do
  tab=$(printf '\t')
  meta=@{record%%"$tab"*}
  path=@{record#*"$tab"}
  set -- $meta
  mode=$1 oid=$2 stage=$3
  [ "$mode" != 160000 ] || { echo writer_recover_unsupported; exit 0; }
  g cat-file -e "$oid^{blob}"
  path=$(decode "$path"; printf '.')
  path=@{path%.}
  printf '0 %s\t%s\0' "$oid" "$path" >> /tmp/removals
  printf '%s %s\t%s\0' "$mode" "$oid" "$path" >> "/tmp/stage$stage"
done < /tmp/quoted
for s in 1 2 3; do
  [ -s "/tmp/stage$s" ] || continue
  export GIT_INDEX_FILE="/tmp/index$s"
  g read-tree "$head"
  g update-index -z --index-info < /tmp/removals
  g update-index -z --index-info < "/tmp/stage$s"
  save "stage$s"
done
export GIT_INDEX_FILE=/tmp/worktree-index
g read-tree "$head"
g add -A
save worktree
export GIT_INDEX_FILE=/tmp/manifest-index
g read-tree --empty
manifest_file() {
  blob=$(g hash-object -w "$2")
  g update-index --add --cacheinfo "100644,$blob,$1"
}
manifest_file unmerged-index.txt /tmp/unmerged
manifest_file head.txt /tmp/head
if [ -f .git/MERGE_HEAD ]; then manifest_file merge-head.txt .git/MERGE_HEAD; fi
save manifest
g --git-dir=/tmp/scratch bundle create /bundles/recover.bundle --all
echo recovered
`.replaceAll("@{", "${").replace("BOUNDARY_COMMAND", BOUNDARY_GIT);

interface Head { oid: string; source: string; part: string }

/** Called only after setup's lock, lease, fence and Doctor gate. Never updates writer state. */
export async function recoverWriter(ctx: WriterContext, name: string): Promise<RecoveryOutcome> {
  const paths = writerPaths(ctx.home, name), bundle = join(paths.bundles, "recover.bundle");
  const warnings: RecoveryFinding[] = [];
  const run = (command: string, args: readonly string[]) => ctx.runner.run(command, args, AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS), ctx.leaseFd === undefined ? undefined : { inheritFds: [ctx.leaseFd] });
  const rawGit = (...args: string[]) => run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.useReplaceRefs=false", "-C", ctx.checkout, ...args]);
  const git = async (...args: string[]) => { const r = await rawGit(...args); if (r.exitCode !== 0) throw Error("git failed"); return r.stdout; };
  const execute = async (): Promise<RecoveryFinding> => {
    const state = await readWriterState(ctx.home, name);
    if (!state || state.alias !== ctx.alias) throw Error("state refused");
    await verifyCloneLayout(paths.clone);
    const root = `refs/recovery/writer-${name}/`;
    const scanSlots = async () => {
      const existing = (await git("for-each-ref", "--format=%(refname)", root)).trim().split("\n");
      const slots = new Map<number, Set<string>>();
      for (const ref of existing) {
        const m = /^(\d+)(?:\/(.*))?$/.exec(ref.slice(root.length));
        if (!ref.startsWith(root) || !m) continue;
        const slot = Number(m[1]);
        if (!Number.isSafeInteger(slot)) throw Error("invalid slot");
        const set = slots.get(slot) ?? new Set<string>(); set.add(m[2] ?? ""); slots.set(slot, set);
      }
      for (const [slot, set] of slots) {
        if (!set.has("manifest") && !warnings.some(warning => warning.code === "writer_recover_incomplete" && warning.slot === slot)) {
          warnings.push({ status: "unchanged", code: "writer_recover_incomplete", slot });
        }
      }
      return slots;
    };
    await scanSlots();
    await rm(bundle, { force: true });
    const r = await run("podman", throwawayArgs(name, paths, state.imageId, { clone: "ro", bundles: true }, RECOVERY_SCRIPT, [paths.clone]));
    if (r.exitCode !== 0) throw Error("container failed");
    if (r.stdout.trim() === "nothing_to_recover") return { status: "unchanged", code: "nothing_to_recover" };
    if (r.stdout.trim() === "writer_recover_unsupported") return { status: "failed", code: "writer_recover_unsupported" };
    if (r.stdout.trim() !== "recovered") throw Error("invalid container output");
    await git("bundle", "verify", bundle);
    const heads: Head[] = (await git("bundle", "list-heads", bundle)).trim().split("\n").map(line => {
      const m = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/heads\/recovery\/(stage[123]|worktree|manifest))$/.exec(line);
      if (!m) throw Error("invalid head");
      return { oid: m[1]!, source: m[2]!, part: m[3]! };
    });
    const parts = new Set(heads.map(h => h.part));
    if (parts.size !== heads.length || !parts.has("manifest") || !parts.has("worktree")) throw Error("invalid heads");
    await git("-c", "transfer.fsckObjects=true", "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--end-of-options", bundle, ...heads.map(h => h.source));
    const manifest = heads.find(h => h.part === "manifest")!.oid;
    const head = (await git("show", `${manifest}:head.txt`)).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw Error("invalid parent");
    const entries = await git("show", `${manifest}:unmerged-index.txt`);
    if (!entries.endsWith("\0")) throw Error("invalid manifest");
    const stages = new Set<string>();
    for (const record of entries.slice(0, -1).split("\0")) {
      const m = /^(100644|100755|120000) ([0-9a-f]{40}|[0-9a-f]{64}) ([123])\t([\s\S]+)$/.exec(record);
      if (!m) throw Error("invalid manifest entry");
      stages.add(`stage${m[3]}`);
      if ((await git("cat-file", "-t", m[2]!)).trim() !== "blob") throw Error("invalid blob");
    }
    for (const stage of ["stage1", "stage2", "stage3"]) if (stages.has(stage) !== parts.has(stage)) throw Error("stage mismatch");
    for (const h of heads) {
      if ((await git("cat-file", "-t", h.oid)).trim() !== "commit" || (await git("rev-list", "--parents", "-n", "1", h.oid)).trim() !== `${h.oid} ${head}`) throw Error("parent mismatch");
    }
    const slots = await scanSlots();
    const slot = Math.max(0, ...slots.keys()) + 1;
    if (slot > RECOVERY_SLOT_CAP) throw Error("slot cap");
    // Older Git releases can treat a dangling symbolic ref as absent even with create/no-deref.
    // Refuse one explicitly as well; the transaction remains the authoritative collision check.
    for (const h of heads) {
      const symbolic = await rawGit("symbolic-ref", "--quiet", `${root}${slot}/${h.part}`);
      if (symbolic.exitCode === 0) return { status: "failed", code: "writer_recover_conflict", slot };
      if (symbolic.exitCode !== 1) throw Error("ref inspection failed");
    }
    const transact = async (selected: Head[]) => {
      // CommandRunner has no stdin channel. A Git shell alias supplies a fixed here-document;
      // all interpolated tokens are validated OIDs, fixed part names and a configured writer name.
      const commands = ["start", ...selected.map(h => `create ${root}${slot}/${h.part} ${h.oid}`), "prepare", "commit"].join("\n");
      return rawGit("-c", `alias.writer-recovery=!LC_ALL=C git update-ref --no-deref --stdin <<'RECOVERY_REFS'\n${commands}\nRECOVERY_REFS`, "writer-recovery");
    };
    try {
      const partResult = await transact(heads.filter(h => h.part !== "manifest"));
      if (partResult.exitCode !== 0) return {
        status: "failed", slot,
        code: partResult.stdout.includes("prepare: ok") ? "writer_recover_incomplete"
          : /already exists|reference exists|exists; cannot create/.test(partResult.stderr) ? "writer_recover_conflict" : "writer_recover_failed",
      };
      const manifestResult = await transact(heads.filter(h => h.part === "manifest"));
      if (manifestResult.exitCode !== 0) return { status: "failed", code: "writer_recover_incomplete", slot };
    } catch {
      // A killed command may have published some loose refs. Never roll it back or claim success.
      return { status: "failed", code: "writer_recover_incomplete", slot };
    }
    return { status: "ok", code: "writer_recovered", slot };
  };
  let outcome: RecoveryFinding;
  try { outcome = await execute(); }
  catch { outcome = { status: "failed", code: "writer_recover_failed" }; }
  finally {
    try { await rm(bundle, { force: true }); }
    catch { warnings.push({ status: "unchanged", code: "writer_recover_bundle_left" }); }
  }
  return warnings.length ? { ...outcome, warnings } : outcome;
}
