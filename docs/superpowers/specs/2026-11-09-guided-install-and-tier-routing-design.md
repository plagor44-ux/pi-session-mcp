# Guided installation and tier-based routing

Status: design, approved by the owner on 2026-11-09. Date: 2026-11-09. Base: `main` at `b3f6e33` (0.19.1), Pi SDK 1.5.0.

## Why

Setting up Pi Session MCP today takes many separate steps: install, write a
configuration by hand, choose profiles, register clients, add the wake hook,
provision writers. Routing, meaning which model gets which job, exists only as
private operator notes and a private script. Those notes go stale as models and
prices change, and nothing learns from the sessions the history already records.

The goal has two parts that build on each other:

1. One command leaves a machine with a clean, verified installation, for any
   user and any set of providers.
2. Routing is an optional part of that installation. It is organized in tiers,
   and it improves over time from the session history.

## Relation to earlier decisions

- The 2026-10-29 agent profile setup design ruled out an interactive wizard and
  a configuration-writing command. The owner now asks for an interactive
  installer, and this design replaces those two non-goals. Its agent-driven path
  through the `pi-session-profiles` skill stays, and so does its rule to probe a
  candidate before it goes live.
- `AGENTS.md` names the session history as the only persistent store. Routing
  data lives in that store, so the rule stays true. ADR 0019 is amended by a new
  ADR for the added tables.
- The 2026-10-29 design also excluded prices, and `AGENTS.md` forbids widening
  the offline catalog exception. The owner approved one narrow addition on
  2026-11-09: the catalog may also expose each model's output price, offline,
  and only the guided setup uses it, for a tier proposal the user confirms.
  `AGENTS.md` records this as maintainer-approved.

## Goals

- A single script that a user runs once. A second run at the same version changes
  nothing.
- It works without the maintainer's providers, models or services.
- It clarifies which providers are authenticated, which profiles result, and
  which routing applies, and installs the hooks that go with it.
- A guide that lets a coding agent perform the same installation.
- Routing is optional. With routing off, sessions behave exactly as today.
- Routing is organized in four tiers: `ultra`, `hightech`, `medium`, `low`.
- Learning only changes the order of profiles within a tier.
- A switch selects self-adjusting or manually confirmed routing.

## Non-goals

- A Claude Code plugin as the install path. Plugin-provided tools are named
  `mcp__plugin_<plugin>_<server>__<tool>`, which would break the wake hook
  matcher and existing permission rules, and a plugin does not cover Codex,
  provider login or writer provisioning.
- Upgrades through `install.sh` or the guided setup. The first version covers a
  fresh install and a re-run at the same version. An older installation stops
  with `upgrade_required` and a pointer to the documented upgrade steps.
- Moving a model between tiers automatically.
- Hooks on the Claude Code `Agent` tool, or any rule about whether work should
  be delegated at all.
- Automatic retention of session content.
- Sending history content to workers or other models.
- Setting an output token cap (issue #262 is separate).

## Anti-goals

The work has failed, even if it functions, when any of these is true:

- A learning step sends a hard task to a weaker tier.
- A review requested through routing comes from the author's family without the
  explicit override.
- The installer overwrites a registration or a settings entry it does not own.
- The installer asks for, prints or stores a provider credential.
- Routing refuses a session that named an explicit profile, or an existing
  controller stops working when routing is turned on.
- Routing behaviour depends on a noisy handful of sessions.

## Part 1: guided installation

### Entry points

- `install.sh`, shipped with the release: checks the platform and Node.js
  version, installs one exact package version from npm, then runs the guided
  setup with `--apply`.
- `pi-session-mcp-setup --guided`: dry run by default, like every setup
  operation; prints the plan. `--guided --apply` carries it out.
- `--guided --answers <file>`: the same flow without prompts, for agents and
  non-interactive shells. Without a terminal and without an answers file the
  command fails with `usage_invalid` rather than guessing.

The configuration path defaults to
`~/.config/pi-session-mcp/pi-session-mcp.json`. `--config <path>` overrides it
for the guided mode only, and the registered path is the one chosen here.

### Flow

Each step reuses existing setup code rather than reimplementing it.

1. **Prerequisites.** Platform, Node.js, the checks Doctor already runs; report
   optional features that are unavailable (Podman for writers, bubblewrap for
   the sandbox shell).
2. **Providers.** Use the offline catalog behind `--list-models` to show which
   providers are authenticated. For a missing provider, print how to log in with
   the Pi binary from the package's own dependency tree, as a shell expression
   so the output stays path-free, and let the user re-check. With an answers file, stop with
   `provider_login_required` when a required provider is missing. The guided
   setup never reads or accepts a credential.
3. **Profiles.** For each tier, propose at most one `code` and one `review`
   profile per authenticated family, and one `explore` profile for `low`. At most
   four profiles per tier and role. Thinking level: `code` medium, `review` high,
   `explore` low. The proposed tier follows the output price per million tokens
   in the offline catalog: `ultra` from 30 USD, `hightech` from 3.5 USD, `medium`
   from 1.5 USD, `low` below that. A model without a known price gets no proposal.
   The user confirms or changes every assignment. Prices are not stored and never
   affect selection at run time. Warn when a tier has fewer than two families,
   because the review rule then needs the override.
4. **Workspaces.** Ask for repositories and their mode (`read-only`, `host` or
   `container`), using the existing mode provisioning.
5. **History.** Ask whether to enable the history, and say that it stores
   redacted session content locally.
6. **Routing.** Ask for `off`, `manual` or `auto`. Choosing `auto` requires the
   history, and the prompt says so.
7. **Candidate and probe.** Write a candidate configuration beside the live one
   and validate it with Doctor. State the number of provider turns, then run one
   fixed `PONG` probe per new profile through `--probe-profile --apply` against
   the candidate. A profile that fails is removed from the candidate and reported.
8. **Go live.** Back up the live file and replace it atomically.
9. **Clients.** Register Claude Code and Codex where present, with the existing
   ownership rules and controller skills. When Claude Code is selected, set
   `events.delivery: "spool"` and install the wake hook.
10. **Finish.** Run Doctor and `--verify`, and print what was done and what the
    user still has to do, such as reconnecting running clients.

### Existing configurations

The guided setup merges. It never regenerates a configuration, so extensions,
MCP grants, skill catalogs and other fields stay as they are. It only adds
profiles and blocks. Existing profiles are left unchanged. The user sees the
difference and confirms it. With an answers file a change to an existing file
requires `allowConfigChange: true`, otherwise the run fails.

### Approvals without a terminal

An answers file may approve probes and configuration changes, because the agent
acts for the owner as it does under the `pi-session-profiles` skill. Host writes
need the existing explicit `acceptHostWrites`, and the agent guide says only the
owner may give it.

### Rules

Existing setup rules hold: explicit `--apply`, no auto-replacement of divergent
registrations, ownership records, sanitized output.

### Agent guide

`docs/agent-install.md` tells a coding agent how to install: which commands to
run, how to build an answers file, when to stop and ask (missing login, an
existing configuration, a divergent registration, spending on probes, host
writes), and how to report the outcome.

## Part 2: tier routing

### Storage

- `routing.json`, next to the configuration, owned by the operator: `mode`, the
  assignment of profile aliases to tiers, each profile's family, floors and
  learning limits. Learning never writes this file. Like the configuration, the
  server reads it once at startup, so a change needs a client reconnect.
- New tables in the history store hold the routing decisions, per-cell outcomes,
  the current order, suspensions and version history. Metadata only: tier, role,
  risk, profile, family, turn outcomes, cost and verdict. No prompts, paths,
  workspace aliases or task labels. The tables have no foreign key to `sessions`,
  so `prune` does not remove them, and they keep at most the latest 200 outcomes
  per cell.

`auto` requires the history. `manual` works without it, as static selection from
`routing.json` with no proposals. A history failure never blocks a session:
selection then uses the order in `routing.json`.

Assigning a tier does not change a profile, so writers need no new provisioning.

### The switch

`mode` is `off`, `manual` or `auto`, set in the guided setup or with
`pi-session-mcp-routing mode <value>`.

| Mode | Behaviour |
| --- | --- |
| `off` | Default without opt-in. `tier` arguments are refused with `routing_off`. Nothing is recorded. |
| `manual` | Selection follows the tiers. Learning, when the history is on, produces proposals only; `pi-session-mcp-routing apply <id>` applies one. No exploration. |
| `auto` | Selection follows the tiers. Learning applies changes itself, within one tier, recorded and reversible. Default when the user opts in. |

### Session start

`pi_session_start` gains optional arguments: `tier`, `role` (`code`, `review`,
`explore`), `risk` (`normal`, `high`), `shell` (boolean, requires a sandboxed
profile), `authorFamily` and `allowSameFamily`. `tier` and `executionProfile` are
mutually exclusive.

The result gains `routing: { tier, role, profile, reason, exploration }` when
routing selected the profile. `pi_capabilities_get` always gains a `routing`
block with `mode`, and when routing is on the tiers and each profile's family,
from the startup snapshot. The current order is not published: the server
applies it, and the result names the profile. This is an additive public contract
change: minor release, schema updates, and setup's verifier accepts the new block.

An explicit `executionProfile` stays valid in every mode and is never refused by
routing. It is recorded as explicit. If the caller also passes `role` and the
profile is in a tier, it counts toward that cell. `status` shows how often
controllers bypass routing.

### Who decides the tier: hybrid

A rule sets a floor, and the controller may go higher.

- The server does not see the prompt at start, so the rule uses role, declared
  risk and workspace.
- Floors, defaults: `code` `medium`, `review` `medium`, `explore` `low`,
  `risk: high` `hightech`. A workspace may raise its floor.
- `tier` omitted: use the floor.
- `tier` above the floor: allowed and recorded as raised.
- `tier` below the floor: refused with `routing_tier_below_floor`.
- The controller skill states what counts as high risk: security, isolation,
  boundaries, migrations, irreversible changes.

### Choosing a profile

1. Candidates are the profiles assigned to the tier that fit the role (`code`
   needs coding; `review` and `explore` need read-only), the workspace mode (a
   container workspace only offers its selected profiles, a snapshot workspace
   only profiles it admits), and `shell` if requested.
2. Remove suspended profiles and, for `review`, profiles of `authorFamily`.
3. Take the first candidate in the current order.
4. No candidate: refuse with `routing_no_candidate`, or `routing_same_family` when
   only the family rule removed them. A start never moves to another tier, with
   one exception: a `review` whose tier has no other family may use the next
   lower tier if that tier is not below the floor. The result says so.

A `role: review` start through a tier must carry `authorFamily` or
`allowSameFamily: true`, else it is refused with `routing_author_required`. The
override is recorded. It exists for users with a single family.

Families are stored per profile in `routing.json`. The guided setup proposes them
from the model name and the user confirms, so no pattern table is consulted at
run time. A family is a lowercase label, and `authorFamily` is compared to these
labels. The controller skill tells a controller which label to pass for its own
work.

A start error such as missing authentication is returned as today. Routing does
not try the next candidate within a call.

### Learning

Learning needs no daemon. A refresh runs at most once per 24 hours, started after
a `pi_session_start` has returned, bounded in time, and it never delays a session.
`pi-session-mcp-routing refresh` runs it by hand. It joins history rows on the
session id inside the server process and stores derived rows. It is not an MCP
tool that queries history, which ADR 0019 rejects, because nothing is exposed to
a client.

Two kinds of signal:

- **Hard signal.** A profile is suspended for 24 hours when at least 3 distinct
  sessions among its last 10 had a failed turn. Deadline stops and aborts do not
  count, since they can reflect the task. The last candidate of a cell is never
  suspended. `auto` applies this. `manual` turns it into a proposal.
- **Quality** comes from controller verdicts: `accepted` counts 1, `reworked`
  0.5, `rejected` 0. `accepted` means the result was used without correction, for
  every role. If a session has several verdicts the latest counts. Sessions closed
  without a turn are ignored.

Order within one tier and role cell:

- A profile with fewer than `minSamples` verdicts in the cell keeps its place.
  Default 8.
- Compare by the Wilson lower bound of the score.
- Move a profile above another only if its bound exceeds the other's by
  `margin` (default 0.1). Otherwise the cheaper median session cost goes first.
- At most one change per cell per refresh.

**Exploration.** In `auto` only, `explorationRate` (default 0.1) of starts in a
cell go to another candidate. Never with `risk: high`, never across tiers, and
stopped when `explorationBudgetUsd` (default 5 per week) is used or cost is
unknown.

**Reversal.** Every applied change is a numbered version with its reason.
`pi-session-mcp-routing rollback` restores the previous order and freezes that
cell until `pi-session-mcp-routing unfreeze`.

Expect slow learning. Small cells may take weeks to reach `minSamples`, and until
then only the hard signal acts. The status command must make this visible.

### Enforcement

The server enforces floors, families and candidates for starts that use `tier`,
so Claude Code and Codex behave alike and no extra client hook is needed for
routing. The installer only installs the existing wake hook.

### Commands

`pi-session-mcp-routing` with `status`, `mode`, `proposals`, `apply`, `rollback`,
`unfreeze` and `refresh`. Output follows the CLI rule: sanitized, no paths or
prompts.

### Data needed from controllers

Verdicts drive quality, but only about half of the sessions in a real history had
one. The controller skill must require a verdict for each session it finishes,
and `status` reports the coverage.

## Constraints

- Node.js 22.19 or newer, strict TypeScript, ESM, exact dependency pins.
- MCP stdout stays exclusive to frames. Doctor stays offline.
- Pi stays behind `PiSessionAdapter`; tests use fakes and no provider credentials.
- Public documents contain no operator-specific hosts, services or paths.
- A new ADR records the routing decision and amends ADR 0019.

## Verification

- Provider-free unit tests for tier resolution, floors, family rule, candidate
  filters, suspension, ranking with thresholds, exploration budget and rollback,
  including negative cases.
- Contract tests showing that an explicit profile works in every mode and that
  sessions and results are unchanged with routing off.
- A guided run with an answers file in a temporary home, a second run that reports
  no changes, and a run against a foreign registration that refuses.
- A failed probe that leaves the live configuration untouched.
- A replayed fixture history that proves no reordering below `minSamples`.
- `npm run typecheck`, `npm run build`, `npm test`.

## Left to the builder

- Module layout, the schema of `routing.json`, the tables and the answers file.
- The exact wording and order of prompts.
- The refresh deadline and the exact Doctor check names.
- How `install.sh` is shipped and verified.

## Calls made by the author of this design

These were not decided by the owner and can be changed:

- Server-side selection and enforcement instead of client hooks.
- `auto` as the default after opt-in, with exploration on.
- Routing data inside the history store; `auto` requires the history.
- An explicit profile is never refused, so controllers can bypass routing.
- `routing.json` is read at startup, so switching the mode needs a reconnect.
- Floors, `minSamples`, `margin`, exploration rate and budget, the suspension rule
  and the verdict weights.
- The review fallback to the next lower tier, and the `allowSameFamily` override.
- The profile proposal rule, its price thresholds, and the merge-only handling of
  existing files.

## Owner decisions

Taken on 2026-11-09, on the author's recommendation:

- `install.sh` and the guided setup do not perform upgrades in the first version.
- The setup may read output prices from the offline catalog for its tier proposal.
