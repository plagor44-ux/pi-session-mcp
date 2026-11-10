# Multi-session skill acceptance on `main` `93980d9` and on `v0.20.0` (2026-11-10)

Targeted runs of the
[multi-session skill acceptance](../../acceptance.md#multi-session-skill-acceptance)
with real clients, from 22:55 to 23:18 UTC. They follow Part 3 of the
[execution plan](../../superpowers/plans/2026-11-10-level3-live-acceptance.md).
They are not a [Level 3](../../acceptance.md#level-3-live-two-client-acceptance)
cycle and add nothing to the gate of the
[cycle of the same day](../level3-2026-11-10/README.md).

Two targets ran, for a reason that the plan names: the `main` commit ships a
controller skill that differs from the copies in the operator's home, and the
harness refuses a Codex run in that state. The copies were not changed. Codex
therefore ran on the published `v0.20.0`, whose skill equals those copies, and
Claude Code ran on both targets.

## Setup

- Harness: `scripts/multi-session-acceptance.mjs` of each target, SHA-256
  `bb1620ad94f97a68b73806bee846a9f65daae32b18f8ec8ecab7245b6c080c31` in both.
  Only the `acceptance` verdict that it computes counts.
- Target B: the clone and build of the cycle of the same day, commit
  `93980d93c4b748ada38b8137fedca547aa293150` with Pi SDK `1.5.2`, clean, no
  tag. SHA-256 of `dist/main.js`:
  `362286248e2b59c3b90058533427f89d3168983584c4e9fdeecd2c5f9a5ab336`. The
  harness's digest over `dist/` is
  `f200521c4ac8679c37f6e10acd4c44a3f5f603297fa4d2a24a9178969911d416`.
- Target A: a fresh clone of the annotated tag `v0.20.0` (tag object
  `4884c13b6092732301b39e82907d217cf5718f68`), commit
  `727d8ac8df5a7bbbf20c0744c74458ca97877b56` with Pi SDK `1.5.0`, clean, built
  with `npm ci`, `npm run build` and `npm run build:cli`. Their logs show no
  error; their exit statuses were not recorded. `dist/main.js` has the same
  SHA-256 as for target B, because that file is byte-identical in both
  builds. The harness's digest over `dist/` is
  `372826e51a12f0a707c18c1ae17fbda52a998a8027106f27ba050f25e6ba0c00`. Level 1
  was not run on this clone.
- Release binding of target A. It was taken after the runs, not before the
  first one as the plan asks; the clone was still clean then, and the
  harness's digest over `dist/`, computed again, was the one bound at
  `prepare`. `npm pack --ignore-scripts` in the clone, with npm `10.9.9`, gave
  a tarball with the shasum `9f9e8f7f99fc139bb022c8b73b6cc0ae2dc14cea`. The
  registry serves `0.20.0` with the shasum
  `e08a0b300afc9b658bf05afccc3b5ea9c1f5fedb`. The two archives differ, and
  their 1065 entries have the same paths, modes and contents. The runs used
  the clone's build, not an installed package.
- Host: Linux (`x64`), Node.js `22.23.3`.
- Configuration: `prepare --from-profile` copied provider, model and thinking
  level of one operator `coding` profile, `deepseek` `deepseek-flash` with
  thinking `high`, into the three run profiles, one `read-only` and two
  `coding`. No extensions. The ten fixture workspaces had no execution mode
  set, and event delivery was off. Every prepared run had the configuration
  fingerprint
  `sha256:8b2372698a599f9a7226f836ba6f23f91090d7931f09c2b123ff31e4ffe2819e`.
- Clients, started as the harness starts them: Claude Code `2.1.322`, with the
  model `claude-sonnet-5-5` selected through the client's model environment
  variable because the harness passes none; Codex CLI `0.166.0` with its
  default model, which its JSON output does not report. Each client got the
  server from the harness for that run only: Claude Code through a run-scoped
  MCP configuration with `--strict-mcp-config`, Codex through `-c` options
  with `--ignore-user-config`.
- Controller skill: for Claude Code installed by the target's own setup in the
  controller's directory (`applied`, `skill_installed`, a regular copy equal to
  the shipped skill); for Codex a run-scoped link. Tree digest
  `a465e06afd649737addafad3e12f30a6dbeb9ba5088fca56d586b5e04df88194` for
  target B and
  `c58d34b04a53be54dacb34da6330e7e25a77b50d012d26f5a50cd1947a44b6bf` for
  target A. Both copies in the operator's home have the digest of target A.
- Prepared runs: B-1 (`parallel`, `abort`) and B-2 (`trio`) on target B; A-1
  (`parallel`, `abort`), A-2 (`trio`) and A-3 (the two Codex scenarios that
  got no clean run on A-1) on target A. Each scheduled pair of client and
  scenario was attempted once per prepared run. Four Codex attempts were
  refused before launch: all three on target B and `abort` on A-1.

Skill precedence with Claude Code `2.1.322`, checked on B-1 before its first
scenario: a session in the prepared controller directory, started with the
harness's `--setting-sources project,local`, loaded `pi-session-orchestration`
from the project copy. The skill's base directory was the project's, and the
loaded text held a reference that only the skill of target B has. The check
used the differing installed pair, not a separate marker skill. In the three
scenario runs on target B the skill was loaded from the project copy as well.

## Results

Target B, `main` commit `93980d9`:

| Client | Scenario | Result | Duration | First turns overlap |
| --- | --- | --- | --- | --- |
| Claude Code | `parallel` | passed | 55 s | 7.1 s |
| Claude Code | `abort` | passed | 88 s | 14.5 s |
| Claude Code | `trio` | passed | 94 s | 6.8 s |
| Codex | `parallel`, `abort`, `trio` | refused before launch | – | – |

The harness refused each Codex scenario because a `pi-session-orchestration`
skill in a Codex skill source (`homeAgentsSkills`, `codexAncestorSkills`)
differs from the candidate's. No launch was recorded.

Target A, `v0.20.0`:

| Client | Scenario | Prepared run | Result | Duration | First turns overlap |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `parallel` | A-1 | passed | 45 s | 6.2 s |
| Claude Code | `abort` | A-1 | passed | 91 s | 17.8 s |
| Claude Code | `trio` | A-2 | passed | 93 s | 7.7 s |
| Codex | `parallel` | A-1 | failed: `resourcesChanged` | 67 s | 7.6 s |
| Codex | `abort` | A-1 | refused before launch: `resourcesChanged` | – | – |
| Codex | `trio` | A-2 | failed: `neighborsNotRunningDuringAbort` | 102 s | 4.6 s |
| Codex | `parallel` | A-3 | passed | 69 s | 7.8 s |
| Codex | `abort` | A-3 | passed | 92 s | 18.0 s |

- Codex `parallel` on A-1: every scenario check held. Both first turns
  completed and overlapped, the follow-up completed, the fixture tests and the
  business checks passed, only allowed files changed, and the handshake was
  written during the follow-up. The verdict failed because the bound resource
  `codexHomeSkills` differed after the run: Codex rewrote its bundled skills in
  its home when it started, and the change time of that directory is the
  launch time. The state bound at `prepare` of A-1 differed from the one bound
  about nine minutes earlier for B-2; after Codex's start it was the earlier
  state again. What had changed the directory in between was not determined. The
  harness then refused `abort` on A-1.
- A-3 was prepared after that, with the rewritten bundled skills bound, and
  ran `parallel` and `abort` with Codex once each. It is a new attempt and
  does not replace the result of A-1.
- Codex `trio` on A-2: the abort returned `ok`, the aborted turn was seen
  `aborted` before its session was closed, `slug` completed and passed its
  tests, the `review` fixture was unchanged, and all three sessions were
  closed. The verdict failed on one criterion: the read-only review turn had
  ended 0.5 seconds before the aborted turn ended, so the abort did not lie
  inside the running intervals of both neighbours. The review turn ran for
  14.4 seconds, and Codex started the two coding turns 9.8 seconds after it.
  The scenario was not repeated. Claude Code failed the same criterion on an
  earlier release ([#74](https://github.com/plagor44-ux/pi-session-mcp/issues/74))
  and passed it here on both targets.

`pi_turn_get` calls per run: 4, 5 and 6 for Claude Code on target B; 3, 6 and
6 for Claude Code on target A; 3 and 7 for Codex on A-1 and A-2; 3 and 6 for
Codex on A-3.

Exit statuses: the harness's `run` command exited with 0 for all ten launched
runs, the two with a failed verdict included. Its exit status says that the
run finished; the verdict is in its result. In each of the ten the client
process exited with 0 and was not ended by the harness's time limit. The
refused Codex `abort` on A-1 exited with 2. For the three refused Codex
attempts on target B only the refusal was recorded, not the exit status.
`prepare` and `evidence` exited with 0 for A-1, A-2 and A-3; for B-1 and B-2
their exit statuses were not recorded.

## Independent checks

These are the harness's own checks, read from its results.

- Every launched run: the structural leak scan had 0 hits and
  `assistantText` 0 mentions, no process of the run remained, and no bound
  resource had changed before the launch. After the run no bound resource had
  changed, except `codexHomeSkills` in the Codex `parallel` run on A-1.
- Every launched run confirmed the candidate version and the configuration
  fingerprint through capabilities, called `pi_capabilities_get` first and
  closed every session it had started.
- The digests of the real Claude Code MCP registrations and of the Codex
  configuration were identical before the first and after the last run.
- Reported client cost: Claude Code USD 1.13 on target B, USD 1.05 on target A
  and USD 0.18 for the precedence check. Codex reports token counts only.

## What this shows and what it does not

- The same build, fixtures and profiles for both clients exist only on
  `v0.20.0`. There both clients passed `parallel` and `abort`, Codex on the
  further prepared run A-3, and `trio` passed with Claude Code and failed with
  Codex on one timing criterion.
- On the `main` commit only Claude Code ran. Codex stays untested there with
  this harness until the copies in the operator's home equal the candidate's
  skill, which a release and an upgrade bring about, or until the maintainer
  approves changing them for a run.
- One run per client, scenario and prepared run, with workers on one model. A
  pass says nothing about how often a controller passes, and the `trio`
  timing criterion depends on the pace of the controller and of the review
  model.

Not covered: extensions, container workspaces, macOS, and anything the
[cycle](../level3-2026-11-10/README.md) and the
[wake check](../wake-2026-11-10/README.md) of the same day cover.
