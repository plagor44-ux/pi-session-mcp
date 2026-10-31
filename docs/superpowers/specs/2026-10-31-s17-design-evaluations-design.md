# Sprint 17: four design and evaluation issues — design

Date: 2026-10-31. Status: approved by the operator on 2026-10-31, including the designer's calls listed under "Decisions after the builder check".
Tracking: [#213](https://github.com/plagor44-ux/pi-session-mcp/issues/213),
[#212](https://github.com/plagor44-ux/pi-session-mcp/issues/212),
[#210](https://github.com/plagor44-ux/pi-session-mcp/issues/210),
[#214](https://github.com/plagor44-ux/pi-session-mcp/issues/214).
Planning basis: main `41ae199` (PR #219 merged), published 0.14.3.

## Intent

The four issues are development ideas, not reactions to an incident. None of
them rests on a measured failure, and each issue says so itself: decide or
evaluate first, build later. The operator wants each idea taken to a
well-founded decision. A reasoned **defer** or **reject** is a full result,
not a failure; it is not required that every idea ends in an implementable
design.

Two issues are design work, two are evaluations:

| Issue | Kind | Deliverable |
| --- | --- | --- |
| #213 recovery export for a writer with an unmerged index | design | ADR (`Proposed`) plus a provider-free real-Git proof |
| #212 server-enforced maximum turn duration per profile | design | ADR (`Proposed`) plus provider-free race tests against a development-only prototype |
| #210 structured worker reports vs the `STATUS` contract | evaluation | case matrix, provider-free validator fixtures, a bounded live comparison, adopt/defer/reject |
| #214 worker questions via `NEEDS_CONTEXT` | evaluation | case matrix, provider-free correlation fixtures, a bounded live check with Claude Code and Codex, adopt/defer/reject |

Order: #213, #212, then #210 and #214 together (both touch the report
contract of the controller skill). The order is the designer's proposal; the
operator accepted it.

## Goals

- One decision record per issue, with evidence that a reader can re-run.
- No runtime behavior change in the product. Proposed ADRs describe the
  change; implementation follows only after the maintainer accepts an ADR.
- Every claim in the records is bound to a source (commit, test, run record)
  and every unsuccessful attempt stays in the evidence.

## Non-goals

- No release, tag or npm publication. #220 (acceptance of #217 on 0.15.0)
  stays open and is not part of this sprint.
- No production `submit_report`, `ask_controller` or answer tool, no pending-
  question state, no turn-deadline enforcement in `src/`, no recovery
  operation in the setup CLI. These would follow accepted ADRs.
- No token or cost accounting (#92 stays closed). Time and usage are reported
  only where they were actually observed, never inferred from bytes.
- No macOS work.

## Anti-goals

- A design that weakens the existing fail-closed behavior: today an unmerged
  index blocks collection and every cleanup without `--discard`; that refusal
  must survive any recovery design unchanged.
- A deadline design that can claim a successful cancellation it did not
  observe, or that produces two terminal transitions for one turn.
- Treating a worker's report as evidence. Every evaluation separates "valid
  shape" from "task actually succeeded" through an independent Git/test
  oracle.
- Publishing raw prompts, transcripts, private absolute paths, provider errors
  or repository content from writer clones as evidence.

## Constraints

- AGENTS.md applies in full: English docs, exact dependency pins, stdout
  reserved for MCP frames, workspaces only through aliases, Pi behind
  `PiSessionAdapter` with fakes in tests, sanitized reports, Doctor offline.
- Owner rule: one branch (`feat/s17-design-evaluations`), one pull request
  naming all four issues, separate commits per issue.
- Never run host Git in a writer clone or fetch directly from it
  (docs/isolation-setup.md:223, ADR 0008, ADR 0012). Clone-side Git runs only
  in the throwaway no-network container (`throwawayArgs`,
  src/writer-boundary.ts:225).
- Development-only code lives outside the shipped package (under `eval/`,
  like `eval/bridge/`) or in `test/`; its tests may run under `npm test` as
  the bridge tests do.
- Live runs are allowed for #210 and #214 (operator, 2026-10-31) within the
  budget fixed below, pre-registered before the first model turn.

## #213: recovery export for an unmerged writer index

### Findings that shape the design

- The refusal is implicit: `write-tree` fails under `set -eu` in the inspect
  and collect scripts (src/writer-lifecycle.ts:323, :426), surfacing as
  `writer_inspect_failed` or `writer_collect_failed`. There is no dedicated
  code.
- `collectWriter` drops any earlier `collected` digest at its start
  (writer-lifecycle.ts:394-396). A recovery path built on collect would
  therefore invalidate an older digest; recovery must be a separate operation
  that never reads or writes `state.collected`.
- Artifacts under `writers/<name>/bundles/` trip the Doctor warning
  `writer_uncollected_bundle` (src/doctor.ts:518-525) and die with
  `--remove` (src/writer-tree-removal.ts).
- A real-Git unmerged fixture already exists
  (test/writer-collect-real-git.test.ts:384-400), using the harness that runs
  the container scripts locally.

### Direction (designer's call, to be argued in the ADR)

- A new explicit writer operation, `--writer <name> --recover`, dry-run by
  default and `--apply` to run, taking the setup lock and the writer lease
  exactly like the other operations (`runWriterOperation`,
  src/setup-writers.ts:101-124).
- Inside the throwaway container (clone read-only, scratch under `/tmp`,
  output only to the bundles mount) the script builds, from a copy of the
  index, separate commits for: the worktree including conflict markers and
  untracked files; and one tree each for index stages 1, 2 and 3 where they
  exist, plus a manifest of the unmerged entries (`ls-files -s -z` of the
  conflicted paths). It exports them as a bundle.
- The host imports the bundle into the operator checkout under a namespace
  separate from collection, for example
  `refs/recovery/writer-<name>/<n>/{worktree,stage1,stage2,stage3}`, and
  removes the bundle file. The writer's clone, index, refs and `state.json`
  are untouched; no digest is written.
- Ordinary collect, finish, reset, recreate and remove stay refused before and
  after a recovery. The operator resolves manually from the recovery refs and
  then decides on `--discard`.
- New sanitized codes (for example `writer_recover_planned`,
  `writer_recovered`, `writer_recover_failed`, `nothing_to_recover`) and
  defined outcomes for: running session (`writer_busy`), missing objects,
  ref-name collisions, symlinks, submodules (gitlinks), unsupported layouts,
  partial import (destination refs rolled back, reported distinctly).

The ADR names unsupported content classes explicitly (for example ignored
files, reflogs, unreachable objects) and decides the release type.

### Proof

A development-only recovery script plus real-Git tests in the existing harness
style: the unmerged fixture before and after recovery (collect/cleanup still
fail closed; `ls-files -u`, refs and working files byte-identical), the
recovered stages checked independently in the operator checkout
(`git ls-tree`/`cat-file` against the expected blobs), no change to
`state.collected`, and the edge cases above. A Podman boundary case runs only
when the pinned image is available locally, as in
test/writer-lifecycle.podman.test.ts.

## #212: maximum turn duration per execution profile

### Findings that shape the design

- No total-turn deadline exists. Existing bounds: preflight, abort and close
  cleanup 5 s each, shutdown 12 s in the registry (src/session-registry.ts:53-59);
  the relay uses 15/15/10 s and a 60 s start budget (src/writer-relay.ts:14-19).
- One `turn.terminal` flag (first writer wins) prevents double transitions;
  `beginAbort` coalesces aborts. A rejected abort leaves the turn running; an
  `abort_timeout` leaves the abort pending.
- `close()` marks the turn `aborted` before the abort result is known
  (session-registry.ts:271-277), an existing example of the false cancellation
  claim the issue wants to avoid. The ADR records it; changing it is out of
  scope here.
- The registry keeps no reference to the resolved profile after `start()`;
  timestamps are wall-clock (`new Date()`), deadlines are `setTimeout`.
- Profiles are a strict zod schema (src/config.ts:24-72). A new raw profile
  field is copied into the inner writer configuration
  (src/writer-lifecycle.ts:102) but is not part of the ten published
  capability fields that the relay compares at admission
  (src/writer-relay.ts:77-86), so inner and outer could both enforce, or
  silently differ.
- The failed turn view has a single code, `turn_failed`; turn events accept
  only `completed|failed|aborted` and `via: registry|close`
  (src/turn-events.ts:52). Any new reason or `via` is a contract change.

### Direction (designer's call, to be argued in the ADR)

- Optional profile field (name to be fixed in the ADR, for example
  `maxTurnSeconds`), integer within bounds that keep the timer below Node's
  `setTimeout` limit; absent means "no limit", stated explicitly in the docs.
- One monotonic deadline per turn, anchored when the turn is published
  (preflight accepted), because before that no public turn exists and
  preflight has its own bound. The ADR weighs the alternative anchor at
  admission.
- Expiry calls the same `beginAbort` as a manual abort, at most once. A
  successful abort ends the turn `aborted` with an additive reason field; a
  rejected or timed-out abort does not claim cancellation: the session is
  marked not reusable (like `writer_session_lost`), get and close keep
  working, and an inner writer stays fenced by its lease as today.
- For container writers, enforcement happens in exactly one place; the ADR
  decides which (recommendation: the inner server that owns the Pi session,
  with the field added to the compared capability projection so a mismatch
  counts as `settingsChanged`).
- The ADR lists configuration, capability, tool-contract, turn-event, skill
  and documentation impacts and the required release type (minor under
  ADR 0003).

### Proof

A development-only supervisor prototype under `eval/` that wraps the real
`SessionRegistry` with a `FakeHandle` and applies the deadline from outside,
plus fake-timer tests in `test/` for: completion exactly at the deadline,
manual abort before and during expiry, close and shutdown racing expiry,
abort rejection and abort timeout after expiry, late settlement, exactly one
terminal notice per turn, and an unaffected parallel session. A relay case
uses the existing fake inner server pattern of test/writer-relay.test.ts.
Real child-process termination is named as a gap unless a cheap stdio test
covers it.

## #210: structured worker reports

### Findings that shape the evaluation

- The current contract is text: first line `STATUS:` with one of `DONE`,
  `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED`, then fields; one
  correction follow-up on a format failure; early-stop rules
  (skills/pi-session-orchestration/SKILL.md:54, :81-85;
  skills/pi-session-implementation/SKILL.md:36-52).
- Nothing in code validates it. No aggregated rate of format repairs or false
  success exists; sprint records show isolated `BLOCKED` and early-stop cases,
  each resolved by one follow-up.
- The review verdict tokens disagree: the controller expects `BLOCKING`,
  `NON_BLOCKING_ONLY`, `CLEAN`; the review skill emits `BLOCKING_FINDINGS`,
  `NON_BLOCKING_ONLY`, `NO_FINDINGS`.
- Roadmap K11 entry condition: an ADR only if the report contract is shown
  insufficient (docs/roadmap.md:513; Sprint 10 D3).

### Evaluation design

- A versioned candidate receipt (`receipt-v1`, a fenced JSON block after the
  status line) with task status, base and result commit, changed files,
  checks with command and exit code, unresolved concerns. Every check is a
  worker claim until verified.
- A development-only validator under `eval/reports/` for both forms: the
  current text contract and the receipt. Provider-free fixtures cover the
  issue's matrix: malformed or missing status, missing commit, missing checks,
  failed checks, `NEEDS_CONTEXT`, truncation (`truncated` and
  `completion: "output_limit"`), early stop, and a valid but false success.
  The validator rejects incomplete shapes, keeps failed checks and concerns,
  and never treats a claim as evidence (the false-success fixture passes
  shape validation and fails the Git/test oracle).
- A retrospective count from the existing sprint records (format repairs,
  early stops, follow-ups), labeled as such.
- Live comparison within the budget below: the same small coding tasks with
  the text contract and with the receipt, each verified by an independent
  Git/test oracle; measured are format repairs, controller follow-ups and
  independently accepted tasks.
- The verdict-token mismatch is fixed in its own commit, before the live runs,
  as a correction of the shipped skills (see "Decisions after the builder
  check").
- Pre-registered decision rule: with no measured failure to start from and a
  sample of a few tasks, the live runs cannot show a rate difference. They
  look for concrete failures of the text contract that the validator would
  have caught and the receipt would have prevented. **Adopt** only if at
  least one such failure occurs that one corrective follow-up did not
  resolve; **reject** if the receipt itself causes format failures the text
  contract did not; otherwise **defer** with the fixtures kept as the basis
  for a later decision. If the budget runs out mid-comparison, the decision is
  taken on what was recorded and says so.
- Decision adopt/defer/reject under K11. If adopt, this sprint records the
  recommendation and opens a follow-up issue for the ADR and the exact
  minor-version contract; no third ADR is drafted in this sprint.

## #214: worker questions via `NEEDS_CONTEXT`

### Findings that shape the evaluation

- `NEEDS_CONTEXT` exists in all three skills; the controller answers in a
  follow-up in the same session. There is no question-round limit, deadline
  or stale-answer rule, and no recorded real `NEEDS_CONTEXT` from a worker.
- ADR 0011 leaves the question channel undecided behind a demand gate
  (docs/adr/0011-turn-events-and-controller-wake.md:130-133); Codex has no
  external wake (:113). The `eval/bridge/` prototype already tested a separate
  `ask_controller` channel; it is not the route evaluated here.

### Evaluation design

- Provider-free fixtures against the real registry with a fake or scripted
  adapter for the server-side facts the `NEEDS_CONTEXT` route relies on:
  correlation by `sessionId`/`turnId`, retained session context across the
  follow-up, a second prompt on a running session refused
  (`session_running`), answers after abort or close refused
  (`unknown_session`), two concurrent sessions with different questions kept
  apart, a duplicate answer after the follow-up was accepted.
- A comparison with a minimal typed question inside the report (a field of
  the #210 receipt) on the same fixtures.
- Live check within the budget below, with Claude Code and Codex as
  controllers, each separately: two concurrent workers given deliberately
  underspecified tasks that should end in `NEEDS_CONTEXT`; recorded are
  whether the question is correlated and answered once, whether no worker
  resumes speculatively or reports `DONE` while blocked, extra controller
  calls, and independent task acceptance. Controller compaction cannot be
  triggered in a headless controller; it is a named gap of this evaluation.
- Decision adopt/defer/reject under ADR 0011's demand gate, including whether
  an ADR amendment, new state or tools, or a minor release would be needed.
  Pre-registered rule: **adopt** (recommend a channel) only if the route loses
  or misroutes a question, or a worker resumes speculatively, in a way the
  controller procedure cannot prevent; otherwise **defer** or **reject**, with
  the procedure gaps (round limit, stale-answer rule) recorded as skill
  follow-ups. As for #210, an adopt opens a follow-up issue; no ADR is drafted
  in this sprint.

### Controllers in the live runs

The live controllers are separate headless processes, not this session:
`claude -p` and `codex exec`, each with a private MCP configuration that
points at the installed pi-session-mcp server and the bundled controller
skill. This session acts as the harness: it prepares the kit, starts each
controller with a fixed task prompt, and judges the outcome with the oracle.
The controller never sees the expected answers or the oracle. One controller
process from start to exit is one controller run. #210's live comparison is
driven by this session directly through the MCP tools (its subject is the
worker report, not the controller), so it uses worker turns but no
controller runs.

## Live budget for #210 and #214

Fixed before the first model turn, recorded in a pre-registration file under
each evaluation directory; amendments are appended, never rewritten.

- At most 24 worker turns in total, follow-ups included: #210 ≤ 12, #214 ≤ 12.
  #214 plans one controller run per client (two workers, each with a question
  turn and an answer follow-up: 4 turns per run, 8 in total); the remaining 4
  turns and at most one further controller run per client are retry margin.
  At most 4 controller runs in total and at most 120 minutes of wall time for
  all live runs together.
- Stop rules: a start error of the classes `local_authentication_missing` or
  `unknown_execution_profile` stops the run and is reported (pi-routing
  rules); no profile switch to work around a failure; every attempt is kept.
- Routes (designer's call): coding tasks on this repository's container
  writers (`pi-session-mcp-w1`, `-w2`) with one coding profile; review-style
  tasks with one read-only profile; xAI and Cursor profiles are not planned.
  The exact profiles are fixed in the pre-registration after a
  `pi_capabilities_get` check.

## Roles

- Controller (this session): plans, integrates, writes all records and ADRs,
  runs final checks, owns git and the pull request.
- Proof and fixture code: Pi coding writers on this repository or the
  `implementer` subagent, one task per writer, each on its own branch; the
  controller integrates and verifies.
- Reviews: each ADR gets a cross-family review (read-only `review` profile)
  and a Claude-family review (`reviewer` subagent); the evaluations get one
  review each. Findings are checked against code or Git behavior before they
  are adopted.

## Records

- `docs/adr/0016-…` and `docs/adr/0017-…` (numbers in order of writing) with
  status `Proposed`.
- `docs/evaluation/<topic>-2026-10-31/` per issue, with README, source
  binding, recorded runs and limits, following
  docs/evaluation/review-snapshots-2026-10-31/ and
  docs/evaluation/s7-live-acceptance-2026-10-24/.
- `docs/sprints/2026-10-31-s17-design-evaluations.md` with preflight,
  routing, progress log, checks and remaining risk; a roadmap line per issue.
- `CHANGELOG.md` only if a shipped file changes (the skill token fix).

## Done when

- #213 and #212: ADR `Proposed`, its proof runs green and is recorded, both
  reviews done and their findings resolved or recorded as open.
- #210 and #214: matrix, fixtures and live runs recorded within budget, with
  a decision adopt/defer/reject and its reasoning.
- `npm run typecheck`, `npm run build` and
  `NODE_OPTIONS=--unhandled-rejections=strict npm test` pass; the pull request
  reports only checks that were run.
- Merge, the decision on each ADR and any follow-up implementation are
  maintainer decisions.

## Decisions after the builder check

Designer's calls (the operator can overturn them):

- Live controllers are headless `claude -p` and `codex exec` processes run by
  this session as a harness; compaction is a named gap (see #214).
- #214 plans one controller run per client; the rest of its budget is retry
  margin.
- Pre-registered adopt/defer/reject rules for #210 and #214 as stated in
  their sections.
- An "adopt" in #210 or #214 yields a recommendation and a follow-up issue,
  not a further ADR in this sprint.

Operator decision: the verdict-token mismatch (orchestration skill expects
`BLOCKING`/`NON_BLOCKING_ONLY`/`CLEAN`, review skill emits
`BLOCKING_FINDINGS`/`NON_BLOCKING_ONLY`/`NO_FINDINGS`). Decided 2026-10-31:
the worker tokens are canonical; the orchestration skill adopts
`BLOCKING_FINDINGS`/`NON_BLOCKING_ONLY`/`NO_FINDINGS`, the review skill is
unchanged. The fix lands as its own commit with a changelog entry before the
live runs; it changes only skill text, not the MCP contract or runtime.

## Left to the builder

Names of fields, codes and files; the exact recovery namespace; the internal
structure of prototypes and fixtures; which concrete small tasks the live runs
use, provided they have an independent oracle.
