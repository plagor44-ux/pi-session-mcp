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
| Source and build | a dedicated arm-A commit: the final harness with `skills/` and `src/server.ts` restored to `612fbcb` | Sprint 5 final head | Bound per arm by digest; both arms use the same harness |
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

- **P1, skill tree binding (implemented, not live-verified).** The controller
  skill digest covers the whole skill tree of `skills/pi-session-orchestration`
  (`SKILL.md` plus `references/start-errors.md`) via `readSkillTree`/`fingerprint`
  from `src/skill-library.ts`. In embedded delivery, the controller prompt contains
  the reference file content clearly delimited (`--- Reference: references/start-errors.md ---`),
  making start-error guidance available to the controller. Arm A's old tree has no
  reference file, so its prompt is the old `SKILL.md` alone.
- **P2, worker skill selection (implemented, not live-verified).** The manifest
  and decision template support optional explicit worker skills (`pi-session-implementation`
  for coding, `pi-session-review` for read-only) with tree digests. The executor
  verifies digests before starting and configures worker profiles; default remains
  "no worker skills" so existing pilot templates remain valid. The evaluation server
  runs from a compiled build without a shipped `skills/` directory, so selected
  skills are configured as the digest-verified source `SKILL.md` paths, not
  `builtin:` entries.
- **P3, client version (implemented, not live-verified).** The controller client
  version is bound from the approval/decision (`codex-cli 0.162.1` installed)
  instead of the hard constant `0.162.0`. The executor refuses to run
  (`controller_version_mismatch`) if the installed client version differs from the
  bound version. Historical records remain untouched.

P1–P3 are now implemented provider-free in the evaluation harness and verified by
unit tests; live execution remains unapproved (`approved: false`).

Arm A cannot run on `612fbcb` itself, because that commit lacks P1–P3. Before an
approval, create one arm-A commit from the final head that restores only `skills/`
and `src/server.ts` to `612fbcb`, and bind its source and build digests. Tree
digests measured on 2026-10-18:

| Skill tree | Arm A (`612fbcb` trees) | Arm B (Sprint 5 head) |
| --- | --- | --- |
| `pi-session-orchestration` | `v2:25494639…e250ab` | `v2:1d39e8ac…7cbdb2a` |
| `pi-session-review` | `v2:610c0b48…7952bf0` | `v2:30f0e1f8…6c1a4` |
| `pi-session-implementation` | `v2:f8ce75ef…94eb12` | `v2:d9487905…abbeab5` |

Full values are in [`ab-proposal.json`](ab-proposal.json).

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
