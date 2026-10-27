# Execution Modes Plan B: Container Writers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Setup provisions, accepts, registers, collects, resets and removes rootless Podman writers per container repository, and every refusal on the way is loud.

**Architecture:** Each writer has a state directory with a path-free state file. Host Git runs only in the operator's checkout (bundles in and out). Git inside a writer's clone runs only in throwaway containers. A generated one-line wrapper starts a Node launcher. The launcher either serves a refusal server (no Podman, writer not ready) or runs the accepted `podman run` command, and it refreshes the boundary's credential copy periodically. Inside the boundary, the server's writer guard refuses a coding session while the clone holds uncollected work or another coding session is open.

**Tech Stack:** TypeScript (strict, ESM), Node.js ≥ 22.19.0 built-ins, existing pinned dependencies only (MCP SDK 2.3.1, zod 4.6.5, Pi SDK 1.2.0), rootless Podman on Linux, Vitest 5.0.3.

**Spec:** `docs/superpowers/specs/2026-10-18-execution-modes-design.md` (Plan A is merged: `execution-modes.json`, `workspace_mode_forbids_coding`, Doctor mode checks, `--repo` mode selection).

## Global Constraints

- Node.js 22.19.0 or newer, TypeScript strict, ESM, `.js` suffixes in relative imports. No new dependencies; Node built-ins and the existing exact pins only.
- Stdout is reserved for MCP frames in every server, the launcher and the refusal server. Diagnostics go to stderr, are structured, and contain no secrets, paths or prompts.
- Setup reports and state files are path-free and secret-free. Finding codes match `^[a-z][a-z0-9_]{0,63}$`.
- Host Git never runs inside a writer's clone. Git in a clone runs only in a throwaway container (`--network=none`, no credentials) or inside the writer's own boundary.
- The host credential file `~/.pi/agent/auth.json` is only read, never written, by setup and the launcher. The boundary copy holds OAuth entries with an empty `refresh` and API-key entries only for the selected profiles' providers. Cursor is refused.
- Never a silent fallback to host coding for a container repository: no Podman, missing writer, failed reset or a stale acceptance gives a stable refusal code.
- Setup never restarts servers or controllers, never rewrites other repositories' entries, and never touches other writers.
- Mutations need `--apply`, or the explicit `--remove` operation. Everything else is a dry run.
- Linux only for writer operations. On macOS, writer operations report `platform_unsupported`.
- Tests are provider-free. Podman-dependent tests use `describe.skipIf(!podmanUsable)` and print the skip reason with `console.warn("podman unavailable: <reason>")` once. Process-table lock tests are authoritative on the host only (Plan A ruling).
- All tracked documentation is English. This branch prepares 0.9.0 and does not bump the version.
- Writer names are `<alias>-w<n>` (n = 1..16). State lives below `~/.local/state/pi-session-mcp/writers/<name>/`. Registrations are named `pi-coding-<alias>-w<n>`.

## Decisions this plan adds (maintainer review)

These settle what the spec leaves to the builder. Each one is a ruling and can be changed before execution.

1. **Launcher behind a one-line wrapper.** The generated wrapper is `exec <node> <release>/dist/writer-launch.js <name> "$@"`. The launcher holds the logic (Podman probe, readiness, credential copy, refusal server) and spawns the accepted `podman run` with inherited stdio. It stays alive as the parent, which makes the periodic credential refresh possible. Python is no longer needed.
2. **Writer guard in the contained server.** Setup writes a guard file into the boundary's read-only config directory. The server reads it at every coding `pi_session_start` and refuses with `writer_uncollected` (clone not at the recorded baseline) or `writer_busy` (another coding session is open on that workspace). This enforces "uncollected work refuses a new coding session" without a server restart. It adds two start codes to the 0.9.0 contract.
3. **`--finish` = collect + reset**, the controller's one command after a task. For `ephemeral` writers, finish recreates the writer instead of resetting it.
4. **Image values.** `node` means the accepted digest `docker.io/library/node@sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d`, which setup pulls on apply. Any other value is a local 64-hex image ID that must already exist. Both are recorded by image ID and served with `--pull=never`. The optional `cache: "go"` mounts `<state>/go` and sets `GOPATH`, `GOCACHE` and `GOTOOLCHAIN=local`.
5. **Collected-ness is a work digest.** Collect records a digest of the clone's branches and work tree. Reset proceeds only when the current digest equals the recorded one (or with `--discard`).
6. **Doctor stays file-only.** `writer_dirty` compares the clone's HEAD and branch refs with the baseline by reading files. It cannot see uncommitted changes; the guard and setup can.
7. **Boundary profiles.** A selected container profile with `mcpServers`, `extensions` or a non-`builtin:` skill is refused with `container_profile_unsupported` (spec: not carried in v1).
8. **Acceptance during provisioning.** It needs a recorded host control run (`--isolation-control --apply`, explicit only). Without one, a provisioned writer stays not ready and setup reports `isolation_control_required`.

## Review Focus

1. A hostile branch name in a writer clone (`--upload-pack=x`, `a..b`, a leading `-`, a space, 300 characters) must never reach host Git as an option or invalid refspec. Collect skips it with `ref_name_refused`. (Task 4)
2. Podman disappears after setup. The next launch serves the refusal server answering `container_runtime_unavailable` on every tool and exits 0 when stdin closes. It never runs the host server. (Task 6)
3. The host credential file is missing, unparsable, or lacks a selected provider. The boundary copy becomes `{}` or holds only the providers that exist, never a partial entry with a refresh token, and the host file's bytes and mtime are unchanged. (Task 5)
4. Reset with uncommitted changes or an extra branch that was never collected refuses `writer_uncollected`. With `--discard` it succeeds, and a following guard check passes. (Task 4)
5. Provisioning is interrupted after the clone and before the state reaches `ready`. The launcher refuses `writer_not_ready`, and re-running `--repo … --apply` recreates the writer instead of reusing the half-made clone. (Tasks 3, 6)

---

### Task 1: Writer state model

**Files:**
- Create: `src/writer-state.ts`
- Modify: `src/execution-modes.ts` (container entry: `image` becomes `"node"` or `/^[0-9a-f]{64}$/`; add `cache: z.enum(["none","go"]).default("none")`; `ContainerSettings.cache`)
- Test: `test/writer-state.test.ts`, extend `test/execution-modes.test.ts`

**Interfaces:**
- Produces:
  - `WRITER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}-w([1-9]|1[0-6])$/`
  - `writerName(alias: string, index: number): string`
  - `writerRegistrationName(name: string): string` (returns `pi-coding-${name}`)
  - `writersRoot(home: string): string` (returns `<home>/.local/state/pi-session-mcp/writers`)
  - `writerPaths(home: string, name: string)` returning `{ root, clone, agent, bundles, config, go, wrapper, state }`. `config` is a directory holding `pi-session-mcp.json`, `execution-modes.json` and `writer-guard.json`. `wrapper` is `<root>/wrapper.sh`. `state` is `<root>/state.json`.
  - `WriterState` (zod strict, `schemaVersion: 1`) with these fields:
    - `alias`, `index`
    - `phase: "provisioning" | "ready" | "not_ready"`
    - `lifecycle`, `profiles`, `network`, `cache`
    - `imageId` (64 hex)
    - `base: { ref: string; commit: string }` (ref like `refs/heads/main`, commit 40 or 64 hex)
    - `acceptance?: { fingerprint: string; verdict: "pass"; network: "limited" | "not_limited"; at: string }`
    - `collected?: { digest: string; at: string }`
  - `readWriterState(home, name): Promise<WriterState | undefined>`: `undefined` when absent; throws `WriterStateError("writer_state_invalid")` when invalid.
  - `writeWriterState(home, name, state): Promise<void>`: temp file `wx` 0600, fsync, rename, directory fsync.
  - `acceptanceFingerprint(input: { wrapperDigest: string; packageVersion: string; imageId: string; podmanVersion: string; network: string; cache: string }): string` (`sha256:` + hex of the canonical JSON)
  - `WriterStateError` with `code`

- [ ] **Step 1: Write the failing tests**

`test/writer-state.test.ts`:
- `writerName("pi-session-mcp", 2)` is `"pi-session-mcp-w2"`. Index 0 and 17 throw.
- `WRITER_NAME_PATTERN` rejects `"x-w0"`, `"x-w17"`, `"X-w1"` and `"../a-w1"`.
- A state round-trips through `writeWriterState` and `readWriterState`. The file mode is `0o600`.
- An unknown key is rejected as `writer_state_invalid`. So is a path-like value in `alias`.
- An absent file returns `undefined`.
- `acceptanceFingerprint` is stable for equal input and differs when `podmanVersion` changes.
- `JSON.stringify(state)` contains no `/` outside `base.ref`.

`test/execution-modes.test.ts`:
- `image: "node"` and a 64-hex ID parse.
- `image: "latest"` and a 65-character string are rejected.
- `cache` defaults to `"none"`.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run test/writer-state.test.ts test/execution-modes.test.ts`. Expected: FAIL (module missing; image accepts "latest").

- [ ] **Step 3: Implement `src/writer-state.ts` and the schema change**

The state directory is created with mode 0700. `readWriterState` uses `lstat` and refuses a non-regular file.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/writer-state.test.ts test/execution-modes.test.ts test/setup-modes.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

`feat(writers): add the writer state model`

### Task 2: Boundary commands and the clone layout check

**Files:**
- Create: `src/writer-boundary.ts`
- Test: `test/writer-boundary.test.ts`, `test/writer-boundary.podman.test.ts`

**Interfaces:**
- Consumes: `writerPaths`, `WriterState` (Task 1); `CommandRunner` (`src/client-adapters/types.ts`).
- Produces:
  - `NODE_IMAGE_REF` (the digest from decision 4)
  - `serveArgs(paths, state, command: readonly string[], releaseRoot: string): string[]`: argv after `podman`. It reproduces the accepted wrapper:
    - `run -i --rm --pull=never --userns=keep-id --read-only --cap-drop=all --security-opt=no-new-privileges --network=<network>`
    - tmpfs `/tmp` (`rw,nosuid,nodev,size=512m`) and `/pi/home` (`rw,nosuid,nodev,mode=0700,size=64m,U`)
    - clone read-write at the same absolute path; `.git/hooks` and `.git/config` read-only
    - the release at `/opt/pi-session-mcp` read-only
    - the config dir at `/pi/config` read-only; agent at `/pi/agent` read-write
    - `--workdir <clone>`
    - env `HOME=/pi/home`, `PI_SESSION_MCP_CONFIG=/pi/config/pi-session-mcp.json`, `PI_CODING_AGENT_DIR=/pi/agent`, `PI_SESSION_MCP_WRITER_GUARD=/pi/config/writer-guard.json`
    - for `cache: "go"`: `<go>:/pi/go:rw` plus `GOPATH=/pi/go`, `GOCACHE=/pi/go/cache`, `GOTOOLCHAIN=local`
    - then `<imageId>` and `command`
  - `throwawayArgs(paths, imageId, opts: { clone: "ro" | "rw"; bundles: boolean; base?: string }, script: string, args: readonly string[]): string[]`: `run --rm -i --pull=never --network=none --userns=keep-id --read-only --cap-drop=all --security-opt=no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,size=1g -e HOME=/tmp`, plus mounts, then `<imageId> sh -c <script> sh <args...>`. Untrusted values travel only as positional arguments.
  - `BOUNDARY_GIT = "git -c safe.directory=* -c core.fsmonitor=false -c core.hooksPath=/dev/null"`: the prefix used inside every script.
  - `podmanInfo(runner): Promise<{ usable: boolean; version?: string }>`
  - `resolveImage(runner, image: string, pull: boolean): Promise<string>`: returns the 64-hex ID, or throws `BoundaryError("image_unavailable")`.
  - `verifyCloneLayout(clone: string): Promise<void>`: throws `BoundaryError("clone_verification_failed")` unless `.git` is a directory (not a symlink or gitfile), none of `commondir`, `gitdir` or `config.worktree` exists in it, and `.git/hooks` holds only regular `*.sample` files.
  - `isSafeRefName(name: string): boolean`: `/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/`, no `..`, no `//`, no trailing `/` or `.lock`.
  - `BoundaryError` with `code`

- [ ] **Step 1: Write the failing tests**

`test/writer-boundary.test.ts`:
- `serveArgs` contains `--pull=never`, `--read-only`, `--cap-drop=all`, the two `:ro` Git mounts and `PI_SESSION_MCP_WRITER_GUARD`.
- `serveArgs` never contains `--env-host`, `--privileged` or an `-e` without `=`.
- With `cache: "go"` it contains `GOTOOLCHAIN=local`.
- `throwawayArgs(..., "x", ["--upload-pack=evil"])` keeps the hostile value after `sh` as an argument, never inside the script.
- `isSafeRefName` accepts `feature/x-1` and rejects `-x`, `a..b`, `a b`, `x.lock`, `--upload-pack=x` and a 201-character name.
- `verifyCloneLayout` on temp directories:
  - passes for `.git/` with `hooks/pre-commit.sample`;
  - fails for a `.git` file, `.git/commondir`, `.git/config.worktree`, `hooks/pre-commit` and a symlinked `.git`.
- `podmanInfo` with a fake runner returning `true\n` plus version `6.1.4` gives `{usable:true, version:"6.1.4"}`; a non-zero exit gives `{usable:false}`.

`test/writer-boundary.podman.test.ts` (skipIf no Podman):
- `throwawayArgs` with `BOUNDARY_GIT --version` runs and exits 0 with the accepted image, when it is present locally. Otherwise skip with the reason `image not present`.

- [ ] **Step 2: Run and verify they fail.** Run: `npx vitest run test/writer-boundary.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `src/writer-boundary.ts`.** Probe `podman info --format {{.Host.Security.Rootless}}` and `podman version --format {{.Client.Version}}` through the injected runner. Bound everything with the runner's timeout.
- [ ] **Step 4: Run and verify they pass.** Run: `npx vitest run test/writer-boundary.test.ts test/writer-boundary.podman.test.ts`. Expected: PASS (Podman test passes or reports its skip reason).
- [ ] **Step 5: Commit.** `feat(writers): build boundary commands and check clone layout`

### Task 3: Provision and remove writers

**Files:**
- Create: `src/writer-lifecycle.ts` (provision, remove, work state)
- Test: `test/writer-provision.test.ts`, `test/writer-lifecycle.podman.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `WriterContext { home: string; releaseRoot: string; nodePath: string; runner: CommandRunner; checkout: string; alias: string }`. `checkout` is the alias's configured path, used only for host Git.
  - `provisionWriter(ctx, input: { index; settings: ContainerSettings; baseRef?: string; profiles: ReadonlyMap<string, ConfiguredExecutionProfile> }): Promise<WriterOutcome>`
  - `removeWriter(ctx, name, opts: { discard: boolean }): Promise<WriterOutcome>`
  - `inspectWork(ctx, name): Promise<{ baseline: boolean; digest: string; branches: readonly { name: string; commit: string }[]; dirty: boolean }>`
  - `WriterOutcome = { code: string; status: "ok" | "planned" | "unchanged" | "failed" }`
  - `contained configuration`: `renderContainedConfig(alias, clonePath, profiles)` returns the boundary's `pi-session-mcp.json` object. It contains only the clone as workspace, only the selected profiles, and the first selected profile as default. It throws `container_profile_unsupported` for `mcpServers`, `extensions` or a non-`builtin:` skill.

Algorithms (decisions the signatures do not carry):
- **Base.** Host Git in the checkout:
  - the default `baseRef` is the target of `refs/remotes/origin/HEAD`; else `refs/heads/main`. An explicit `--base` must resolve with `git rev-parse --verify --end-of-options <ref>^{commit}`.
  - `git bundle create <bundles>/base.bundle <ref>` records `base.commit`.
  - Origin URL: `git remote get-url origin`. A `scheme://` URL with userinfo is refused (`remote_url_refused`); scp-like `user@host:path` is allowed; no origin means no remote.
  - Every host Git call uses `GIT_CONFIG_NOSYSTEM=1` and `-c core.hooksPath=/dev/null`.
- **Image.** `resolveImage(runner, settings.image, pull: true)` runs before the clone and gives `imageId`. Only `node` is ever pulled; a missing local ID reports `image_unavailable` and writes nothing.
- **Clone.** A throwaway container with `clone: "rw"` on an empty clone directory runs:
  - `BOUNDARY_GIT clone --no-hardlinks /bundles/base.bundle <clone>`;
  - `checkout -B <short> <commit>`;
  - `remote set-url origin <url>` (or `remote remove origin`).
  - Then the host runs `verifyCloneLayout`.
- **Files.** Setup writes, all 0600 in 0700 directories:
  - `config/pi-session-mcp.json`;
  - `config/execution-modes.json` (`{alias: {mode:"host", acceptHostWrites:true}}`);
  - `config/writer-guard.json` (`{schemaVersion:1, workspace: alias, baseRef, baseCommit}`);
  - an empty `agent/auth.json` (`{}`);
  - `wrapper.sh` (Task 6 `renderWrapper`), mode 0700.
- **State order.** `phase: "provisioning"` is written before the clone and `"not_ready"` after the files. Acceptance (Task 8) sets `"ready"`. A provision that finds an existing `provisioning` or invalid state deletes the writer directory and starts over (Review Focus 5). An existing `ready` or `not_ready` writer with equal settings reports `writer_unchanged`.
- **Work state.** A throwaway container with `clone: "ro"`:
  - copies `.git/index` to `/tmp/index`;
  - with `GIT_INDEX_FILE=/tmp/index`, `GIT_OBJECT_DIRECTORY=/tmp/objects` and `GIT_ALTERNATE_OBJECT_DIRECTORIES=<clone>/.git/objects`, runs `add -A` and `write-tree`;
  - prints `HEAD`, `for-each-ref refs/heads refs/stash` and the tree ID.
  - Digest = sha256 of that output.
  - `baseline` = HEAD equals `base.commit`, the only branch is the base branch, there is no stash, and the tree equals the base commit's tree.
- **Remove.** Refuses `writer_uncollected` unless `inspectWork().baseline`, `collected.digest === digest`, or `discard`. Then it deletes the writer directory. Registration removal is Task 9's job, called by Task 10.

- [ ] **Step 1: Write the failing tests** (`test/writer-provision.test.ts`, fake runner that records argv and simulates outputs):
  - `remote_url_refused` for `https://user:tok@host/x.git`; allowed for `git@github.com:o/r.git`.
  - Provision writes the state in order: `provisioning` first, `not_ready` last.
  - All files are mode 0600 or 0700. `writer-guard.json` holds `baseCommit`.
  - `renderContainedConfig` refuses a profile with `extensions`, and one with a catalog skill `./x/SKILL.md`. It accepts `builtin:pi-session-implementation`.
  - An existing `provisioning` state leads to deletion and a fresh provision (the runner sees a second clone).
  - No recorded argv runs host `git` with `-C <clone>`. Every host Git argv targets the checkout.
- [ ] **Step 2: Run and verify they fail.** `npx vitest run test/writer-provision.test.ts`
- [ ] **Step 3: Implement provision, remove, inspectWork.**
- [ ] **Step 4: Podman integration** (`test/writer-lifecycle.podman.test.ts`, skipIf no Podman or no accepted image):
  - Provision from a temp source repo.
  - `inspectWork` reports `baseline: true`.
  - Write an untracked file in the clone from the host filesystem: `baseline: false`.
  - `removeWriter` refuses `writer_uncollected`; with `discard` the directory is gone.
- [ ] **Step 5: Run and verify they pass.** `npx vitest run test/writer-provision.test.ts test/writer-lifecycle.podman.test.ts`
- [ ] **Step 6: Commit.** `feat(writers): provision and remove writers from a base bundle`

### Task 4: Collect, reset, recreate, finish

**Files:**
- Modify: `src/writer-lifecycle.ts`
- Test: `test/writer-collect.test.ts`, extend `test/writer-lifecycle.podman.test.ts`

**Interfaces:**
- Produces:
  - `collectWriter(ctx, name): Promise<WriterOutcome & { refs: readonly string[] }>`
  - `resetWriter(ctx, name, opts: { discard: boolean; baseRef?: string })`
  - `recreateWriter(ctx, name, opts: { discard: boolean })`
  - `finishWriter(ctx, name)`: collect, then reset (persistent) or recreate (ephemeral).

Algorithms:
- **Collect.** First, the redirect check (`verifyCloneLayout`). Then a throwaway container with clone `ro` and bundles `rw` runs the following steps:
  1. Create the scratch bare repo `/tmp/scratch` with the clone's objects as alternates.
  2. For each `refs/heads/*` except the base branch at the base commit, `update-ref` the same name in the scratch repo.
  3. When the tree differs from HEAD's tree, create a WIP commit with `commit-tree -p HEAD` (author `pi-writer <pi-writer@example.invalid>`, message `WIP collected by pi-session-mcp`) and set `refs/heads/<current-branch>-wip` in the scratch repo.
  4. Run `bundle create /bundles/collect.bundle --all`.

  The host then:
  - runs `git -C <checkout> bundle verify`;
  - runs `git bundle list-heads` and skips names failing `isSafeRefName` with finding `ref_name_refused`;
  - fetches each safe ref as `+refs/heads/<n>:refs/remotes/writer-<name>/<n>`, with `--no-tags --end-of-options`;
  - deletes the bundle;
  - records `collected = { digest, at }` from `inspectWork`.

  Nothing to collect gives `nothing_to_collect`, with the digest still recorded.
- **Reset.** Refuses `writer_uncollected` unless `baseline`, `collected.digest === inspectWork().digest`, or `discard`. Then:
  1. Refresh the base bundle from the checkout (same ref, or `baseRef`).
  2. In a throwaway container with clone `rw`:
     - `checkout -f --detach`;
     - `fetch --no-tags /bundles/base.bundle +<ref>:<ref>`;
     - `checkout -f <short>`; `reset --hard <commit>`;
     - delete every other `refs/heads/*`; `stash clear`; `clean -fd` (ignored files kept).
  3. Rewrite `writer-guard.json` with the new base.
  4. Set `agent/auth.json` to `{}` and the state `base`.
  5. Verify with `inspectWork().baseline` plus `verifyCloneLayout`.

  On a failed verification, recreate and report `writer_recreated`. The work was collected or discarded before, so nothing is lost.
- **Recreate.** Same refusal rule. Delete the clone and agent copy, provision again, and keep `acceptance` (the fingerprint does not depend on the clone).

- [ ] **Step 1: Write the failing tests** (`test/writer-collect.test.ts`, fake runner):
  - `list-heads` with `refs/heads/--upload-pack=x` and `refs/heads/a..b` gives two `ref_name_refused` findings; neither reaches a fetch argv.
  - Fetch argv contains `--end-of-options` and the namespaced destination.
  - Reset without collect on a non-baseline clone refuses `writer_uncollected`; with `discard` it proceeds.
  - Reset after collect with an unchanged digest proceeds; with a changed digest (new work after collect) it refuses.
  - Failed reset verification leads to recreate (`writer_recreated`).
  - `finishWriter` for `ephemeral` calls recreate and never reset.
- [ ] **Step 2: Run and verify they fail.** `npx vitest run test/writer-collect.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Podman integration** (extend the Podman test):
  - Commit on a branch and leave an untracked file, both inside a throwaway container.
  - Collect: the checkout has `refs/remotes/writer-<name>/<branch>` and `<branch>-wip`.
  - Reset passes and `inspectWork().baseline` is true (Review Focus 4).
- [ ] **Step 5: Run and verify they pass.** `npx vitest run test/writer-collect.test.ts test/writer-lifecycle.podman.test.ts`
- [ ] **Step 6: Commit.** `feat(writers): collect, reset, recreate and finish writers`

### Task 5: Boundary credentials

**Files:**
- Create: `src/writer-credentials.ts`
- Test: `test/writer-credentials.test.ts`

**Interfaces:**
- Produces:
  - `selectBoundaryCredentials(host: unknown, providers: readonly string[]): Record<string, unknown>`
    - `oauth` entries are copied with `refresh: ""`; `api_key` entries are copied as they are.
    - Unknown types, missing providers and `cursor` are omitted.
    - Unparsable input gives `{}`.
  - `writeBoundaryCredentials(agentDir: string, value: Record<string, unknown>): Promise<void>`: atomic, 0600.
  - `expiresWithin(host: unknown, providers, minutes: number, now: number): boolean`: true when any selected OAuth entry expires within `minutes`. `expires` is in ms when > 1e12, else in s.
  - `refreshHostLogin(input: { nodePath; releaseRoot; warmupConfig: string; timeoutMs: number }): Promise<void>`. It starts the released server (`dist/main.js`) with `PI_SESSION_MCP_CONFIG=<warmupConfig>` and runs `initialize`, `pi_session_start` on workspace `warmup` and `pi_session_close` over stdio. It makes no model request, ignores stderr, and SIGTERMs after `timeoutMs` (20 000). This ports `docs/evaluation/isolation-acceptance-2026-10-18/auth-warmup.mjs`.
  - `ensureWarmupConfig(home, profiles): Promise<string>`. It writes `<writersRoot>/.warmup/config.json`: workspace `warmup` = `<writersRoot>/.warmup/empty`, and one read-only profile per selected OAuth provider with that provider's model.
  - `REFRESH_THRESHOLD_MINUTES = 20`, `REFRESH_INTERVAL_MS = 300_000`

- [ ] **Step 1: Write the failing tests:**
  - An OAuth entry keeps `access` and `expires` and gets `refresh: ""`.
  - An `api_key` entry is copied.
  - `cursor` and unselected providers are omitted; `"not json"` gives `{}`.
  - The written file is mode 0600 and contains no host refresh-token value (sentinel `"SECRET_REFRESH"`).
  - `expiresWithin` handles both units.
  - `refreshHostLogin` against a fake `main.js` that records frames sends exactly `initialize`, `notifications/initialized`, `pi_session_start` and `pi_session_close`, and never `pi_session_prompt`.
  - Review Focus 3: a missing host file gives `{}`, and a test host file's bytes and mtime are unchanged after select and write.
- [ ] **Step 2: Run and verify they fail.** `npx vitest run test/writer-credentials.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and verify they pass.**
- [ ] **Step 5: Commit.** `feat(writers): copy boundary credentials and refresh the host login`

### Task 6: Launcher, wrapper and refusal server

**Files:**
- Create: `src/writer-launch.ts` (entry, guarded by `isEntryPoint`), `src/refusal-server.ts`
- Modify: `src/writer-lifecycle.ts` (write the wrapper via `renderWrapper`)
- Test: `test/writer-launch.test.ts`, `test/refusal-server.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 5.
- Produces:
  - `renderWrapper(nodePath: string, releaseRoot: string, name: string): string`
    - `#!/bin/sh`, a comment that stdout is reserved, then `exec '<node>' '<release>/dist/writer-launch.js' '<name>' "$@"`.
    - Values single-quoted; a value containing `'` throws.
  - `wrapperDigest(text: string): string`
  - `serveRefusal(code: "container_runtime_unavailable" | "writer_not_ready", io?: { stdin; stdout }): Promise<void>`. An MCP stdio server registering the eight `pi_*` tool names with permissive object input. Every call returns `isError: true` with structured `{ ok: false, error: { code, message } }` and the same error shape as `src/server.ts`. The message is a fixed sentence per code.
  - `launch(argv: readonly string[], deps: LaunchDependencies): Promise<number>` with `LaunchDependencies { home; nodePath; releaseRoot; runner; spawnPodman(args): ChildProcess; env; now(); setInterval; clearInterval }`.

Launch algorithm:
1. If `argv[0]` fails `WRITER_NAME_PATTERN`, serve refusal `writer_not_ready`.
2. If `podmanInfo` is not usable, serve refusal `container_runtime_unavailable`.
3. Only when no command follows the name (the registered server):
   - the state must be `ready`;
   - the acceptance fingerprint must equal `acceptanceFingerprint` of the current wrapper digest, package version, image ID, Podman version, network and cache;
   - otherwise serve refusal `writer_not_ready`.

   A passed-through command (the acceptance harness's `node …`) skips this check, and the probe still gets the identical `serveArgs`.
4. Unless `env.PI_WRITER_NO_CREDENTIAL_REFRESH === "1"`:
   - if `expiresWithin` the threshold, run `refreshHostLogin`;
   - write `selectBoundaryCredentials` for the selected profiles' providers;
   - set an interval of `REFRESH_INTERVAL_MS` that repeats both steps while the child runs.
5. Spawn `podman serveArgs(...)` with inherited stdio, forward SIGINT and SIGTERM, clear the interval on exit, and return the child's exit code.

Errors never print to stdout.

- [ ] **Step 1: Write the failing tests:**
  - `renderWrapper` output passes `sh -n` and contains no unquoted value; a name with `'` throws.
  - `refusal-server.test.ts` uses the MCP SDK client over in-memory streams: `tools/list` returns the eight names; `pi_session_start` returns `container_runtime_unavailable` as `isError` with `ok:false`; stdout carries only frames.
  - `writer-launch.test.ts` (fakes):
    - unusable Podman serves `container_runtime_unavailable` and never calls `spawnPodman` (Review Focus 2);
    - a missing or `provisioning` state, or a stale fingerprint (Podman version changed), serves `writer_not_ready` (Review Focus 5);
    - a `ready` state spawns with `serveArgs`;
    - `argv ["x-w1","node","-","cfg"]` spawns even when not ready;
    - the no-refresh env skips `refreshHostLogin` and the credential write;
    - the interval re-copies after 300 000 ms of fake time and is cleared on child exit.
- [ ] **Step 2: Run and verify they fail.** `npx vitest run test/writer-launch.test.ts test/refusal-server.test.ts`
- [ ] **Step 3: Implement.** Add `writer-launch.js` (relative to `dist/`) to the release binding's required runtime files in `immutableReleaseBinding` (`src/setup.ts`).
- [ ] **Step 4: Run and verify they pass**, plus `npx vitest run test/setup-release.test.ts`.
- [ ] **Step 5: Commit.** `feat(writers): add the writer launcher, wrapper and refusal server`

### Task 7: Writer guard in the server

**Files:**
- Create: `src/writer-guard.ts`
- Modify: `src/session-registry.ts` (`RegistryErrorCode` gains `writer_uncollected`, `writer_busy`), `src/server.ts` (map both), `src/main.ts` (load the guard path from `PI_SESSION_MCP_WRITER_GUARD`), `docs/tool-contracts.md`, `skills/pi-session-orchestration/references/start-errors.md`
- Test: `test/writer-guard.test.ts`, extend `test/orchestration-skill-start-codes.test.ts` expectations if it enumerates codes

**Interfaces:**
- Produces:
  - `WriterGuard { check(workspace: string, openCodingSessions: number): Promise<void> }`. It throws `RegistryError("writer_busy")` when `openCodingSessions > 0` and `RegistryError("writer_uncollected")` when not at baseline.
  - `createWriterGuard(guardPath: string, workspaces: ReadonlyMap<string,string>, git?: GitProbe): WriterGuard`. It re-reads the guard file at every check, so a reset is seen without a restart. An unreadable or invalid guard file counts as `writer_uncollected` (fail closed). Workspaces other than the guard's `workspace` pass.
  - `GitProbe(cwd) → { head; branches; dirty; stash }`. The default runs `git -c core.hooksPath=/dev/null -c core.fsmonitor=false status --porcelain=v1 -uall`, `rev-parse HEAD` and `for-each-ref --format=%(refname) refs/heads refs/stash` with `execFile` (no shell, 10 s timeout).
  - `SessionRegistry` constructor option `writerGuard?: WriterGuard`. It is checked in `start` for `coding` profiles only, before `adapter.create`, counting this registry's open sessions on that workspace with a coding profile.

- [ ] **Step 1: Write the failing tests** (`test/writer-guard.test.ts`, fake `GitProbe` and fake adapter):
  - Without the env or option, behavior is unchanged (existing registry tests stay green).
  - A dirty clone gives `writer_uncollected` and `adapter.create` is never called.
  - An extra branch gives `writer_uncollected`; a stash gives `writer_uncollected`.
  - A second coding start while one is open gives `writer_busy`.
  - A read-only profile start passes on a dirty clone.
  - After the guard file changes to a new baseline equal to the probe, a start passes without a new registry.
  - An invalid guard file gives `writer_uncollected`.
  - Server mapping returns `{ok:false,error:{code:"writer_busy",...}}`.
- [ ] **Step 2: Run and verify they fail.** `npx vitest run test/writer-guard.test.ts`
- [ ] **Step 3: Implement.** Classify both codes in `start-errors.md` as "Controller action" (collect and reset the writer, or wait for or close the open session). Add both rows to the error table in `docs/tool-contracts.md`, with the env variable documented as boundary-only.
- [ ] **Step 4: Run and verify they pass.** `npx vitest run test/writer-guard.test.ts test/orchestration-skill-start-codes.test.ts test/server*.test.ts test/session-registry*.test.ts`
- [ ] **Step 5: Commit.** `feat(server): refuse coding sessions on writers with uncollected work`

### Task 8: Acceptance integration and Doctor writer checks

**Files:**
- Create: `src/writer-acceptance.ts`
- Modify: `src/doctor.ts` (`DoctorCheckId` gains `writer_not_ready`, `writer_dirty`, `writer_uncollected_bundle`; dependency `home?: string`, `podmanVersion?: () => Promise<string | undefined>`), `package.json` `files` (add `scripts/isolation-acceptance.mjs`, `scripts/isolation-probe.cjs`), `docs/doctor-design.md`
- Test: `test/writer-acceptance.test.ts`, `test/doctor-writers.test.ts`

**Interfaces:**
- Produces:
  - `controlStatePath(home)`, which is `<home>/.local/state/pi-session-mcp/isolation-control.json`.
  - `runIsolationControl(ctx): Promise<WriterOutcome>`. Explicit only. It clones the checkout into `~/.cache/pi-session-mcp-isolation/control/clone` with host Git. This is the harness's own disposable clone, not a writer clone. It runs `node <release>/scripts/isolation-acceptance.mjs --mode uncontained-control --launch node --workspace <clone> --out <tmp json>`, records `{schemaVersion:1, verdict, at}` (path-free), and deletes the clone.
  - `acceptWriter(ctx, name): Promise<WriterOutcome>`. It requires a control verdict of `control_detected_escapes` (else `isolation_control_required`). It runs `--mode contained --agent-dir-copy-writable --agent-dir-copy <agent> --launch "<wrapper> node" --workspace <clone>`. On exit 0 with verdict `pass` it records `acceptance` (fingerprint, the network classification from the report) and sets `phase: "ready"` (`writer_accepted`). Otherwise it reports `writer_acceptance_failed` and the phase stays `not_ready`. Report JSON is parsed only for `verdict` and `network.classification`.
  - Doctor, for each container alias and each `n ≤ writers`:
    - `writer_not_ready` (error): state absent or invalid, phase not `ready`, or the fingerprint is stale. Staleness covers the wrapper digest, package version and Podman version; the image check is `podman image exists <id>` through the injected probe. Remediation: `run pi-session-mcp-setup --repo <alias> --apply, or --writer <name> --recreate --apply`, with no path.
    - `writer_dirty` (warning). Doctor reads `.git/HEAD`, lists `.git/refs/heads` recursively and reads `.git/packed-refs`. Each read is bounded to 64 KiB and never follows symlinks. The warning fires when HEAD is not the base ref, the base ref's commit differs, or another branch exists.
    - `writer_uncollected_bundle` (warning): a non-empty `bundles` directory other than `base.bundle`.
    - When all are fine, `ok` lines for each.

- [ ] **Step 1: Write the failing tests:**
  - `acceptWriter` without a control state gives `isolation_control_required` and no harness spawn.
  - A fake harness exiting 0 with `{"verdict":"pass","network":{"classification":"not_limited"}}` gives `ready` and a fingerprint.
  - A harness exit of 1 gives `writer_acceptance_failed` and the phase stays `not_ready`.
  - The control run deletes its clone even when the harness fails.
  - Doctor on a temp home:
    - an absent state gives an error;
    - a ready state with a matching fingerprint gives ok;
    - a changed Podman version gives `writer_not_ready`;
    - an extra `.git/refs/heads/x` gives `writer_dirty`;
    - a symlinked `.git/HEAD` gives `writer_dirty` without following it;
    - `bundles/collect.bundle` gives `writer_uncollected_bundle`;
    - no output contains `/` in a subject or remediation.
  - `npm pack --dry-run --json` lists both scripts (assert in `test/setup-release.test.ts` or a new test).
- [ ] **Step 2: Run and verify they fail.** `npx vitest run test/writer-acceptance.test.ts test/doctor-writers.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and verify they pass**, plus `npx vitest run test/doctor*.test.ts`.
- [ ] **Step 5: Commit.** `feat(writers): accept writers and report them in Doctor`

### Task 9: Writer registrations

**Files:**
- Create: `src/client-adapters/writer-registration.ts`
- Modify: `src/client-adapters/types.ts` (`CommandRunner.run(command, args, signal?, options?: { cwd?: string })`), `src/setup-process.ts` (honor `cwd`), `src/setup-command-guardian.ts` (protocol accepts an optional absolute `cwd`, validated with `isAbsolute` and ≤ 4096 chars)
- Test: `test/writer-registration.test.ts`, extend `test/setup-process.test.ts`

**Interfaces:**
- Produces:
  - `WriterRegistrationIntent { client: "claude-code" | "codex"; name: string /* pi-coding-<writer> */; wrapperPath: string; projectDir: string }`
  - `createWriterRegistrationAdapter(runner): { inspect(intent): Promise<RegistrationState>; add(intent, execution?): Promise<void>; remove(intent, execution?): Promise<void> }`
    - Claude Code: `claude mcp get|add|remove <name>` with `-s local`, run with `cwd: projectDir`. `add` is `claude mcp add <name> -s local -- <wrapperPath>`.
    - The `equivalent` state requires `type: stdio`, `command: <wrapperPath>`, no args and no environment.
    - Codex (user scope, only on explicit request): `codex mcp get|add|remove <name>` with `add <name> -- <wrapperPath>`.
    - The parsers follow the bounded-text style of `claude-code.ts` and `codex.ts`.
  - `registerWriter`, `unregisterWriter(ownership: OwnershipStore, adapter, intent)`. They use `ownership.transaction` with the target `{ client, scope: client === "codex" ? "user" : "local", alias: intent.name }` and the guardian `mutationRunner`. The fingerprint is sha256 of `{wrapper: wrapperPath, digest}`. They follow `SetupOrchestrator.apply`'s pending/owned protocol: a divergent unowned registration is never replaced (`divergence_requires_replacement`).

- [ ] **Step 1: Write the failing tests:**
  - With fake `claude` outputs: absent leads to `add` with exact argv and `cwd`; an equivalent registration is unchanged; a registration with an environment or a different command is `divergent` and `add` is never called.
  - Unregister of an unowned registration refuses `ownership_unavailable`.
  - `setup-process` runs `pwd` with `cwd` set and returns that directory.
  - The guardian rejects a relative `cwd` request.
- [ ] **Step 2: Run and verify they fail.** `npx vitest run test/writer-registration.test.ts test/setup-process.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and verify they pass** (host run authoritative for guardian and process-table tests).
- [ ] **Step 5: Commit.** `feat(setup): register writer servers per writer`

### Task 10: Setup operations

**Files:**
- Create: `src/setup-writers.ts`
- Modify: `src/setup-cli.ts`, `src/setup-main.ts`, `src/setup-modes.ts` (after a container mode is applied, call `reconcileWriters`; transitions)
- Test: `test/setup-writers.test.ts`, extend `test/setup-cli.test.ts`, `test/setup-modes.test.ts`, `test/setup-main.test.ts`

**Interfaces:**
- Consumes: Tasks 1–9.
- Produces:
  - CLI flags:
    - `--writer <name>` with exactly one of `--collect`, `--reset`, `--recreate`, `--finish`, `--remove` (the existing operation) or `--verify`;
    - `--discard` (only with reset, recreate or remove);
    - `--base <ref>` (only with `--repo` or `--reset`);
    - `--client codex` (with `--repo`, adds Codex registrations);
    - `--isolation-control`.
  - Everything is dry-run unless `--apply`; `--remove` and `--verify` are explicit operations. Combination errors give `usage_invalid` (exit 64).
  - Findings use the target `{ client: "writer", scope: <alias>, alias: <writer name> }`. The control run uses `{ client: "writer", scope: "host", alias: "control" }`.
  - `reconcileWriters(configPath, alias, request: { apply; discard; baseRef?; codex: boolean }, deps): Promise<SetupResult>`
    - For container mode: provision missing writers `1..N`; remove writers above `N` (refuse `writer_uncollected` without `--discard`); accept each `not_ready` writer; register each ready writer; and report `controllers_restart_required` once when anything changed.
    - Changing an alias away from `container` removes all its writers and registrations. Without `--discard`, any uncollected work refuses the whole change before the modes file is written.
    - Writer operations bypass the Doctor gate for their own alias only (spec).
  - `runWriterOperation(name, operation, opts, deps)` for `--writer`. `--verify` runs Doctor for that writer, registration equality, and a bounded MCP handshake through the wrapper with `PI_WRITER_NO_CREDENTIAL_REFRESH=1`, using `verifyMcpCapabilities` with a launcher for `[wrapperPath]`. It starts no session and touches no credential.
  - Each writer operation holds a per-writer lock (`acquireOverrideLock(<writer root>)`). A second concurrent operation gets `lock_held` (or the existing lock code).

- [ ] **Step 1: Write the failing tests** (`test/setup-writers.test.ts`, fakes for the lifecycle, acceptance and registration functions):
  - `--repo x --mode container --profiles code --writers 2 --apply` provisions w1 and w2, accepts both, registers both, and reports `controllers_restart_required`.
  - The dry run calls no mutating fake.
  - `--writers 1` with an uncollected w2 refuses `writer_uncollected`, and the modes file is unchanged.
  - `--mode read-only` with clean writers removes both writers and their registrations.
  - `--writer x-w1 --finish --apply` calls collect, then reset.
  - `--writer x-w1 --remove` without `--discard` on uncollected work refuses.
  - `--writer x-w1 --verify` sets the no-refresh env.
  - macOS platform gives `platform_unsupported`.
  - `parseSetupArgs` rejects `--discard` with `--collect`, `--writer` with `--target`, `--base` with `--collect`, and a name failing `WRITER_NAME_PATTERN`.
  - Reports contain no `/` outside codes and targets.
- [ ] **Step 2: Run and verify they fail.** `npx vitest run test/setup-writers.test.ts test/setup-cli.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and verify they pass.** `npx vitest run test/setup*.test.ts`
- [ ] **Step 5: Commit.** `feat(setup): provision, finish and remove writers from setup`

### Task 11: Controller skill and documentation

**Files:**
- Modify:
  - `skills/pi-session-orchestration/SKILL.md` (a "Finish a task on a writer" step: collect and reset with `pi-session-mcp-setup --writer <name> --finish --apply` after taking over the result, before the next task; never run Git inside the writer's clone);
  - `skills/pi-session-orchestration/references/start-errors.md`;
  - `docs/execution-modes.md` (replace "Plan B is pending" with the writer lifecycle, flags, finding codes, readiness and migration);
  - `docs/isolation-setup.md` (now the reference for what setup automates; migration of hand-made writers: remove the manual registration and directory, then `--repo … --apply`);
  - `docs/tool-contracts.md`, `docs/doctor-design.md`, `docs/adr/0009-execution-modes.md` (a Plan B section with decisions 1–8 above), `docs/installation.md` (link), `CHANGELOG.md` (Unreleased), the roadmap.
- Test: existing skill and doc tests; `test/orchestration-skill-*.test.ts` stay green.

- [ ] **Step 1: Write a failing test.** Add the following assertions to `test/orchestration-skill-start-codes.test.ts` (or the skill test that covers sections):
  - SKILL.md mentions `--finish`;
  - `start-errors.md` classifies `writer_uncollected`, `writer_busy`, `writer_not_ready` and `container_runtime_unavailable` exactly once each.
- [ ] **Step 2: Run and verify it fails.**
- [ ] **Step 3: Write the documentation.** Each new finding and Doctor code appears once in a table with its meaning. The migration covers `psm-alpha` and `go-app-alpha`. Residual risks (provider credentials in the boundary, network `pasta` not limited) are restated.
- [ ] **Step 4: Run** `npx vitest run` (full suite on the host), `npm run typecheck`, `npm run build && npm run build:cli`, `npm run eval:schemas -- --check`, and the relative link check. Expected: all pass, with the Podman tests either passing or reporting their skip reason.
- [ ] **Step 5: Commit.** `docs: document container writers and the controller finish step`
