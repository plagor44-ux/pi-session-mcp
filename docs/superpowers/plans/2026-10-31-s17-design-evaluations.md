# Sprint 17 design and evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take #213, #212, #210 and #214 to recorded decisions: two `Proposed` ADRs with provider-free proofs, and two evaluations with fixtures, bounded live runs and an adopt/defer/reject verdict.

**Architecture:** Nothing in `src/` changes. Proof and evaluation code lives under `eval/recovery/`, `eval/turn-deadline/` and `eval/reports/`, with Vitest tests in `test/` that run under `npm test` (as `eval/bridge/` does). Records go to `docs/adr/`, `docs/evaluation/` and `docs/sprints/`. The only shipped-file change is the verdict-token correction in the orchestration skill.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Vitest 5.0.3 with fake timers, real Git, optional rootless Podman, pi-session-mcp MCP tools, headless `claude -p` and `codex exec` controllers.

**Spec:** `docs/superpowers/specs/2026-10-31-s17-design-evaluations-design.md`

## Global Constraints

- Branch `feat/s17-design-evaluations`, one pull request naming #210, #212, #213 and #214; commits per issue (the verdict fix commits under #210).
- No change under `src/`; no release, tag or npm publication.
- AGENTS.md rules: English docs, `.js` suffixes in relative imports, exact pins (no new dependency is planned), tests use fakes and never need provider credentials, reports sanitized (no secrets, absolute private paths, complete prompts, transcripts or raw provider errors).
- Never run host Git in a writer clone or fetch directly from it; clone-side Git only inside the script passed to `throwawayArgs` (`src/writer-boundary.ts:225`), host Git only in the operator checkout.
- Live budget, fixed before the first model turn: ≤ 24 worker turns including follow-ups (#210 ≤ 12, #214 ≤ 12), ≤ 4 controller runs, ≤ 120 minutes wall time for all live runs. Stop on `local_authentication_missing` or `unknown_execution_profile`; no profile switch to work around a failure; every attempt is kept.
- xAI and Cursor profiles are not used.
- Checks before the pull request: `npm run typecheck`, `npm run build`, `NODE_OPTIONS=--unhandled-rejections=strict npm test`. Report only checks that ran.

## Review Focus

- A conflict where one side deleted the file (stage 2 or 3 absent): recovery must record the absence, not fail or invent a blob. Test in Task 2.
- Conflicted file names with spaces or newlines: the recovery script must use `-z` and survive them. Test in Task 2.
- A configured turn limit at the upper bound must stay below Node's `setTimeout` limit (2,147,483,647 ms); larger or fractional values must be refused, not wrapped. Test in Task 4.
- A wall-clock jump during a turn must not fire or delay the deadline (monotonic clock). Test in Task 4.
- A receipt with two JSON blocks, unknown keys or a `STATUS` line that disagrees with the receipt's `status` must be rejected, not merged. Test in Task 6.

---

### Task 1: Preflight and verdict-token correction (#210)

**Files:**
- Modify: `skills/pi-session-orchestration/SKILL.md:98`
- Modify: `test/skill-library.test.ts` (new `it` after line 177)
- Modify: `CHANGELOG.md` (`Unreleased` section)
- Modify: `tsconfig.json` (`include`)

**Interfaces:**
- Produces: tsconfig `include` entries `eval/recovery/**/*.ts`, `eval/turn-deadline/**/*.ts`, `eval/reports/**/*.ts`, used by Tasks 2, 4 and 6.

- [ ] **Step 1: Preflight.** Run `git worktree list`, `git status --porcelain`, `gh pr list`, and `pi_session_list` (no open sessions expected). Record findings for the sprint record (Task 13).
- [ ] **Step 2: Write the failing test** `it("asks reviewers for the verdict tokens the review skill emits")`: read `pi-session-orchestration/SKILL.md`; expect it to contain ``exactly one of `BLOCKING_FINDINGS`, `NON_BLOCKING_ONLY` or `NO_FINDINGS` ``; expect it not to contain `` `CLEAN` ``; read `pi-session-review/SKILL.md` and expect it to contain `BLOCKING_FINDINGS`, `NON_BLOCKING_ONLY` and `NO_FINDINGS`.
- [ ] **Step 3: Run** `npx vitest run test/skill-library.test.ts`. Expected: the new test FAILS on the orchestration assertion.
- [ ] **Step 4: Edit** line 98 of the orchestration skill to ``exactly one of `BLOCKING_FINDINGS`, `NON_BLOCKING_ONLY` or `NO_FINDINGS` ``. Add a changelog entry under `Unreleased` → `Fixed`: the controller skill now asks for the verdict tokens the review skill emits (#210). Add the three `eval/` include entries to `tsconfig.json`.
- [ ] **Step 5: Run** `npx vitest run test/skill-library.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `fix(skills): align the controller's review verdict tokens with the review skill (#210)`.

### Task 2: Recovery prototype and real-Git proof (#213)

**Files:**
- Create: `test/real-git-writer-fixture.ts` (move `spawn`, `git`, `gitPresent`, `realRunner`, `fixture` and the constants they use out of `test/writer-collect-real-git.test.ts`, unchanged)
- Modify: `test/writer-collect-real-git.test.ts` (import them instead)
- Create: `eval/recovery/recover.ts`
- Create: `test/writer-recover-real-git.test.ts`

**Interfaces:**
- Consumes: `WriterContext`, `collectWriter`, `finishWriter`, `removeWriter` (`src/writer-lifecycle.ts`); `writerPaths`, `readWriterState` (`src/writer-state.ts`); `throwawayArgs`, `BOUNDARY_GIT`, `verifyCloneLayout`, `isSafeRefName`, `BoundaryError` (`src/writer-boundary.ts`); `acquireWriterLease` (`src/writer-lease.ts`); `SETUP_LEASE_WAIT_MS` (`src/setup-writers-common.ts`).
- Produces: `export type RecoverCode = "writer_recover_planned" | "writer_recovered" | "nothing_to_recover" | "writer_recover_unsupported" | "writer_recover_failed" | "writer_recover_incomplete" | "writer_busy"` and `export async function recoverWriter(ctx: WriterContext, name: string, options: { apply: boolean }): Promise<{ code: RecoverCode; status: "ok" | "planned" | "unchanged" | "failed"; slot?: number }>`. `RECOVERY_REF_ROOT = "refs/recovery"`; refs land at `refs/recovery/writer-<name>/<slot>/{worktree,stage1,stage2,stage3,manifest}`, `slot` = 1 + highest existing slot.

- [ ] **Step 1: Extract the fixture** into `test/real-git-writer-fixture.ts` and run `npx vitest run test/writer-collect-real-git.test.ts`. Expected: PASS, same test count as before.
- [ ] **Step 2: Write the failing tests** in `test/writer-recover-real-git.test.ts`, each building the #200 conflict from `test/writer-collect-real-git.test.ts:384-392` (sentinels `SYNTHETIC_CONFLICT_MAIN_3107` / `_OTHER_3107`) plus one untracked file `notes.txt`:
  - `recovers the worktree and all three index stages into a new slot`: code `writer_recovered`, slot 1; in the checkout `git show <ref>/stage1:base.txt` is `base\n`, `stage2` the MAIN sentinel, `stage3` the OTHER sentinel; `worktree:base.txt` contains `<<<<<<<` and both sentinels; `worktree:notes.txt` exists; `manifest` holds one file `unmerged-index.txt` with three lines.
  - `leaves the writer byte-identical`: before/after equal for `ls-files -u -z`, `for-each-ref` in the clone, `.git/index` bytes, `base.txt` bytes, `state.json` bytes, also with a pre-seeded `collected: { digest: "sha256:" + "0".repeat(64), at }`.
  - `keeps collect, finish and remove refused after recovery`: all three `status: "failed"`.
  - `adds a second slot without touching the first`: second run gives slot 2; slot 1 refs unchanged.
  - `plans without writing`: `apply: false` gives `writer_recover_planned`, no `refs/recovery` refs, `bundles/` holds only `base.bundle`.
  - `reports nothing_to_recover without an unmerged index`: clean writer, no refs.
  - `records a deleted side`: other side runs `git rm base.txt`; `stage3` ref has no `base.txt`, manifest lists two stages.
  - `handles conflicted names with spaces and newlines`: file `"a b\nc.txt"` in conflict; all stages recovered.
  - `recovers a symlink conflict`: stages carry mode `120000`.
  - `refuses a gitlink in conflict`: `writer_recover_unsupported`, no refs.
  - `fails cleanly on a missing stage object`: delete one stage blob from the clone's object store; code `writer_recover_failed`, no refs, writer otherwise unchanged.
  - `refuses while the writer lease is held`: hold `acquireWriterLease(home, "repo-w1", { waitMs: 0 })`, call with `SETUP_LEASE_WAIT_MS` replaced by a short wait seam; code `writer_busy`, no refs.
  - `rolls back a partial import`: runner wrapper fails the third host `fetch`; code `writer_recover_incomplete`, no refs under that slot, writer unchanged, bundle removed.
  - `leaves no bundle behind`: after every case `bundles/` holds only `base.bundle`.
- [ ] **Step 3: Run** `npx vitest run test/writer-recover-real-git.test.ts`. Expected: FAIL, `recoverWriter` not defined.
- [ ] **Step 4: Implement `recoverWriter`** in `eval/recovery/recover.ts`. Order: dry-run returns `writer_recover_planned` without the lease; otherwise acquire the lease and pass its fd to every runner call (as `leasedContext` does); `verifyCloneLayout`; run one throwaway container (clone `ro`, bundles `rw`) with this script; host `bundle verify`, `bundle list-heads`, one `fetch --no-tags --end-of-options <bundle> +refs/heads/recovery/<x>:refs/recovery/writer-<name>/<slot>/<x>` per head (names checked with `isSafeRefName`); on any fetch failure delete that slot's refs with `update-ref -d` and return `writer_recover_incomplete`; always remove `bundles/recover.bundle`; never read or write `state.json`. Container script algorithm:

```sh
set -eu
export GIT_CONFIG_NOSYSTEM=1
export GIT_OBJECT_DIRECTORY=/tmp/objects GIT_ALTERNATE_OBJECT_DIRECTORIES="$1/.git/objects"
export GIT_AUTHOR_NAME=pi-writer GIT_AUTHOR_EMAIL=pi-writer@example.invalid
export GIT_COMMITTER_NAME=pi-writer GIT_COMMITTER_EMAIL=pi-writer@example.invalid
G="$BOUNDARY_GIT -C $1"; mkdir -p /tmp/objects
cp "$1/.git/index" /tmp/orig
GIT_INDEX_FILE=/tmp/orig $G ls-files -u -z > /tmp/unmerged
[ -s /tmp/unmerged ] || { echo nothing_to_recover; exit 0; }
# refuse gitlinks: any entry with mode 160000 -> echo writer_recover_unsupported; exit 0
head=$($G rev-parse HEAD)
for s in 1 2 3; do   # index = HEAD tree, then each unmerged path set to its stage-$s entry or removed if absent
  GIT_INDEX_FILE=/tmp/s$s $G read-tree "$head"
  # feed "<mode> <sha> 0\t<path>\0" for entries of stage $s and --force-remove the other unmerged paths (-z)
  t=$(GIT_INDEX_FILE=/tmp/s$s $G write-tree); c=$(... commit-tree "$t" -p "$head" -m "recovery stage $s")
done
GIT_INDEX_FILE=/tmp/wt $G read-tree "$head"; GIT_INDEX_FILE=/tmp/wt $G add -A   # markers + untracked, not ignored
# worktree commit, manifest commit (tree with unmerged-index.txt = `ls-files -u` text), then:
# bare /tmp/scratch with alternates (/tmp/objects and the clone's objects), refs/heads/recovery/{worktree,stage1,stage2,stage3,manifest}
# bundle create /bundles/recover.bundle --all; echo recovered
```

  Stage refs for a stage with no entries at all are omitted.
- [ ] **Step 5: Run** `npx vitest run test/writer-recover-real-git.test.ts test/writer-collect-real-git.test.ts`. Expected: PASS.
- [ ] **Step 6: Podman case (optional).** If `podmanInfo` is usable and the pinned Node image resolves locally, add one `it.skipIf(...)` case to a new `test/writer-recover.podman.test.ts`, gated like `test/writer-lifecycle.podman.test.ts:24-29`, asserting `writer_recovered` and stage2/stage3 contents. Run it; record pass or skip with its reason.
- [ ] **Step 7: Commit** `test(recovery): prove a non-destructive recovery export of an unmerged writer (#213)`.

### Task 3: ADR 0016 and recovery evidence (#213)

**Files:**
- Create: `docs/adr/0016-writer-recovery-export.md`
- Create: `docs/evaluation/writer-recovery-2026-10-31/README.md`

- [ ] **Step 1: Write ADR 0016**, status `Proposed`, in the structure of `docs/adr/0015-review-snapshots.md`. It decides: operation `--writer <name> --recover` (dry-run default, `--apply`), lock and lease order as `runWriterOperation`, the container script contract, the namespace `refs/recovery/writer-<name>/<slot>/…`, the code table from Task 2, preserved classes (worktree incl. markers, untracked, stages 1–3, manifest) and named unsupported classes (ignored files, reflogs, unreachable objects, stash entries, gitlinks), rollback of partial imports, the Doctor interaction (`writer_uncollected_bundle` only for a leftover `recover.bundle`), the manual resolution path, that `collect`/cleanup refusals are unchanged, and the release type (minor: new CLI operation and codes).
- [ ] **Step 2: Write the evidence README** like `docs/evaluation/review-snapshots-2026-10-31/README.md`: how to run, source commit, Node and Git versions, `uname -sr`, the test list with pass/skip, limits.
- [ ] **Step 3: Review round.** Start a read-only `review` session (another model family) with the ADR text and the test names in the prompt (read-only workers cannot read outside the workspace; give content, not paths), asking for `VERDICT:` with `BLOCKING_FINDINGS`, `NON_BLOCKING_ONLY` or `NO_FINDINGS`. In parallel dispatch the `reviewer` subagent on the same commit. Check each finding against code or Git behavior; adopt or record it as rejected with the reason; one re-review if any finding was blocking.
- [ ] **Step 4: Commit** `docs(adr): propose ADR 0016 for a writer recovery export (#213)` (plus a separate commit per review revision).

### Task 4: Turn-deadline prototype and race tests (#212)

**Files:**
- Create: `eval/turn-deadline/supervisor.ts`
- Create: `test/turn-deadline-prototype.test.ts`

**Interfaces:**
- Consumes: `SessionRegistry`, `TurnTerminalNotice`, `RegistryError`, `PromptResult` (`src/session-registry.ts`); `FakeAdapter`, `FakeHandle` (`test/fake-adapter.ts`).
- Produces:
  - `export const MAX_TURN_SECONDS_MIN = 60; export const MAX_TURN_SECONDS_MAX = 86_400;`
  - `export function parseMaxTurnSeconds(value: unknown): number | undefined` (undefined for absent; throws `Error("invalid_max_turn_seconds")` for anything but an integer within bounds).
  - `export type ExpiryOutcome = "aborted" | "settled_first" | "abort_failed" | "abort_timeout";`
  - `export class DeadlineSupervisor { constructor(registry: SessionRegistry, options: { maxTurnSeconds: number; now?: () => number }); prompt(sessionId: string, text: string): Promise<PromptResult>; notice(event: TurnTerminalNotice): void; expiries(): ReadonlyArray<{ sessionId: string; turnId: string; outcome: ExpiryOutcome }>; usable(sessionId: string): boolean; }`. `notice` is wired as the registry's `onTurnTerminal`. `prompt` refuses an unusable session with `Error("turn_deadline_uncertain")`. Deadline anchor: the moment `registry.prompt` resolves (turn published); clock `now` defaults to `performance.now`.

- [ ] **Step 1: Write the failing tests** (fake timers with `toFake: ["setTimeout", "clearTimeout", "Date", "performance"]`, registry deadlines as `test/lifecycle-hardening.test.ts:5`, `maxTurnSeconds: 60`):
  - `parses only integers within bounds`: 60 and 86_400 accepted; undefined gives undefined; 0, 59, 86_401, 60.5, `"60"`, NaN throw `invalid_max_turn_seconds`; `86_400 * 1000 < 2 ** 31 - 1`.
  - `does nothing when the turn completes before the deadline`: complete at 59 s; no abort; `vi.getTimerCount()` is 0 after settling.
  - `completion one tick before expiry wins`: advance 59_999 ms, `complete()`, advance 1 ms: turn `completed`, `aborted === 0`, no expiry.
  - `expiry aborts exactly once`: advance 60 s: `handle.aborted === 1`, turn `aborted`, one terminal notice, outcome `aborted`, session usable.
  - `completion during the expiry abort stays completed`: `abortGate` pending, `abortSettlesPrompt = false`, expire, `complete()`, release gate: turn `completed`, outcome `settled_first`, one notice.
  - `manual abort before expiry cancels the deadline`: `registry.abort` at 30 s; advance to 120 s; `aborted === 1`, no expiry.
  - `manual abort during expiry is coalesced`: expire with pending `abortGate`, call `registry.abort`; `aborted === 1`.
  - `a rejected expiry abort claims nothing`: `abortError` set; outcome `abort_failed`; turn still `running`; `usable` false; `supervisor.prompt` rejects `turn_deadline_uncertain`; `registry.get` and `registry.close` still work.
  - `an expiry abort timeout claims nothing until it settles`: `abortGate` never resolves until released; outcome `abort_timeout`; turn `running`; releasing the gate ends the turn `aborted` with exactly one notice.
  - `close racing expiry yields one notice`: `registry.close` at 60 s; one notice with `via: "close"`; no abort beyond close's.
  - `shutdown racing expiry yields one notice per turn`.
  - `a parallel session is unaffected`: second session's turn keeps running past the first's expiry; its own notice count 0.
  - `a wall-clock jump does not move the deadline`: `vi.setSystemTime(Date.now() + 3_600_000)` at 10 s; no expiry until 60 s of timer time.
- [ ] **Step 2: Run** `npx vitest run test/turn-deadline-prototype.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `eval/turn-deadline/supervisor.ts`. One timer per published turn, cleared by `notice` or after the expiry abort settles; expiry checks `registry.getTurn(...).state === "running"` before calling `registry.abort` once; classify `RegistryError` codes `abort_failed` and `abort_timeout`; an `abort_timeout` turn that later settles `aborted` keeps outcome `abort_timeout` but the session stays unusable.
- [ ] **Step 4: Run** `npx vitest run test/turn-deadline-prototype.test.ts`. Expected: PASS.
- [ ] **Step 5: Relay case (bounded).** If the fake inner server of `test/writer-relay.test.ts` can drive a relayed session within one new test, add `expiry on a relayed session aborts the inner turn once` there; otherwise do not add it and record the gap for the ADR.
- [ ] **Step 6: Commit** `test(turn-deadline): prototype a per-profile turn deadline and its races (#212)`.

### Task 5: ADR 0017 and deadline evidence (#212)

**Files:**
- Create: `docs/adr/0017-turn-duration-limit.md`
- Create: `docs/evaluation/turn-deadline-2026-10-31/README.md`

- [ ] **Step 1: Write ADR 0017**, status `Proposed`. It decides: profile field `maxTurnSeconds` (60–86,400, absent = no limit), anchor at publication with the admission alternative weighed, monotonic clock, one abort through `beginAbort`, the result of a successful expiry (`aborted` plus an additive reason; name and shape fixed here), the non-reusable session after `abort_failed`/`abort_timeout` and its refusal code, interaction with close/shutdown, the existing `close()` early-`aborted` behavior (recorded, not changed), relay placement (inner server enforces; field added to the compared capability projection so a mismatch counts as `settingsChanged`), configuration/capability/tool-contract/turn-event/skill/doc impacts with file references from the spec, the test matrix (Task 4 plus gaps), and minor release under ADR 0003. It states that provider-request termination, side-effect rollback and cost caps are not guaranteed.
- [ ] **Step 2: Write the evidence README** (run command, source commit, Node version, test list with results, gaps such as real child-process termination).
- [ ] **Step 3: Review round** as Task 3 Step 3.
- [ ] **Step 4: Commit** `docs(adr): propose ADR 0017 for a per-profile turn duration limit (#212)`.

### Task 6: Report validator and fixtures (#210, #214)

**Files:**
- Create: `eval/reports/validate.ts`
- Create: `eval/reports/fixtures/` (one `.txt` per case and form)
- Create: `test/report-validator.test.ts`

**Interfaces:**
- Produces:
  - `export type ReportStatus = "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";`
  - `export type Problem = "status_missing" | "status_invalid" | "commit_missing" | "checks_missing" | "question_missing" | "concerns_missing" | "receipt_missing" | "receipt_invalid" | "receipt_duplicate" | "status_mismatch" | "incomplete_turn";`
  - `export interface ParsedReport { status: ReportStatus; commit?: string; checks: Array<{ command: string; exitCode: number }>; concerns: string[]; question?: string; claimsOnly: true; }`
  - `export function validateTextReport(turn: { assistantText: string; truncated: boolean; completion: "stop" | "output_limit" | "tool_use" }): { ok: true; report: ParsedReport } | { ok: false; problems: Problem[] }`
  - `export function validateReceipt(turn: same as above): same result type`. Receipt form: line 1 `STATUS: <status>`, then exactly one fenced `json` block `{ "schema": "receipt-v1", "status", "base", "result": { "branch", "commit" | null }, "changedFiles": [], "checks": [{ "command", "exitCode" }], "concerns": [], "question"? }`; unknown keys reject.
  - Rules for both: `truncated` or `completion` not `stop` gives `incomplete_turn`; `STATUS:` must be line 1, uppercase, trailing whitespace allowed; `DONE`/`DONE_WITH_CONCERNS` need a commit (or the literal `not committed` with a reason in text form) and at least one check; `DONE_WITH_CONCERNS` needs a concern; `NEEDS_CONTEXT` needs a question; failed checks (exit code ≠ 0) are kept in `checks`, never dropped.
- [ ] **Step 1: Write the fixtures and failing tests**, one per case and form: valid DONE, malformed status, missing status, missing commit, missing checks, failed check kept, NEEDS_CONTEXT with and without question, truncation (`truncated: true`) and `completion: "output_limit"`, early stop (empty text), valid-but-false success (shape `ok`; a separate oracle helper in the test, `oracle(fixtureRepo)`, runs `git rev-parse --verify <commit>` in a throwaway repository and fails), plus Review Focus cases: two JSON blocks (`receipt_duplicate`), unknown key (`receipt_invalid`), `STATUS: DONE` with receipt `status: "BLOCKED"` (`status_mismatch`), lowercase `status: done` (`status_invalid`).
- [ ] **Step 2: Run** `npx vitest run test/report-validator.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `eval/reports/validate.ts`. Text form fields are read from the labels the implementation skill prescribes (`Commit:`, `Checks run:`, open points) as listed in `skills/pi-session-implementation/SKILL.md:38-42`.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `test(reports): validate the text report contract and a receipt-v1 candidate (#210)`.

### Task 7: NEEDS_CONTEXT route fixtures (#214)

**Files:**
- Create: `test/needs-context-route.test.ts`

**Interfaces:**
- Consumes: `SessionRegistry` and `FakeAdapter` (as in `test/lifecycle-hardening.test.ts:1-11`); `validateTextReport`, `validateReceipt` from Task 6.

- [ ] **Step 1: Write the tests** (they should pass against today's registry; a failure is a finding to record, not to fix in `src/`):
  - `answers a question in the same session`: turn 1 text `STATUS: NEEDS_CONTEXT` with a question; follow-up prompt on the same session; `adapter.handles.length === 1`; turn 2 has a new `turnId`; both turns retrievable with `getTurn`.
  - `keeps two concurrent questions apart`: two sessions with different question texts; each answer goes to its own `sessionId`; each handle's received prompt texts contain only its own answer.
  - `refuses a second answer while the follow-up runs`: `session_running`.
  - `refuses an answer after close`: `unknown_session`.
  - `refuses an answer while an abort is pending`: `session_running`.
  - `a duplicate answer after the follow-up completed starts a new turn`: documents that the server cannot tell a late duplicate from a new follow-up (the controller's ledger must).
  - `the typed question in a receipt is machine-readable`: the receipt form yields `question`; the text form yields it from the same report.
- [ ] **Step 2: Run** `npx vitest run test/needs-context-route.test.ts`. Expected: PASS (record any failure verbatim).
- [ ] **Step 3: Commit** `test(questions): pin the server facts the NEEDS_CONTEXT route relies on (#214)`.

### Task 8: Retrospective count and pre-registrations (#210, #214)

**Files:**
- Create: `docs/evaluation/worker-reports-2026-10-31/retrospective.md`
- Create: `docs/evaluation/worker-reports-2026-10-31/pre-registration.md`
- Create: `docs/evaluation/worker-questions-2026-10-31/pre-registration.md`

- [ ] **Step 1: Retrospective.** From `docs/sprints/*.md` (Sprints 10–16) and `docs/acceptance.md`, count worker tasks, format-repair follow-ups, early stops, `BLOCKED`, `NEEDS_CONTEXT`, each with file:line. Label it as a retrospective of recorded cases, not a rate.
- [ ] **Step 2: Route check.** `pi_capabilities_get`; pick one coding profile for the #210 writers and one read-only profile for the #214 workers from the listed, non-xAI, non-Cursor profiles. Check `claude --version` and `codex --version`.
- [ ] **Step 3: #210 pre-registration:** source commit; route; three tasks on writers `pi-session-mcp-w1`/`-w2`, each with an independent oracle: (A) a small doable change with a targeted test (oracle: collected commit exists, targeted test passes on the controller's host), (B) a task whose required check fails by construction (oracle: the report keeps the failed check), (C) a task with a deliberately wrong stated base (oracle: `BLOCKED`, no commit). Each task once with the text contract and once with the receipt form: 6 turns, ≤ 6 follow-ups. Measures, the decision rule from the spec verbatim, stop rules, cleanup (collect, compare, finish each writer).
- [ ] **Step 4: #214 pre-registration:** two read-only underspecified tasks per controller run whose answer the controller prompt contains but the worker prompt does not (example: "report the value of the deadline constant the operator means" with the operator's choice only in the controller prompt); oracle: the final report names the right value; measures (question correlated and answered once, no speculative `DONE`, extra controller calls, acceptance); controller invocation for `claude -p` and `codex exec` with the bundled controller skill and the installed server; the decision rule from the spec verbatim; compaction recorded as a gap.
- [ ] **Step 5: Commit** `docs(evaluation): pre-register the worker report and question evaluations (#210, #214)`. No model turn before this commit.

### Task 9: #210 live comparison

**Files:**
- Create: `docs/evaluation/worker-reports-2026-10-31/README.md` and `runs/*.json` (sanitized per-run records: case, form, route, wall time, status line, validator result, follow-ups, oracle result)

- [ ] **Step 1: Run** the six pre-registered turns through `pi_session_start`/`pi_session_prompt`/`pi_turn_get`, with at most one corrective follow-up per turn, within budget. Validate each report with Task 6's validator; judge each with its oracle.
- [ ] **Step 2: Clean up** both writers: collect, compare refs with expectations, finish (`writer_reset`), delete collected refs. Record the end state.
- [ ] **Step 3: Write the README** (source binding, budget used, runs table including failed attempts, measures, result against the pre-registered rule, limits) and **commit** `docs(evaluation): record the worker report comparison (#210)`.

### Task 10: #214 live check with Claude Code and Codex

**Files:**
- Create: `docs/evaluation/worker-questions-2026-10-31/README.md` and `runs/*.json`

- [ ] **Step 1: Run** one controller run per client as pre-registered, each starting two workers. The harness records only tool-call sequences, turn states, status lines and oracle results; no transcripts. Use the retry margin only for an attempt that failed for a reason outside the evaluated behavior, and record it.
- [ ] **Step 2: Close** any session left open by a controller; verify with `pi_session_list`.
- [ ] **Step 3: Write the README** and **commit** `docs(evaluation): record the NEEDS_CONTEXT route check with Claude Code and Codex (#214)`.

### Task 11: Decisions (#210, #214)

**Files:**
- Modify: both evaluation READMEs (`## Decision`)
- Modify: `docs/roadmap.md` (K11 row and the question-channel row, around lines 512-513)

- [ ] **Step 1: Decide** adopt/defer/reject for each strictly by the pre-registered rules; name the evidence. Record procedure gaps for #214 (round limit, stale-answer rule) as skill follow-ups.
- [ ] **Step 1b: Review** each evaluation once: a read-only `review` session with the README content in the prompt; check and resolve findings before the decision is final.
- [ ] **Step 2: Follow-up issues** only for an adopt or a recorded procedure gap, via `gh issue create` with the repository templates; link them.
- [ ] **Step 3: Commit** `docs(roadmap): record the K11 and question-channel decisions (#210, #214)`.

### Task 12: Sprint record

**Files:**
- Create: `docs/sprints/2026-10-31-s17-design-evaluations.md`
- Modify: `docs/roadmap.md` (Sprint 17 entry)

- [ ] **Step 1: Write the record** in the structure of `docs/sprints/2026-10-31-s15-completion-kind-review-snapshots.md`: preflight, scope and decisions, roles and routing table with actual outcomes, progress log with commits, checks, remaining risk, writer end state.
- [ ] **Step 2: Commit** `docs(sprints): record Sprint 17`.

### Task 13: Final checks and pull request

- [ ] **Step 1: Run** `npm run typecheck`, `npm run build`, `NODE_OPTIONS=--unhandled-rejections=strict npm test`. Expected: all exit 0; record counts.
- [ ] **Step 2: Whole-branch review** by the `reviewer` subagent on `main...HEAD`; check and resolve findings.
- [ ] **Step 3: Verify** `git worktree list`, writers at baseline, no open Pi sessions; update the sprint record's end state if needed.
- [ ] **Step 4: Push and open one pull request** naming #210, #212, #213, #214, using the template, listing only the checks that ran. Do not edit the description or push while CI runs unless necessary.
