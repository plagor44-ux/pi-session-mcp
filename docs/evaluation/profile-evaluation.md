# Synthetic execution-profile evaluation

For the current result matrix, publication verification and historical-source
distinctions, see the [evaluation overview](README.md).

This development-only suite evaluates the current local stdio → embedded Pi SDK
path. It does not replace Claude Code orchestration, qualify production use,
accept ADR 0008, add a sandbox, or change production profile aliases. No live
model run is authorized by the checked-in plan.

For the subsequently authorized eight-run screening and its preserved inputs,
see the [live report](2026-10-17-live-screening.md). The
[coverage register](2026-10-17-test-coverage.md) states exactly which extensions,
MCP paths and skills ran, were inventoried only, or remain untested.

The follow-on [extension dossier](extension-audit-2026-10-17/README.md) records
the seven exact candidate audits, real resolver checks, OpenWiki headless
component evidence and remaining installation/compatibility blockers.

The later approved [Node 24 follow-up](node24-followup-2026-10-17/README.md)
records actual client interpreter migration, isolated installation and headless
checks of the four missing candidates, and the restricted Cursor component test.
It supersedes the earlier missing-package and Node-22 blockers for that scope.
The subsequent [existing-client reconnect record](client-reconnect-2026-10-17/README.md)
confirms both remaining Claude connections running Node 24 and no matching old
Node-22 server left at the final observation.

The [original-plan continuation](plan-continuation-2026-10-17/README.md) clarifies
T1/T5 receipt instructions without relaxing their oracles and prepares a separate
six-start re-screen. Its new source binding does not reclassify historical runs;
the role pilot remains gated on new accepted screening evidence.
The subsequently authorized [live re-screen](live-rescreen-2026-10-17/README.md)
started five of six planned slots, accepted three tasks and qualified the Sol
route for a separately approved synthetic pilot. Luna and Grok did not qualify;
the remaining Grok slot was blocked by the runner's fail gate.

The later [extension function checks](extension-functions-2026-10-17/README.md)
separate actual candidate tool/hook execution from the earlier load checks, and
record the exact tested Pi, standalone MCP and synthetic-host paths. These checks
submit no external model turns and do not measure a B/C quality ablation.

## Preflight and implementation

The 2026-10-17 preflight confirmed `origin/main`
`406dae7e6b99aa5715960490e869bd3fc668cca2`, release `v0.8.3`, and all seven
Pi package pins at `1.2.0`. PRs #80, #82 and #83 were merged; there were no open
PRs; issues #79 and #81 remained open. CI for that main commit passed. ADR 0008
remained Proposed. The original local checkout was older and clean; implementation
uses a separate branch/worktree. No roadmap, accepted decision, release field,
production registration, credential store, or external repository was edited.
The explicit evaluation assignment authorizes this synthetic development harness;
Sprint 4's prohibition on isolation runtime changes remains in force.

Reusable components are `PiSessionAdapter`, `SdkPiSessionAdapter`, the session
registry, strict MCP contracts, fake/scripted runtimes, the compiled-entry helper,
real stdio fixture servers, and existing skill/extension/lifecycle tests. New
components are task/run/result contracts, nine public synthetic fixtures,
controller-side oracles, approval-bound execution, sanitized records, and comparison
rows. The research attachments were not needed. No additional root runtime or
development dependency is required. Optional browser tooling has its own exact
pins and lockfile outside the candidate fixture.

## Commands

Use Node.js >=22.19.0 and the repository lockfile:

```sh
npm ci
npm run eval:profiles -- --plan
npm run eval:profiles -- --offline
npm run eval:schemas
node scripts/profile-evaluation-schemas.mjs --check
```

The first command installs development dependencies. The npm evaluation entry
compiles into an owned temporary build and removes it afterward. Explicit schema
generation and runner unit tests use the ignored `.profile-eval/` directory. Plan
execution leaves repository files unchanged and creates
no workspace, session, provider request, registration, or result directory. Its
JSON contains no prompts. Without a mode it plans. Offline runs execute a bounded
provider-free Vitest subset with a fresh empty Pi agent directory and no provider
credential environment. Local loopback scripted HTTP endpoints are test doubles,
not external models. Offline results go to a new `eval/results/<opaque-id>/`.
An explicit `--output <new-directory>` also must name a fresh directory; existing
attempts are never overwritten. The parent of an explicit output must exist.
The complete repository `npm test` remains the broader final check. On the
implementation host the final full verification used `--maxWorkers=2` after a
default-parallel run hit an intermittent existing recovery-lock failure; both
attempts are preserved in the evidence report. This is test-load calibration,
not a product session limit.

To inspect a deliberately selected existing configuration without auth resolution:

```sh
npm run eval:profiles -- --plan --inventory "$PI_SESSION_MCP_CONFIG"
```

Inventory loads configured aliases and the public SDK catalog, lists credential
**metadata only**, and hashes selected skill directories. It never calls
`getAuth`, `checkAuth`, login, token refresh, or a model. Metadata existence does
not establish credential validity, remaining quota, provider reachability, effort
support, or successful transport resolution. Extension providers are not loaded
for inventory; Cursor can therefore be absent from the native catalog despite a
configured extension. Billing stays unknown unless subscription metadata proves
its kind. Environment-based auth may exist without a stored credential entry.

## Tasks and independent acceptance

Only `eval/fixtures/Tn/public/` is copied to the candidate workspace. Hidden
expectations, independent assertions and evaluation code stay controller-side.
This separation is an evaluation convention, **not a filesystem read boundary**.
A writer receives a full disposable fixture copy without `.git`, hooks, local Git
configuration, `.env`, Pi project state, or credentials. Every attempt gets its own
copy and a path-free scope ID. Symlinks and special files in fixture copies are
rejected. Snapshots record content, modes, directory entries and symlink targets
without following worker-created symlinks. The final diff is checked independently.

| Task | Profile / view | Oracle |
| --- | --- | --- |
| T1 code paths and stale documentation | P1 scout | Source-linked ordered path and contradictory source/document claims |
| T2 backend contract | P2 implementer | Independent failing baseline and passing repaired behavioral tests; exact diff scope |
| T3 React/Vite UI | P4 UI writer | 375×800 and 1280×800, overflow, error alert, keyboard focus, screenshots |
| T4 multi-module cause | P2 implementer | Direct cause-module assertion plus checkout and empty-cart countercase |
| T5 immutable review | P3 reviewer | Both independent seeded defects, source locations, preconditions/impact, clean cases and extra findings |
| T6 tester | P4 tester | Concrete coverage gaps, weak test and external boundary probes; zero candidate mutations |
| T7 infrastructure sources | P1 scout | Static mount and masked shell-exit findings; no operational or current-host claims |
| T8 documentation | P1 docs-writer draft | Revision/date/source conflict and Proposed status; no publication |
| T9 context continuation | P1 read / P2 mutation | BLOCKED without an actual observed, controlled compaction event |

P3 can additionally review frozen T2/T4 results. Accepted P2 results retain a
`<run-id>.snapshot` tree, its digest, and a relative-label patch. A later approved
P3 run names `review_target: {path, hash}` within `eval/results/`, uses the
unchanging copied result plus `review.patch`, and must return its target hash,
reviewed files and findings. Passing repaired tests alone does not accept a review.
A changed target or candidate mutation invalidates the run.

The older roles remain separate views: scout→P1, implementer→P2, reviewer→P3,
docs-writer→P1 draft-only, tester→P4 read-only. A document-writing candidate and
researcher with an external data path are deferred. Tester has no shell tool:
its approved executable checks run in the controller oracle. UI writer has the
coding toolset. No role name creates a production alias.

For optional actual browser checks, see the fixture tooling package. Install
only its locked local development dependencies, then provision the matching
browser explicitly. The runner never installs packages or downloads a browser.
A missing browser runtime is BLOCKED, not evidence of UI failure or success.
The Browser plugin was not available during implementation, so regular Playwright
is the browser path. Browser assertions execute outside the worker; screenshots
alone never pass T3. Browser test failures and unavailable tooling stay distinct.

## Contracts, records and provenance

`eval/profiles/schemas.ts` is the authoritative strict contract, version `1.0.0`.
The five checked-in JSON Schemas describe structural task, run, result, manifest
and budget shapes. Zod additionally enforces cross-field bindings, profile/view
pairs, stage limits and gates; JSON Schema alone is insufficient. Task hashes bind
prompt hashes, public fixture snapshots, view mapping and expectations via the
source digest. The source digest covers current source, scripts, tests, evaluation
contracts and fixtures, package manifests/lockfiles and compiler configurations.
This binds uncommitted implementation bytes as well as the base commit.

| Status | Meaning |
| --- | --- |
| PASS | The named executed assertion met its criterion |
| FAIL | An executed requirement was violated; a missing required protection is not a pass |
| BLOCKED | A known prerequisite is absent |
| NOT_RUN | Execution did not start |
| INCONCLUSIVE | Execution started but evidence cannot decide the result |

Harness, task, boundary and recommendation fields are separate. A successful MCP
turn, exit zero, screenshot, or worker success statement cannot accept the task.
Missing credentials are a BLOCKED prerequisite, not an implementation failure.
Truncated, malformed, missing or failed acknowledgements cannot produce acceptance.
The runner never retries a whole mutation attempt. SDK-internal retries are a
separate existing production behavior; the MCP contract exposes no count or switch.
`max_retries: 0` bounds controller restarts, not unobservable SDK provider retries.

The runner supplies task/source/fixture/profile/skill/extension digests, requested
route, auth/billing declarations, view, repetition, budget, timestamps, scope ID,
external check exit codes, observed diffs and artifact hashes. The real server's
postchecked session supplies provider/model/effort labels and the observed turn
state/truncation flag. These labels do not prove the provider's internal model
revision; that value remains null. Tool counts, provider usage, dollar cost and
manual rework remain null when not observed. In particular missing usage is never
zero. Controller-call counts and elapsed time are measured locally. Cost per
accepted result is null without a reliable meter. No dollar ceiling is promised
from a runner estimate; a provider-side cap is a separate operator control.

Records never store full prompts, raw assistant text, raw provider errors,
authentication values, private absolute paths or public session/turn IDs. They
contain relative artifacts, hashes, stable codes, booleans and counts. Failed
fixtures remain in the runner's own temporary scope, identified by scope ID; a
sanitized diagnostic artifact is retained in the result directory. Successful
fixtures are removed only after checking the private ownership marker. No cleanup
searches or deletes unrelated temporary resources. Raw Vitest JSON is transient;
only its sanitized counts and exit status enter the offline evidence.

## Technical boundaries and negative evidence

`test/fixtures/profile-evaluation/coverage.json` maps N1–N8 to exact provider-free
tests. Tests use scripted tool requests, not model obedience:

- Read-only sessions actually attempt write/edit/bash after reading injected
  AGENTS content; unavailable tools cannot mutate the synthetic canary.
- Ungranted outer MCP tool calls do not contact the test service. A separate
  collector canary shows that granting the outer tool **does not filter inner
  methods**: N2's required inner-method protection is FAIL. No such collector is
  granted in baseline A.
- Strict inputs reject raw model/permission/skill/extension overrides; configured
  resources, missing skills/extensions and MCP discovery fail visibly.
- Timeout, provider errors, lost responses, invalid/truncated receipts, abort,
  EOF, close, SIGTERM and simultaneous independent scopes are checked separately.

Read-only is tool selection, not general file-read confinement. Workspace aliases
and Git worktrees are not OS sandboxes. Coding tools can write outside their task;
there is no server-enforced allowed-file set. The diff gate can reject adoption
but cannot undo an already executed mutation. Coding `boundary_status` therefore
records FAIL for that absent file-scope protection even when a synthetic task's
actual diff is acceptable. This suite installs no OS boundary and performs no
home/credential/production target write probe. There is no claimed multi-user
isolation inside the trusted-peer server. Extensions, MCP children and Cursor
can introduce other execution paths.

The live child receives a minimal environment plus only the selected native
provider's API-key variable where applicable; GitHub and SSH credentials are not
forwarded as environment variables. Existing Pi authentication still runs under
the same OS user and can be read by powerful tools. The lack of OS containment
is unchanged. Live approval does not certify that risk away.

Independent oracles execute in a separately bounded subprocess group. Timeout
and abort terminate that group before the runner returns; its child cleanup is
observed separately from the MCP server. This is lifecycle management, not OS
containment.

Lifecycle observation on Linux records sampled `/proc` descendant identities and
start times, closes sessions, bounds transport shutdown, and signals only still
matching owned identities. A short-lived process that daemonizes between samples
can escape this observation. Passing cleanup establishes the controlled tested
process paths, not arbitrary process-tree containment. Unsupported observation
platforms yield INCONCLUSIVE. No production cleanup or isolation claim follows.

## Live gates and maximum plan

The first live wave requires one explicit operator approval of the **exact**
matrix, usable existing routes, and budget. Export the plan's `manifest`, resolve
its auth/billing declarations, set its approval only after that decision, and
bind the approved budget's `manifest_digest` to SHA-256 of
`JSON.stringify(validatedManifest)`, including schema-defaulted fields. Both
`schema_version` fields must be `1.0.0`. The runner recomputes all source/task
bindings before any session start. Changing routes, repetitions, fixtures, code,
permissions, or the matrix requires a newly bound approval. Proposed budgets in
offline output deliberately fail approval validation.

```sh
npm run eval:profiles -- --live --manifest approved-manifest.json --budget approved-budget.json
```

The executable screening manifest has at most eight slots: Luna T1/T2, Sol T1/T2,
optional DeepSeek T1/T2, and Grok T5 twice. On this host the configured native
OpenAI route is `openai-codex`; it is not silently replaced by `openai`.
`eval/profiles/waves.json` records the later gated 18-slot pilot and optional
four-run ablation, for at most 30 total. GLM replaces a comparison slot or needs
new approval. Astra is only a justified escalation. Cursor/Antigravity comparisons
are excluded. Pilot routes must come from hash-bound accepted screening result files in
`screening_evidence`, with T1/T2 for coding/read candidates or both T5 repetitions
for P3. Mixed-stage approval is rejected; views stay separate. T9 remains blocked; its one read and one mutation slot cannot provide two
repetitions for either combination. Fixed-result review slots replace pilot slots
or require a revised matrix, never silently exceed the stage budget.

Proposed, unapproved budgets: screening USD 5, pilot USD 15, ablation USD 5.
Screening is supervised and sequential, max eight session starts, zero whole-run
retries, 180 seconds per run, 1,440 seconds for the wave plus bounded cleanup.
A failed combination is blocked while independent combinations can continue.
An observed scope violation, unverified process cleanup, abort, changed source or
exhausted wave budget stops the wave and records remaining slots as blocked. Missing reliable usage requires an explicit unmetered-cost
acknowledgement; a provider cap, if available, is declared separately. No new
subscription, credit top-up, account or credential acquisition is implemented.

Baseline A has no additional skill, extension or external MCP grant. Existing
implementation/review skills are inventoried separately. There is currently no
measured live bottleneck, so no ablation is justified, selected, installed or
executed. B/C execution is deliberately blocked until a selected, already installed
exact allowlist package has its package/peer/SDK/license/telemetry/data-path/headless
audit. Necessary protections cannot be removed for an ablation. Optional candidates
remain pi-lens, context-mode, cache optimizer for a measured cache issue, a separate
permission-system gate experiment, and later explicitly scoped research tools.
No inner agents, goal loops, default context compressors or workflow framework
are introduced.

A provisional selection requires all applicable mandatory contract/lifecycle
checks, no critical task/scope error, and every mandatory task assertion in both
repetitions. P3 additionally needs both seeds and no confirmed clean-case false
positives. One failed combination does not reject all routes. Two repetitions are
not a statistically defensible ranking; no score compensates for a boundary
violation. Allowed decisions are suitable for the tested synthetic scope,
restricted, blocked/not established, or rejected for that scope. The current
provider-free evidence establishes no live-model selection.
