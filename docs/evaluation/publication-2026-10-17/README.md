# Publication verification — 2026-10-17

This record covers the implementation prepared for the evaluation pull request.
It is separate from the historical live screens and optional extension
experiments. No new external model request, pilot or ablation was run for this
publication step.

## Final implementation

The development-only runner implements versioned task/run/result/manifest/budget
contracts, nine synthetic task families, independent task acceptance, explicit
source/route/approval binding, bounded execution and observed process cleanup.
The public MCP server, production profiles, SDK/dependency pins and release
version remain unchanged. CI adds short provider-free plan and schema checks.

PR review found a false-positive regression-oracle path: T2/T4 imported candidate
code could call `process.exit(0)` before any assertions and still be accepted.
The corrected oracle requires both a successful exit and an unpredictable
completion token written only after all assertions over a dedicated pipe.
The pipe adds no temporary completion files that could survive a worker timeout.
Regressions exercise early exit in both tasks and preserve genuine-fix acceptance;
existing bounded-worker timeout/abort tests cover the surrounding lifecycle.
This completion protocol is a behavioral check, not a boundary against arbitrary
hostile code sharing the evaluator process.

The [check record](checks.json) contains exact commands, exit codes, aggregate test
counts, source binding and hashes of locally retained raw logs. Logs are not
published. The [review record](review.json) identifies the independent review,
resolved findings and the limits of acceptance. The [integrity index](integrity.json)
binds this publication record.

## Source and historical decisions

The initial eight-run wave used digest
`sha256:686887d57899c2e55593bb7dd98b78be08ea0fc6c471a6dd4eab3298f890d160`.
The later five-start re-screen and extension function checks used
`sha256:a4524626851448908b8d21ecbd7248c9956ce830406e81c45fda46c8eb6fffc5`.
Both describe uncommitted evaluation trees based on main commit
`406dae7e6b99aa5715960490e869bd3fc668cca2` at execution time.
The published oracle completion fix changes the source digest; the current value
is in `checks.json`. Committing or merging also changes the Git base identity.

Historical manifests, approvals, results and task decisions retain their original
bindings and were not reclassified or reused. In particular, Sol's screening
eligibility was established only at the re-screen revision; this publication
claims no new-source model qualification. The old oracle's early-exit weakness
is disclosed and fixed, without inferring that a particular historical worker
exploited it. The old live results establish only the checks that actually ran.
New live work needs a newly bound explicit matrix and budget approval.

Some retained optional experiment scripts deliberately pin their historical tree
or write a fixed immutable attempt name. They are provenance, not ordinary CI
commands; they can refuse a changed source or an existing destination. The main
plan/offline entrypoints always create their own current-source scopes. The
current source checks do not silently re-execute historical optional packages or
external model routes.

## Public evidence export

All intended files were checked for credentials, complete live prompts or
transcripts, raw provider errors, private host paths and unintended vendor or
scratch content. Exact provider/model inventory names, credential-presence
booleans and auth-type metadata are intentionally retained; credential values and
private configuration paths are absent.

One archived Node-24 experiment runner contained a private interpreter path.
The [derived export record](../node24-followup-2026-10-17/publication-export.json)
identifies its replacement with `process.execPath`, preserves the original
script/index hashes and discloses that the public script is a derived copy.
The original script/index remain in the owned ignored publication scope. No
historical run receipt was edited. The Node-24 index is explicitly marked as a publication export. A second
[format-only export](../extension-audit-2026-10-17/publication-export.json) removes
one redundant blank line at the end of an earlier Markdown report for staged
whitespace validation; its original hash/index are retained in the same manner.
No report prose or run receipt changed. All other earlier dossier files and
indexes are preserved.

Installed package prefixes, generated builds, raw logs, owned result workspaces
and auth material are excluded from Git. Synthetic browser screenshots,
accepted fixture snapshots, sanitized attempt receipts and lockfiles for the
optional browser tooling are intentional evidence. The independent publication
audit and final integrity checks are recorded alongside the verification.

## Local acceptance result

All final checks passed under Node 24.22.0: strict full suite **1,459 passed, six skipped**, offline subset **308 passed**, typecheck, CLI/server builds, plan mode and schema drift check. Root `npm audit` reported **zero vulnerabilities**. Node 22.23.2 also passed no-emit evaluation compilation and all eight oracle cases. The suites overlap and their counts are not additive.

Current evaluated source digest: `sha256:922f78c2f4a2f85673606fb45a3776fa5246da47c1f7a7862fd87fe08727bbfe`. The final plan carries this digest and remains unapproved. Required remote CI is enforced through the pull request; this record is local verification, not a claim about an unobserved CI run.
