# Original-plan continuation after environment qualification

The implementation and the first eight live starts are complete. Node 24,
isolated package installation and client reconnects remove setup prerequisites;
they do not qualify a model route for the role pilot. None of the original routes
passed the complete screening gate. This continuation first repairs the receipt
instructions and prepares a bounded replacement screening.

## Receipt clarification and verification

T1 now specifies a top-level `claims` array, exactly three execution-order paths,
and exactly the API function, service function and qualified data-store lookup.
It does not supply their names or the answer. T5 now specifies the exact clean
case value `no finding` and one assessment of `clean.ts`. Neither oracle's
acceptance logic nor any fixture changed. New negative assertions still reject
container-only symbols, reversed paths, an alternative clean-status spelling and
duplicate clean assessments. The [patch](receipt-contract-update.patch) and
[source delta](source-delta.json) preserve the change; the historical source hash
was independently reconstructed from the prior file bytes.

The new source digest is
`sha256:a4524626851448908b8d21ecbd7248c9956ce830406e81c45fda46c8eb6fffc5`.
Existing screening results remain unchanged historical records. They are not
reclassified as accepted. The exact-source promotion gate means that even the
earlier accepted T2 results cannot qualify this new source revision.

Provider-free verification passed: eight oracle tests; 1,459 full-suite tests,
six skipped, zero failures across 60 files; and 308/308 standalone offline tests.
The test sets overlap. Typecheck, production build, CLI build and schema drift
check passed. An initial new-test TypeScript nullability error was corrected
before the successful typecheck. [Checks](checks.json), [review](review.json).

## Proposed next live wave — not approved

The executable [manifest](manifest.proposed.json) and
[budget](budget.proposed.json) are both explicitly unapproved.
The [validation](proposal-validation.json) proves that live execution refuses the
proposal. Structural approval fixtures existed only in memory for validation;
they did not authorize or start anything. [Fresh inventory](inventory.json)
checked catalog and credential metadata only, without authentication resolution,
refresh, connectivity probes or model calls.

| Slots | Task / profile | Existing exact route | Effort |
| --- | --- | --- | --- |
| 1–2 | T1 / P1 scout; T2 / P2 implementer | `openai-codex/gpt-6-luna` | low |
| 3–4 | T1 / P1 scout; T2 / P2 implementer | `openai-codex/gpt-6.1-sol` | medium |
| 5–6 | T5 / P3 reviewer, repetitions 1 and 2 | `xai/grok-4.7` | high |

All slots use baseline A: no worker skills, third-party extensions or external
MCP grants. The limit is **six starts**, sequential, **zero controller retries**, 180 seconds
per run and 1,080 seconds total plus bounded cleanup. The proposed advisory
budget is **USD 5**, using the existing OAuth/subscription routes. Cost and usage
remain unexposed by MCP; the amount is not an enforceable provider cap.
SDK-internal provider retries and subscription quota are also unobservable.
DeepSeek is omitted as an optional comparison; this wave targets the
original Luna/Sol/Grok role hypotheses. Six starts, rather than four, are needed
to re-establish T2 evidence under the new exact source binding.

The previous eight-start allowance is exhausted. The original assignment says
to start real model runs only after explicit approval of matrix and budget.
Continuing implementation or reconnecting clients does not approve this new
wave. Approval must precede creating approved inputs and recomputing their digest.
No pilot, automatic retry or ablation is part of this proposal.

To regenerate a proposal into a fresh output directory from the repository root
under the selected Node 24 environment:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.eval.json
node docs/evaluation/plan-continuation-2026-10-17/prepare-rescreen.mjs \
  eval/results/operator-selected-fresh-proposal
```

The generator reads only the existing client registration's configuration path
and the catalog/credential metadata used by the existing inventory function. It
does not overwrite prior proposal files. It checks all expected route metadata
and refuses missing prerequisites.

## Later stages and role decisions

| Profile / view | Current evidence | Next gate |
| --- | --- | --- |
| P1 scout | T1 rejected for all three prior routes | Accepted new T1 and same-route T2 screening before pilot T1/T7 |
| P1 docs-writer | Offline T8 oracle; live draft view NOT_RUN | Qualified route, then two T8 draft repetitions; no publication |
| P2 implementer | Three prior T2 task passes; no OS file-scope boundary | New-source screening, then two repetitions for selected T2/T4 views |
| P3 reviewer | Both seeds found twice; only one complete accepted T5 receipt | Two accepted new T5 repetitions, then immutable T2/T4 fixed-result reviews |
| P4 UI writer | Browser oracle calibrated offline; no live UI result | Qualified Sol route, two T3 repetitions with independent browser assertions |
| P4 tester | Offline T6 checks; live NOT_RUN | Separate read-only two-repeat T6 view; no product repair |
| Researcher | Deferred | Separate approved external data path; no implicit P1 expansion |
| T9 read/mutation | BLOCKED | Actual observable controlled compaction; no long-prompt substitute |

The [planning ledger](next-stage-ledger.json) counts these six proposed re-screen
starts against the original 30-start maximum planning envelope. If approved and
fully used, 14 starts would have been spent, leaving at most 16 for all later
pilot/ablation work together. The old generic 18-plus-four schedule therefore
cannot run unchanged. No later allocation is approved. Fixed-result reviews must
displace other slots within the chosen allocation. There is currently no measured
feature bottleneck that justifies an extension-quality ablation; it remains
NOT_RUN. Loading an extension or fixing receipt instructions is not such proof.

The [subsequent permission gate dossier](../permission-gates-2026-10-17/README.md)
separately tests selected provider-free policy decisions. It does not turn this
baseline into an extension variant or change production profiles.

No deployment, publication, push, PR, production-profile change or auth-store
edit was made. Earlier evidence indexes are preserved. This dossier's
[integrity index](integrity.json) binds the new records.
