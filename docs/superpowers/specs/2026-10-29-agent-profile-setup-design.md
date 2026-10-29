# Agent-driven execution-profile setup — design

Date: 2026-10-29. Status: approved by the operator on 2026-10-29, including
the designer's calls listed under "Designer's calls after the builder check".
Tracking: [#139](https://github.com/plagor44-ux/pi-session-mcp/issues/139).

## Intent

Execution profiles are worked out by hand today: provider, model, thinking
level, skills, extensions, MCP grants, the sandbox shell, and which coding
profiles a container repository selects. The last attempt to get help from an
agent happened in a chat that could not read the real configuration, and its
proposal used a wrong provider name and skill placements the writer boundary
refuses (#135).

The operator does not want a guided conversation. They want a controlling
agent (Claude Code or Codex) to take a request such as "add a review profile
with the sandbox shell" or "add a second provider to the coding profiles of
this repository" and carry it out **by itself, cleanly**, end to end. They
should not have to edit JSON or approve each step.

"Cleanly" means: the agent reads the real configuration (never credential
values), knows which providers and models exist instead of guessing, validates
a candidate before it touches the live file, proves every changed profile with
one real provider turn, brings affected container writers into the matching
state without losing work, and reports what it did with evidence.

## Decisions taken with the operator

- **The agent acts alone.** It does not stop for approval of the inventory,
  the candidate, the Doctor check, the backup and live write, one PONG probe
  per changed profile, or re-provisioning of writers that hold no work.
- **It stops and asks only when:**
  1. a writer it would remove or re-provision has uncollected work or a dirty
     clone;
  2. a check would cost money beyond one PONG probe per changed profile;
  3. a profile should be deleted while a container repository still selects it.
- **No operator-specific references in the product.** The shipped skill,
  its examples, tests and docs never name the operator's hosts, machines,
  repositories, profile aliases, models or internal services. The skill works
  on the machine it runs on. Anything beyond that (other machines, the
  operator's own routing notes or profile tables) belongs to the operator's
  own agent instructions; the skill only says: if your operator's
  instructions require further steps, follow them.
- **The product gets its own probe command.** The running MCP server reads
  its configuration once at start, and a controller cannot reconnect its own
  MCP server, so the agent cannot prove a changed profile through its own
  `pi_session_start`. A setup command that runs one fixed PONG turn per
  profile, outside any controller, closes that gap. Rejected: stopping for a
  manual reconnect (breaks "alone"), and spawning a nested headless controller
  (a detour through a second agent).
- **The product gets an offline model catalog.** The agent must be able to
  pick a new provider or model by itself without guessing ids, which was the
  #135 failure. Setup lists the providers and models Pi knows, and the probe's
  dry run checks provider and model offline. Rejected: the operator naming
  every new provider and model.

## Goals

1. `pi-session-mcp-setup --list-models` lists, offline, the providers and
   model ids Pi knows on this machine and whether each provider has
   configured authentication (yes or no, never a value).
2. `pi-session-mcp-setup --probe-profile <alias>[,<alias>…]` checks the named
   profiles offline in its dry run and proves them with one real provider
   turn each with `--apply`.
3. A shipped controller skill `pi-session-profiles` that lets an agent create,
   change or retire execution profiles and the profile selection of container
   repositories, following the decisions above.
4. Setup installs the new skill next to `pi-session-orchestration` for every
   client target, with the same ownership, update, verify and remove
   behaviour.

## Non-goals

- No interactive wizard, TUI or new MCP tool.
- No new configuration-writing command. The agent edits the main JSON
  configuration with its own file tools. `execution-modes.json` stays owned
  by the existing `--repo` mode requests; the agent never edits it by hand.
- No multi-machine behaviour, synchronisation or remote access.
- No systematic quality comparison of profiles. `npm run eval:profiles`
  stays the tool for that; the skill may point to it, never runs it.
- No live reload of a running server's configuration.
- No change to `--verify` or Doctor: both stay provider-free.

## Anti-goals (a failure even if it technically works)

- A credential value, token, filled environment file, absolute path or
  complete prompt in any report, log line, skill example or conversation
  output.
- Lost writer work: a writer removed or reset while it holds uncollected
  commits or a dirty clone.
- A live configuration that Doctor rejects, or one written without a backup
  of the previous file.
- A profile that the agent reports as working without a passed probe.
- Operator-specific names anywhere in tracked files.

## Part A: model catalog and probe command

Both read Pi's model registry through `ModelRuntime` from the package root
(`getProviders`, `getModels`, `getModel`, `checkAuth`), created
without network access to model endpoints and without refreshing
credentials. That access sits behind a small injectable interface, like the
session adapter, so tests use a fake and need no credentials. The ADR records
this as a second, narrow use of `ModelRuntime` next to the one approved for
the writer wrapper (#142).

### `--list-models`

- Offline and read-only; no provider call, no setup lock.
- Reports each provider id Pi knows, whether it has configured
  authentication (`true`/`false`), and its model ids. Optionally the
  model's reasoning support if the SDK exposes it on the model object; no
  prices, no endpoints, no credential source.
- Providers that only an extension registers (for example through a Pi
  extension package) are not listed; the report says so in one fixed note.
  A profile using such a provider is checked by the probe's start instead.
- `--json` gives the same report as JSON.

### `--probe-profile`

Interface:

- Without `--apply` it is a dry run: it loads the configuration from
  `PI_SESSION_MCP_CONFIG`, and for each alias checks offline that the
  profile exists, that its provider and model are in the catalog, and that
  the provider has configured authentication. No provider call.
- With `--apply` it runs the same offline checks, then the probes, one
  profile after another.
- `--json` gives the sanitized JSON projection, as for every setup command.
- Not combinable with `--target`, `--repo`, `--writer`, `--customize-skill`,
  `--list-models`, `--verify`, `--rollback` or `--remove`.
- Pointing `PI_SESSION_MCP_CONFIG` at a candidate file lets the agent check
  and probe a candidate before it goes live.

Doctor gate (with and without `--apply`): Doctor runs offline on the same
configuration first. The request is refused (`doctor_failed`, exit 1) only
by errors that make the configuration unusable as a whole (configuration
missing, unreadable or invalid, build or version problems) or by errors whose
subject is one of the probed profiles. Errors about other profiles,
workspaces or writers, and all warnings, do not block; the report lists that
they exist by check id.

What one probe does:

- Creates a private, empty temporary directory (mode 0700) as the session's
  working directory, and removes it afterwards. It is not a workspace alias
  and is never taken from an argument; it exists so that no profile,
  including a coding profile, can touch a real repository during a probe.
  This is a deliberate, narrow exception to "workspaces only through
  configured aliases" (that rule is about client-supplied tool arguments);
  the ADR records it.
- Starts one session through the real `PiSessionAdapter`
  (`SdkPiSessionAdapter`) with the profile resolved exactly as the server
  would resolve it, so provider, model, thinking level, local authentication,
  extensions, external MCP servers, the sandbox shell and selected skills all
  pass through their normal start checks.
- Sends one fixed prompt that asks for exactly `PONG`. The prompt is not
  configurable.
- Passes when the turn completes and the reply, trimmed, is `PONG`. The reply
  text itself is never printed.
- Closes the session within a bounded cleanup deadline.
- Turn events are off; nothing is written to the event spool.

Findings, one per profile, with the profile alias as subject and, for runs,
a duration in milliseconds:

| Code | Status | Meaning |
| --- | --- | --- |
| `probe_planned` | planned | Dry run: offline checks passed |
| `probe_profile_unknown` | failed | Alias not in the configuration |
| `probe_provider_unknown` | failed | Provider not in the catalog (offline) |
| `probe_model_unknown` | failed | Model not in the provider's catalog (offline) |
| `probe_auth_missing` | failed | Provider has no configured authentication (offline) |
| `probe_passed` | ok | Session started, reply was `PONG` |
| `probe_unexpected_reply` | failed | Turn completed with another reply |
| `probe_turn_failed` | failed | Turn failed or was aborted |
| `probe_start_failed` | failed | Session creation refused; carries the existing sanitized `PiSessionCreationErrorCode` |
| `probe_timeout` | failed | Start or turn deadline passed; the session was aborted and disposed |

- A profile that fails an offline check is not started. Every other named
  profile is still probed.
- Exit 0 only if every profile passed; exit 1 otherwise.
- Only `probe_passed`, `probe_unexpected_reply`, `probe_turn_failed` and a
  `probe_timeout` after the turn began mean a provider turn was sent. The
  report marks this per profile (`providerTurn: true|false`), so the skill
  can count its budget.
- Provider usage and money cost are reported as `unknown` unless the adapter
  can read them through a documented package-root export.

Container repositories: the probe runs on the host with the host's Pi agent
directory. It proves the profile itself. Whether a container writer accepts
the profile stays with Doctor's `container_profile_refused` check and with
writer provisioning; the probe does not run inside a writer.

Platforms: `--list-models` and probes are not mutations and do not need the
setup lock. They run on Linux and macOS. A profile whose start checks are
platform-bound (the sandbox shell needs bubblewrap) fails there with its
normal start code.

Boundary records: a new ADR records the provider-using operation (opt-in
through `--apply`, fixed prompt, no reply text in output), the offline
catalog access through `ModelRuntime`, that `--verify` and Doctor stay
provider-free, and the temporary-directory exception. `AGENTS.md` gets the
matching rule lines.

## Part B: the `pi-session-profiles` controller skill

A new directory `skills/pi-session-profiles/` beside the existing skills,
written in English, generic, without operator-specific names. Its
description triggers when an operator asks the controlling agent to create,
change, tune, rename or retire an execution profile, or to change which
profiles a container repository selects. It is for the controlling agent,
never for a Pi worker.

The skill points to the product docs for the rules instead of restating them.
They ship in the installed package's `docs/` directory (found through the
package root, as `docs/skills.md` describes for skills) and are also on the
project's public repository.

Steps:

1. **Find the configuration.** Use `PI_SESSION_MCP_CONFIG` from the
   environment. If it is unset, read the variable from the client's own
   registration of the `pi-session-mcp` server. If neither gives it, ask
   the operator. Never guess a path.
2. **Inventory.** Run Doctor (`--json`), `--list-models`, read the
   configuration file and `execution-modes.json`, and call
   `pi_capabilities_get` if the MCP server is connected. Never open Pi's
   credential or model files and never print environment values.
3. **Work out the change.** Translate the request into concrete profile
   entries and, for container repositories, the intended profile selection.
   Pick providers and models only from `--list-models` with configured
   authentication. Prefer the shape of an existing, working profile of the
   same kind. Ask the operator only when the request leaves open something
   that changes the result and that the catalog and existing profiles do not
   settle; otherwise decide and say so in the report.
4. **Build and check a candidate.** Write the candidate configuration beside
   the live file, in the same directory, under a name that cannot be
   mistaken for the live file, with the live file's mode. It then resolves
   relative paths, `execution-modes.json` and the skill override directory
   exactly as the live one does. Edit only the candidate. Run Doctor and
   `--probe-profile <changed>` (dry run) with `PI_SESSION_MCP_CONFIG`
   pointing at it. For container repositories whose selected profiles are
   affected, `container_profile_refused` must be absent. Fix and repeat.
5. **Probe the candidate.** `--probe-profile <changed> --apply` against the
   candidate. A failure without a provider turn (`providerTurn: false`) costs
   nothing: fix the candidate and probe again. Each changed or new profile
   gets at most one provider turn without asking; a second provider turn for
   the same profile is a stop for the operator.
6. **Prepare writers.** For each container repository whose selected
   profiles or settings change, determine every writer's state with the
   documented read-only means (Doctor's `writer_dirty` and
   `writer_uncollected_bundle`, a `--collect` dry run). If any writer has
   uncollected work or a dirty clone, stop and ask before anything goes
   live. Also stop and report on `writer_busy`, `podman_unavailable`,
   `registration_divergent` or any other refusal of a writer step. Writers
   that hold no work are removed with `--writer <name> --remove`.
7. **Go live.** Back up the live configuration as a timestamped copy beside
   it with the same file mode, then replace the live file atomically by
   renaming the candidate onto it. Run Doctor on the live configuration.
8. **Provision.** For each affected container repository, repeat the mode
   request with the full intended settings and `--apply`
   (`--repo <alias> --mode container --profiles … --apply`), which writes
   `execution-modes.json` and provisions the writers, then run the writer
   verification the docs name.
9. **Report.** The changed profile entries (aliases and field names, no
   secrets), Doctor results, probe results with usage or `unknown` and the
   number of provider turns, writer actions, and the backup's file name
   (relative to the configuration directory). State that running controllers
   see the change after their MCP server restarts or reconnects. If the
   operator's own agent instructions require further steps (for example
   other machines or their own routing notes), follow them.

Stop conditions are exactly the three listed under "Decisions taken with the
operator", plus a refused writer step in step 6 or 8, which the agent reports
instead of working around. Deleting a profile that no repository selects needs
no stop. Unrelated Doctor errors found in the inventory are reported, not
fixed.

## Part C: setup installs the skill

- `CONTROLLER_SKILLS` gains `pi-session-profiles`. Every client target then
  reports a second skill finding with the alias `pi-session-profiles`, with
  the same codes and the same rule that a skill problem never blocks the
  registration but a `divergent` or `failed` skill finding fails the run.
- Operator overrides and `--customize-skill` work for it the same way they do
  for `pi-session-orchestration`, as far as the existing mechanism is
  per-skill already.
- `docs/skills.md` and `docs/client-setup.md` describe both controller
  skills.

## Constraints

- Everything in `AGENTS.md`, in particular: stdout only for MCP frames in the
  server and sanitized reports in CLIs; no secrets, paths or complete prompts
  in reports; Pi only behind `PiSessionAdapter` (and the new catalog
  interface); tests use fakes and never need provider credentials; exact
  dependency pins; documented package exports only; English for all tracked
  documentation.
- One branch and one pull request for the whole change, with separate
  commits per issue; the pull request names every issue it covers.

## Designer's calls after the builder check

These were settled by the designer, not the operator; check them while
reading.

- `execution-modes.json` is never hand-edited; profile selection goes through
  the existing `--repo` mode request, after the live configuration changed.
- Writers that hold no work are removed before the live write, so the
  window in which writers and configuration disagree stays short, and a stop
  for uncollected work happens before anything is live.
- The candidate lives beside the live file, so relative paths resolve the
  same.
- The probe's Doctor gate blocks only on configuration-wide errors and errors
  about the probed profiles.
- Start refusals without a provider turn do not count against the probe
  budget; the agent may fix and re-probe.
- The agent never runs `--collect --apply` by itself, because it writes into
  the operator's checkout and turns a dirty clone into commits; a writer with
  work is a stop.
- The configuration path comes from the environment, then the client
  registration, then the operator.

## Left to the builder

- Exact deadlines for start, turn and cleanup of a probe.
- The exact PONG prompt wording and the reply comparison (case handling).
- Module layout, and how the new findings fit `SetupFinding`.
- Whether the probe and catalog get a separate issue next to #139.
- Wording, length and section structure of the skill, and any reference
  files it needs.
- Tests, including for the second controller skill in setup.
