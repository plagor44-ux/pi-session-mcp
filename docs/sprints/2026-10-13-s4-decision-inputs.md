# Sprint 4 decision inputs: R12, R15, R17 and R18

Date: 2026-10-13. Base: main `0aae6390c539e1d70138f1efaf297e6193a2b497` (the
merge of Sprint 2). Tracking:
[#72](https://github.com/plagor44-ux/pi-session-mcp/issues/72).
Planning sources: the [roadmap](../roadmap.md) and the
[post-0.8.1 audit](../reviews/2026-10-13-post-0.8.1-audit.md), whose
[Sprint 4 section](../reviews/2026-10-13-post-0.8.1-audit.md#sprint-4-decide-the-next-investment-from-usage)
routes R12, R15, R17 and R18 "into one concrete follow-up or the deferred list
according to need".

This record is decision input, not the Sprint 4 decision. It checks the entry
condition of each of these four conditional items against facts gathered on
2026-10-13, while Sprint 3 (live usage acceptance) is still running. It
implements nothing: no workflow, `package.json`, release tooling or runtime
change. The usage evaluation that Sprint 4 needs from Sprint 3 (failures and
their causes, scope violations, polls per turn, task duration, cleanup,
restart cost and planned non-disposable workspaces) is outside this record.
Sprint 3 results can change the assessments of R12 and R15 below; Sprint 4
re-checks them.

R-identifiers are planning identifiers from the audit, not GitHub issue
numbers.

## Summary

| Item | Entry condition | Assessment on 2026-10-13 | Re-check in Sprint 4 |
| --- | --- | --- | --- |
| R17 scheduled advisory check | Further demonstrated `npm audit` drift | Not met | Any advisory found between releases or at a release gate; any Dependabot alert |
| R18 npm provenance / Trusted Publishing | External use makes it relevant | Not determinable; no evidence of external consumers | Distinguishable external use, or a maintainer decision to harden publication anyway |
| R12 real crash, contention and signal runs | Operating experience warrants targeted evidence | Not met | Sprint 3 records and operator reports of interrupted updates, customization conflicts or signal-ended analyses |
| R15 explicit unverified evidence for an unreadable start time | A run passes while the start time was unreadable, or a demonstrated need | Not met | Sprint 3 `noServerObserved` failures whose investigated cause is an unreadable start time |

Assessment values: **met** (the facts satisfy the entry condition), **not
met** (the facts were checked and do not satisfy it), **not determinable**
(the available facts cannot decide it).

## R17: scheduled advisory check

Definition
([audit, cluster C](../reviews/2026-10-13-post-0.8.1-audit.md#c-acceptance-and-release-evidence-quality)):
`npm audit` is manual only. Deliverable: keep the manual release gate;
consider one small scheduled advisory check only after further demonstrated
drift, in its own issue.

Facts:
- `npm audit` and `npm audit --omit=dev` against the lockfile of `0aae639`
  reported 0 vulnerabilities each (331 dependencies), exit 0.
- The release notes of v0.6.4, v0.7.0, v0.7.1, v0.8.0 and v0.8.1 each record
  `npm audit` and `npm audit --omit=dev` with 0 vulnerabilities. The native
  gates of [Sprint 1](2026-10-13-s1-correctness.md) and
  [Sprint 2](2026-10-13-s2-evidence.md) recorded 0 vulnerabilities on every
  run.
- No changelog entry and no commit after the initial public release patches
  an audit advisory. The 0.6.2 changelog records that the earlier lockfile
  patches for `proxy-addr`, `shell-quote` and `concurrently`, present since
  the initial public release (2026-10-06), left the tree with the Inspector
  update `5015143` of 2026-10-09, before v0.6.2 was tagged the same day.
  [Releasing](../releasing.md#patch-audit-advisories) describes the
  `concurrently` case.
- GitHub vulnerability alerts (Dependabot alerts) are enabled for the
  repository and list no alerts. There is no `.github/dependabot.yml`, so no
  version-update pull requests are configured. Dependabot alerts already give
  a passive advisory signal for the default branch between releases.
- `npm audit signatures` on the installed tree of the workstation checkout
  (consistent with the lockfile: `npm ls --all` exit 0) reported 251 packages
  with verified registry signatures and 79 with verified attestations, exit 0.
  CI does not run it.
- A scheduled-workflow precedent exists:
  [`pi-sdk-canary.yml`](../../.github/workflows/pi-sdk-canary.yml) runs nightly
  and reports an incompatible SDK into one labeled tracker issue.

Assessment: **not met**. No drift is demonstrated after the initial release.

If the condition is met later, the smallest follow-up is its own issue for a
nightly job that runs both audit commands against the lockfile and reports
into one labeled tracker issue, following the canary's pattern. The manual
release gate stays. Whether Dependabot alerts already cover the need is part
of that decision.

## R18: npm provenance and Trusted Publishing

Definition
([audit, cluster C](../reviews/2026-10-13-post-0.8.1-audit.md#c-acceptance-and-release-evidence-quality)):
npm publication has no provenance attestation. Deliverable: consider Trusted
Publishing or provenance as a separate supply-chain decision if external use
makes it relevant; not a blocker for bounded local dogfooding.
[#3](https://github.com/plagor44-ux/pi-session-mcp/issues/3) deferred
"provenance and trusted publishing from GitHub Actions" when the package was
first published.

Facts about publication:
- The registry lists 0.6.1, 0.6.2, 0.6.3, 0.6.4, 0.7.0, 0.7.1, 0.8.0 and 0.8.1,
  published between 2026-10-06 and 2026-10-12 (UTC), plus the staging placeholder
  `0.0.0-stage`. None of them carries a provenance attestation in its registry
  metadata.
- [Releasing](../releasing.md#publish-a-release) publishes from a fresh local
  clone of the tag with `npm stage publish`; the maintainer approves the staged
  version with the account's second factor and compares the shasum.

Facts about use:
- The npm download API, whose data ended on 2026-10-11 at the time of the
  query, reports 915 downloads from 2026-10-07 to 2026-10-11 (59, 15, 150, 349
  and 342 per day) and none earlier in the 30-day window, all within days of
  the six publications from 0.6.1 to 0.7.1; 0.8.0 and 0.8.1 fall after the
  data. The counts do not distinguish
  people from registry mirrors and automated fetchers, nor external users from
  the maintainer's own installations.
- GitHub reports one star, no forks and no watchers. Its 14-day traffic shows
  770 clones (229 unique) and 45 views (3 unique); every CI run checks the
  repository out, so clones do not indicate external users either.
- All 26 pull requests are from the maintainer account. Before #72, 43 of 45
  issues were from the maintainer account and two (#28, #29) from one other
  account. #28 reports use from a clone of a release tag, not from the npm
  package. No issue or pull request identifies an external consumer of the
  npm package.

Facts about the mechanism (npm documentation, read on 2026-10-13:
[Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers),
[Staged publishing for npm packages](https://docs.npmjs.com/staged-publishing),
[Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements)):
- Trusted publishing authenticates a CI workflow through OIDC instead of a
  long-lived token. It needs npm CLI 11.5.1 or later and Node.js 22.14.0 or
  later, a GitHub Actions workflow with `id-token: write`, and a trusted
  publisher configured on npmjs.com for the owner, repository and workflow
  file name.
- A trusted publisher always allows `npm stage publish`; a direct
  `npm publish` and dist-tag management are separate options. A staged
  version still needs a maintainer's approval with the second factor, so the
  current approval step can stay. Staging needs npm 11.15 or later (see
  [Releasing](../releasing.md#publish-a-release)), above the trusted-publishing
  minimum.
- Trusted publishing from GitHub Actions generates provenance attestations
  automatically when the repository and the package are public. Both are
  public. A local publish, as today, cannot produce provenance.

Assessment: **not determinable**. The available counts cannot separate
external consumers from mirrors, automation and the maintainer's own
installations, and no external consumer has made itself known.

If the condition is met later, or the maintainer decides to harden
publication without it, the smallest follow-up is its own issue and a release
procedure decision:
- a tag-triggered workflow with `id-token: write` that runs `npm ci`, builds
  and stages the package with `npm stage publish`;
- a trusted publisher on npmjs.com limited to staging, so every version still
  needs the second-factor approval;
- [Releasing](../releasing.md) updated, including a check of the attestation
  after approval;
- the published-release Level 2 acceptance unchanged.

Trade-offs to weigh: the release bytes are built on a GitHub-hosted runner
instead of a fresh local clone; the repository gains a workflow with an
OIDC token permission and depends on the actions it uses; the first release
under the new procedure needs the same pre-release acceptance as any other.
The change touches release tooling; if a 0.8.2 patch release happens, keeping
this change out of it would keep that patch's scope unchanged.

## R12: real crash, contention and signal runs

Definition
([audit, cluster B](../reviews/2026-10-13-post-0.8.1-audit.md#b-evidence-and-orchestration)):
a real skill-update crash, a real customization contention and a
harness-analysis signal run are absent from live evidence. Deliverable: add
only targeted evidence when operating experience warrants it; existing
provider-free tests are not renamed as live evidence.

Facts:
- The [acceptance status](../acceptance.md#status) states that its records do
  not cover a real crash in the middle of a setup skill update, a real
  contention of two customization processes outside the tests, or an
  operating-system signal to the harness during a live analysis, and that the
  provider-free tests cover these.
- Those provider-free tests exist: SIGKILL recovery at six of the seven update
  checkpoints in [`setup-skills-recovery.test.ts`](../../test/setup-skills-recovery.test.ts),
  concurrent customization in
  [`skill-customize-concurrency.test.ts`](../../test/skill-customize-concurrency.test.ts)
  and signal handling of the harness in
  [`multi-session-acceptance.test.ts`](../../test/multi-session-acceptance.test.ts).
- No issue and no acceptance record reports an interrupted real skill update,
  a customization conflict between two processes, or a live analysis ended by
  a signal.
- On `main` since Sprints 1 and 2, not yet in a published release, recovery
  retains an unprovable intermediate
  ([#59](https://github.com/plagor44-ux/pi-session-mcp/issues/59)) and the
  dry-run predicts it ([#60](https://github.com/plagor44-ux/pi-session-mcp/issues/60)).
  A real interruption that leaves an unprovable intermediate on a build that
  contains these changes would surface as `skill_recovery_retained`; the
  published 0.8.1 still deletes a partial trash.

Assessment: **not met**.

If the condition is met later, the smallest follow-up records that occurrence
as evidence, with its sanitized setup report, and adds a targeted test only
when the occurrence shows behavior the provider-free tests miss.

## R15: explicit unverified evidence for an unreadable start time

Definition
([audit, cluster C](../reviews/2026-10-13-post-0.8.1-audit.md#c-acceptance-and-release-evidence-quality)):
a client start time that is unreadable immediately after spawn leaves no
sighting. Deliverable: explicit failed or unverified evidence; never infer
cleanup from an absent observation. [Sprint 2](2026-10-13-s2-evidence.md#tasks)
did not include it and set the entry condition: a run that passes while the
start time was unreadable, or a demonstrated need for an explicit unverified
code.

Facts:
- The [multi-session harness](../../scripts/multi-session-acceptance.mjs)
  records a process only together with its start time; without the client's
  start time nothing is recorded. Its pass criteria include at least one
  observed server (`noServerObserved`) and no residual process.
- The acceptance records contain one run with `noServerObserved` failures:
  run 2 on `06471b5`, where three invocations failed only with
  `noServerObserved`. Their cause was a harness defect that replaced earlier
  sightings; `cb6e949` fixed it. The code was misleading there, but the runs
  failed. The cause was not an unreadable start time.
- No record shows a run that passed while a start time was unreadable.

Assessment: **not met**.

If the condition is met later, the smallest follow-up is its own issue for an
explicit failure code when the client's start time cannot be read, so the
result names the cause instead of `noServerObserved`; such a run still fails.

## Sources and checks

All checks ran on 2026-10-13 on the Linux workstation, read-only, without a
client, Pi session, provider or model:
- `npm audit` and `npm audit --omit=dev` against the lockfile of `0aae639`;
  `npm audit signatures` on the installed tree of the workstation checkout.
- npm registry metadata of `pi-session-mcp` (publication times, attestations)
  and the npm download API (point and daily range).
- GitHub API: repository statistics, 14-day traffic, Dependabot alerts and
  the vulnerability-alert setting, issue and pull request authors.
- Release notes of v0.6.4 to v0.8.1, `CHANGELOG.md`, the Git history,
  [Releasing](../releasing.md), [Acceptance](../acceptance.md), the Sprint 1
  and Sprint 2 files, the audit and
  [#3](https://github.com/plagor44-ux/pi-session-mcp/issues/3).
- npm documentation on trusted publishing, staged publishing and provenance,
  read through a documentation index on 2026-10-13.
