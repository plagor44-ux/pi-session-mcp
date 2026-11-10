# Level 3 live acceptance with Codex and Claude Code: execution plan

**Status:** plan only. Nothing in this plan has been run. Every step that uses a
real client, a provider, a budget or a persistent installation needs its own
maintainer approval before it starts.

**Issues:** [#277](https://github.com/plagor44-ux/pi-session-mcp/issues/277)
(Level 3 cycle) and, separately,
[#278](https://github.com/plagor44-ux/pi-session-mcp/issues/278) (provider
credentials against a real provider).

**Authority:** [Acceptance](../../acceptance.md), sections
[Level 3](../../acceptance.md#level-3-live-two-client-acceptance),
[Multi-session skill acceptance](../../acceptance.md#multi-session-skill-acceptance)
and [Evidence rules](../../acceptance.md#evidence-rules). The last cycle is
recorded in
[Level 3 cycle on v0.16.1](../../evaluation/level3-2026-11-02/README.md); this
plan reuses its method.

## Starting point

- The last full ten-task cycle ran on `0.16.1` with Pi SDK `1.5.0`. No cycle
  ran on `0.17.0` to `0.20.0`.
- The tag `v0.20.0` pins Pi SDK `1.5.0`. `main` has since moved to Pi SDK
  `1.5.2` as an unreleased change, and the changelog names the Level 3 run on
  `1.5.2` as open.
- The last cycle did not cover the Claude Code wake (event delivery was off),
  container workspaces or macOS.

## Three separate parts

A result of one part is never evidence for another, and no number of targeted
runs adds up to the gate.

| Part | What it is | Counts for the Level 3 gate |
| --- | --- | --- |
| 1. Ten-task cycle | Five tasks per client, six sequential invocations, event delivery off, both clients poll | Yes, it is the gate (#277) |
| 2. Claude Code wake | Event delivery `spool`, the wake hook installed by setup, an interactive or stream-json session | No, targeted |
| 3. Multi-session skill acceptance | `scripts/multi-session-acceptance.mjs`, scenarios `parallel`, `abort` and `trio` per client | No, targeted |

#278 is a fourth, independent check on a disposable installation; see
[Provider credentials](#provider-credentials-278).

## Decisions before preparation

The maintainer decides these; preparation does not start without them.

| Decision | Options | What the choice means |
| --- | --- | --- |
| Target under test | A: the published `v0.20.0` (tag clone). B: one candidate commit on `main` with Pi SDK `1.5.2` | A closes the gap for the version operators run today and says nothing about SDK `1.5.2`. B covers every change since `0.16.1` and the SDK update and can serve as pre-release evidence of the next version; `0.20.0` then stays without a cycle, and the README must keep saying so |
| Worker provider and model per profile, and a budget ceiling | Operator selection | The last cycle used a low-cost model for the read-only profile and another for the coding profile. The ten tasks are small; the ceiling bounds a runaway turn, not the expected cost |
| Client versions and the Claude Code model | The versions installed at execution | Recorded exactly; a client upgrade between preparation and execution invalidates the preparation |
| Parts 2 and 3 | With the cycle, later, or not at all | Each gets its own record and its own approval |
| Container workspace | None, as in the last cycle, or one extra targeted run | A container run is targeted evidence, not part of the ten tasks |

Recommendation: target B, taken after the pending changes are merged, as the
pre-release Level 3 of the next version. `0.20.0` is superseded by that
release, while SDK `1.5.2` would otherwise ship without a live cycle. Choose A
in addition only if the published `0.20.0` itself must be covered.

## Evidence binding

Record for every part, before the first task:

- source commit, the tag object if there is one, and whether the checkout is
  clean;
- SHA-256 of `dist/main.js` and, where the harness provides it, the digest over
  every built module in `dist/`;
- for a published target also the registry's tarball checksum and the checksum
  of `npm pack` from the tag clone;
- date and time in UTC, platform and architecture, Node.js version, Pi SDK
  version;
- both client versions, the client models where the client reports them, and
  how each client reached the server;
- per execution profile: permission profile, provider, model and thinking
  level;
- per workspace: its execution mode (`read-only`, `host` or `container`);
- event delivery (`off` or `spool`);
- digests of the plan, the oracles, the configurations, the fixtures and the
  harness.

A record that lacks one of these says so; it does not fill the field from
another run.

## Part 1: ten-task cycle (#277)

Preparation, provider-free:

1. Clone the target into a separate detached checkout. Run `npm ci`,
   `npm run build:cli` and `npm run build`, then the full
   [Level 1](../../acceptance.md#level-1-repository-checks) sequence. Level 1
   must be green; it is a gate criterion.
2. Write a temporary, credential-free configuration: six synthetic workspace
   aliases (an analysis, a coding and an abort fixture per client), one
   `read-only` and one `coding` profile, event delivery off. Offline Doctor
   must pass.
3. Prepare the harness of this cycle outside the repository: prompts, oracles,
   hidden tests, a stdio proxy that logs the JSON-RPC frames and copies a
   coding workspace before a session's second prompt is forwarded, the digest
   tool and the leak scan. The abort oracle is the documented state: a manual
   abort leaves `abortReason` absent.
4. Fix and digest the plan, the prompts, the oracles, the tools, the
   configurations and the fixtures. From here on nothing changes.
5. Record the digests of the existing client registrations. The cycle uses a
   per-invocation MCP configuration and changes no registration.

Execution, after approval of provider turns and client runs:

6. Preflight: `pi-session-mcp-setup --probe-profile <alias> --apply` for both
   profiles, then one capability-only connectivity check per client without a
   session. If one fails, record the cycle as blocked and start no turn.
7. Run six invocations strictly one after the other: Claude Code analysis with
   follow-up, coding with follow-up, abort with a fresh session; then the same
   three for Codex. Each client may wait a few seconds between `pi_turn_get`
   calls. No task is repeated.
8. Verify independently, as the guide lists: read-only invariance of each
   analysis fixture, the coding barrier with oracles on the snapshot, the scan
   of every tool result, process cleanup before and after each invocation, and
   the `pi_turn_get` count per turn.
9. Evaluate the nine gate criteria one by one. Eight of ten is the floor for
   task outcomes only; every scope, leak and cleanup criterion must hold on its
   own.
10. Compare the registration digests with step 5 and remove the temporary
    configuration, fixtures and checkout.

Stop and record as blocked or failed, without a retry in the same cycle, when
a fixture digest differs before an invocation, a server process of the run
remains, or the leak scan has a hit.

## Part 2: Claude Code wake (targeted)

A one-shot `claude -p` run polls, so the cycle of Part 1 cannot show the wake.
The wake needs event delivery `spool`, the `pi-session-mcp-wake` hook installed
by setup, and an interactive or stream-json Claude Code session.

- Install the hook only through the target's own
  `pi-session-mcp-setup --apply --target claude-code:project:pi-session-mcp` in
  a disposable project directory, with a disposable home for the setup step.
  A first `--apply` must report `hook_added`. Then run
  `pi-session-mcp-setup --verify --target claude-code:project:pi-session-mcp`
  with the same configuration and home; it must report `hook_verified`. No
  global registration or hook changes.
- Scenarios, as defined for the
  [Sprint 7 candidate](../../sprints/2026-10-24-s7-stabilization-live-acceptance.md):
  a turn ends while the controller waits and one result read follows, with no
  polling and no sleep loop; two sessions with different end times each wake
  the controller for the right turn; a budget wake causes exactly one status
  read and a re-arm; abort and close leave no wake for a removed session and no
  stray hook, server or worker process.
- Codex is checked for the opposite: it starts with delivery off and completes
  the same workflow by polling. No Codex wake is claimed.

Record the two clients separately. A wake result never replaces a task of
Part 1.

## Part 3: multi-session skill acceptance (targeted)

Two prepared runs, because the scenarios share fixtures. `parallel` uses the
fixtures `slug` and `stats`, `abort` uses `wait` and `range`, and `trio` uses
`slug`, `wait` and `review`. `run` refuses a scenario with `fixturesChanged`
when one of its fixtures differs from the baseline that `prepare` stored, and
a passed `parallel` has changed `slug`. So `parallel` and `abort` share one
prepared run, and `trio` gets a second one with untouched fixtures. Each
prepared run holds its own fixtures for both clients.

```bash
# Run A: parallel and abort
node scripts/multi-session-acceptance.mjs prepare --candidate <checkout> \
  --base-config <operator configuration> --from-profile <alias>
node scripts/multi-session-acceptance.mjs run --run <run directory A> \
  --client claude --scenario parallel   # then abort; then both with --client codex
node scripts/multi-session-acceptance.mjs evidence --run <run directory A> --out <file A>

# Run B: trio, on fixtures that no scenario has touched
node scripts/multi-session-acceptance.mjs prepare --candidate <checkout> \
  --base-config <operator configuration> --from-profile <alias>
node scripts/multi-session-acceptance.mjs run --run <run directory B> \
  --client claude --scenario trio       # then --client codex
node scripts/multi-session-acceptance.mjs evidence --run <run directory B> --out <file B>
```

- Both prepared runs use the same candidate checkout, client versions and
  profile. Keep both evidence files and both results; neither replaces the
  other. A scenario that `run` refuses is recorded as refused and is not
  repaired by resetting a fixture by hand.
- Linux only. The working directory must not lie in a temporary directory.
- `prepare` binds the build, the controller skill, the worker skills, the
  fixtures, the harness and the controller skill copies in the operator's
  home. `run` refuses a changed resource.
- A candidate whose `pi-session-orchestration` skill differs from the copies in
  the operator's home has a known precondition: a Codex run is refused while a
  home skill source holds a controller skill that differs from the
  candidate's. A target B taken after a change to that skill is merged is such
  a candidate. Either the operator updates or removes the home copies for the
  run, which is a change to the host and needs its own approval, or Part 3
  runs on a target whose skill equals the installed copies.
- For Claude Code, the precedence of the project skill over a differing home
  copy was observed with one client version. Re-check it with a marker skill
  on the client version of the run before relying on it.
- After a Codex upgrade, start Codex once before `prepare`; its bundled skills
  are bound and a later change invalidates the run.
- Each client and scenario runs once. Only the mechanically computed
  `acceptance` verdict counts, not the controller's report.

## Provider credentials (#278)

Independent of Parts 1 to 3 and never evidence for the gate.

- Use a disposable home, a disposable configuration and a synthetic workspace.
  Existing credentials and registrations stay untouched.
- Enter a dedicated, least-privilege test key only through
  `pi-session-mcp-provider auth set` on a terminal. The key never appears in an
  argument, a log, an issue, a fixture or a tracked file.
- Check one real-provider turn with a `key` source through the installed
  server. Exercise the guided key step only on an interactive terminal;
  otherwise record that subcheck as blocked. Container writers and
  operator-defined providers stay untested unless they can be exercised safely.
- Removal, agreed before the test: remove the stored key with
  `pi-session-mcp-provider auth remove`, delete the disposable home after the
  evidence is secured, and revoke the test key at the provider. Remove nothing
  that the test did not create.

## Record

- One new record per part and attempt, in the form of the `0.16.1` record:
  setup, results, independent checks, deviations from the pre-registration,
  the gate table and what was not covered.
- Follow the evidence rules: statuses, counts, durations, versions and
  digests only. No prompt, assistant response, transcript, session or turn
  identifier, credential, local path, endpoint address or raw provider error.
- Failed, blocked and partial attempts stay on record. A new attempt gets a
  new record.
- Change the README status only when the gate table supports it, and only for
  the exact version or commit that ran.

## Approvals this plan needs

- [ ] Target under test (A, B or both).
- [ ] Worker provider, models and budget ceiling.
- [ ] Real client runs for Part 1.
- [ ] Part 2 and Part 3, each separately.
- [ ] For Part 3 on target B: the change to the controller skill copies in the
      operator's home.
- [ ] #278: the disposable installation, the test key and its removal.
- [ ] Publishing each record through a pull request.

## Not covered by any part

macOS, the wake in the VS Code extension, interactive approval dialogs,
external MCP grants, client restart or resume, and model capability on larger
work.
