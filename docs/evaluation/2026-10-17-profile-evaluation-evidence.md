# Profile evaluation evidence — 2026-10-17

This is the historical pre-live record. The subsequently authorized eight-run
[live screening](2026-10-17-live-screening.md) has separate immutable evidence.

The final source-bound full suite passed **1,459 tests**, with **6 skipped** and
zero failures across **60 files**. The standalone offline command passed **308
tests** with zero failures or skips. Typecheck, both builds, schema drift checks
and audits passed. Source digest:
`sha256:686887d57899c2e55593bb7dd98b78be08ea0fc6c471a6dd4eab3298f890d160`.

This record covers the provider-free implementation and synthetic oracle
calibration. **No live Pi candidate evaluation was started.** It establishes no
model ranking, production approval, OS isolation, accepted ADR, or release.

Source base: `406dae7e6b99aa5715960490e869bd3fc668cca2`; branch
`eval/pi-profile-evaluation-2026-10-17`. Package `0.8.3`, Pi SDK and its six sibling
packages `1.2.0`; Node.js `22.23.2`, npm `12.2.0`, Linux x64. The uncommitted
implementation is bound by the source digest in the final machine records.

The preflight independently confirmed the assignment's remote main/release
snapshot, merged PRs #80/#82/#83, open issues #79/#81, no open PRs and green CI
on main. It read current configuration, adapter, tool-selection, existing
acceptance scripts, shipped skills, roadmap and ADRs 0002/0003/0006/0007/0008.
No isolation runtime change conflicts with Sprint 4: none was implemented.

## Implementation and checks

The suite reuses the real server, adapter seam, fake/scripted runtime, registry,
compiled-entry helper and existing stdio/lifecycle/skill/extension tests. It adds
versioned structural schemas plus strict cross-field validation, public synthetic
fixtures, independent oracles, immutable snapshot review, route-specific comparison,
source-bound approvals and separately supervised oracle subprocesses.

Final counts, exit codes, source digests and source-stability checks are in
[checks.json](evidence-2026-10-17/checks.json) and
[offline.json](evidence-2026-10-17/offline.json). The offline output includes every
planned screening slot and explicit NOT_RUN/BLOCKED state. The final full-suite
record is [full-tests.json](evidence-2026-10-17/full-tests.json).
The first development full-suite attempt failed because Vitest discovered the
plain Node synthetic tester fixture as a suite; renaming it `page-check.mjs`
resolved that collection failure. It is retained separately in the check history.
A later default-parallel run failed one existing SIGKILL-recovery test with
`ownership_lock_unavailable`; its immutable attempt is retained as
[full-attempt-default.json](evidence-2026-10-17/full-attempt-default.json).
The isolated recovery file passed all 31 tests. The final full run passed with
`--maxWorkers=2` and unchanged source before/after execution. The cause of the
intermittent default-parallel failure is not established; production locking and
CI test concurrency were not changed. The two-process setting concerns this
verification run, not a Pi product session limit.

Checks executed: lockfile installation, strict typecheck, CLI and server builds,
complete provider-free Vitest suite, deterministic evaluation subset, plan CLI,
rejection of unapproved live invocation, structural-schema drift check, root and
production-only npm audits, optional UI-tooling audit, diff whitespace and evidence
leak scan. Raw test output is not published. All recorded metrics concern the
harness or synthetic reference calibration, not a live model.

The real evaluation transport was exercised through a compiled production server,
MCP stdio and the embedded SDK with a loopback-only scripted SSE endpoint and a
placeholder credential. Exact provider/model/effort, complete JSON receipt,
close/list-empty and observed Linux cleanup passed. This is transport evidence;
it is not an external model run or a Claude Code live-orchestration result.

Negative tests execute scripted forbidden tool requests, hostile AGENTS context,
ungranted MCP calls, resource-load failures, provider/timeout/lost-response cases,
malformed/truncated receipts, no whole-run mutation retry, abort/EOF/close/SIGTERM,
parallel independent copies/results, and stubborn oracle children. Review fixes
have regression coverage: oracle deadlines and cancellation, separate oracle child
cleanup, final-diff failure clearing acceptance, and route-specific aggregation.
An unverified oracle cleanup stops all later combinations, and explicitly selected
Chromium executable configuration crosses the oracle-process boundary.

## Profile and task-view decisions

All live acceptance fractions are **0 accepted / 0 started**. Offline assertions
qualify the evaluation machinery, not the candidate route's task quality.

| Profile / view | Offline evidence | Technical limit | Decision |
| --- | --- | --- | --- |
| P1 scout | T1 source-path/contradiction oracle; T7 static infrastructure oracle; scripted read-only tool denials | No general filesystem read boundary; Luna transport NOT_RUN | Blocked/not established for model quality |
| P1 docs-writer draft | T8 dated revision/conflict/Proposed oracle, read-only scope | Draft only; no publication or document-writing qualification | Blocked/not established |
| P2 implementer | T2/T4 fail-before/pass-after and cause/countercase checks, immutable snapshots and diff gate | Coding tools have no enforced file-scope/OS boundary | Model quality NOT_RUN; any later synthetic result remains restricted |
| P3 reviewer | T5 two seed defects, clean cases, source locations, precision/false-positive counts; T2/T4 fixed-result review receipts | Grok screening NOT_RUN; a clean test alone never approves review | Blocked/not established |
| P4 UI writer | Actual Chromium calibration at both viewports; keyboard focus, preserved long text, Refresh error state, screenshots | Controller browser oracle; no live Sol repair was attempted | Harness verified; model quality NOT_RUN |
| P4 tester | T6 existing weak check plus independent boundary probes and concrete coverage gaps | Read-only worker; controller runs approved checks; no repair | Blocked/not established for model quality |
| Separate researcher / document writer with write rights | No pilot slot | Requires its own explicit external-data or document-write scope | Deferred |
| T9 read and mutation continuation | Public handoff fixture; explicit blocked oracle | No observed controlled compaction through the current public MCP path, and no successful live baseline | BLOCKED |

Read-only tool selection passed its controlled canaries. N2's **inner-method
policy requirement failed**: granting an outer collector tool permits its inner
`delete_all` method to reach the synthetic service. Baseline A grants no collector.
A missing OS file-scope boundary is recorded as FAIL, not inferred as PASS from a
clean diff. A diff gate cannot reverse an earlier write. Process cleanup evidence
covers observed process identities/groups; deliberately detached processes that
escape sampling are not contained. No real home, credential, production host,
mount or network exfiltration target was probed.

The source-bound [UI calibration record](evidence-2026-10-17/ui-reference/result.json)
contains failing-before/passing-after checks for a controller-provided reference
CSS fix. Its [375px](evidence-2026-10-17/ui-reference/T3-375.png) and
[1280px](evidence-2026-10-17/ui-reference/T3-1280.png) screenshots are synthetic
harness artifacts, not model results. Shortening the long fixture content is
explicitly rejected by the oracle.

## Existing routes and unknowns

The sanitized [inventory](evidence-2026-10-17/inventory.json) was obtained with the
public SDK catalog and `listCredentials` metadata only. Native registered routes:

| Candidate | Exact configured provider / model | Effort | Auth / billing metadata |
| --- | --- | --- | --- |
| Luna | `openai-codex` / `gpt-6-luna` | low | OAuth / subscription |
| Sol implementation | `openai-codex` / `gpt-6.1-sol` | medium | OAuth / subscription |
| Sol review | `openai-codex` / `gpt-6.1-sol` | high | OAuth / subscription |
| Grok | `xai` / `grok-4.7` | high | OAuth / subscription |
| DeepSeek | `deepseek` / `deepseek-flash` | high | API-key metadata / billing unverified |
| GLM alternative | `mistral` / `zai-glm-5-3` | high | API-key metadata / billing unverified |

Credential validity, quota, model reachability and real transport effort resolution
remain NOT_RUN. No auth resolution, refresh, login, new account, credit top-up or
credential acquisition occurred. Existing skill aliases/digests are inventoried;
loaded/read-by-model state is not claimed. Cursor requires its configured extension
and is excluded from native baseline comparisons. No extension was installed or
loaded for a candidate run.

Unknown costs, usage, tool-error counts, manual rework and model revision remain
null. No cost per accepted result can be computed. Controller starts, runtime
and retries can be bounded; SDK-internal retries and provider billing are not
metered through the production MCP contract.

## First live wave and later stages

The preserved [screening manifest](evidence-2026-10-17/manifest.json) is unapproved.
It has Luna T1/T2, Sol T1/T2, optional DeepSeek T1/T2, and Grok T5 twice: at most
eight session starts, sequential, zero controller retries, 180 seconds per run,
1,440 seconds for the wave plus bounded cleanup. Proposed screening API budget:
USD 5, with existing subscription quotas separately confirmed. This is an estimate,
not a demonstrated provider-side cap. Matrix, usable existing routes, auth/billing
declarations and budget require one explicit operator approval before execution.
No unapproved connectivity or PONG probe is inserted before the eight slots.

The later pilot has at most 18 slots and requires hash-bound accepted screening
records on the selected exact routes. T9 remains blocked. Fixed-result T2/T4
reviews replace pilot slots or require a revised matrix. One optional ablation
has at most four additional runs and a proposed USD 5 budget; pilot budget is
USD 15. The ceiling is 30 runs, not a required workload. No measured live baseline
bottleneck exists, so ablation selection, package audits and model runs are NOT_RUN.
GLM replaces a comparison slot; Astra is an explicit escalation; Cursor and
Antigravity stay separate, excluded harness comparisons.

No push, PR, merge, publication, deployment, global production-profile change,
new sandbox, public MCP function, ADR acceptance or release change occurred.
The complete relative changed-file list is
[changed-files.txt](evidence-2026-10-17/changed-files.txt).
