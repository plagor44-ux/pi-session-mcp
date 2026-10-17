# Authorized six-slot live re-screen — 2026-10-17

The approved wave finished with **five starts, three accepted tasks, two rejected
task receipts and one blocked slot**. Every started run passed its harness,
route-binding, session cleanup, observed process cleanup and diff-scope checks.
The CLI returned exit code 1 because task acceptance failed; this was not a
transport failure. No retry, replacement run, pilot or ablation was started.

## Authorization and execution

The operator replied “Ja mach” to the explicit six-start proposal: Luna T1/T2,
Sol T1/T2 and Grok T5 twice; baseline A, sequential, zero controller retries,
USD 5 advisory with no hard provider cap. The preserved
[approval](approval.json), [manifest](approved-manifest.json) and
[budget](approved-budget.json) bind the wave to:

- Base commit `406dae7e6b99aa5715960490e869bd3fc668cca2`.
- Source digest `sha256:a4524626851448908b8d21ecbd7248c9956ce830406e81c45fda46c8eb6fffc5`.
- Approved manifest digest `sha256:b3e80291c681ce8509ade8a387e278a65eae6eeb00cc709fbee76c5932206c97`.
- Six maximum starts, 180 seconds per run and 1,080 seconds total plus bounded cleanup.
- Package 0.8.3, SDK 1.2.0, evaluation client 1.0.0, selected runner Node 24.22.0.

No worker skills, third-party extensions or external worker MCP grants were
selected. Each run used a fresh synthetic fixture and the production stdio MCP
entry with embedded SDK. Discovery preceded session creation. No separate PONG
or connectivity call was added. The [runtime observation](runtime-observation.json)
independently sampled one active evaluation server under Node 24.22.0; it is not
a per-run runtime trace.

Execution interval: **2026-10-17T13:22:54.870Z to 13:24:09.294Z**, or **74.424
seconds**. Every started run finished below its 180-second limit.

## Results

| Run | Exact route / effort | Task / view | Result | Seconds | Failed task checks |
| --- | --- | --- | --- | ---: | --- |
| rescreen-1 | openai-codex / gpt-6-luna / low | T1 / scout | FAIL | 7.532 | api-data-flow |
| rescreen-2 | openai-codex / gpt-6-luna / low | T2 / implementer | PASS | 10.435 | — |
| rescreen-3 | openai-codex / gpt-6.1-sol / medium | T1 / scout | PASS | 12.217 | — |
| rescreen-4 | openai-codex / gpt-6.1-sol / medium | T2 / implementer | PASS | 13.258 | — |
| rescreen-5 | xai / grok-4.7 / high | T5 / reviewer, repetition 1 | FAIL | 30.356 | seed-tenant-scope; no-extra-findings |
| rescreen-6 | xai / grok-4.7 / high | T5 / reviewer, repetition 2 | BLOCKED / NOT_RUN | — | Prior same-combination gate failed |

Luna passed the stale-document contradiction check but failed T1's combined exact
path/symbol criterion. Sol passed both T1 checks. This rejects Luna for this
receipt contract; it does not establish a general code-understanding limitation.
The historical run results were not reclassified after the instruction change.

Both T2 workers made the same minimal `contract.mjs` fix:
`Number.isFinite(parsed) && parsed >= 0`. The independent fail-before/pass-after
oracle passed and only the allowed file changed. The controller inspected both
actual patches and reran seven cases on each preserved snapshot, including a
negative fraction, zero and a valid fraction: **14 additional assertions passed**.
[Independent backend checks](backend-independent-checks.json).
Coding boundary status remains FAIL because no OS file-scope boundary exists.

Grok reported two findings. The strict oracle confirmed the wildcard finding;
the tenant finding did not meet its structured path/line/preconditions/impact
gate. The clean-case status check passed and no finding targeted `clean.ts`.
The recorded metrics are one confirmed finding out of two, one unmatched finding,
one detected seed out of two, and zero findings on clean cases. The unmatched
finding is a **potential** false positive under this exact oracle, not an
independently confirmed false alarm or proof that the model missed the tenant
defect. No raw model receipt was archived, so the rejected content and precise
reason cannot be reconstructed. No acceptance criterion was relaxed.

The runner correctly blocked the second Grok slot after the first failed result
for the same route/profile/view. Its record has no start time, no claim and no
session. The unused allowance was not repurposed.

## Decisions and limits

| Route | Screening decision | Supported next step |
| --- | --- | --- |
| gpt-6-luna / low | Not qualified: T1 failed | No pilot promotion for this route |
| gpt-6.1-sol / medium | T1 + T2 screening gate passed | Eligible for a separately approved synthetic P1/P2/P4 pilot |
| grok-4.7 / high | Not qualified: first T5 failed, second blocked | P3 review pilot remains blocked |

Sol's eligibility is not a two-repeat role qualification or production approval.
UI, tester, documentation, infrastructure and fixed-result review views remain
unproven live at this source revision. T9 remains blocked by the controlled
compaction prerequisite. No measured feature bottleneck justifies a quality
ablation. The earlier provider-free extension/policy checks remain separate.

**Actual cost and token usage remain unknown.** Every run retains
`cost_usd:null` and `usage:null`; cost per accepted result cannot be computed.
OAuth/subscription classification comes from approved inventory metadata, not
per-request billing attestation. Public MCP verifies selected provider, model
and effort; it does not expose provider billing, actual model revision,
SDK-internal retries or subscription quota. Compliance with the advisory USD 5
amount cannot be demonstrated as a hard limit.

The [planning ledger](planning-ledger.json) counts **13 actual starts** across
the original eight-run wave and this five-start wave. At most 17 starts remain
within the original 30-start planning envelope; none is automatically approved.
The original generic 18-plus-four schedule cannot be run unchanged. No new
subscription, key provisioning, production-profile edit, deployment, push or PR
was performed by this wave.

## Evidence and cleanup

The [audit](audit.json) checks source and approval bindings, five claims, all six
records, route/profile/task identity, schemas, artifact hashes, sequential
intervals, budgets, unique scopes and recomputed comparison. Three accepted
temporary fixtures were removed and two failed diagnostic fixtures retained.
Observed sessions and server processes cleaned up; this is not OS containment.
The [independent read-only review](review.json) confirmed the aggregates and the
narrow interpretation of the unmatched finding.

The [run comparison](runs/comparison.json) keeps routes and views separate.
Snapshots, patches, claims and sanitized diagnostics are preserved beside the
individual run records. No credentials, private absolute host paths, full prompts
or full model responses are archived. The [integrity index](integrity.json)
hashes the archive; the original source and previous evidence remain unchanged.
