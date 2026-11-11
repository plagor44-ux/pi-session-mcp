# Multi-session skill acceptance with Codex on `v0.20.1` (2026-11-11)

Targeted runs of the
[multi-session skill acceptance](../../acceptance.md#multi-session-skill-acceptance)
with a real Codex controller and real workers, from 09:03 to 09:11 UTC. They
are not a [Level 3](../../acceptance.md#level-3-live-two-client-acceptance)
cycle and add nothing to that gate.

They close one gap of the
[record of 2026-11-10](../multi-session-2026-11-10/README.md). There the
harness refused Codex on the `main` commit `93980d9`, because the controller
skill copies in the operator's home differed from the candidate's. The upgrade
of that installation to `0.20.1` replaced the copies with the shipped skill,
so Codex could run on the release. Claude Code was not run again: it passed
all three scenarios on `93980d9`, with the same harness, the same controller
skill and a build whose `dist/` has the same digest.

## Setup

- Pre-registration: a local note, written before the first `prepare`, SHA-256
  `3f3371c6f8aebeda165ae5176a9e5be2e4536930fd0b8c26830e24f8e9543a46`. It fixed
  the target, the configuration, the three scenarios with one attempt each,
  the harness's verdict as the only one that counts, and one exception: if a
  scenario is refused before launch or fails only with `resourcesChanged` on
  `codexHomeSkills`, as on 2026-11-10, one further prepared run attempts the
  affected scenarios once, and both attempts are reported.
- Harness: `scripts/multi-session-acceptance.mjs` of the target, SHA-256
  `bb1620ad94f97a68b73806bee846a9f65daae32b18f8ec8ecab7245b6c080c31`, the same
  as on 2026-11-10. Only the `acceptance` verdict that it computes counts.
- Target: a fresh clone of the annotated tag `v0.20.1` (tag object
  `962d98af0d86249e4d1a0a67010c724e19d6469e`), commit
  `a8c1d5dc6c6db602d3a631e79eeb58271675fd94` with Pi SDK `1.5.2`, clean, built
  with `npm ci`, `npm run build` and `npm run build:cli`, each exiting with
  `0`. SHA-256 of `dist/main.js`:
  `362286248e2b59c3b90058533427f89d3168983584c4e9fdeecd2c5f9a5ab336`. The
  harness's digest over `dist/` is
  `f200521c4ac8679c37f6e10acd4c44a3f5f603297fa4d2a24a9178969911d416`. Both
  equal the values of the `93980d9` build in the record of 2026-11-10, and
  `skills/` and the harness script do not differ between `93980d9` and the
  tag. Level 1 was not run on this clone. On another fresh clone of the tag
  the commands that CI runs passed, without `npm audit` and
  `git diff --check`
  ([post-release evidence](../../acceptance.md#v0201-post-release-evidence));
  the complete Level 1 ran on the release candidate before the tag
  ([pre-release acceptance](../../acceptance.md#v0201-pre-release-acceptance)).
- Release binding: the registry serves `0.20.1` with the shasum
  `d1a88207486beeb5085daad58f5838292ac6562d`, staged from another fresh clone
  of the same tag. The runs used this clone's build, not an installed package.
- Host: Linux (`x64`), Node.js `22.23.3`.
- Configuration: `prepare --from-profile` copied provider, model and thinking
  level of one operator `coding` profile, `deepseek` `deepseek-flash` with
  thinking `high`, into the three run profiles, one `read-only` and two
  `coding`. No extensions. The ten fixture workspaces had no execution mode
  set, and event delivery was off. Every prepared run had the configuration
  fingerprint
  `sha256:8b2372698a599f9a7226f836ba6f23f91090d7931f09c2b123ff31e4ffe2819e`,
  the one of 2026-11-10.
- Client, started as the harness starts it: Codex CLI with its default model,
  which its JSON output does not report. `codex --version` printed `0.166.0`
  before the first `prepare`. The harness neither binds nor records the
  client's version; see the note on the Codex update under Results. The client
  got the server from the harness for that run only, through `-c` options with
  `--ignore-user-config`.
- Controller skill: a run-scoped link for Codex, tree digest
  `a465e06afd649737addafad3e12f30a6dbeb9ba5088fca56d586b5e04df88194`. The
  harness bound the same digest for both copies in the operator's home.
- Prepared runs: R-1 (`parallel`, `abort`), R-2 (`trio`) and R-3 (the two
  scenarios that got no clean run on R-1). Each scheduled scenario was
  attempted once per prepared run, strictly one after the other.

## Results

| Scenario | Prepared run | Result | Duration | First turns overlap |
| --- | --- | --- | --- | --- |
| `parallel` | R-1 | failed: `resourcesChanged` | 84 s | 6.5 s |
| `abort` | R-1 | refused before launch: `resourcesChanged` | – | – |
| `trio` | R-2 | passed | 116 s | 5.0 s |
| `parallel` | R-3 | passed | 95 s | 6.9 s |
| `abort` | R-3 | passed | 129 s | 17.9 s |

- `parallel` on R-1: every scenario check held. Both first turns completed and
  overlapped, the follow-up completed, the fixture tests and the business
  checks passed, only allowed files changed, and the handshake was written
  during the follow-up. The verdict failed because the bound resource
  `codexHomeSkills` differed after the run: Codex rewrote its bundled skills in
  its home 0.2 seconds after the harness launched it. The harness then refused
  `abort` on R-1. The same sequence occurred on 2026-11-10 on `v0.20.0`. The
  three later launches of this record did not change that directory.
- R-3 was prepared after R-2, with the rewritten bundled skills bound, and ran
  `parallel` and `abort` once each. It is the one further prepared run that
  the pre-registration allowed for this cause. It is a new attempt and does
  not replace the result of R-1.
- `trio` on R-2: the abort returned `ok` and lay inside the running intervals
  of both neighbours, the aborted turn was seen `aborted` before its session
  was closed, `slug` completed and passed its tests, the `review` fixture was
  unchanged, and all three sessions were closed. On `v0.20.0` Codex had failed
  this scenario on the neighbour criterion.

`pi_turn_get` calls per run: 3 for `parallel` on R-1, 8 for `trio`, and 3 and
5 for `parallel` and `abort` on R-3.

The Codex installation changed during the last run. About 12 seconds after the
harness launched the client for `abort` on R-3, the lock file of Codex's own
updater in the operator's home was written, and about 5 seconds later the
installation's active release switched from `0.166.0` to `0.167.1`. All four
launches preceded that switch, so each launched process started from the
`0.166.0` release. This follows from the launch times and the file times of
the installation, not from a version that a run reported. Which process
started the update was not observed. The harness does not bind the client
binary, so its verdicts do not reflect the change, and a later Codex run on
that host uses `0.167.1`.

Exit statuses: `prepare` and `evidence` exited with `0` for all three prepared
runs. The harness's `run` command exited with `0` for the four launched runs,
the one with a failed verdict included; its exit status says that the run
finished, and the verdict is in its result. In each of the four the client
process exited with `0` and was not ended by the harness's time limit. The
refused `abort` on R-1 exited with `2`.

## Independent checks

These are the harness's own checks, read from its results.

- Every launched run: the structural leak scan had 0 hits, no process of the
  run remained, and no bound resource had changed before the launch. After the
  run no bound resource had changed, except `codexHomeSkills` in `parallel` on
  R-1.
- `assistantText` mentions: 0 in three runs and 1 in `parallel` on R-3, where
  the worker's report named the absolute path of its own `HANDSHAKE.txt`.
  `assistantText` is the worker's free text, counted separately, and not a
  structural leak.
- Every launched run confirmed the candidate version and the configuration
  fingerprint through capabilities, called `pi_capabilities_get` first and
  closed every session it had started.
- The digests of the real Claude Code MCP registrations and of the Codex
  configuration were identical before the first `prepare` and after the last
  run.
- Cost: Codex reports token counts only, and the cost of the worker turns was
  not read.

## What this shows and what it does not

- With the controller skill that `0.20.1` ships, a Codex controller passed
  each of the three scenarios once on the release build: `trio` in its first
  attempt, `parallel` and `abort` on the further prepared run.
- The first `parallel` attempt failed on a bound resource that Codex itself
  changed at its start, not on a scenario check. This has now happened on the
  first Codex run of this harness on both days. Whether a Codex start before
  `prepare` avoids it was not tested.
- Codex failed the `trio` neighbour criterion on `v0.20.0` and passed it here.
  The two releases differ in the Pi SDK and in the controller skill, and each
  result is a single run, so this record does not attribute the difference.
  The criterion depends on the pace of the controller and of the review
  model.
- One run per scenario and prepared run, with workers on one model. A pass
  says nothing about how often a controller passes.
- The results hold for Codex CLI `0.166.0`, a version inferred for each run
  and not reported by it. The installation updated itself to `0.167.1` during
  the last run, and no scenario ran with that version.
- Claude Code did not run on the release.

Not covered: extensions, container workspaces, macOS, the server host, the
Claude Code wake, and a Level 3 cycle.
