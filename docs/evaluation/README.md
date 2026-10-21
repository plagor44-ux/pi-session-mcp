# Pi profile evaluation: current status and evidence

This development-only evaluation adds reproducible synthetic tasks, independent
acceptance checks, provider-free boundary tests and explicitly approved live
screening. It does not change production profiles, the public MCP contract, SDK
pins, release version or the proposed isolation decision in ADR 0008.

Start here for current status. The [maintainer guide](profile-evaluation.md)
explains the runner, task contracts, technical limits and approval gates.
Dated dossiers below describe what actually ran at their recorded revisions;
their historical PASS/FAIL decisions are not current-source qualifications.

## What ran

The separately requested [token-footprint calibration](token-footprint-2026-10-17/README.md)
records 80 provider-free transport cases, 50 filter cases and ten adverse report
controls. A separate synthetic Codex request probe measures client projection
only on its declared local fixture route. The approved real-provider
[M1 pilot](token-footprint-2026-10-17/m1-pilot/README.md) passed on 2026-10-18 on
its third attempt, with two harness fixes recorded; it measured **controller**
usage for its one Codex route (171,034 / 219,683 / 396,699 cumulative input
tokens for L1 / L2 / L3, mostly cached). Worker usage remains unknown, and so do
token usage and cost of the historical profile screenings below. A dedicated development
executor preserves the existing gate and adds exact schedule approval. This is
not a new live wave or production optimization. Sprint 5 added
[decision inputs](s5-decision-inputs-2026-10-18/README.md) (including a
provider-free Claude Code projection probe),
[tool-definition measurements](tool-definitions-2026-10-18/README.md) and an
unapproved [A/B proposal](m1-ab-proposal-2026-10-18/README.md).
Sprint 6 added the provider-free [ledger and event-bridge
evaluation](ledger-event-bridge-2026-10-21/README.md) with a Claude Code
client-level rewake probe; its real-model measurement is not approved.

| Evidence | Observed result | Interpretation |
|---|---|---|
| [Original provider-free suite](2026-10-17-profile-evaluation-evidence.md) | 1,459 passed, six skipped; overlapping offline subset 308 passed | Historical harness/oracle calibration, not model quality |
| [First authorized live screen](2026-10-17-live-screening.md) | Eight starts; four accepted tasks | Baseline A: no selected third-party extensions, skills or external worker MCP grants |
| [Later authorized re-screen](live-rescreen-2026-10-17/README.md) | Five starts; three accepted tasks; sixth planned slot blocked | Sol met that revision's T1/T2 screening gate; Luna and Grok did not |
| [Extension function checks](extension-functions-2026-10-17/README.md) | Seven selected candidates; actual functions and partial/inconclusive results distinguished | Provider-free component checks; no measured live B/C benefit |
| [Publication verification](publication-2026-10-17/README.md) | Current checks and oracle early-exit regression evidence | Applies to the publishable implementation, separately from the historical live source |
| [Extension ablation](extension-ablation-2026-10-20/README.md) | Approved live waves (four), 15 of 35 planned runs scored, USD 8.34 spent of the USD 10 budget; `pl-code-deepseek` do-not-enable (A 3/3, B 2/3), `pl-code` enable by the pre-registered rule (A 2/3, B 2/3); review pairings descriptive only; pi-cache-optimizer not run | One run per task and arm: indicative, not significant; both verdicts hinge on a single timeout or early stop; no production change recommended |

The two approved live waves used 13 starts in total. Their actual token usage and
cost remain unknown; the USD 5 amounts were advisory, with no demonstrated hard
provider cap. The PR that introduced these dossiers authorized no pilot, ablation
or additional live call; the later extension ablation ran under its own approvals.
Historical screening eligibility does not transfer across source bindings.

## Selected extension functions

| Exact installed candidate | Tested function | Remaining limit |
|---|---|---|
| `pi-lens@4.4.3` | Six `symbol_search` calls and one `project_report` call: expected cold-cache/retry responses | Warm fixture retrieval INCONCLUSIVE |
| `context-mode@1.0.169` | Actual SDK `tool_result` hook persists a synthetic canary with fixture attribution | Restricted MCP probe BLOCKED by its guard; retrieval INCONCLUSIVE; compression NOT_RUN |
| `pi-cache-optimizer@2.9.3` | Six payload, bypass, warming, headless-command and synthetic-statistics cases PASS | Fixture host; no measured cache savings or provider request |
| `@gotgenes/pi-permission-system@40.3.0` | Seven policy queries and four actual SDK hook decisions PASS | No tool executor or OS boundary established |
| `openwiki@0.7.2` | All six registered Pi lifecycle tools through the actual stdio child; 14 checks PASS | One synthetic repository/writer; retrieval and model quality untested |
| `pi-web-access@0.41.0` | Standalone MCP raw fetch and stored-content lookup PASS | Pi loading BLOCKED by its manifest entry; search/source-check tools discovered only |
| `pi-cursor-sdk@0.5.3` | Skill activation/resource enumeration and rejection cases PASS | Synthetic host; no Cursor agent, model, cloud or Cursor-owned MCP session |

The [function dossier](extension-functions-2026-10-17/README.md) contains exact
receipts, registered hooks/tools, process/network observations, failed attempts,
runnable probes, independent reviews and integrity indexes. Other inventoried
workflow packages remain untested; none was enabled as a default.

## Reproduce the provider-free implementation

Use the lockfile and Node.js >=22.19.0. Optional installed-package probes require
the exact candidate pins and Node 24.22.0 documented in their component dossiers.
They are not installation scripts and are not prerequisites for ordinary CI.

```sh
npm ci
npm run typecheck
npm run build:cli
NODE_OPTIONS=--unhandled-rejections=strict npm test -- --maxWorkers=2
npm run build
npm run eval:profiles -- --plan
npm run eval:profiles -- --offline
npm run eval:schemas -- --check
npm audit
```

The plan starts no session/provider and makes no fixture or result directory.
Offline mode uses scripted/fake routes and owned synthetic scopes. Browser
reference calibration has separate optional pinned tooling under
`eval/fixtures/T3/tooling`; it is not a new production dependency.

The publication review found that T2/T4 could previously accept an imported
candidate calling `process.exit(0)` before assertions. The published oracle now
requires an explicit completion result after all independent assertions. New
regressions reject premature successful exit in both tasks and retain acceptance
of genuine fixes. The new source digest and checks are recorded in
[publication verification](publication-2026-10-17/README.md). Historical runs are
preserved at their original source digests and have not been replayed or silently
reclassified; no new pilot qualification is claimed for the changed source.

## Evidence handling and limits

The [coverage register](2026-10-17-test-coverage.md) preserves the original wave's
inventory separately from subsequent component checks. Earlier
[package audits](extension-audit-2026-10-17/README.md),
[Node 24 follow-up](node24-followup-2026-10-17/README.md),
[client reconnect](client-reconnect-2026-10-17/README.md) and
[permission gates](permission-gates-2026-10-17/README.md) remain dated evidence.

For public portability, one archived runner's private interpreter path was
replaced with `process.execPath`, retaining its exact version check. Its
[explicit export record](node24-followup-2026-10-17/publication-export.json)
preserves the original script/index hashes and identifies the derived copy.
A [format-only export](extension-audit-2026-10-17/publication-export.json) trims
one redundant Markdown end-of-file blank line. Run receipts were not changed. Scratch results, installed packages, credentials,
raw test logs and temporary builds remain ignored. Public route inventory
contains names, exact versions, credential-presence booleans and auth-type
metadata only, with no credential values or private configuration paths.

Read-only tool selection is not a filesystem read boundary; coding is not an OS
sandbox. The collector inner-method boundary and coding file-scope boundary are
not established. A clean diff cannot undo an earlier mutation. Guarded child
process tests establish the named observed paths, not arbitrary containment.
T9 controlled compaction, remaining live role/task views and quality ablations
remain unqualified. Historical approval files describe completed waves and must
not be reused as authorization for new calls.
