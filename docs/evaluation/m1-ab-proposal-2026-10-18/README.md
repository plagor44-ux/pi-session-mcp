# M1 A/B proposal (#93): not approved, nothing runs

Date: 2026-10-18. This is a proposal for the operator. It authorizes no model
use: [`ab-proposal.json`](ab-proposal.json) has `approved: false`, a null
advisory amount and no unmetered-cost acknowledgment. The 10 USD advisory of the
[M1 pilot](../token-footprint-2026-10-17/m1-pilot/README.md) applied to that
pilot only and is not reused. A new approval is needed for the finished,
concrete matrix below; preparing it does not block other work.

## Design

Reuse the existing M1 fixtures (T1, T2), oracles, `--footprint-live` executor and
its approval gate. No second benchmark platform.

- Matrix per repetition: the full L1/L2/L3 set of the pilot (one read; one T2
  repair; two reads plus one follow-up with the labelled invariance re-fetch).
- Three paired repetitions, each pair one baseline arm (A) and one variant arm
  (B), in alternating order: pair 1 A then B, pair 2 B then A, pair 3 A then B.
- Arithmetic: 3 pairs × 2 arms = 6 matrix runs. Each run has 3 fresh controller
  invocations, 4 worker starts and 5 work turns. Total **18 fresh controller
  invocations, 24 worker starts, 30 work turns, 0 retries**.
- Order limitation: with three pairs, arm A runs first in two of them (run
  sequence A B B A A B). Drift, cache warming or throttling that favors the
  first position would therefore act on A more often; this is recorded as a
  known limitation of the prescribed three-pair design, not corrected.
- One executor run per matrix run, each with its own decision bound to that arm's
  source, build and skill digests, so the existing per-run limits (4 starts,
  5 turns, 3 invocations, 0 retries) stay unchanged.
- Primary route: the existing Codex M1 route (Codex controller, `openai` /
  `gpt-6.1-sol` / high; workers from `review` Sol high and `code` Sol medium over
  `openai-codex`). The same client version, models and efforts in both arms.
- Claude Code is a separate later plan that depends on #89 and its own approval.
  No result of this A/B is generalized to Claude Code or to other routes.

## Arms and factors

| Factor | Arm A (baseline) | Arm B (variant) | Rule |
| --- | --- | --- | --- |
| Source and build | main `612fbcb` | Sprint 5 final head | Bound per arm by digest |
| Controller skill (#86) | old tree | new tree (`SKILL.md` + `references/start-errors.md`) | Tree digest, not `SKILL.md` alone |
| Tool descriptions and input schemas (#88, #90) | old | new | Part of the source binding |
| Worker skills (#87) | old trees, explicitly selected | new trees, explicitly selected | Only with prerequisite P2; otherwise #87 is reported as **not tested** |
| Skill delivery | embedded in the controller prompt | embedded in the controller prompt | Constant in both arms; embedded vs installed is a separate factor and must not change between A and B |
| Client, models, effort, fixtures, prompts | identical | identical | Bound by digest and version per run |

Because arm B changes several things at once, the result is reported as **one
package effect**. No separate effect per measure (#86, #87, #88, #90) is
claimed. A single-factor comparison would need a dedicated source commit per
factor and its own approval.

## Prerequisites before an approval can be bound

- **P1, skill tree binding.** The executor hashes and embeds only `SKILL.md`
  (`eval/profiles/token-live.ts`, `eval/profiles/token-footprint-plan.ts`). With
  the new reference file, arm B must bind the whole tree digest and make the
  reference available to the controller, or record that start-error guidance is
  absent in embedded mode.
- **P2, worker skill selection.** The pilot's evaluation workers select no
  skills. Comparing #87 needs both arms to select the worker skills explicitly,
  old immutable trees in A and new trees in B.
- **P3, client version.** The pilot and the provider-free projection probe pin
  Codex `0.162.0`; this machine now has `0.162.1`
  ([tool-definition evidence](../tool-definitions-2026-10-18/README.md)). The
  approval must name the version actually installed, the same for all six runs;
  a version change during the wave stops it.

P1–P3 are harness changes for a later, separately reviewed step. None is
implemented in Sprint 5.

## Measurements, kept separate

Per case, arm and pair: cumulative controller input tokens, cached subset, output
and reasoning tokens as the client reports them (no bytes-to-tokens conversion,
no net-of-cache or money figure); controller tool calls by tool; `pi_turn_get`
split into running polls, first terminal reads, avoidable repeated terminal reads
and labelled invariance re-fetches (the L3 re-fetch is counted separately, never
as waste); controller runtime; worker final-answer bytes and `truncated`;
independent acceptance per case; cleanup (sessions closed, server exit, process
table). Worker usage stays unknown unless a public source exists (see
[#92 note](../s5-decision-inputs-2026-10-18/worker-usage.md)).

## Minimum evidence, negative cases and stop rules (fixed in advance)

- Every case in both arms needs its independent oracle: T1 source claims and an
  unchanged fixture; T2 fails before and passes after with only `contract.mjs`
  changed; L3 invariance of the original turn.
- Before the live wave, rerun the existing provider-free M0 controls on both arm
  sources, including the adverse-report controls (failed checks and blockers
  must survive).
- Stop the wave, preserve every attempt and do not retry within the approval on:
  any gate or harness failure; a failed cleanup (open session, residual process,
  server exit other than 0); a scope violation; a provider, quota or
  authentication error; a time limit; client or route drift.
- Report all attempts, including failed and stopped ones. No success rate, saving
  or ranking is predicted or derived beyond the observed client and route.

## Approval still needed from the operator

1. Approve or change this exact matrix, order, routes and limits.
2. A positive operator-selected advisory amount (not a cap, not a cost estimate),
   or keep it null and do not run.
3. Acknowledge that subscription usage is unmetered.
4. Accept P1–P3 as preconditions, or decide to run without P2 and report #87 as
   not tested.
