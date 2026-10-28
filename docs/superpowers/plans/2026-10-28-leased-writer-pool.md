# Leased Writer Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coding on `container` workspaces runs through the single host registration `pi-session-mcp`, which leases a writer per session, spawns the writer's launcher and relays the session over MCP stdio.

**Architecture:** Two tracks with disjoint files. Track A (fence) adds a per-writer `flock` lease, a Podman container fence, a fenced launcher and fenced setup operations, then migrates writers off their client registrations. Track B (relay) adds the default base, the contract plumbing in registry, server and capabilities, the relay adapter with pool allocation, and the Doctor checks. The controller integrates each task into `feat/157-leased-writer-pool`.

**Tech Stack:** Node.js >= 22.19, TypeScript strict ESM, zod, Vitest, `@modelcontextprotocol/client` 2.3.1 package-root exports, rootless Podman, util-linux `flock`.

**Spec:** [ADR 0012](../../adr/0012-leased-writer-pool.md), issue [#157](https://github.com/plagor44-ux/pi-session-mcp/issues/157).

## Global Constraints

- Follow `AGENTS.md`. In particular: stdout only for MCP frames; no tool argument that accepts a path or `cwd`; Pi stays behind `PiSessionAdapter`; tests use fakes and no provider credentials; the `getAuth` refresh stays in the launcher (#142) and is not widened; Doctor stays offline; setup stays dry-run by default.
- Pin dependencies exactly; add none unless a task says so (none does).
- Linux only for lease, fence and relay. On other platforms container workspaces keep failing as today.
- Diagnostics are structured JSON on stderr and never contain paths, prompts, branch names or credentials.
- Public error codes added by this plan, exactly: `writer_unavailable`, `writer_session_lost`, `base_not_applicable`, `writer_busy` (setup and launcher refusal), `writer_fenced`, `writer_lease_unavailable`, `workspace_base_ambiguous`. Removed: `writer_reconnect_required`.
- `writer_unavailable` reasons, exactly: `none_ready`, `none_at_base`, `none_admitted`; counts keys, exactly: `busy`, `notAtBaseline`, `settingsChanged`.
- Constants, exactly: `RELAY_START_BUDGET_MS = 60_000`, `RELAY_POLL_INTERVAL_MS = 1_000`, `RELAY_CALL_TIMEOUT_MS = 10_000`, `RELAY_PREFLIGHT_DEADLINE_MS = 15_000`, `RELAY_ABORT_DEADLINE_MS = 15_000`, `RELAY_CLEANUP_DEADLINE_MS = 10_000`, `RELAY_MAX_RESPONSE_BYTES = 524_288`, `LAUNCHER_CLEANUP_BOUND_MS = 40_000`, `SETUP_LEASE_WAIT_MS = 10_000`, `FENCE_STOP_TIMEOUT_MS = 20_000`.
- Names, exactly: lease file `~/.local/state/pi-session-mcp/leases/<name>.lock` (directory 0700, file 0600); container name `pi-writer-<name>`; label `pi-session-mcp.writer=<name>`; inherited lease env `PI_WRITER_LEASE_FD`; writer state field `launch: "legacy" | "relay"` (default `"legacy"`); execution-modes container field `base` (short branch name).
- Every task runs `npm run typecheck`, its targeted tests, then `npm test`. Inside a writer, report lock and hook test timeouts by file and test name instead of changing them.
- English for all tracked text. No version bump in this plan; the release is a separate maintainer step.

## Review Focus

1. **Host server killed mid-turn (SIGKILL):** the launcher sees stdin end, stops its container and releases the lease; the next start on that writer succeeds. Test in Task 3.
2. **Two servers start on a one-writer workspace at once:** exactly one session starts; the other gets `writer_unavailable` with reason `none_admitted` and `busy: 1`. Test in Task 7.
3. **Inner turn completes while the abort is in flight:** the outer turn ends `completed`, not `aborted`. Test in Task 7.
4. **Writer reset to another branch between selection and lease:** the relay closes the inner session and moves on; the session never starts on the moved writer. Test in Task 7.
5. **Oversized or malformed inner responses:** the turn fails or the start moves on; nothing is passed through raw, and the session becomes lost when the transport state is unknown. Test in Task 7.

---

## Execution order

| Round | Writer w1 (track A) | Writer w2 (track B) |
|---|---|---|
| 1 | Task 1 | Task 5 |
| 2 | Task 2 | Task 6 |
| 3 | Task 3 | Task 7 |
| 4 | Task 4 (needs Task 5) | Task 9 (needs Task 3) |
| 5 | Task 8 | — |
| 6 | Task 10 (controller) | — |

Each task starts from the current integration branch, after the controller resets the writer to it.

---

### Task 1: Writer lease

**Files:**
- Create: `src/writer-lease.ts`
- Modify: `src/override-lock.ts` (export `flockBinary` and `lockWithFlock` unchanged in behaviour; add a non-blocking mode)
- Test: `test/writer-lease.test.ts`

**Interfaces:**
- Produces:
  - `export const LEASE_DIRECTORY = [".local", "state", "pi-session-mcp", "leases"] as const`
  - `export function writerLeasePath(home: string, name: string): string` (validates `name` with `WRITER_NAME_PATTERN`)
  - `export class WriterLeaseError extends Error { code: "writer_busy" | "writer_lease_unavailable" }`
  - `export interface WriterLease { readonly fd: number; release(): Promise<void> }`
  - `export async function acquireWriterLease(home: string, name: string, options: { waitMs: number; signal?: AbortSignal; flockCandidates?: readonly string[]; isTrustedBinary?: (path: string) => boolean; readStatfs?: StatfsReader }): Promise<WriterLease>`; `waitMs: 0` means non-blocking (`flock -n`).
  - `export async function adoptInheritedLease(home: string, name: string, fd: number, options?: same seams): Promise<WriterLease>`; `release()` on an adopted lease only closes the descriptor.

- [ ] **Step 1: Write the failing tests** in `test/writer-lease.test.ts`:
  - `creates the lease directory 0700 and file 0600 and never deletes the file on release`
  - `second non-blocking acquire in another process fails with writer_busy` (spawn a child Node process that acquires and holds; assert parent gets `writer_busy`; after the child exits, acquire succeeds)
  - `bounded wait returns writer_busy after waitMs` (child holds; `waitMs: 200`; elapsed >= 200 and < 2000)
  - `refuses a symlink, a directory or a foreign-owner file at the lease path with writer_lease_unavailable`
  - `refuses an untrusted flock binary with writer_lease_unavailable`
  - `adoptInheritedLease accepts a descriptor of the lease file that holds the lock` and `rejects a descriptor of another file, or an unlocked descriptor, with writer_lease_unavailable` (lock held proof: own `flock -n` on the fd succeeds and a fresh open of the path fails with busy)
  - `lock survives the death of the flock helper and ends with the last descriptor` (pass the fd to a child via `stdio[3]`, close it in the parent, assert still busy until the child exits)

- [ ] **Step 2: Run** `npx vitest run test/writer-lease.test.ts`. Expected: FAIL, module missing.

- [ ] **Step 3: Implement** `src/writer-lease.ts` on the `override-lock.ts` primitives: `O_NOFOLLOW | O_CREAT` open, `fstat` type/owner/mode check, `assertSupportedFilesystem`, trusted `flock` on the descriptor (`-n` for `waitMs: 0`, `-w` otherwise), then the dev/inode recheck of the path. Linux only; other platforms throw `writer_lease_unavailable`.

- [ ] **Step 4: Run** the targeted tests, `npx vitest run test/override-lock.test.ts`, then `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(writers): add a per-writer host lease` with `Refs #157`.

---

### Task 2: Container fence, labels and lease inheritance

**Files:**
- Create: `src/writer-fence.ts`
- Modify: `src/writer-boundary.ts` (`serveArgs`, `throwawayArgs`), `src/client-adapters/types.ts` (`CommandRunner.run` options), `src/setup-process.ts` (`createProcessRunner`)
- Test: `test/writer-fence.test.ts`, extend `test/writer-boundary.test.ts`, `test/setup-process.test.ts`

**Interfaces:**
- Consumes: none from Task 1 beyond the fd number.
- Produces:
  - `CommandRunner.run(..., options?: { cwd?: string; env?: NodeJS.ProcessEnv; inheritFds?: readonly number[] })`: each fd lands at child index 3, 4, … in order.
  - `export function writerContainerName(name: string): string` → `pi-writer-<name>`
  - `export function writerLabel(name: string): string` → `pi-session-mcp.writer=<name>`
  - `export async function ensureWriterAbsent(runner: CommandRunner, paths: WriterPaths, name: string, options: { leaseFd: number; stopTimeoutMs?: number }): Promise<void>`: throws `BoundaryError("writer_fenced")` when absence cannot be confirmed.
  - `serveArgs(paths, state, command, releaseRoot, eventsDir?, options?: { name?: string })` adds `--name pi-writer-<name>` when `options.name` is set and always adds `--label pi-session-mcp.writer=<name>`; `throwawayArgs` gains a required `name: string` parameter as its first argument and adds the label only.

- [ ] **Step 1: Write the failing tests:**
  - `serveArgs adds the fixed name and label`; `throwawayArgs adds the label and no name` (exact argv arrays)
  - `ensureWriterAbsent passes when no labelled container and no clone mount exist` (fake runner returns `[]` for `podman ps -a --filter label=… --format json` and for `podman ps -a --filter volume=<clone> --format json`)
  - `ensureWriterAbsent removes a found container with podman rm -f -t, polls until absent, and passes the lease fd to every podman call` (assert `inheritFds: [leaseFd]` on each call)
  - `ensureWriterAbsent throws writer_fenced when podman ps fails, returns unparsable JSON, or the container is still listed after stopTimeoutMs`
  - `createProcessRunner passes inheritFds at child index 3` (child script asserts `fstat(3)` matches the parent's file)

- [ ] **Step 2: Run** the new tests. Expected: FAIL.

- [ ] **Step 3: Implement.** Update every `throwawayArgs` caller in `src/writer-lifecycle.ts` and `src/writer-acceptance.ts` to pass the writer name (behaviour otherwise unchanged; Task 4 adds the fence calls). Parse `podman ps` JSON with a zod schema of `{ Id: string, Names: string[] }[]`, bounded by the runner's output limit.

- [ ] **Step 4: Run** targeted tests, `npx vitest run test/writer-provision.test.ts test/writer-collect.test.ts`, then `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(writers): fence writer containers by name, label and clone mount` with `Refs #157`.

---

### Task 3: Fenced launcher and relay launch mode

**Files:**
- Modify: `src/writer-launch.ts`, `src/refusal-server.ts`, `src/writer-state.ts`
- Test: extend `test/writer-launch.test.ts`, `test/writer-state.test.ts`

**Interfaces:**
- Consumes: `acquireWriterLease`, `adoptInheritedLease` (Task 1); `ensureWriterAbsent`, `writerContainerName`, `serveArgs(..., { name })`, `inheritFds` (Task 2).
- Produces:
  - `RefusalCode` adds `"writer_busy" | "writer_fenced"`.
  - `writerStateSchema` adds `launch: z.enum(["legacy", "relay"]).default("legacy")`; not part of the acceptance fingerprint.
  - `LaunchDependencies` adds `lease?: { acquire: typeof acquireWriterLease; adopt: typeof adoptInheritedLease }`, `ensureAbsent?: typeof ensureWriterAbsent`, `spawnPodman(args: string[], inheritFds: readonly number[]): ChildProcess`.

Launch order, exactly: validate name → take the lease (adopt `PI_WRITER_LEASE_FD` if set, else non-blocking acquire; busy → refusal `writer_busy`, other failure → `writer_not_ready`) → Podman info → state and acceptance → `ensureWriterAbsent` (failure → refusal `writer_fenced`) → events directory only when `state.launch === "legacy"` → credential refresh → spawn Podman with the lease fd inherited and `--name pi-writer-<name>` → refresh timer.

Cleanup, exactly: on child close, `SIGINT`, `SIGTERM` or `SIGHUP`: stop scheduling refreshes; forward the signal to Podman once; wait for an outstanding refresh; wait for the child to close; if it has not closed within `LAUNCHER_CLEANUP_BOUND_MS`, run `podman rm -f -t 0 pi-writer-<name>`; then `ensureWriterAbsent` once; release the lease; exit. The refusal server path holds the lease only while it serves.

- [ ] **Step 1: Write the failing tests:**
  - `refuses with writer_busy and spawns no podman when the lease is held`
  - `adopts PI_WRITER_LEASE_FD and does not acquire a second lease`
  - `refuses with writer_fenced and writes no credentials when absence cannot be confirmed` (assert `writeBoundaryCredentials` not reached: boundary `agent/auth.json` unchanged)
  - `relay launch omits the events mount; legacy launch keeps it`
  - `passes the lease fd to podman and names the container`
  - `on stdin end of the host (child close) joins an outstanding refresh before releasing the lease` (fake refresh resolves after a delay; assert release after refresh resolution)
  - `on SIGHUP forwards SIGTERM to podman once and releases after the child closes`
  - `force-removes the container after LAUNCHER_CLEANUP_BOUND_MS when podman does not exit` (fake timers)
  - writer-state: `launch defaults to legacy and does not change the acceptance fingerprint`
  - integration, in `test/writer-lifecycle.podman.test.ts` and gated like it: `host SIGKILL of the relay parent releases the writer within the cleanup bound` (spawn the launcher with a pipe stdin, kill the parent, assert a second launch is admitted)

- [ ] **Step 2: Run** `npx vitest run test/writer-launch.test.ts test/writer-state.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** in `src/writer-launch.ts`; keep the refresh and warm-up code unchanged apart from moving it after the fence.

- [ ] **Step 4: Run** targeted tests, then `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(writers): hold the lease and fence in the writer launcher` with `Refs #157`.

---

### Task 4: Setup operations under the fence; finish to the default base

**Files:**
- Modify: `src/setup-writers.ts`, `src/writer-lifecycle.ts`, `src/writer-acceptance.ts`
- Test: extend `test/setup-writers.test.ts`, `test/writer-provision.test.ts`, `test/writer-collect.test.ts`, `test/writer-acceptance.test.ts`

**Interfaces:**
- Consumes: Task 1 lease, Task 2 fence and `inheritFds`, Task 5 `ContainerSettings.base`.
- Produces:
  - `WriterContext` adds `leaseFd?: number`; every Podman and host-Git call in `writer-lifecycle.ts` and `writer-acceptance.ts` passes `inheritFds: [ctx.leaseFd]` when set.
  - `async function fenced<T>(ctx: WriterContext, name: string, deps: WriterSetupDependencies, action: (ctx: WriterContext) => Promise<T>): Promise<T>` in `setup-writers.ts`: inside the existing `locked`, acquire the writer lease with `waitMs: SETUP_LEASE_WAIT_MS`, run `ensureWriterAbsent`, run `action` with `leaseFd`, release.
  - Acceptance launches the wrapper with `PI_WRITER_LEASE_FD=3` and `inheritFds: [leaseFd]`.
  - `finishWriter` and `recreateWriter` without an explicit base reset to `refs/heads/<ContainerSettings.base>`; `resetWriter` without `--base` keeps today's behaviour.

- [ ] **Step 1: Write the failing tests:**
  - `collect, reset, recreate, finish, remove and verify fail with writer_busy while another process holds the writer lease`
  - `provisioning reconciliation and acceptance run under the writer lease and pass the lease fd to podman`
  - `acceptance launches the wrapper with PI_WRITER_LEASE_FD=3`
  - `finish resets a writer on a fix branch to the workspace default base`
  - `reset without --base keeps the writer's current base`
  - `no outcome reports writer_reconnect_required` (replace the existing #136 expectations)
  - `a container found under the lease is removed before any credential write or clone change` (fake runner order assertion)

- [ ] **Step 2: Run** the targeted tests. Expected: FAIL.

- [ ] **Step 3: Implement.** Remove the `reconnectRequired` finding from `runWriterOperation`.

- [ ] **Step 4: Run** targeted tests, `test/writer-lifecycle.podman.test.ts` when Podman is available, then `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(writers): run every writer operation under the lease and fence` with `Refs #157`.

---

### Task 5: Default base in execution modes

**Files:**
- Modify: `src/execution-modes.ts`, `src/setup-modes.ts`
- Test: extend `test/execution-modes.test.ts`, `test/setup-modes.test.ts`

**Interfaces:**
- Produces:
  - Container entry schema adds `base: z.string().refine(isShortBranchName).optional()`; `ContainerSettings` adds `readonly base?: string`.
  - `export function isShortBranchName(value: string): boolean` in `src/execution-modes.ts`: `isSafeRefName(value)`, not `HEAD`, no `refs/` prefix, not a 40 or 64 hex commit ID, at most 200 characters.
  - `changeExecutionMode` records `base` from `request.baseRef` (short form) when given, keeps the recorded value on a repeated container request without `--base`, and otherwise leaves it unset (Task 8 fills it at migration).
  - `codingAllowed(entry)` is unchanged here; Task 6 changes it.

- [ ] **Step 1: Write the failing tests:**
  - `accepts base main and dev; rejects refs/heads/main, HEAD, a commit ID, ../x and an empty string with invalid_execution_modes`
  - `setup records --base dev for a container request`
  - `a repeated container request without --base keeps base dev`
  - `an existing entry without base still loads`

- [ ] **Step 2: Run** `npx vitest run test/execution-modes.test.ts test/setup-modes.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** targeted tests, then `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(modes): record a default base for container workspaces` with `Refs #157`.

---

### Task 6: Contract plumbing in adapter, registry, server and capabilities

**Files:**
- Create: `src/tool-schemas.ts` (move the zod schemas out of `src/server.ts` unchanged, then extend them)
- Modify: `src/pi-adapter.ts`, `src/session-registry.ts`, `src/server.ts`, `src/capabilities.ts`, `src/execution-modes.ts` (`codingAllowed` only)
- Test: extend `test/registry.test.ts`, `test/mcp-contract.test.ts`, `test/capabilities.test.ts`

**Interfaces:**
- Produces:
  - `PiSessionAdapter.create(input: { cwd: string; workspace: string; base?: string; executionProfile: ResolvedExecutionProfile; signal?: AbortSignal })`
  - `PiSessionHandle` adds optional `readonly placement?: { writer: string; base: { ref: string; commit: string } }`, `readonly deadlines?: { preflightMs?: number; abortMs?: number; cleanupMs?: number }`, `isLost?(): boolean`.
  - `PiTurnOutcome` completed variant adds `truncated?: boolean`; the registry sets `turn.truncated = normalized.truncated || outcome.truncated === true`.
  - `SessionRegistry.start(workspace: string, executionProfile: ResolvedExecutionProfile, options?: { base?: string })`; the registry uses `handle.deadlines` over its defaults for that session; `prompt` throws `RegistryError("writer_session_lost")` when `handle.isLost?.()` is true.
  - `RegistryErrorCode` adds `"writer_session_lost" | "base_not_applicable"`.
  - `export class WriterUnavailableError extends Error { code: "writer_unavailable"; reason: "none_ready" | "none_at_base" | "none_admitted"; counts?: { busy: number; notAtBaseline: number; settingsChanged: number } }` in `src/pi-adapter.ts`; `safe()` in `server.ts` emits `error: { code, message, reason, counts? }`.
  - `SessionView` adds optional `writer?: string` and `base?: { ref: string; commit: string }`.
  - `pi_session_start` input adds `base: z.string().refine(isShortBranchName).optional()`; `base` with a read-only profile or a non-container workspace fails with `base_not_applicable` before a session is created.
  - `codingAllowed(entry, relay: boolean)`: `container` allows coding only when `relay` is true; `main.ts` passes `true` for the host server (Task 7).
  - Capabilities workspace entries for `container` add `writers: number` and `defaultBase: string | null`.

- [ ] **Step 1: Write the failing tests:**
  - registry: `passes workspace and base to the adapter`; `uses handle deadlines for preflight, abort and cleanup` (fake handle with 50 ms deadlines and a 30 ms preflight succeeds while the default would be shorter in a configured test registry); `prompt on a lost handle fails with writer_session_lost; get and close still work`; `completed outcome with truncated true sets truncated`; `placement appears in the session view`
  - server: `base with a read-only profile fails with base_not_applicable`; `base on a host workspace fails with base_not_applicable`; `writer_unavailable carries reason and counts`; `container coding is forbidden without relay and allowed with relay`; `tools/list input schema of pi_session_start lists base`
  - capabilities: `container workspace lists writers and defaultBase`

- [ ] **Step 2: Run** the targeted tests. Expected: FAIL.

- [ ] **Step 3: Implement.** Keep `createServer`'s existing parameters; add `relay = false` as the last parameter.

- [ ] **Step 4: Run** targeted tests, `npx vitest run test/registry-turn-events.test.ts test/sdk-contract.test.ts`, then `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(server): carry base, placement and relay errors through the session contract` with `Refs #157`.

---

### Task 7: Relay adapter and pool allocation

**Files:**
- Create: `src/writer-relay.ts`, `src/child-stdio-transport.ts`, `test/fixtures/fake-writer-server.mjs`
- Modify: `src/main.ts`
- Test: `test/writer-relay.test.ts`, `test/child-stdio-transport.test.ts`

**Interfaces:**
- Consumes: Task 6 contract; Task 3 refusal codes; `readWriterState`, `writerPaths` from `src/writer-state.ts`; `ReadBuffer`, `serializeMessage`, `Client` from `@modelcontextprotocol/client`.
- Produces:
  - `export class ChildStdioTransport implements Transport` spawning `command` with `detached: true`, stdio pipes, a minimal env, stderr drained; `close()` ends stdin and does not kill the child.
  - `export interface WriterProcessFactory { spawn(wrapperPath: string, env: Record<string, string>): Transport }`
  - `export class WriterRelayAdapter implements PiSessionAdapter` with constructor `(options: { home: string; workspaceModes: ReadonlyMap<string, WorkspaceModeEntry>; executionProfiles: ReadonlyMap<string, ConfiguredExecutionProfile>; spawn?: WriterProcessFactory; now?: () => number; pollIntervalMs?: number })`
  - `export class RoutingPiSessionAdapter implements PiSessionAdapter` with constructor `(host: PiSessionAdapter, relay: PiSessionAdapter, workspaceModes: ReadonlyMap<string, WorkspaceModeEntry>)`: coding profile on a `container` workspace → relay; everything else → host.

Allocation, exactly:
1. Candidates: writers `<alias>-w1` … `-w<writers>` whose state is `ready`, `launch === "relay"`, acceptance present, and `base.ref === "refs/heads/" + (input.base ?? entry.container.base)`. No ready relay writer → `none_ready`; none on the base → `none_at_base`. A missing default base counts as `none_at_base`.
2. Per candidate in index order, within `RELAY_START_BUDGET_MS` overall: spawn the wrapper (env `HOME`, `PATH`, `XDG_RUNTIME_DIR` when set); MCP connect; `tools/list`; `pi_capabilities_get` validated with the capabilities schema. A refusal server (tools that return `writer_busy`, `writer_fenced`, `writer_not_ready`) counts `busy` for `writer_busy` and is skipped otherwise. Compare the inner profile entry (`permissionProfile`, `provider`, `model`, `thinkingLevel`) with the host profile; difference → `settingsChanged`. Inner `pi_session_start({ workspace, executionProfile })`: `writer_uncollected` → `notAtBaseline`, `writer_busy` → `busy`, other errors → that `PiSessionCreationError` code ends the allocation. Re-read the writer state; base changed → close the inner session, end the transport, next candidate.
3. No candidate admitted → `WriterUnavailableError("none_admitted", counts)`.

Handle, exactly:
- `prompt`: `pi_session_prompt` with `RELAY_CALL_TIMEOUT_MS`; inner `ok: true` with a running turn → `preflight(true)`; inner error → `preflight(false)` and resolve `failed`; timeout or lost response → `pi_session_abort`, then resolve `failed`. Poll `pi_turn_get` every `pollIntervalMs`; call `onActivity` only when the inner `updatedAt` changes; on a terminal inner turn resolve with its state, `assistantText` and `truncated`.
- `abort`: `pi_session_abort`, then one `pi_turn_get`; the outer outcome is the inner terminal state (a completed inner turn stays `completed`).
- Lost: transport close or error, an invalid or oversized (`RELAY_MAX_RESPONSE_BYTES`) response → running turn resolves `failed`, `isLost()` returns true.
- `dispose`: `pi_session_close` within `RELAY_CLEANUP_DEADLINE_MS`, then `transport.close()`; never waits for the launcher's cleanup.
- `deadlines`: `{ preflightMs: RELAY_PREFLIGHT_DEADLINE_MS, abortMs: RELAY_ABORT_DEADLINE_MS, cleanupMs: RELAY_CLEANUP_DEADLINE_MS }`; `placement` from the writer state.
- `appliedSelection`: from the inner session view, so the registry's selection check applies unchanged.

`main.ts` wraps `SdkPiSessionAdapter` and `WriterRelayAdapter` in `RoutingPiSessionAdapter` and passes `relay = true` to `createServer`, except when `PI_SESSION_MCP_WRITER_GUARD` is set (the server inside a writer).

- [ ] **Step 1: Write the fake writer** `test/fixtures/fake-writer-server.mjs`: an MCP stdio server with the six tools, driven by a JSON scenario file passed in `argv[2]` (refuse with a code, settings drift, uncollected, slow prompt, complete during abort, oversized text, exit mid-turn).

- [ ] **Step 2: Write the failing tests** in `test/writer-relay.test.ts`:
  - `starts on the first ready relay writer at the default base and reports placement`
  - `base selects only writers on that branch; none matches → none_at_base`
  - `skips legacy and not-ready writers; none left → none_ready`
  - `busy, uncollected and drifted writers are counted; none admitted → none_admitted with counts`
  - Review Focus 2: `two relay adapters racing for one writer: one session, one writer_unavailable with busy 1` (real `acquireWriterLease` through a fake launcher fixture that takes the lease)
  - Review Focus 3: `abort racing an inner completion settles completed`
  - Review Focus 4: `writer state base changed after the inner start → inner close, next candidate`
  - Review Focus 5: `oversized assistantText or a schema-invalid turn fails the turn and marks the session lost`
  - `child exit while idle marks the session lost; prompt fails with writer_session_lost`
  - `activity advances only when inner updatedAt changes`
  - `start budget exhausted → none_admitted, all spawned transports closed`
  - `routing: read-only profile on a container workspace and any profile on a host workspace use the host adapter`
  - `child-stdio-transport: spawns detached, close ends stdin without killing the child`

- [ ] **Step 3: Run** `npx vitest run test/writer-relay.test.ts test/child-stdio-transport.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement.** Validate every inner `structuredContent` with the `src/tool-schemas.ts` schemas; never forward raw frames.

- [ ] **Step 5: Run** targeted tests, then `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 6: Commit** `feat(relay): lease and relay container coding sessions through the host server` with `Refs #157`.

---

### Task 8: Migration, registration removal, wake hook and verify

**Files:**
- Modify: `src/setup-writers.ts`, `src/setup-hooks.ts`, `src/wake-hook.ts`, `src/writer-state.ts`
- Test: extend `test/setup-writers.test.ts`, `test/setup-hooks.test.ts`, `test/wake-hook.test.ts`, `test/setup-modes.test.ts`

**Interfaces:**
- Consumes: Task 4 `fenced`, Task 5 `base`, Task 3 `launch`.
- Produces:
  - Container provisioning no longer plans or applies writer client registrations or writer wake hooks.
  - Migration, run by the existing provisioning command with `--apply`, per writer under `fenced`: confirm absence; remove the `pi-coding-<name>` registrations setup owns (by ownership record, never by starting the server); a divergent registration keeps the writer at `launch: "legacy"` and reports `registration_divergent`; rewrite the wrapper for this release; re-accept provider-free through the relay launch path; set `launch: "relay"`.
  - Migration records `base` in the modes entry: the single shared writer base, or `--base`; differing bases without `--base` → `workspace_base_ambiguous`, no writer changed.
  - `--writer <name> --verify` checks Doctor, the host registration and a bounded relay-path spawn with `PI_WRITER_NO_CREDENTIAL_REFRESH=1`; it no longer requires writer registrations.
  - `WAKE_TOOL_PATTERN` matches `mcp__pi-session-mcp__…` only; the `mcp__pi-coding-.*` matchers are removed from the hook entry.

- [ ] **Step 1: Write the failing tests:**
  - `provisioning a new container workspace creates no writer registrations and no writer hooks`
  - `migration removes owned writer registrations, rewrites wrappers, re-accepts and sets launch relay`
  - `a divergent writer registration stays, the writer stays legacy and the report names registration_divergent`
  - `migration records the shared base; differing bases need --base, else workspace_base_ambiguous with no change`
  - `migration under a held writer lease fails with writer_busy and changes nothing`
  - `verify spawns the wrapper with PI_WRITER_NO_CREDENTIAL_REFRESH=1 and needs no writer registration`
  - `wake hook ignores mcp__pi-coding-<name>-w1__pi_turn_get`; `hook entry has no pi-coding matcher`

- [ ] **Step 2: Run** the targeted tests. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** targeted tests, `test/writer-lifecycle.podman.test.ts`, then `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(setup): migrate writers to the relay and drop per-writer registrations` with `Refs #157`.

---

### Task 9: Doctor checks

**Files:**
- Modify: `src/doctor.ts`
- Test: extend `test/doctor-writers.test.ts`

**Interfaces:**
- Consumes: Task 1 `writerLeasePath`, Task 3 `launch`, Task 5 `base`.
- Produces, all offline and path-free:
  - `writer_lease_directory` error when the lease directory exists and is not a private real directory of the user; absent is ok.
  - `writer_not_migrated` warning per writer with `launch: "legacy"`.
  - `workspace_base_unset` warning per container workspace without `base`.
  - `writer_off_default_base` warning per container workspace with a count of ready writers whose base differs from `base`.

- [ ] **Step 1: Write the failing tests**, one per check, plus `reports no branch names, paths or counts beyond the documented field`.
- [ ] **Step 2: Run** `npx vitest run test/doctor-writers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with the existing bounded no-follow reads.
- [ ] **Step 4: Run** targeted tests, then `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(doctor): check leases, migration and writer bases` with `Refs #157`.

---

### Task 10: Documentation, skills and live check (controller)

**Files:**
- Modify: `docs/tool-contracts.md`, `docs/execution-modes.md`, `docs/isolation-setup.md`, `docs/doctor-design.md`, `docs/architecture.md`, `docs/threat-model.md`, `docs/installation.md` (upgrade runbook), `docs/roadmap.md`, `docs/acceptance.md`, `skills/pi-session-orchestration/SKILL.md` and its `references/start-errors.md`

- [ ] **Step 1:** Document the `base` argument, placement fields, new error codes with reasons and counts, the default base, the removed reconnect, the fix-round flow and the migration runbook. Remove `writer_reconnect_required` and `pi-coding-*` tool guidance from the skill.
- [ ] **Step 2:** Run `npm test` (docs tests included) and the private-identifier scan on the whole branch diff.
- [ ] **Step 3:** Live check on a maintainer workstation with Podman, recorded in `docs/acceptance.md` without host-specific data: migrate one repository, start two parallel sessions through one host registration, kill the host server mid-turn, confirm lease release and container removal, run one fix round with `base`.
- [ ] **Step 4: Commit** `docs: document the leased writer pool` with `Closes #157`.
