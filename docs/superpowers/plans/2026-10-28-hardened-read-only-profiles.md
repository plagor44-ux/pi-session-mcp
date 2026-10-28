# Plan: hardened read-only profiles (#169, ADR 0013)

Branch: `feat/169-hardened-read-only`. The decision record is
[ADR 0013](../../adr/0013-hardened-read-only-profiles.md); it is the contract.
Read it first. Follow `AGENTS.md` (ESM, `.js` suffixes, strict TS, stdout
reserved for MCP frames, Pi only behind `PiSessionAdapter`, only documented
SDK root exports from `@earendil-works/pi-coding-agent` 1.4.0).

Work test-first per task. Commit per task with a conventional message ending in
`(#169)`. Do not push, do not bump the version.

## Task 1: path confinement module

New `src/confined-tools.ts`.

- `allowedReadRoots(workspace: string, skills: readonly Skill[]): Promise<string[]>`:
  `realpath` of the workspace and of `dirname(skill.filePath)` for each
  selected skill, deduplicated.
- `confineToolPath(input: unknown, cwd: string, roots: readonly string[]): Promise<string>`:
  `undefined` or `""` means `"."`. Refuse non-strings and any string that
  starts with `@` or `~`, starts with `file:`, or contains NUL or a character
  of `/[  -   　]/` (the SDK's
  `normalizePath` would rewrite these; see
  `node_modules/@earendil-works/pi-coding-agent/dist/utils/paths.js`). Then
  `resolve(cwd, input)`, canonicalize with `realpath`, or for a missing path
  the nearest existing ancestor's `realpath` plus the remaining segments (same
  idea as `canonical` in `eval/extensions/tools.ts`). Allowed if equal to a
  root or below it (`root + sep` prefix). Refusal throws
  `new Error("Path is outside the allowed read roots")`, never echoing the path.
- `createConfinedReadOnlyTools(cwd, roots): ToolDefinition[]` returns
  definitions named `read`, `grep`, `find`, `ls`, created with
  `createReadToolDefinition`, `createGrepToolDefinition`,
  `createFindToolDefinition`, `createLsToolDefinition` (root exports) and
  wrapped so that `execute` first runs `confineToolPath` on `params.path`
  (all four tools name the argument `path`; verify in
  `dist/core/tools/*.d.ts`), then delegates with unchanged params.
  Pass `operations` that re-check the absolute path with the same root test
  (via `realpath`) before delegating to `node:fs/promises`:
  read (`access`, `readFile`, `detectImageMimeType` if the default does
  more than nothing; otherwise omit it), grep (`isDirectory`, `readFile`),
  ls (`exists`, `stat`, `readdir`). Give `find` **no** operations: custom
  `FindOperations` without `glob` would still use `fd`, but keep it simple and
  rely on the wrapper.

Tests `test/confined-tools.test.ts` on real temporary directories (no
provider): relative inside, absolute inside, `..` escaping, absolute outside,
symlink inside the workspace pointing outside (file and directory) for each
tool, `~`, `@`, `file:` and Unicode-space refusals, missing path inside
(allowed by the check, then the SDK's own not-found error), skill directory as
extra root, `grep` and `find` with an outside `path`, `grep` over a directory
containing an outward symlink not returning outside content.

## Task 2: wire confinement into the adapter

`src/sdk-pi-adapter.ts`, both `create` and `createWithExtensions`, for
`permissionProfile === "read-only"` only:

- compute roots from `input.cwd` and the loaded skills, build the confined
  definitions and append them to `customTools` together with the MCP tools;
- the tool allowlist names stay as today;
- in `admit`, for read-only sessions, require
  `session.getToolDefinition(name) === <our definition>` for each confined
  name (and for `bash` from Task 3); otherwise fail at stage `postcheck` with
  `pi_session_creation_failed`.

Extend `test/sdk-pi-adapter.test.ts` (fake `createSession`) to assert the
custom tools are passed for read-only and not for coding, and the admission
failure when the session reports another definition. Coding profiles must be
byte-for-byte unchanged in behavior.

## Task 3: `shell: "sandboxed"`

Config (`src/config.ts`, `src/execution-profile.ts`): optional
`shell: z.literal("sandboxed")` on the profile schema; superRefine rejects it
unless `permissionProfile === "read-only"`, when `grantedExtensionTools` is
set, and when `process.platform !== "linux"` (inject the platform for tests
the way existing code does, or read it through a small helper). Carry it into
`ConfiguredExecutionProfile` and `ResolvedExecutionProfile`
(`toResolvedExecutionProfile`).

Tools: `src/session-tools.ts` gets the notion that a read-only profile with a
sandboxed shell also has `bash` (helper such as `profileTools(profile)`), used
by both adapter paths and `composeSessionTools`.

New `src/sandbox-shell.ts`:

- `BWRAP_PATH = "/usr/bin/bwrap"`; trusted only if
  `isTrustedSystemBinary` from `src/setup-platform.ts` holds.
- `sandboxArgs(input: { workspace: string; gitCommonDir?: string; cwd: string; rootEntries: ... }): string[]`,
  a pure function producing exactly the ADR's argument list:
  `--unshare-all --disable-userns --die-with-parent --new-session --clearenv
  --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /tmp/home
  --ro-bind /usr /usr`, for each of `/bin`, `/lib`, `/lib64`, `/sbin`:
  `--symlink <target> <path>` if it is a symlink on the host, `--ro-bind` if
  it is a directory, nothing if absent; `--ro-bind /etc /etc --dev /dev
  --proc /proc --tmpfs /tmp --dir /tmp/home`, then
  `--overlay-src <ws> --tmp-overlay <ws>`, optionally the same for the Git
  common dir, then `--chdir <cwd> -- /usr/bin/bash -c <command>`. Host facts
  (lstat/readlink) come through an injectable dependency.
- `resolveWorktreeGitDir(workspace)`: only when `<ws>/.git` is a regular file
  with `gitdir: <path>`; accept only if that path (made absolute against the
  workspace) is `<common>/worktrees/<name>`, `<gitdir>/gitdir` names
  `<ws>/.git` (compare realpaths), `<gitdir>/commondir` resolves to
  `<common>`, and `<common>` contains `HEAD`, `objects/`, `refs/`. Otherwise
  `undefined`. Never throws for bad content.
- `createSandboxedBashOperations(...)`: `exec(command, cwd, { onData, signal, timeout })`
  ignores the passed `env`, refuses a `cwd` outside the workspace root,
  spawns bwrap with `env: {}` and stdin ignored, streams stdout and stderr to
  `onData`, kills bwrap with SIGKILL on abort or timeout, and resolves
  `exitCode` (signal termination as 128 + signal number, per the SDK doc).
  The spawn function is injectable so tests use a fake runner.
- `probeSandbox(...)`: runs `/usr/bin/true` with the same arguments, bounded
  (e.g. 5 s); returns boolean.

Adapter: for profiles with `shell: "sandboxed"`, check the trusted binary and
run the probe before creating the session; on failure throw
`PiSessionCreationError("sandbox_unavailable")` at a new diagnostic stage
`sandbox`. Then add `createBashToolDefinition(cwd, { operations,
exposeSessionEnvironment: false })` to the custom tools and `bash` to the
allowlist, and include it in the admission identity check.

New error code `sandbox_unavailable` in `src/pi-adapter.ts` with message
`Read-only shell sandbox is not available` and class `needs_operator`; follow
how `extension_tool_missing` is threaded through (`grep -rn extension_tool_missing src`,
including `src/writer-relay.ts`' code list and the MCP error projection).

Tests: config validation cases; `sandboxArgs` exact output for merged and
non-merged `/usr` hosts and with a Git common dir; `resolveWorktreeGitDir`
accept and each reject case (missing back-pointer, wrong shape, pointer to an
unrelated directory such as a fake home, missing `objects`); exec with a fake
spawner: env not forwarded, abort/timeout kill, exit-code mapping, cwd outside
refused; adapter fail-closed paths (untrusted binary, failing probe) with no
session created. One opt-in real test file `test/sandbox-shell.bwrap.test.ts`
that `skipIf`s unless `/usr/bin/bwrap` is trusted and the probe succeeds:
write inside the sandbox is not visible on the host afterwards, no network
(e.g. `getent hosts example.com` or a TCP connect fails), the operator home
is not visible, `git log` works in a plain repo and in a linked worktree.

## Task 4: Doctor and capabilities

- `src/doctor.ts`: new check ids `sandbox_unavailable` (error, subject the
  profile alias, for each profile with `shell: "sandboxed"`: trusted binary,
  probe with the fixed arguments against a temporary empty directory) and
  `workspace_git_unavailable` (warning per workspace whose `.git` is a file
  that `resolveWorktreeGitDir` rejects, only when some profile has a
  sandboxed shell). Probes injectable in `DoctorDependencies`; tests in a new
  `test/doctor-sandbox.test.ts`.
- `src/capabilities.ts`: `shell: "none" | "sandboxed"` after
  `grantedExtensionTools`. Update `test/capabilities.test.ts`, the setup
  verifier's capability validation (`validCapabilities` in
  `src/client-adapters/mcp-verifier.ts`) and its tests, and
  `eval/controller-skill/plugin/evals/mocks/pi-session-mcp/_tools.json` only
  if it embeds a capabilities sample.

## Task 5: documentation

English only. Update `docs/threat-model.md` (confinement, sandbox, residual
risks from the ADR's consequences), `docs/installation.md` (bubblewrap
prerequisite, AppArmor/userns note, sandbox toolchain limits),
`docs/session-mcp.md` and `docs/tool-contracts.md` (field, error code,
confinement error), `pi-session-mcp.example.json` if it shows profile fields,
`CHANGELOG.md` under an Unreleased section (breaking: read-only confinement),
and the ADR index wherever ADRs are listed (`grep -rn "0012-leased" docs README.md`).

## Gates

`npm run typecheck`, the targeted test files, then `npm test`. Report exact
results; list any lock or hook test that times out by file and test name
instead of changing it.
