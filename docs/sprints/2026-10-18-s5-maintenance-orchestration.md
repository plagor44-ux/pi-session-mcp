# Sprint 5: maintenance and orchestration friction

Date: 2026-10-18. Base: main `612fbcb976d4563ea597e87be56123055b782c1a` (merge of
PR #85), package 0.8.3, Pi SDK 1.2.0, MCP SDK 2.3.1. Maintenance under ADR 0003.
The isolation decision (#79, ADR 0008 Proposed) stays the prioritized
architecture work; this sprint does not accept ADR 0008 and implements no
isolation. No merge, tag, version bump or npm publication is part of it.

## Goal

Reduce confirmed friction in diagnosis and orchestration, make the evidence
summaries consistent, and prepare the next decisions with concrete inputs.

## Preflight (2026-10-18)

- `origin/main` = `612fbcb`; no open pull requests; main CI run 39121671820
  green on Linux, macOS 15, macOS 26 and verify; latest release v0.8.3.
- Open issues: #79, #81, #86, #87, #88, #89, #90, #91, #92, #93 (all read
  with comments, including the 2026-10-18 comments on #88 and #89).
- Local checkout: clean, 15 commits behind and fast-forwarded. Pre-existing
  linked worktrees of earlier sprints (`docs/79-isolation-adr`,
  `chore/release-v0.8.2`, `docs/s4-decision`) are left untouched.
- The main checkout's `node_modules` held Pi SDK 1.1.0 although the lockfile
  pins 1.2.0 (a stale local install, not a repository defect). All checks of
  this sprint ran in fresh full clones after `npm ci`.
- Installed clients: Claude Code 2.1.301, Codex 0.162.1. The provider-free
  Codex projection probe pins Codex 0.162.0 exactly, so it cannot run here.
- #85's security summary binds `98a7dc4`, not its final head `132f48e`; no
  review approval is derived from it.

## Routes and ownership

Discovered with `pi_capabilities_get` (once) and `agy models` / `agy --help`.

| Route | Finding | Use in this sprint |
| --- | --- | --- |
| Pi coding profiles (`code`, `code-*`) | Only one workspace alias for this repository, pointing at the operator's main checkout; no dedicated writer alias exists | **Blocked** by the Sprint 4 interim rule (coding only on dedicated worktrees, one writer per alias). No MCP configuration was widened |
| Pi read-only profiles | Available | `review` (Sol, high) for #92 |
| agy (Gemini) headless | Models listed; without a permission grant headless agy denies shell and URL tools; `--yolo` was refused by the Claude Code auto-mode classifier and not worked around | File-read-only analysis for #79; web research blocked on this route |
| Claude subagents | Available | Writers in separate full clones (own `.git`, base `612fbcb`); research and review |

Writers never shared a clone, file ownership was disjoint, and the integrator
serialized every change into one integration clone. Worktrees are not an OS
sandbox, and neither are these clones.

## Ledger

Session and turn IDs were kept only transiently.

| Task | Issue | Owner / route | Workspace | Scope | Status | Checks (by owner, then integrator) |
| --- | --- | --- | --- | --- | --- | --- |
| A | #81 | Claude implementer | clone `a` | `src/doctor.ts`, `test/doctor-gitfile.test.ts`, `docs/doctor-design.md` | implemented | typecheck, build:cli, 67 Doctor tests + 18 new; integrator fix: byte-based size cap |
| B | #86 | Claude implementer | clone `b` | orchestration skill tree, start-code, skill-library, package and setup tests | implemented | typecheck, builds, 12 files / 235 tests + 2 files / 338 tests; integrator fix: no retry before a start code is classified |
| C | #87 | Claude implementer | clone `c` | both worker skills, `test/skill-library.test.ts` | implemented | typecheck, 6 files / 122 tests |
| D | #88, #90 | Claude implementer | clone `d` | `src/server.ts`, `test/mcp-contract.test.ts`, `docs/evaluation/tool-definitions-2026-10-18/` | implemented; Codex projection gate open | typecheck, build, 5 files / 125 tests, 156 raw responses compared |
| E1 | #79 | agy `gemini-3.8-flash-high`, file-read tools only | main checkout, read-only | decision brief | delivered, verified by integrator | — |
| E2 | #92 | Pi `review`, read-only | alias `pi-session-mcp` | SDK usage semantics | delivered; rechecked against 1.2.0 | session closed |
| E3 | #91 | Claude researcher (agy web route blocked) | read-only | decision inputs | delivered | — |
| E4 | #89 | Claude researcher, then Claude implementer | clone `e` | provider-free Claude projection probe | partial: q1/q2 answered, q3 unmeasurable, q4 not measured | typecheck, 2 files / 9 tests, eval:schemas --check; probe attempt 1 inconclusive, attempt 2 PASS (base), attempt 3 PASS (Sprint 5 head, after review fixes) |
| F | #93 | integrator | integration clone | A/B proposal | delivered, unapproved | — |
| G | — | integrator | integration clone | roadmap, sprint, evaluation summaries, CHANGELOG, ADR facts, acceptance | delivered | relative-link check of all changed Markdown files |
| R1 | all | agy `gemini-3.8-flash-high`, file-read tools only | frozen diff `612fbcb..87bde7a` | independent review | 5 findings, all fixed | — |
| R2 | all | Pi `review-grok` (xAI), read-only | main checkout detached at `87bde7a` | independent review | 2 findings, fixed; turn budget extended once from 15 to 25 minutes, finished after 17 | session closed |

## Results per issue

- **#81 implemented.** Doctor warns `workspace_gitfile` (warning, exit 1, never
  masking an error) when a workspace's `.git` is a regular file starting with
  `gitdir:` and a coding profile exists. The detection is conservative: a
  gitfile also marks submodules and separate Git directories, and the pointer is
  never followed. Symbolic links, unreadable and malformed files yield `ok`,
  meaning "not detected", not "verified clean". See
  [Doctor design](../doctor-design.md).
- **#86 implemented.** Terminal turns are recorded once; cadence 10 s then
  15–30 s; fixed task and cleanup budgets; cost note as a Codex route
  observation; the start-code classification lives in
  `references/start-errors.md`. `SKILL.md` went from 9,025 to 9,112 bytes; the
  reference adds 1,380 bytes, loaded only after a start failure. No token saving
  is claimed. The test still checks complete, unique coverage of every
  documented start code against `docs/tool-contracts.md`.
- **#87 implemented.** Worker reports: concise, relative evidence, failing lines
  only, nothing dropped for space, `truncated` semantics. Implementation skill
  2,789 → 3,482 bytes, review skill 2,610 → 3,254 bytes. Live effect unmeasured.
- **#88 implemented.** Four descriptions gained hints; `pi_session_start` is
  unchanged. Patch under ADR 0003: descriptions are not tools, fields, states
  or error codes.
- **#90 implemented** after the compatibility check passed: input schemas use
  `z.string().meta({ format: "uuid" }).pipe(z.string().uuid())` (public zod API),
  so the JSON Schema keeps `format: "uuid"` without `pattern` and validation is
  unchanged. 156 raw JSON-RPC responses (26 values for each of the six fields)
  were byte-identical before and after, with no side effects. Patch under ADR
  0003. Output schemas and `content`/`structuredContent` are unchanged.
- **#79 open maintainer decision.** [Decision brief](../reviews/2026-10-18-adr-0008-decision-brief.md);
  ADR 0008 facts updated (R10/R11 passed for Claude Code, macOS containment
  unproven, #81 delivered); status stays Proposed.
- **#89 partially delivered.** A provider-free Claude Code probe uses the
  documented gateway route (`ANTHROPIC_BASE_URL` to a loopback fake, dummy key,
  fresh config, `--bare`). On that route: output schema not observed; one
  tool-result representation observed; deferred tool search unmeasurable
  (bare mode has no tool search); per-case controller input not measured.
  Claude Code's `server/discover` request breaks the M1 frame proxy, a
  prerequisite for any later Claude M1 plan. See the
  [probe](../evaluation/s5-decision-inputs-2026-10-18/claude-projection/README.md).
- **#91 decision inputs delivered** ([note](../evaluation/s5-decision-inputs-2026-10-18/bounded-wait.md));
  decision deferred until the A/B. No `waitMs`, no `pi_turn_wait`.
- **#92 research delivered** ([note](../evaluation/s5-decision-inputs-2026-10-18/worker-usage.md));
  usage is per assistant response, a per-turn aggregate is not provided by the
  SDK. No contract change.
- **#93 proposal delivered, unapproved** ([package](../evaluation/m1-ab-proposal-2026-10-18/README.md)):
  3 pairs, order A/B, B/A, A/B; 18 fresh controller invocations, 24 worker
  starts, 30 work turns, 0 retries. Prerequisites P1–P3 (skill tree binding,
  worker skill selection, client version) are not implemented.

## Measured bytes (not tokens)

From the [tool-definition evidence](../evaluation/tool-definitions-2026-10-18/README.md):

| Measure | Base | After #88 | After #90 |
| --- | ---: | ---: | ---: |
| `tools/list` frame | 19,962 | 20,217 | 19,143 |
| `tools` array | 19,917 | 20,172 | 19,098 |
| Eight pi definitions (name, description, input schema) | 3,616 | 3,871 | 2,797 |

The 2,246 bytes quoted in #88/#90 were not reproduced and are bound by no
committed evidence; the committed Codex figure of 21,412 bytes is the whole
client tools array including Codex's own tools. The actual Codex projection
before and after is an open measurement gate (installed 0.162.1, probe pins
0.162.0). On the provider-free Claude Code bare route (probe attempts 2 and 3)
the request `tools[]` went from 7,144 to 6,325 bytes (−819) and the first
request body from 11,608 to 9,004 bytes; the 1,785-byte remainder is
unexplained. Bytes are not tokens. Live token effect of any change in this
sprint: unmeasured.

## Verification and review

See [Acceptance](../acceptance.md#sprint-5-provider-free-checks-2026-10-18):
full suite (67 files, 1,531 passed, 6 skipped), builds, evaluation plan,
offline harness and schema checks, package listing, diff check and Level 2
setup acceptance (160 of 160) ran once on the integrated head `87bde7a`. Seven
review findings were fixed afterwards and only the affected checks were
repeated on the final code.

## Cleanup

Two Pi sessions were started (`review` for #92, `review-grok` for the final
review); both were closed and `pi_session_list` was checked at the end. agy
runs end with their process. Writer clones and the probe's owned temporary
directories live outside the repository; the probe verified its own removal.
The main checkout was detached for the frozen review and returned to `main`.

## Gates for later sprints

- #79 decision before any isolation work.
- #93 approval (and P1–P3, or an explicit decision to report #87 as untested)
  before the A/B.
- A/B results before the final #91 decision.
- A public contract decision before any minor-release work (`waitMs`, usage
  fields, compact results).

## Prepared R22 text (not applied)

The project instructions in the operator's ChatGPT project still describe 0.8.1
and SDK 1.1. Replace them with the
[Sprint 4 appendix text](2026-10-15-s4-decision.md#appendix-proposed-chatgpt-project-instructions-r22)
plus this paragraph. This repository cannot apply or check that change.

```text
Sprint 5 (docs/sprints/2026-10-18-s5-maintenance-orchestration.md) added, unreleased
on main after its PR merges: a Doctor gitfile warning (#81), consume-once polling and
an on-demand start-error reference in the orchestration skill (#86), concise worker
reports (#87), tool-description hints (#88) and slimmer input schemas (#90), all
without a public contract change. Open decisions: #79 isolation (ADR 0008 Proposed),
#93 A/B approval, then #91 bounded wait; #89 and #92 are research items. The M1 pilot
measured Codex controller usage only; worker usage and money cost are unknown.
```
