# Orchestrator footprint evaluation, 2026-10-17

Actual model tokens, subscription cost and cloud-route behavior remain **unknown**.
The current provider-free calibration passes transport, task, filter and cleanup
checks. Actual Codex 0.162.0 request bodies on a declared synthetic loopback route
contain one selected marker occurrence per tool output despite two equal server
representations. No production optimization follows from this alone.

The explicit user request authorized this bounded development evaluation.
Maintenance and the isolation priority (#79, ADR 0008 Proposed) remain unchanged;
#81 is untouched. Base/origin-main was verified as PR #84,
`d6f360926e26629f7b382583c077016daeb954ca`. Package 0.8.3, Pi SDK 1.2.0,
MCP SDK 2.3.1, production sources/contract, dependencies, CI, registrations and
installed skills remain unchanged. No commit, push, external issue/PR or release
was made. All work is local on the separate evaluation branch.

## Current evidence and preserved attempts

- [Current measurement](current-calibration/measurement.json), [frozen baseline](current-calibration/baseline.json)
  and [calculated summary](current-calibration/summary.json): 80 actual-stdio cases,
  50 filter cases and ten adverse-report controls; five repetitions per case.
- [Current Codex projection](current-client-projection.json): one pilot plus five
  repetitions each of success, domain error and registry truncation; 16 clients,
  63 scripted HTTP requests, five scripted sessions/turns, all cleaned.
- [M1 package](live-package.json), [manifest](live-approval/manifest.json),
  [budget](live-approval/budget.json), [decision](live-approval/decision.json):
  current-source executable templates, all **unapproved**.
- [Final checks](checks-final.json), [follow-up](follow-up.md) and
  [integrity index](integrity.json): actual verification, recommendations and file hashes.
- The parent `measurement.json`, `baseline.json`, `summary.json`, `checks.json`
  and `live-proposal.json` preserve the first attempt byte-for-byte; see
  [its binding note](prior-calibration/README.md). The [second qualified attempt](calibration-2/README.md)
  and [earlier client attempts](client-attempts/README.md) remain separate.
  No failed or source-changed run was silently omitted or upgraded.

Current executed source:
`sha256:33c450601727e38cf63b1874df0fcadc158c3d06af3b472b3d1603da6383c929`.
Current launched M0/client build:
`sha256:59e7b855ea0bbb545246fbf28e27692ae3b1f35212a3d5526b3190ac58054065`.
Both measurements rechecked source and build unchanged. M0 ran
2026-10-17T20:58:49.268Z–2026-10-17T20:59:37.176Z; client calibration ran
2026-10-17T21:00:08.245Z–2026-10-17T21:00:31.651Z (UTC). Runtime: Node 22.23.2, Linux.
Bindings include uncommitted measurement sources, fixtures, tests, scripts and
compiler inputs; prompt/report/fixture hashes are exported. Fresh temporary builds
and raw client homes were removed afterward.

The M1 template uses its own build-digest algorithm over compiled production/eval
files and package metadata. M0/client additionally bind compiled test fixtures
and snapshot modes. Those two algorithms must not be compared as one build ID.
M1 has not executed that provider path.

## Three distinct measurement boundaries

| Boundary | Direct observation | Limits |
| --- | --- | --- |
| MCP transport | Exact complete JSON-RPC UTF-8 frames including LF, by direction/tool/state/time; per-turn polls and repeated terminal results; component sizes separately | Whole-frame totals count each frame once. Components overlap; never add them into tokens. Raw read/write totals reconcile with complete frames, even for an already exited child. |
| Codex request projection | Actual HTTP JSON bodies emitted by Codex to the scripted loopback endpoint; selected tool-output bytes/markers, whole input/tools/body sizes, new output versus repeated history | This particular client/configuration/route only. Tool UI events alone prove no injection. HTTP headers and raw bodies never persist. No cloud-route or model quality claim. |
| Model usage | No real controller or worker model ran | Input/output/cache/reasoning, cost and cost per accepted task are null. No tokenizer, bytes-to-tokens estimate, cache subtraction or overlapping usage sum. Missing usage is not zero consumption. |

Byte/count/time fields are observed; ratios, medians and sums are calculated from
observations. All token/money fields are explicitly unknown. The HTTP fixture
never forwards provider requests; this is not evidence of general OS egress
containment. `previous_response_id` was absent and Authorization headers were
absent in every observed request. Cache/compaction and real subscription metering
remain unestablished.

## Frozen M0 baseline versus one-factor candidates

Each row contains five repetitions. Whole **server-to-client** bytes include
initialization, fresh discovery, capabilities, lifecycle and polling. All five
byte/count values matched within each row. Times are medians of harness wall time
excluding separately measured independent oracle subprocess time; they are not
model latency. Controller model usage is null throughout.

| Scenario / arm | Response bytes | Pi calls | Running / terminal polls (repeated) | Harness ms | Oracle ms | Independent tasks |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| Read baseline | 47,794 | 6 | 0 / 1 (0) | 274.03 | 322.66 | 5/5 |
| Read compact | 25,738 | 6 | 0 / 1 (0) | 264.56 | 310.78 | 5/5 |
| Repair baseline | 47,244 | 6 | 0 / 1 (0) | 291.31 | 714.63 | 5/5 |
| Repair compact | 25,188 | 6 | 0 / 1 (0) | 271.56 | 753.16 | 5/5 |
| Read + two terminal re-fetches | 95,624 | 8 | 0 / 3 (2) | 275.22 | 327.35 | 5/5 |
| Same read, consume once | 47,794 | 6 | 0 / 1 (0) | 270.22 | 335.93 | 5/5 |

The baseline was written exclusively **before** candidates; its file digest is
`sha256:b033918d66d49b14596346b9c0b74559b2ca0f9071890acfb6ea893e7bced4bd`.
The large baseline reports deliberately contain public synthetic repeated detail.
They are calibration inputs, not observations of natural live report verbosity.
Removing that field preserves source claims, actual changes, checks including
baseline exit 1 / repaired exit 0, blockers, risks and relative evidence.
Read final text falls from 11,466 to 446 bytes, repair from 11,243 to 223;
each terminal response loses 22,056 bytes. Ten failed/blocked controls preserve
their failed checks and blocker and remain rejected as success. Malformed,
missing-field and registry-truncated reports are also rejected.

Two labelled terminal re-fetches add exactly 47,830 response bytes and two calls.
This is a calibration counterfactual, not a claim about current normal usage.
Baseline-before-candidate order and host load confound timing; the retained
attempts show no established live latency benefit. No live A/B ran. 4 KiB is an
advisory report candidate, not a token cap, relevance/truth check or secrecy boundary.

M0 carries actual task instructions inside its synthetic control envelope:
T1 726 instruction bytes / 788 total prompt bytes; T2 377 / 435. The targeted
same-session follow-up is 188 prompt bytes. Actual JSON-RPC request bytes are
separate. The earlier 41-byte prompt figure described only the old control
message and is not reused as natural-language delegation size.

Discovery uses 20,009 request-plus-response bytes per fresh case; the tools array
is 19,917 bytes. All eight per-tool input/output/definition sizes are in
`schema_sizes`; the largest definitions are `pi_session_prompt` (5,025 bytes,
4,338 output-schema bytes) and `pi_turn_get` (4,485 / 3,662). A baseline read
terminal frame is 23,915 bytes: `content` 12,020, `structuredContent` 11,827,
with equal JSON meaning. The compact terminal frame is 1,859 bytes. These
component numbers overlap with the whole frame.

The scripted 420 ms turn uses 60 ms pauses and observes six running polls plus
one terminal poll; the two-session case has three accepted turns, including its
explicit follow-up. Neither establishes actual live polling practice. Existing
skill guidance requests pauses of seconds; the existing profile runner uses
250 ms. M1 will observe the client's practice. No new wait tool is justified
under ADR 0003 by these synthetic timings.

## Actual Codex request projection on the synthetic route

Fresh empty disposable HOME/CODEX_HOME, ignored user configuration, ephemeral
sessions, no inherited credential/proxy variables and a no-auth loopback Responses
provider isolate this declared fixture from existing provider access. Scripted
Responses function calls drive the actual CLI/MCP loop, without a model.
Namespaced function calls follow the public Responses representation; no private
provider/SDK imports or historical session logs are used.

| Selected response, five repetitions | Server frame bytes | Server representations | Projected output bytes | Selected marker occurrences |
| --- | ---: | ---: | ---: | ---: |
| Capabilities success | 1,021 | 2 equal | 529 | 1 |
| Domain error | 280 | 2 equal | 129 | 1 error marker |
| Completed registry-truncated turn | 131,789 | 2 equal | 12,062 | 1 |

Projected output bytes serialize the selected `function_call_output.output`, not
an entire request or token count. No `structuredContent`/`structured_content` key
was observed in those selected outputs. This establishes one marker occurrence
for these responses on this route; it does not establish universal field copying
or behavior of another client/model configuration. Removing a server representation
has no demonstrated controller-token benefit here.

The large server assistant text is exactly 65,536 UTF-8 bytes with whole emoji
code points. Codex further shortens its projection to 12,062 serialized bytes.
The completed/truncated metadata **remained decodable in all five runs**; no
invalid JSON claim is made about this probe. The full answer text did not survive.
Both ordinary plaintext tool-echo and `<think>`-wrapped echo markers survive
once in this selected projected result. Only hit counts persist.

The complete request tools array was 21,412 bytes; a normal first whole request
was 43,712 bytes. These include the client's own tools/instructions. Per-request
`input_bytes`, whole-body bytes and newly added tool-output bytes remain distinct.
Later requests contain previous outputs again; `new_in_request` and opaque call
ordinals prevent counting repeated history as two copies within one response.
Cumulative token input usage remains null. This probe measures no model judgment,
provider billing, cache saving, cloud projection or natural orchestration latency.

## Independent quality, filters and process observations

M0 uses unchanged production `createServer` registrations, PR #84's disposable
fixtures/snapshots/bounded oracles and `FakeAdapter`. T2 must fail independently
before repair and pass afterward, with only `contract.mjs` changed. T1 verifies
source-linked claims and unchanged read fixtures. Immediate/delayed/long, repeated
fetch, small/exact/over-limit Unicode, domain/provider error, abort and preflight
timeout all passed their named criteria. The test timeout is 40 ms; production's
5,000 ms preflight deadline remains unchanged. All 80 cases closed sessions and
processes, with reconciled transport totals.

Filter calibration executes actual `SdkPiSessionAdapter` → registry → server →
MCP Client, using a stub AgentSession returned at the public factory seam. It
executes no real Pi agent loop/provider. Ten cases × five passed, including
explicit disposal/subscription/empty-registry checks. Every public response,
including close, is scanned transiently. The separate Codex fixture tests the
registry/server/client-request segment; it is not relabelled as one real SDK loop.

Structured thinking, tool calls/arguments/results, intermediate/stream messages,
unknown block payloads and late cross-session callbacks stay out of the public
final answer. Text blocks concatenate without an inserted separator. Provider
errors are sanitized. Ordinary final text repeating tool content or `<think>`
markers passes through; neither block filtering, regex nor a schema establishes
semantic secrecy. SDK `length` below the cap can be completed with
`truncated:false`; no SDK output-limit flag is promised. `completed`, a formatted
report and exit zero never replace independent acceptance.

M1's narrow proxy fails closed on malformed/oversized/over-quota requests and
checks returned routes/permissions, unique turn receipts, first-turn invariance,
scope, distinct successful closes and final empty list. It preserves allowlisted
partial failure evidence and unknown consumption when metrics are absent.
Linux process cleanup covers owned controller and registered server groups,
using PID/start-time/group identity and determinate non-zombie observations.
This is not containment of arbitrary reparented/setsid subprocesses. The existing
isolation limitation is unchanged.

## M1 decision package and exact remaining gate

The dedicated development executor is implemented and reviewed; the existing
`validateApproval` gate and generic runner schemas remain unchanged. L1 is one
read, L2 one independently verified repair, L3 two read sessions sharing one
immutable disposable T1 fixture followed by one follow-up in the first session.
Re-fetching the original turn after the follow-up is explicit invariance
verification overhead. The schedule is three fresh sequential Codex controllers,
four worker starts and five work turns, zero whole-run retries, one pilot only.

Codex 0.162.0 controller: `openai` / `gpt-6.1-sol` / high, repository orchestration
skill; read workers derive `openai-codex` / Sol / high from `review`, coding uses
Sol / medium from `code`. Evaluation worker profiles select no skills, extensions
or external MCP grants; production profiles are untouched. Worker turn supervision
is 180 s after acceptance, case/controller 600 s, wave 1,800 s. The 3 s poll pause
is advisory. Cleanup has separate bounded waits (configured sum 60,500 ms) plus
process-table observation; no invented aggregate 30-second hard cap remains.

Fresh metadata inventory is not proof of valid login, quota or reachability.
Selected production skill-directory digests remain unavailable/null; no repair
was made. Claude Code 2.1.302 is inventoried separately and was not invoked for a
comparison. No alternative subscription, provider credential or route was acquired.

**The missing gate is the explicit current operator decision for this exact
matrix/routes/budget.** All three templates have approval false. Subscription USD
and provider hard cap remain null. The existing gate additionally requires a
positive operator-selected advisory amount and explicit unmetered-cost
acknowledgment. No amount was invented, and an advisory is not a measured cost
or hard ceiling. After the decision, approve copies and bind normalized validated
manifest/budget digests; the pretty JSON file hash is not the approval digest.
No additional repetition, live A/B, Claude comparison or Level-3 qualification is
approved. Existing technical access does not substitute for this decision.

Official [Codex exec documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
documents usage events. The [public item-stream example](https://developers.openai.com/cookbook/examples/partners/harness_aware_plugin_evals/harness_aware_plugin_evals)
uses `structured_content` in MCP item results. The pure event projector retains
only supported nonnegative usage details, with missing fields null and no additive
total. Item events remain separate from the actual request-body observations.
The [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents the declared custom Responses provider settings used by the local probe.

## Reproduce and verify

Linux, Node >=22.19.0 and the existing lockfile; no provider credentials for M0 or
the synthetic client probe (the latter requires the observed Codex 0.162.0):

```sh
npm ci
npm run typecheck
NODE_OPTIONS=--unhandled-rejections=strict npx vitest run test/token-footprint.test.ts test/token-filter-calibration.test.ts test/token-client-events.test.ts test/token-client-projection.test.ts test/token-live.test.ts --maxWorkers=1
npm run --silent eval:profiles -- --footprint-offline
npm run --silent eval:profiles -- --footprint-client-offline
npm run --silent eval:profiles -- --footprint-plan
```

Outputs use fresh opaque ignored `eval/results/` directories; `--output` requires
a fresh destination. The existing launcher compiles/binds/removes the actual build.
Plan mode starts no session/provider or fixture workspace. Optional `--inventory`
performs only metadata inspection. No root dependency or CI change was needed.
After explicit approval only, the separate executor takes three approved copies:

```sh
npm run --silent eval:profiles -- --footprint-live --manifest approved-manifest.json --budget approved-budget.json --decision approved-decision.json
```

Checked-in proposals deliberately fail this gate. The exact executed checks,
failures and overhead are in `checks-final.json` and the preserved earlier record.
The broader verification commands actually executed were:

```sh
npm run build:cli
NODE_OPTIONS=--unhandled-rejections=strict npm test -- --maxWorkers=2
npm run build
npm run eval:schemas -- --check
npm run --silent eval:profiles -- --plan
git diff --check
```

The full suite passed 1,495 tests with six skipped on the second binding. Only
cleanup-plan metadata changed afterward, verified by exact source reconstruction;
current-source M0/client measurements and targeted checks were repeated. Full
suite/build/schema qualifications retain their actual earlier source binding.
No clean-checkout release acceptance, setup mutation, real-provider dogfooding,
model ranking or Level-3 cycle is claimed.
