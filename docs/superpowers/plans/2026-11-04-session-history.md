# Opt-in Session History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in, per-machine SQLite file records every Pi session entry (redacted on the host), session metadata, gaps and controller verdicts; a separate CLI lists, shows, exports, queries and prunes it.

**Architecture:** A `src/history/` module owns the store (fixed location, `node:sqlite`, schema migrations), redaction and a non-throwing recorder. The registry hands the recorder a cursor-based `readHistory` of each handle after a turn's terminal transition. Host handles read their own in-memory `SessionManager`; relay handles page entries from the inner writer server through an inner-only tool, and the host treats them as untrusted. The new binary `pi-session-mcp-history` reads the same file. Default off.

**Tech Stack:** Node.js >= 22.19 (`node:sqlite` `DatabaseSync`), TypeScript strict ESM, zod, Vitest, Pi SDK `@earendil-works/pi-coding-agent` 1.5.0 package-root exports (`SessionManager`, `ReadonlySessionManager.getHeader/getEntries/getEntryCount`), `@modelcontextprotocol/server` and `client` as already pinned.

**Spec:** [docs/superpowers/specs/2026-11-03-session-history-design.md](../specs/2026-11-03-session-history-design.md) (calls 1–19), issue [#215](https://github.com/plagor44-ux/pi-session-mcp/issues/215).

## Global Constraints

- Follow `AGENTS.md`: stdout only for MCP frames in the server; Pi behind `PiSessionAdapter`; tests use fakes and no provider credentials; no tool argument that accepts a path or `cwd`; Doctor offline; documented package-root exports only.
- No new dependency. `node:sqlite` only. If it cannot open a file without flags on Node 22.19.0, stop and report (call 7).
- The SQLite module is loaded lazily, only when history is enabled or the CLI runs, through `loadSqlite()` (Task 2). It drops exactly the `ExperimentalWarning` whose message starts with `SQLite`, so stderr keeps only structured JSON lines.
- History never fails, delays beyond its bound, or changes the outcome of a Pi session or turn (anti-goals). Every recorder method is non-throwing.
- Fixed location, independent of `HOME` and `XDG_STATE_HOME`: `join(userInfo().homedir, ".local", "state", "pi-session-mcp", "history", "history.sqlite")`; directory `0700`, file `0600` (also `-wal` and `-shm`), checked with `lstat` (call 12).
- Redaction runs on the host before every write, irreversibly. Known values come from the server's environment only; `auth.json` is never read (call 13).
- Constants, exactly: `HISTORY_SCHEMA_VERSION = 1`, `HISTORY_BUSY_TIMEOUT_MS = 2_000`, `HISTORY_SETTLE_DEADLINE_MS = 3_000`, `HISTORY_ENTRY_CAP_BYTES = 1_048_576`, `HISTORY_RELAY_PAGE_BYTES = 458_752`, `MIN_KNOWN_VALUE_LENGTH = 8`, `TASK_LABEL_MAX = 64`, `VERDICT_REASON_MAX = 500`.
- Gap codes, exactly: `history_locked`, `history_full`, `history_corrupt`, `history_unavailable`, `history_relay_invalid`.
- Session completeness, exactly: `complete`, `incomplete`, `has_gaps`. Capture source, exactly: `host`, `writer-relay`. Verdicts, exactly: `accepted`, `rejected`, `reworked`.
- Redaction marker, exactly: `[REDACTED:<kind>]`; kinds: `known_value`, `github_token`, `api_key`, `aws_access_key`, `slack_token`, `jwt`, `private_key`, `url_credentials`, `assignment`. Path-rule marker text in `show`: `content not stored (path rule)`.
- Default path globs, exactly: `.env`, `.env.*`, `*.sops.*`, `secrets/**`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `kubeconfig*`. Configuration may add globs, never remove defaults.
- Path rule scope (call 17): `read` result; `grep` result lines from matching files; `edit` and `write` arguments and result. `bash`, `find`, `ls` and external MCP tools get the pattern stage only.
- Diagnostics on stderr: structured JSON, no entry text, no paths, no task labels.
- All commits reference `#215`; one branch `feat/215-session-history`, one PR. No version bump; the release is a separate maintainer step.
- Every task runs `npm run typecheck`, its targeted tests, then `npm test`.

## Review Focus

1. **Claude Code and Codex servers write to the same file at the same time:** WAL plus busy timeout lets both record; no gap under ordinary contention. Test in Task 2.
2. **`pi_session_close` arrives while the last turn's history write is still pending:** close waits up to `HISTORY_SETTLE_DEADLINE_MS`, then disposes; the turn is recorded or a gap is written, the close result is unchanged. Test in Task 5.
3. **Server receives SIGTERM during a running turn:** shutdown closes sessions, the aborted turn and the session close are recorded within the shutdown deadline, the session ends `complete` or `has_gaps`, never silently missing. Test in Task 5.
4. **A PEM private key is written through `write` to a non-matching path such as `notes.txt`:** the multi-line pattern removes the whole block from the arguments and the result. Test in Task 3.
5. **A writer runs an older inner server without the history tool:** the host records `history_relay_invalid` for that session and the turn and connection stay healthy (`isLost()` false). Test in Task 6.

---

### Task 1: ADR 0019 and AGENTS.md boundary

**Files:**
- Create: `docs/adr/0019-opt-in-session-history.md`
- Modify: `AGENTS.md:34-36` (CLI sanitization), `AGENTS.md:58` (boundary), `AGENTS.md:63` (stays in-memory)
- Modify: `docs/adr/0003-post-mvp-maintenance.md` (one "Amended by ADR 0019" line under option D)

**Interfaces:**
- Produces: the decision record later tasks cite in code comments as `ADR 0019`.

- [ ] **Step 1: Write ADR 0019 with status `Proposed`**

Follow the section layout of `docs/adr/0018-sandbox-go-module-cache.md`. Content: context (black-box sessions, #215 widened on 2026-11-03), decision (calls 1–19 in short form), the predefined queries #215 asks for (one session timeline; sessions by workspace/profile/task; verdict counts per profile; tool calls by name with failures; gaps per day), what stays rejected (resume, replay, MCP query tool, web UI, merge across machines), residual risks (unrecognized secrets pass; host-mode coding sessions can read or delete the file, call 18; Codex and Claude controllers may read, others not, call 19), consequences (new binary, config block, `task` argument, Doctor checks, minor release).

- [ ] **Step 2: Amend AGENTS.md**

- Line 58: the boundary becomes "local stdio, in-memory session state, an opt-in local session history file (ADR 0019), and one trusted local MCP peer"; "persistence/resume" becomes "resume".
- Line 63: "Pi Session MCP itself keeps sessions in memory; its only persistent store is the opt-in session history (ADR 0019)."
- After line 36 add: "Exception: `pi-session-mcp-history show --full`, `export` and `query` print redacted session content by purpose (ADR 0019); their other output follows this rule."

- [ ] **Step 3: Verify the docs-related tests still pass**

Run: `npx vitest run test/package-contents.test.ts test/execution-modes-docs.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0019-opt-in-session-history.md docs/adr/0003-post-mvp-maintenance.md AGENTS.md
git commit -m "docs: propose ADR 0019 for the opt-in session history (#215)"
```

---

### Task 2: History store

**Files:**
- Create: `src/history/sqlite.ts`, `src/history/store.ts`, `src/history/schema.ts`
- Test: `test/history-store.test.ts`

**Interfaces:**
- Produces:
  - `loadSqlite(): Promise<typeof import("node:sqlite")>` — dynamic import with the scoped warning filter (wrap `process.emitWarning` for the duration of the import, restore in `finally`).
  - `historyLocation(home?: string): { directory: string; file: string }` — default `userInfo().homedir`.
  - `class HistoryStoreError extends Error { readonly code: GapCode }` with `type GapCode = "history_locked" | "history_full" | "history_corrupt" | "history_unavailable" | "history_relay_invalid"`.
  - `openHistoryStore(options: { home?: string; uid?: number; readOnly?: boolean }): Promise<HistoryStore>` — creates directory `0700` and file `0600` when writable, verifies both with `lstat` (real directory/file, owner = uid, `mode & 0o077 === 0`), sets `journal_mode=WAL`, `busy_timeout=HISTORY_BUSY_TIMEOUT_MS`, `foreign_keys=ON`, runs migrations in one transaction, refuses a `user_version` above `HISTORY_SCHEMA_VERSION` with `history_unavailable`. `readOnly` opens with `{ readOnly: true }` and never migrates.
  - `interface HistoryStore { readonly db: DatabaseSync; transaction<T>(fn: () => T): T; close(): void }`
  - `classifyStoreError(error: unknown): GapCode` — `SQLITE_BUSY`/`SQLITE_LOCKED` → `history_locked`, `SQLITE_FULL` → `history_full`, `SQLITE_CORRUPT`/`SQLITE_NOTADB` → `history_corrupt`, else `history_unavailable`.
  - Schema v1 in `schema.ts` as `MIGRATIONS: readonly string[]` (index = target version − 1). Tables per spec "Data model": `instances(id, pid, proc_start, started_at, ended_at)`, `sessions(...)` with every column the spec lists plus `instance_id`, `completeness`, `capture_source`, `entry_cursor`; `turns`, `entries` (unique `(session_id, pi_entry_id)`, columns `redacted_json`, `redactions` JSON, `dropped_by_path`, `truncated`), `verdicts`, `gaps`. Indexes on `sessions(created_at)`, `sessions(workspace)`, `sessions(execution_profile)`, `sessions(task)`, `sessions(base_commit)`, `entries(tool_name)`.

- [ ] **Step 1: Write the failing tests**

In `test/history-store.test.ts`, using a temporary home from `test/temporary-roots.ts`:
- `creates directory 0700 and file 0600 at the fixed location` — assert `historyLocation(home).file` ends with `.local/state/pi-session-mcp/history/history.sqlite` and the stat modes.
- `ignores HOME and XDG_STATE_HOME` — set both env vars to another dir; `historyLocation()` still equals `join(userInfo().homedir, …)`.
- `refuses a group-readable directory` and `refuses a symlinked file` — `openHistoryStore` rejects with code `history_unavailable`.
- `migrates an empty file to user_version 1` — `PRAGMA user_version` is `1`, all six tables exist.
- `refuses a newer schema without writing` — set `user_version = 2`; reject with `history_unavailable`; file bytes unchanged.
- `two connections write concurrently` (Review Focus 1) — two stores on one file, 50 interleaved inserts each into `gaps`; all 100 rows present, no error.
- `read-only open does not create -shm writes or migrate` — `readOnly: true` on a v1 file; an `INSERT` throws.
- `classifyStoreError maps SQLite codes` — table of `{ errcode / code } → GapCode`.
- `loadSqlite filters only the SQLite experimental warning` — spy on `process.emitWarning` around a call that emits `("SQLite is an experimental feature…", "ExperimentalWarning")` and an unrelated warning; the first is dropped, the second passes, and `process.emitWarning` is restored afterwards. (The compiled-server stderr check on Node 22 is in Task 10.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/history-store.test.ts`
Expected: FAIL, module `src/history/store.js` not found.

- [ ] **Step 3: Implement `sqlite.ts`, `schema.ts`, `store.ts` with the signatures above**

- [ ] **Step 4: Run tests on Node 26 and Node 22**

Run: `npx vitest run test/history-store.test.ts` and `PATH=$HOME/.local/opt/node-v22.23.3-linux-x64/bin:$PATH npx vitest run test/history-store.test.ts`
Expected: PASS on both. If Node 22 needs a flag, stop and report (call 7).

- [ ] **Step 5: Commit**

```bash
git add src/history/sqlite.ts src/history/schema.ts src/history/store.ts test/history-store.test.ts
git commit -m "feat(history): add the fixed-location SQLite store (#215)"
```

---

### Task 3: Redaction and size policy

**Files:**
- Create: `src/history/redact.ts`, `src/history/path-rule.ts`
- Test: `test/history-redact.test.ts`

**Interfaces:**
- Produces:
  - `type RedactionKind = "known_value" | "github_token" | "api_key" | "aws_access_key" | "slack_token" | "jwt" | "private_key" | "url_credentials" | "assignment"`
  - `knownValuesFromEnv(env: NodeJS.ProcessEnv): readonly string[]` — values of variables whose name matches the existing secret-name pattern (reuse the one in `src/process-diagnostics.ts` or the writer env filter if exported; otherwise define `SECRET_NAME_PATTERN = /TOKEN|SECRET|PASSW|API_KEY|PRIVATE|CREDENTIAL|AUTH/i` here), length ≥ `MIN_KNOWN_VALUE_LENGTH`, longest first.
  - `compilePathRule(extra: readonly string[]): (relativeOrAbsolutePath: string) => boolean` — defaults plus extras; matches on the basename for patterns without `/` and on the path for patterns with `/`. No dependency: translate `*`, `**`, `?` to a RegExp.
  - `interface RedactedEntry { json: string; redactions: Partial<Record<RedactionKind, number>>; droppedByPath: boolean; truncated: boolean; toolName?: string; role?: string }`
  - `class Redactor { constructor(options: { knownValues: readonly string[]; pathRule: (path: string) => boolean }); entry(entry: unknown, toolCalls: Map<string, { name: string; path?: string }>): RedactedEntry }` — `toolCalls` maps a `toolCallId` from an earlier assistant `toolCall` block to its name and path argument, so a later `toolResult` entry knows which rule applies.

Order inside `entry`: replace opaque payloads (base64 image `data`, thinking `signature`) with `{"omitted":"<kind>","bytes":<n>}`; apply the path rule (call 17) by replacing the content with `content not stored (path rule)` and setting `droppedByPath`; walk every remaining string for known values then patterns; serialize; truncate above `HISTORY_ENTRY_CAP_BYTES` by cutting the largest string field and appending `[TRUNCATED:<original bytes>]`, setting `truncated`.

Grep rule: Pi's `grep` result text has one match per line prefixed by the file path. Drop each line whose path prefix matches; keep the rest. Take the exact line format from Pi's grep tool in `node_modules/@earendil-works/pi-coding-agent` and pin it in a fixture.

- [ ] **Step 1: Write the failing tests**

Sentinel values: `ghp_` + 36 alnum, `github_pat_` + 82 chars, `sk-ant-api03-` + 40, `sk-` + 48, `AKIA` + 16, `xoxb-1-2-abc`, a three-part JWT, a PEM block `-----BEGIN OPENSSH PRIVATE KEY-----…-----END OPENSSH PRIVATE KEY-----`, `https://u:p4ssw0rd@host/x`, `PASSWORD=hunter2hunter2`, and an env value `KNOWN_9f2c_long_value` under `MY_API_KEY`.
- `replaces every sentinel kind with its marker and counts it` — one assistant text containing all; output JSON contains none of the sentinels and `redactions` has each kind ≥ 1.
- `skips short known values` — env value `abc` under `TOKEN` is not replaced in `abc def`.
- `drops read results for each default glob and a configured glob` — for each default glob a `read` call plus result; `droppedByPath` true, content absent, tool name and path kept.
- `drops grep lines from matching files only` — mixed result; `.env` lines gone, `src/a.ts` lines kept.
- `drops edit and write arguments and results on matching paths` — `write` to `.env` with `TOKEN=…`; arguments `content` absent.
- `bash output gets patterns only` — `bash` result with `cat .env` output containing `ghp_…` and `DB_PASS_RANDOM=Zq8…`: the `ghp_` is redacted, `Zq8…` assigned through an assignment line is redacted, a bare random string `Zq8x7Lm2Pq` on its own line passes (documented limit, negative case).
- `PEM block in write to a non-matching path is removed` (Review Focus 4) — `write` to `notes.txt`; arguments and result contain no `BEGIN` line content.
- `replaces images and thinking signatures with size markers`.
- `truncates an entry above 1 MiB and flags it` — 10 MiB bash result; output ≤ `HISTORY_ENTRY_CAP_BYTES` + marker, `truncated` true.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/history-redact.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `path-rule.ts` and `redact.ts` with the signatures above**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/history-redact.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/history/redact.ts src/history/path-rule.ts test/history-redact.test.ts test/fixtures/history-*
git commit -m "feat(history): redact entries on the host before storage (#215)"
```

---

### Task 4: Configuration, capabilities and the `task` argument

**Files:**
- Modify: `src/config.ts` (schema, `AppConfig`), `src/capabilities.ts`, `src/tool-schemas.ts`, `src/server.ts` (`pi_session_start`), `src/session-registry.ts` (`start` options, `SessionView` unchanged), `pi-session-mcp.example.json`
- Test: `test/config.test.ts`, `test/capabilities.test.ts`, `test/mcp-contract.test.ts`

**Interfaces:**
- Produces:
  - Config block `history?: { enabled: boolean; redactPaths?: string[]; workspaces?: Record<alias, { redactPaths: string[] }> }`, strict; globs are non-empty, ≤ 256 chars, no NUL, no leading `/`, no `..` segment; workspace keys must be configured aliases (new `ConfigErrorCode` `"invalid_history"`).
  - `AppConfig.history: { enabled: false } | { enabled: true; redactPaths: readonly string[]; workspaces: ReadonlyMap<string, readonly string[]> }`.
  - `projectCapabilities(..., history: { enabled: boolean } = { enabled: false })` adds top-level `history: { enabled }`; `capabilitiesSchema` gains `history: z.object({ enabled: z.boolean() }).strict()`.
  - `TASK_LABEL_PATTERN = /^[A-Za-z0-9#][A-Za-z0-9#._:\/-]{0,63}$/` plus refine "no `..`, no `//`", exported from `tool-schemas.ts` as `taskLabelSchema`.
  - `pi_session_start` input gains `task: taskLabelSchema.optional()`; `SessionRegistry.start(workspace, profile, options: { base?: string; task?: string })`. The registry keeps `task` on its private `Entry` for the recorder; it is not added to `SessionView`.

- [ ] **Step 1: Write the failing tests**

- config: `history absent means disabled`; `accepts enabled with globs`; `rejects unknown workspace key with invalid_history`; `rejects a glob with ..`; `history block changes the fingerprint`.
- capabilities: `reports history.enabled` for both values.
- mcp-contract: `pi_session_start accepts task "#215" and "sprint-18/pkg-2"`; `rejects "/etc/passwd", "../x", "a".repeat(65), "a b"` with an input validation error; `tools/list snapshot includes task`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts test/capabilities.test.ts test/mcp-contract.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the schema, projection and argument as specified; update the example config with a commented-out-equivalent `"history": { "enabled": false }`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config.test.ts test/capabilities.test.ts test/mcp-contract.test.ts`
Expected: PASS. Update any `tools/list` or capabilities snapshot that the change touches, nothing else.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/capabilities.ts src/tool-schemas.ts src/server.ts src/session-registry.ts pi-session-mcp.example.json test/config.test.ts test/capabilities.test.ts test/mcp-contract.test.ts
git commit -m "feat(history): add the history config block and the task label (#215)"
```

---

### Task 5: Recorder, host capture and crash reconciliation

**Files:**
- Create: `src/history/recorder.ts`, `src/history/reconcile.ts`
- Modify: `src/pi-adapter.ts` (`PiSessionHandle.readHistory?`), `src/sdk-pi-adapter.ts` (`SdkHandle` keeps its `SessionManager`), `src/session-registry.ts` (option `history`, calls at start, terminal, close, shutdown), `src/main.ts` (open store when enabled, wire recorder, diagnostics), `test/fake-adapter.ts` (scripted entries)
- Test: `test/history-recorder.test.ts`, `test/registry-history.test.ts`, `test/history-reconcile.test.ts`

**Interfaces:**
- Consumes: `openHistoryStore`, `HistoryStore`, `classifyStoreError`, `GapCode` (Task 2); `Redactor`, `knownValuesFromEnv`, `compilePathRule` (Task 3); `AppConfig.history`, `start(..., { task })` (Task 4).
- Produces:
  - In `pi-adapter.ts`: `interface HistoryPage { header?: unknown; entries: readonly unknown[]; next: number; more: boolean }` and optional `readHistory?(cursor: number): Promise<HistoryPage>` on `PiSessionHandle`. Entries are raw Pi `SessionEntry` objects; the host never trusts their shape (validated in the recorder with a zod schema requiring `type`, `id`, `parentId`, `timestamp` strings).
  - `SdkHandle.readHistory(cursor)` returns `getEntries().slice(cursor)`, `next = getEntryCount()`, `more: false`, and `header` when `cursor === 0`.
  - `interface HistoryRecorder { sessionStarted(input: SessionStartRecord): void; turnEnded(sessionId: string, turn: TurnView, read: (cursor: number) => Promise<HistoryPage>): void; settle(sessionId: string, deadlineMs: number): Promise<void>; sessionClosed(view: SessionView): void; flush(deadlineMs: number): Promise<void> }`; `SessionStartRecord = { view: SessionView; sdkSessionId: string; task?: string; source: "host" | "writer-relay" }`.
  - `createHistoryRecorder(options: { store: HistoryStore; redactorFor(workspace: string): Redactor; configurationFingerprint: string; packageVersion: string; instance: { pid: number; procStart: string | null }; diagnostic(code: GapCode): void; now?: () => string }): HistoryRecorder` — every method catches, classifies, records a gap row when the store is writable, otherwise emits one diagnostic `{ level: "warn", event: "history_write_failed", stage: "history", code }`. Work per session is chained so entries stay in order; `turnEnded` loops `read` until `more` is false, then writes turn plus entries in one transaction and advances `sessions.entry_cursor`.
  - `NOOP_HISTORY_RECORDER` for the disabled case.
  - `reconcileInstances(store: HistoryStore, isAlive: (pid: number, procStart: string | null) => boolean): number` — marks sessions of dead instances whose `closed_at` is null as `incomplete`, sets `ended_at` on the instance, marks the last turn `unrecorded` when its `recorded` flag is 0. Returns the count. `defaultIsAlive` uses `process.kill(pid, 0)` and, on Linux, compares field 22 of `/proc/<pid>/stat` with `procStart`.
  - Registry: `SessionRegistryOptions.history?: HistoryRecorder`. After `notifyTerminal` the registry calls `turnEnded` with `handle.readHistory` bound (skip when the handle has none). `close` calls `await history.settle(id, HISTORY_SETTLE_DEADLINE_MS)` before `disposeHandle`, then `sessionClosed`. `shutdown` calls `flush` inside its existing deadline.
  - `main.ts`: when `config.history.enabled`, open the store; on failure emit `{ level: "warn", event: "history_inactive", stage: "startup", code }` and continue with `NOOP_HISTORY_RECORDER`; on success run `reconcileInstances` once, insert the instance row, pass the recorder to the registry. `projectCapabilities` gets `{ enabled: recorder !== NOOP }`.

- [ ] **Step 1: Write the failing tests**

`test/history-recorder.test.ts` (real store in a temp home, fake pages):
- `writes session metadata, turn and entries in order` — two turns, three entries each; `entries` rows ordered by position, `turns.recorded = 1`.
- `is idempotent on duplicate Pi entry ids` — a page repeating an entry id writes one row.
- `records a gap when a write fails and continues` — make the store throw `SQLITE_BUSY` once; next turn records normally; `gaps` has `history_locked` with the failed turn id; `sessions.completeness = has_gaps`.
- `emits one diagnostic when no gap can be written` — closed store; diagnostic sink receives `history_unavailable`; stderr text contains no entry text.
- `rejects a page entry without an id as history_relay_invalid` — source `writer-relay`.

`test/registry-history.test.ts` (fake adapter with `readHistory`):
- `aborted and deadline turns are recorded` — terminal states `aborted` and `aborted` with reason `deadline`.
- `history failure never changes the turn outcome` — recorder whose methods throw; `pi_turn_get` result identical to a run without history.
- `close waits for a pending write up to the settle deadline` (Review Focus 2) — `readHistory` resolves after 200 ms; close returns after the write; with a never-resolving `readHistory` close returns within `HISTORY_SETTLE_DEADLINE_MS + 500` and a gap row exists.
- `shutdown records the aborted turn and the close` (Review Focus 3) — running turn, `registry.shutdown()`; session row has `closed_at`, completeness `complete` or `has_gaps`.
- `task label reaches the session row`.

`test/history-reconcile.test.ts`:
- `marks sessions of a dead instance incomplete and the open turn unrecorded`.
- `leaves sessions of a live instance alone`.
- `treats a reused pid with another proc start as dead` (Linux only, `it.runIf(process.platform === "linux")`).

`test/sdk-pi-adapter.test.ts` addition: `readHistory returns entries after the cursor` using the existing SDK fake that appends to a real `SessionManager.inMemory`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/history-recorder.test.ts test/registry-history.test.ts test/history-reconcile.test.ts test/sdk-pi-adapter.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement recorder, reconcile, handle and registry changes, and the `main.ts` wiring with the signatures above**

- [ ] **Step 4: Run tests to verify they pass, then the registry suites**

Run: `npx vitest run test/history-recorder.test.ts test/registry-history.test.ts test/history-reconcile.test.ts test/sdk-pi-adapter.test.ts test/registry.test.ts test/session-registry-deadline.test.ts test/lifecycle-hardening.test.ts test/mcp-stdio-e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/history/recorder.ts src/history/reconcile.ts src/pi-adapter.ts src/sdk-pi-adapter.ts src/session-registry.ts src/main.ts test/fake-adapter.ts test/history-recorder.test.ts test/registry-history.test.ts test/history-reconcile.test.ts test/sdk-pi-adapter.test.ts
git commit -m "feat(history): record host sessions per turn and reconcile crashes (#215)"
```

---

### Task 6: Writer relay capture

**Files:**
- Modify: `src/server.ts` (inner-only tool), `src/session-registry.ts` (`historyPage`), `src/writer-relay.ts` (`RelayHandle.readHistory`), `src/tool-schemas.ts` (page schema), `src/main.ts` (enable the inner tool when `PI_SESSION_MCP_WRITER_GUARD` is set)
- Test: `test/writer-relay.test.ts`, `test/mcp-session-tools.test.ts` or `test/mcp-contract.test.ts`

**Interfaces:**
- Consumes: `HistoryPage`, `readHistory?` (Task 5); recorder source `writer-relay`.
- Produces:
  - `createServer(..., relay = false, options: { innerHistory?: boolean } = {})`; with `innerHistory: true` it registers `pi_history_read` with input `{ sessionId: idInputSchema, cursor: z.number().int().min(0) }` and output `historyPageSuccessSchema = z.object({ ok: z.literal(true), header: z.unknown().optional(), entries: z.array(z.unknown()), next: z.number().int().min(0), more: z.boolean() })`. The host registration (`relay: true`) never registers it.
  - `SessionRegistry.historyPage(sessionId: string, cursor: number, maxBytes: number): Promise<HistoryPage>` — reads from the handle and cuts the page so its JSON encoding stays ≤ `maxBytes`; a single entry larger than `maxBytes` is replaced by a truncated copy with marker `[TRUNCATED:<bytes>]` (size is never a gap, call 14). The inner tool passes `HISTORY_RELAY_PAGE_BYTES`.
  - `RelayHandle.readHistory(cursor)` calls `pi_history_read` through `Connection.call` with `RELAY_CALL_TIMEOUT_MS`. Any failure (tool missing, schema mismatch, timeout) rejects with `HistoryStoreError("history_relay_invalid")` and must not set `connection.lost` or settle the active turn.
  - Session start for relay handles uses `source: "writer-relay"` in `sessionStarted` (decided by `handle.placement !== undefined`).

- [ ] **Step 1: Write the failing tests**

- `inner tool is absent on the host registration and present with innerHistory` — `tools/list` of both servers.
- `historyPage pages by byte budget` — 30 entries of 40 KiB with `maxBytes = 458_752`; pages concatenate to all 30, every encoded page ≤ budget, last page `more: false`.
- `historyPage truncates one oversized entry instead of failing` — one 2 MiB entry.
- `relay records entries with provenance writer-relay` — fake inner connection; `sessions.capture_source = writer-relay`.
- `malformed, oversized-encoded and mismatched-session pages become history_relay_invalid` — each case: gap row exists, turn result unchanged, `handle.isLost()` false.
- `older inner server without the tool` (Review Focus 5) — inner `tools/list` lacks `pi_history_read`; gap `history_relay_invalid`, next prompt on the same handle still works.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/writer-relay.test.ts test/mcp-contract.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the inner tool, `historyPage`, `RelayHandle.readHistory` and the `main.ts` flag**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/writer-relay.test.ts test/mcp-contract.test.ts test/mcp-session-tools.test.ts test/writer-registration.test.ts`
Expected: PASS. A `podman` suite that cannot run here is reported by file and test name.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/session-registry.ts src/writer-relay.ts src/tool-schemas.ts src/main.ts test/writer-relay.test.ts test/mcp-contract.test.ts
git commit -m "feat(history): page writer entries to the host as untrusted input (#215)"
```

---

### Task 7: CLI `pi-session-mcp-history`

**Files:**
- Create: `src/history-main.ts` (entry, argv, exit codes), `src/history/cli.ts` (commands), `src/history/timeline.ts` (`show` rendering), `src/history/export.ts` (JSONL v3)
- Modify: `package.json` (`bin.pi-session-mcp-history = "dist/history-main.js"`), `test/package-contents.test.ts` expectations if it lists bins
- Test: `test/history-cli.test.ts`

**Interfaces:**
- Consumes: `openHistoryStore` (read-only for `list`, `show`, `export`, `query`; writable for `verdict`, `prune --apply`, `reconcile`), `reconcileInstances`, `defaultIsAlive` (Task 5).
- Produces:
  - `runHistoryCli(argv: readonly string[], io: { stdout: (s: string) => void; stderr: (s: string) => void; home?: string; now?: () => Date }): Promise<0 | 1 | 64>` — `64` usage error, `1` runtime error (file missing, unknown session, refused SQL), `0` success. Session arguments accept the public session id or the history id.
  - Commands and flags exactly as spec "CLI", plus `query "<SELECT …>" [--json]`. `query` rejects anything that is not a single statement starting with `SELECT` or `WITH` (after comments and whitespace), and runs on a read-only connection; output is tab-separated with a header, or JSON lines with `--json`.
  - `list` columns: created, session id (short), workspace, profile, task, turns, completeness, latest verdict.
  - `show` prints one line per entry: `HH:MM:SS  <kind>  <tool or role>  <shortened text ≤ 160 chars>`; `--full` prints untruncated redacted text; dropped entries show `content not stored (path rule)`; gaps and `incomplete` appear as their own lines.
  - `export --format jsonl [--out FILE]`: first line the header (`type: "session"`, `version: 3`, `id`, `timestamp`, `cwd: "<workspace alias>"`), then the redacted entries; when any entry is truncated or a gap exists, stderr says `export is lossy`. `--out` refuses an existing file.
  - `verdict <session> accepted|rejected|reworked --reason "<…>"`: reason one line, 1–`VERDICT_REASON_MAX` chars; appends a row with source `controller`.
  - `prune --older-than <n>d [--apply]`: dry run prints the count; `--apply` deletes sessions closed before the cutoff with their rows in one transaction, then `VACUUM`.

- [ ] **Step 1: Write the failing tests** (fixture DB built through the recorder from Task 5)

- `list filters by workspace, profile, task, since and verdict` — each filter alone and two combined.
- `show renders a timeline with tool names and the path-rule marker`.
- `show --full prints the full redacted text and no sentinel`.
- `export writes Pi JSONL v3 and parses back` — every line `JSON.parse`s, header `version` 3, entry ids match; a truncated fixture prints `export is lossy`.
- `verdict is append-only and list shows the latest`.
- `verdict rejects an unknown value and a multi-line reason with 64`.
- `prune dry run deletes nothing; apply deletes old sessions only`.
- `query allows SELECT and WITH, refuses INSERT, PRAGMA, ATTACH and two statements` — refused with exit 1, file bytes unchanged.
- `missing history file prints a hint and exits 1` — message names no path beyond `~/.local/state/pi-session-mcp/history/`.
- `unknown command and missing arguments exit 64`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/history-cli.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the CLI modules and the bin entry**

- [ ] **Step 4: Run tests to verify they pass, then build and smoke**

Run: `npx vitest run test/history-cli.test.ts test/package-contents.test.ts && npm run build && node dist/history-main.js --help`
Expected: PASS; help text lists all seven commands; exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/history-main.ts src/history/cli.ts src/history/timeline.ts src/history/export.ts package.json test/history-cli.test.ts test/package-contents.test.ts
git commit -m "feat(history): add the pi-session-mcp-history CLI (#215)"
```

---

### Task 8: Doctor checks

**Files:**
- Modify: `src/doctor.ts` (check ids, dependency seam, checks)
- Test: `test/doctor-history.test.ts`

**Interfaces:**
- Consumes: `historyLocation`, `openHistoryStore({ readOnly: true })`, `HISTORY_SCHEMA_VERSION` (Task 2); `AppConfig.history` (Task 4).
- Produces: `DoctorCheckId` additions, exactly: `history_storage` (error: wrong owner, mode, symlink, or location inside a configured workspace path, the writers root, the snapshots root or a skill directory), `history_schema` (error: newer than known), `history_integrity` (error: `PRAGMA quick_check` not `ok`), `history_gaps` (warning: gaps recorded in the last 7 days, count only). A missing file with history enabled is `ok` (created on first server start). History disabled: no history checks. A dependency seam `history?: { inspect(home: string): Promise<HistoryInspection> }` on `DoctorDependencies` keeps tests offline and fast.

- [ ] **Step 1: Write the failing tests**

- `no history checks when disabled`.
- `ok on a fresh v1 file with correct modes`.
- `history_storage on a 0644 file, a symlinked directory, and a workspace alias pointing at the history directory`.
- `history_schema on user_version 2`.
- `history_integrity on a corrupted page` (write garbage over page 2 of a copy).
- `history_gaps warns with a count and no codes or paths in remediation`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/doctor-history.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the checks**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/doctor-history.test.ts test/doctor.test.ts test/doctor-bootstrap.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/doctor.ts test/doctor-history.test.ts
git commit -m "feat(history): add offline Doctor checks for the history file (#215)"
```

---

### Task 9: Documentation, controller skill and changelog

**Files:**
- Modify: `docs/tool-contracts.md` (`task` argument, `history` capability, inner-only tool marked as writer-internal), `docs/threat-model.md` (history file asset, redaction limits, call 18 residual risk, call 19 readers), `README.md` (enable history, CLI usage, `pi --export` for HTML), `skills/pi-session-orchestration/SKILL.md` (pass `task` at start; record a verdict after own verification when `history.enabled`; never pass history content to Pi workers, agy or other models), `CHANGELOG.md` (`## Unreleased`)
- Test: existing skill and docs tests (`test/orchestration-skill-start-codes.test.ts`, `test/setup-skills.test.ts`, `test/package-contents.test.ts`)

**Interfaces:**
- Consumes: names and codes from Tasks 2–8 verbatim.

- [ ] **Step 1: Update the documents**

The skill text stays short: three bullets under the existing start and verification sections. The README section shows the config block from the spec, `pi-session-mcp-history list`, `show`, `verdict`, `query`, and `pi --export <file> out.html`.

- [ ] **Step 2: Run docs- and skill-related tests**

Run: `npx vitest run test/orchestration-skill-start-codes.test.ts test/setup-skills.test.ts test/package-contents.test.ts test/execution-modes-docs.test.ts`
Expected: PASS. If a skill digest test pins the skill bytes, update the pinned digest in the same commit.

- [ ] **Step 3: Commit**

```bash
git add docs/tool-contracts.md docs/threat-model.md README.md skills/pi-session-orchestration/SKILL.md CHANGELOG.md test/
git commit -m "docs: document the opt-in session history (#215)"
```

---

### Task 10: Whole-branch verification and the one PR

**Files:**
- Test: `test/history-sentinel-e2e.test.ts`

- [ ] **Step 1: Write the end-to-end sentinel test**

Start the compiled server (`dist/main.js`) through the existing stdio e2e harness with the fake adapter seam used in `test/mcp-stdio-e2e.test.ts`, history enabled, a temp home, and a scripted session whose entries contain every sentinel from Task 3 plus a `read` of `.env`. After close and shutdown, read the raw bytes of `history.sqlite`, `history.sqlite-wal` (if present) and `history.sqlite-shm`; assert no sentinel substring appears. Assert the server's stdout carried only MCP frames and stderr only JSON lines.

- [ ] **Step 2: Run the full gate**

Run: `npm run typecheck && npm run build && npm test`
Expected: all pass. Container-writer lock or hook timeouts, if any, are listed by file and test name.

- [ ] **Step 3: Run the Node 22 store and sentinel tests**

Run: `PATH=$HOME/.local/opt/node-v22.23.3-linux-x64/bin:$PATH npx vitest run test/history-store.test.ts test/history-sentinel-e2e.test.ts`
Expected: PASS, no `ExperimentalWarning` in captured stderr.

- [ ] **Step 4: Independent review**

Review from another model family than the author (per `<operator rule file>`): a read-only Pi `review` profile on the branch diff against `main`, with acceptance criteria "full `npm test` green, the five Review Focus cases covered, one negative case per redaction kind". Address findings in new commits.

- [ ] **Step 5: Commit, push, open the one PR**

```bash
git add test/history-sentinel-e2e.test.ts
git commit -m "test(history): prove no sentinel reaches the database file (#215)"
git push
gh pr create --title "feat: opt-in session history (#215)" --body-file <prepared body per .github template, checks actually run, ADR 0019 Proposed>
```

ADR 0019 flips to `Accepted` in a final commit after the maintainer accepts it in review, before merge. The live check on the workstation (one host read-only and one container writer session with history enabled, `show`, `pi --export`) runs after acceptance and is recorded in the PR.
