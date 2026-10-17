# Live profile screening — 2026-10-17

The consolidated [test coverage register](2026-10-17-test-coverage.md) distinguishes
live execution, local extension/MCP fixtures, inventory-only entries and untested
production integrations.

The operator-authorized wave completed **eight starts, zero controller retries,
four accepted task results and four rejected task receipts**. All eight harness
records passed, all eight turns completed, and all eight routes matched the
approved provider/model/effort. Total measured run interval: **172.993 seconds**.
No pilot or ablation was started. No production routing was changed.

The CLI returned exit code 1 because four tasks did not meet their acceptance
gates. This does not indicate a transport failure: all route, session cleanup,
observed process cleanup and diff-scope checks passed.

## Authorization and provenance

The operator explicitly authorized the proposed live screening with existing
access, at most eight runs and a USD 5 advisory budget, acknowledging that this
was not a hard cost limit. The immutable [approval](live-screening-2026-10-17/approval.json),
[manifest](live-screening-2026-10-17/approved-manifest.json) and
[budget](live-screening-2026-10-17/approved-budget.json) bind the exact matrix to:

- Base commit: `406dae7e6b99aa5715960490e869bd3fc668cca2`.
- Source digest: `sha256:686887d57899c2e55593bb7dd98b78be08ea0fc6c471a6dd4eab3298f890d160`.
- Approved manifest digest: `sha256:b8eb63eb4013e0943124376cfe72071efab3e584154e1dff8c7cbee420e09f0e`.
- Baseline A, no selected skills, extensions or external MCP grants.
- Sequential execution, zero controller retries, 180 seconds per run and 1,440
  seconds total plus bounded cleanup.
- Existing OAuth/subscription routes for OpenAI Codex and xAI; existing native
  DeepSeek API-key route classified as API billing. This classification is not
  a provider billing measurement.

The [metadata inventory](live-screening-2026-10-17/inventory.json) used no provider
request. No separate connectivity/PONG call was added. Each of the eight session
starts belongs to exactly one planned task slot. The evaluated source remained
unchanged before, during and after the wave. Documentation and evidence are
outside the evaluated source digest.

Execution interval: 2026-10-17T08:13:31.962Z through 2026-10-17T08:16:24.955Z
(UTC; Europe/Berlin was UTC+02:00). Package 0.8.3, Pi SDK 1.2.0,
profile-evaluation client 1.0.0.

## Results

| Run | Exact route and effort | Task / view | Task gate | Seconds | Failed task checks |
| --- | --- | --- | --- | ---: | --- |
| screen-1 | openai-codex / gpt-6-luna / low | T1 / scout | FAIL | 7.881 | api-data-flow, stale-doc-contradiction |
| screen-2 | openai-codex / gpt-6-luna / low | T2 / implementer | PASS | 13.553 | — |
| screen-3 | openai-codex / gpt-6.1-sol / medium | T1 / scout | FAIL | 13.776 | api-data-flow |
| screen-4 | openai-codex / gpt-6.1-sol / medium | T2 / implementer | PASS | 18.767 | — |
| screen-5 | deepseek / deepseek-flash / high | T1 / scout | FAIL | 7.974 | api-data-flow |
| screen-6 | deepseek / deepseek-flash / high | T2 / implementer | PASS | 9.667 | — |
| screen-7 | xai / grok-4.7 / high | T5 / reviewer | PASS | 38.013 | — |
| screen-8 | xai / grok-4.7 / high | T5 / reviewer | FAIL | 62.758 | clean-counterexample |

T1 is a code-understanding receipt check. All three candidates failed its exact
ordered path/symbol gate. Sol and DeepSeek passed the stale-document contradiction
check; Luna did not. These results establish failure to meet this receipt
contract, not a general inability to explain a codebase.

All three T2 candidates made the same minimal change to `contract.mjs`:
`Number.isFinite(parsed) && parsed >= 0`. Fail-before and independent regression
checks passed. The controller separately read the actual patches and reran seven
cases on each preserved snapshot, including negative fractional input, zero and
a valid fraction; all 21 assertions passed. Patches and snapshots are linked from
the individual [run records](live-screening-2026-10-17/runs/comparison.json), and
these additional checks are recorded in the [audit](live-screening-2026-10-17/audit.json).
Only the allowed file changed. The coding boundary remains **FAIL** because Pi's
coding profile does not enforce an OS file-scope boundary. These are restricted
synthetic task successes, not general production implementation approval.

Grok detected both seeded defects in each T5 repetition: four detected of four
possible, four confirmed findings of four reported, and no additional findings
or findings on the clean comparison file. The first repetition passed every
check. The second failed only `clean-counterexample`. The oracle requires
exactly one clean-case entry with status `no finding`; the task prompt asked for
`clean_cases [{path,status}]` and an assessment of `clean.ts`, but did not specify
that exact status spelling. This limits the inference from that rejection. The
raw model receipt is deliberately not archived, so the exact rejected content
cannot be reconstructed. It is not evidence of a false positive or a missed seed.

No route has the complete accepted screening evidence needed for a later pilot:
Luna, Sol and DeepSeek each lack accepted T1 evidence; Grok lacks two accepted T5
repetitions. The [comparison](live-screening-2026-10-17/runs/comparison.json) keeps
routes and task views separate. No general model ranking or production routing
recommendation follows from this small wave. Later pilot, UI, tester, document
writing and controlled compaction evaluations remain outside this authorization.

## Budget, cleanup and verification

**Actual cost and token usage are unknown.** The production MCP contract exposes
neither. Every record retains `cost_usd:null` and `usage:null`; no cost per
accepted result is computable. The USD 5 amount was advisory, with no provider-side
hard cap, and actual compliance with it cannot be demonstrated. SDK-internal
request retries and subscription quota use are also unmetered through this path.
There were no controller retries or extra model calls.

The [audit](live-screening-2026-10-17/audit.json) independently checks eight claims,
eight resolved sessions, eight terminal results, unique scopes, exact approved
routes, result schemas, all artifact hashes, source stability, sequential
intervals, per-run and total wall time, empty-session checks, observed process
cleanup, diff scope and recomputed comparison. All passed. Four successful
fixture directories were removed; four failed fixtures were retained for scoped
diagnostics. No unexpected changed path was observed. The longest run was 62.758
seconds, below its 180-second budget.

A separate read-only reviewer recomputed these bindings and aggregates and found
no additional execution defect. The reviewer confirmed the narrow interpretation
of T1 and the second T5 receipt rejection. No reviewer model/provider calls or
file changes were made. Process cleanup covers observed identities and groups;
it does not establish containment of deliberately detached unsampled processes.

The sanitized archive contains approval inputs, metadata inventory, eight claims,
eight result records, scoped diagnostic identifiers, three accepted synthetic
snapshots and patches, comparison and audit. It contains no credentials, private
absolute host paths, raw provider errors, prompts or full model responses. Its
[integrity index](live-screening-2026-10-17/integrity.json) hashes all archived
machine evidence. The earlier [offline evidence](2026-10-17-profile-evaluation-evidence.md)
is preserved as the historical pre-live record.
