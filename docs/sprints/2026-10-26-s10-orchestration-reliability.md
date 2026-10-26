# Sprints 9 close-out to 11: orchestration reliability

Planning basis: main `e6fc87c` (merge of PR #138), published 0.11.5, 2026-10-26.
Input: the operator's concept "Pi-Orchestrierung verbessern: Kandidaten, Evidenz
und Testplan" (2026-10-25, not tracked in this repository), checked against the
repository below. This file plans work; it does not claim that any item is
implemented or that any gate passed.

## Where the project stands

- 0.11.5 is published and runs the container-writer pilot on the workstation
  (`pi-session-mcp-w1`, `pi-session-mcp-w2`).
- Sprint 9 delivered #134 (closed) and the fail-closed part of #135 in PR #138.
  #135 is still open; its remaining proposal (copying operator overrides into a
  writer) is explicitly out of the sprint. #136 and #137 are open.
- The Sprint 8 migration stopped after the pilot; steps 2–7 (the remaining
  repositories and `second-machine`) wait for Sprint 9.
- Open product decisions: #79 review point 2026-11-15, #120 (`undici` in Pi
  SDK 1.4.0), ADR 0011 item 4 (question channel).
- Route availability on 2026-10-26 (operator routing notes): the xAI profiles
  (`code-grok`, `review-grok`) fail with HTTP 402 and the Cursor profiles end
  with `turn_failed`. Usable coding routes in the writers: `code`,
  `code-deepseek`, `code-glm`, `code-mistral`. Usable read-only routes on the
  host alias: `review`, `review-glm`, `explore-fast`.

## Concept assessment

The concept proposes eleven candidates (K1–K11). Most of them change the
controller skill, the shipped worker skills or client hooks, not the MCP
contract. Checked against the repository:

| # | Candidate | Repository check | Decision |
| --- | --- | --- | --- |
| K1 | Eval suite for the controller skill with `claude plugin eval` and mocked pi-session-mcp tools | `claude plugin eval` exists on Claude Code 2.1.310 here, with `--mocks` and a with/without ablation. Each run costs Claude tokens, not Pi provider tokens. | Sprint 10. Dev-only under `eval/controller-skill/`; the plugin wrapper is a test fixture, not a new distribution channel. |
| K2 | Brief and report contract with fixed status tokens | The worker skills already require a five-part report ("done, partly done or blocked"); no exact tokens. The M1 receipt failures and the Grok T5 status spelling support exact tokens. | Sprint 10. |
| K3 | File ledger per run plus a `SessionStart` hook (matcher `compact`) | Sprint 6 named compaction as the only gap of the in-context ledger (4.1 a) but rejected a file ledger as a **product feature** and called a hook writer a development aid. | Sprint 11, after maintainer decision D1. |
| K4 | Early-stop rule: `completed`, short runtime and no change trigger one follow-up in the same session | 3 of 18 repeat runs and 1 of 15 first-wave runs stopped after 23–45 s. Correction: in a container writer the controller must not inspect the clone, so "no change" means no commit in the report **and** no new ref after `--collect`. | Sprint 10. |
| K5 | Review stage per task with a capped fix loop, reviewer from another model family | Cross-family reviews found real defects in Sprints 5 and 6; Grok missed the verdict in `r-psm-smoke`. Collected refs already sit in the operator checkout as `refs/remotes/writer-<name>/…`. | Run as process from Sprint 10 on; write into the skill in Sprint 11 with the measured result. |
| K6 | Routing per role | Matches the operator routing rules; the evidence is three runs per profile. | Sprint 10, worded as a default with its evidence level, not as a ranking. |
| K7 | Background dispatcher subagent per Pi task | Unknown whether the wake reaches a subagent and whether it shares the registry. | Sprint 11, provider-free probe only. |
| K8 | Wake gaps: hook timeout covers the task budget, wake after `PostToolUseFailure`, one long-turn L4 pair | Ledger evaluation S6 lists the long turn as not measured. | Sprint 11; the L4 pair needs a live approval. |
| K9 | `Stop` hook that blocks only on a read but unverified turn | Depends on K3's ledger. A `Stop` gate on open sessions is rejected because it collides with the wake. | Sprint 11, with K3. |
| K10 | Guided profile setup skill and a Doctor check for profiles in container repositories | #139; the Doctor check also closes the gap #135 left (refusal only at provisioning). | Later; the Doctor check may move forward if Sprint 9 has room. |
| K11 | Report extension for workers (`submit_report`) | Container writers refuse extensions in coding profiles (writer boundary). Needs either a boundary change or a result channel in the MCP contract. | Deferred; needs an ADR and a minor release. |

Two further findings from the concept were checked in code:

- **Worker system prompt.** `phase0ResourceLoaderOptions` in
  `src/sdk-pi-adapter.ts` sets `systemPrompt: "phase-0-system-prompt-disabled"`
  with no-op overrides. Whether workers therefore run without Pi's default
  system prompt is not verified. It is a plausible contributor to early stops
  and is cheap to check without a provider, so it is the first task of
  Sprint 10.
- **`AGENTS.md` as worker context.** Workers load context files
  (`noContextFiles: false`). This repository's `AGENTS.md` holds rules but no
  build or test commands. Adding the commands is a cheap change; its effect is
  unmeasured.

The concept's "not recommended" list agrees with recorded decisions (bounded
wait #91, question channel ADR 0011 item 4, extensions and MCP grants in
container coding profiles, pi-lens on `code`) and is added to the roadmap's
deferred table.

## Sprint 9 close-out

Goal: finish #136 and #137 so the migration can continue. Until they ship, the
migration uses the workarounds: reconnect the writer servers after each reset
or finish, and pin Pi extensions exactly.

| Task | Scope | Route |
| --- | --- | --- |
| S9-1 #136 | After `--reset`, `--finish` or `--recreate`, setup reports that the writer's servers must be reconnected (like `controllers_restart_required`) instead of failing later with `local_authentication_missing`. A refusal while a server runs is not chosen, because a connected client would block every finish. Skill section 11 names the reconnect. | `code` on `pi-session-mcp-w1` |
| S9-2 #137 | Doctor warns when an extension that a profile pins is listed unpinned in Pi's settings. `doctor_failed` from the repository step names the blocking check ids. The gate's tolerance is not widened. | `code-deepseek` on `pi-session-mcp-w2` |
| S9-3 #135 | Record on the issue that the fail-closed part shipped in #138; close it or narrow it to override copying (maintainer decision D4). | controller |

Gate per task: tests for each new path, `npm run typecheck`, `npm test` and
one cross-family review. Level 1 and the release procedure run once, for the
whole branch (see "Delivery").

## Sprint 10: controller reliability

Goal: make the controller skill measurable and close the report and early-stop
gaps (K1, K2, K4, K6 and the system-prompt probe).

1. **S10-0 system-prompt probe.** A provider-free probe (faux provider, like
   the registration probe) that records the system prompt a worker session
   actually receives. If the placeholder replaces Pi's default, plan an A/B
   with a short worker-context addition; otherwise record the result and stop.
2. **S10-1 K1 baseline.** `eval/controller-skill/` with a plugin wrapper and
   mocks for the six pi-session-mcp tools. Six cases: parallel starts before
   the first wait, terminal turn read once, start error code without retry,
   every session closed, worker claim "tests green" checked by the controller
   (`tool_used` on Bash with `input_match`), early-stop mock. Graders without a
   judge, `--runs 3`. Stop rule: if scores vary between runs, sharpen the
   graders before measuring anything else.
3. **S10-2 skill change (K2, K4, K6).** One change to
   `pi-session-orchestration` and the two worker skills: exact status tokens
   `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED`; the controller
   checks the report format before verification; the early-stop rule with the
   container-writer correction above; routing defaults with their evidence
   level. Plus build and test commands in `AGENTS.md`.
4. **S10-3 measurement.** The suite before and after. Then, only with an
   approved budget (D2), `npm run eval:profiles` on the three implementation
   tasks of the ablation, three runs each. Metrics: accepted runs, caught early
   stops, cost per accepted run, or "unknown" where usage is missing.
5. **S10-4 writer rollout check.** The skills ship in the package. Container
   writers see the new worker skills only after the upgrade and a
   `--repo … --apply`; verify that once after the release.

K5 runs as process on every Sprint 10 task: review by `review-glm` for code by
`code` or `code-deepseek`, by `review` for code by `code-glm`; rounds 1–3 as a
follow-up in the same session, rounds 4–5 in a fresh session with a stronger
coding profile, then a recorded decision. Record per task: findings only the
review found, rounds, cost or "unknown".

## Sprint 11: ledger, gates and wake gaps

Entry: decision D1 and the Sprint 10 results.

- K3 and K9 in the form D1 chooses. Test: one session with three running
  tasks, then a manual `/compact`. Pass: no task is sent again, the ledger
  matches `git log` and the collected refs, no turn ends without verification.
  Stop if the hook context does not arrive after compaction.
- K8: hook timeout at least the task budget, a wake after
  `PostToolUseFailure`, and one L4 pair with a turn of several minutes (live
  approval required).
- K7: provider-free probe in the style of the L3 probe under `eval/bridge/`:
  does `pi_session_list` in the main context see a subagent's sessions, and
  does the wake reach the subagent? Stop if either answer is no.
- K5 written into the controller skill with the Sprint 10 numbers.

Hooks are Claude Code only. Codex keeps polling and the in-context ledger; the
skill must say so.

## Parallel track: migration

Sprint 8 steps 2–7 continue after 0.11.6, one repository at a time with the
existing gates and rollback. They need the operator (images, rootless Podman
on the server) and can run alongside Sprint 10, which touches only skills,
`eval/` and documentation. Each migrated repository is also a live check of
the Sprint 10 skill.

## Orchestration

The controller (Claude Code, Opus) plans, writes briefs, integrates, verifies
and owns Git, releases and every operator step.

| Work | Route |
| --- | --- |
| Product code with a clear plan | Container writers via `pi-coding-pi-session-mcp-w1`/`-w2`: `code-deepseek` for fully specified mechanical tasks, `code` where judgement is needed; never two writers on overlapping files |
| Cross-family review | Host alias `pi-session-mcp`, read-only: `review-glm` or `review` (see K5); `explore-fast` for cheap lookups |
| Bulk work: eval cases and mocks, long transcript reads with a digest | agy, `gemini-3.8-flash-high`; no secrets or filled environment files |
| Gates and long logs | Claude `runner` subagent |
| Final diff review before the pull request | Claude `reviewer` subagent |
| Skill and documentation text | the controller itself (small, judgement-heavy) |

Rules for every run:

- Preflight: `git worktree list`, `git status` per worktree, writer state; a
  writer that is not clean on the base stays blocked.
- Each brief carries goal, base commit, change area, checks and the exact
  report fields (K2 already applies to the briefs before it ships in the
  skill).
- Worker and agy results are unverified until the controller has read the
  collected diff and run the gates itself.
- Finish each writer task with `--writer <name> --collect --apply`, review,
  integrate, `--finish --apply`, then reconnect the writer servers (`/mcp`)
  until S9-1 ships.
- Do not plan xAI or Cursor routes until the operator restores them.

## Delivery

All of this plan travels on one branch, `feat/orchestration-reliability`, and
one pull request, with one commit per issue or task. No separate pull requests
for documentation or single fixes. The pull request opens once the planned
work on the branch is complete and verified, so that CI runs on the final
state; it is not edited or pushed again while CI runs unless that is required.

It carries one patch release (0.11.6, MCP contract unchanged) with its version
change and pre-release acceptance, per the release procedure: Level 1 except
the known #120 finding, a final independent review of the whole diff, then
merge, tag and publication as maintainer decisions. Sprint 11 items join the
same branch only if D1 and the live approvals arrive before the Sprint 10 work
is verified; otherwise they wait for the next consolidated branch.

## Maintainer decisions

| Id | Question | Recommendation |
| --- | --- | --- |
| D1 | K3/K9: ship the ledger and its hooks in the package (opt-in, installed by setup like the wake hook), or keep them as a documented operator hook outside the package? | Start outside the package; move it in only if the Sprint 11 test passes. |
| D2 | Live budget for S10-3 (3 tasks × 3 runs × 2 arms) | Set a cap before S10-3 starts. |
| D3 | K11: open an ADR for a worker result channel? | Not before the Sprint 10 numbers show that K2 is not enough. |
| D4 | #135: close, or keep open for override copying? | Close and open a separate proposal issue if wanted. |
