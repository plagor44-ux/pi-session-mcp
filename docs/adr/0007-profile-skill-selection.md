# ADR 0007: Execution profiles select Pi skills from an operator catalog

**Status:** Accepted (2026-10-12). Issue #46. Guide: [Pi skills in execution
profiles](../skills.md).

## Context

Embedded sessions are meant to run without skills. A controlling agent that
delegates work to Pi workers needs a way to give a worker role-specific
instructions, such as an implementation or review procedure, under the same
rule as everything else: the operator decides, the MCP caller picks aliases.

Verified behavior of Pi SDK 1.1.0:

- `noSkills` does not stop skills that an allowlisted extension package
  ships. Those skills reached the session although `noSkills` was set. The
  same held for prompt templates and themes that packages ship. ADR 0006 did
  not intend this and did not decide it.
- `loadSkills` removes duplicate skill names before the SDK's `skillsOverride`
  runs. An override alone therefore cannot report a collision between two
  selected files, so the server has to check names itself.
- Resources that extension hooks add later (`resources_discover`) pass through
  the same override.

ADR 0003 chose maintenance without a new feature phase and reserves public
contract changes for a minor release with their own decision. ADR 0006 is the
precedent for an owner-approved scope expansion. This ADR is such a decision
for issue #46. It does not rewrite ADR 0006; that ADR records only a forward
link.

On 2026-10-12 the owner rejected installing the shipped skills by manual
symlinking and asked for skills that can be installed at install time and
adjusted and extended one by one. The decisions under "Skill library,
installation and customization" below record that, in the same change.

## Decision

The operator may register skills in a catalog and select them per execution
profile.

- **Catalog.** An optional top-level `skillCatalog` maps a skill alias
  (`^[a-z][a-z0-9_-]{0,63}$`, at most 64 entries) to the path of exactly one
  `SKILL.md` (at most 4096 characters). Directories, globs, URLs,
  scheme-prefixed sources, `~` and backslashes are invalid. The one accepted
  scheme is `builtin:<name>` (see below). Relative paths resolve against the
  configuration file's directory. A missing catalog is empty. A skill folder
  needs no `package.json` and no extension.
- **Selection.** An optional `executionProfiles.<alias>.skills` lists catalog
  aliases (at most 16, no duplicates). Missing or empty means no skills. There
  is no inheritance and no default skill. An unknown alias, a duplicate alias,
  or two selected aliases that resolve to the same path is
  `invalid_execution_profile_config`. All other profile fields are unchanged
  and unknown fields are still rejected.
- **MCP surface.** Callers still choose only workspace and profile aliases.
  `pi_session_start` and `pi_session_prompt` get no skill input. No tool is
  added.
- **Loading.** At session start the server loads exactly the selected files
  through the SDK's public `loadSkills`, with no default directories, and
  validates them completely. `skillsOverride` returns exactly that set, also
  after later resource additions by extension hooks.
- **Failure.** A missing, unreadable or oversized (over 256 KiB) file, an
  invalid skill (SDK diagnostics such as a missing description or invalid
  name), two selected files with the same Pi skill name, two aliases on the
  same canonical file (for example through a symlink), or
  `disable-model-invocation: true` fail the start with the new error
  `skill_load_failed` and the fixed message `Configured Pi skill could not be
  loaded`. The message never contains a path, a skill name or SDK text. The
  same Pi skill name in different sessions is fine.
- **Explicit-only skills are incompatible in v1.** MCP prompts never run
  `/skill:` commands, and Pi hides such skills from the model. The server does
  not rewrite the flag.
- **Names.** The catalog alias may differ from the skill's declared `name`.
  Nothing is renamed.
- **Capabilities.** Every execution profile in `pi_capabilities_get` gains
  `skills: string[]`, the selected catalog aliases in configured order, `[]`
  when none. No paths, file names, contents or SDK diagnostics. The setup
  verifier accepts the field and still rejects unexpected fields.
- **Doctor.** Offline, it never parses or executes a skill. New check IDs after
  the extension checks, with the subject `<profile>:<skill-alias>`:
  `skill_missing`, `skill_unreadable` (not a regular file, over 256 KiB, or not
  readable) and `skill_duplicate`. Frontmatter, name rules, collisions and
  explicit-only flags are checked only at session start. A further warning
  check, `skill_override_outdated`, is described below.
- **Diagnostics.** Stderr gets the new stage `skill_load` for a selected file
  that fails validation, with an optional `skill` field holding the catalog
  alias. A catalog that differs from the selection after construction reports
  the existing stages `postcheck`, `extension_load` or `extension_bind`. No
  diagnostic carries a path.
- **Snapshot semantics.** Profile and skill selection are fixed per session.
  The content is not snapshotted: the SDK keeps file paths and later reads may
  see changed files. Operators manage skill files and companion files, do not
  change them during active sessions, and close affected sessions before an
  update. The configuration fingerprint covers configuration bytes, not skill
  contents. There is no hot reload, watcher, copy store for sessions or
  versioning.
- **Shipped skills.** The package ships `pi-session-orchestration`,
  `pi-session-implementation` and `pi-session-review` under `skills/`, one
  canonical copy each. They are ordinary skill files. The two worker skills are
  registered through the catalog like any operator skill, by `builtin:`. The
  orchestration skill is for the controlling client agent and is not a Pi
  worker skill.

## Skill library, installation and customization

Owner decision of 2026-10-12, same issue. The first design of this change had
the operator register shipped skills by absolute path and link the
orchestration skill into the clients by hand; the owner rejected that. Three
decisions were taken:
installation through `pi-session-mcp-setup --apply`, an override directory for
customization, and `builtin:` references in the Pi skill catalog.

- **Skill library.** Shipped skills live in the package's `skills/` directory.
  The operator's override directory is `skills/` next to the configuration file
  (for the default configuration `~/.config/pi-session-mcp/skills/<name>/SKILL.md`).
  An override with the same name replaces the shipped skill; a new name adds a
  skill. Names follow the Agent Skills rule: lowercase letters and digits in
  hyphen-separated groups, 1 to 64 characters. Nothing else is searched.
- **`builtin:<name>`.** A `skillCatalog` value resolves to the override if
  `<override dir>/<name>/SKILL.md` exists, else to the shipped skill. A missing
  skill keeps the shipped location, so Doctor reports `skill_missing` and the
  session start fails with `skill_load_failed`. Resolution happens when the
  server loads the configuration: adding or removing an override needs a
  restart, like any configuration change. Edits to an existing skill file reach
  new sessions under the snapshot semantics above. The example configuration
  uses `builtin:pi-session-implementation` and `builtin:pi-session-review`, so a
  copied example needs no path edits.
- **Customization.** `pi-session-mcp-setup --customize-skill <name>` (a
  dry-run) and `--apply --customize-skill <name>` copy a shipped skill into the
  override directory as a starting point and record the shipped fingerprint in
  `<override dir>/.pi-session-mcp-bases.json`. An existing override is never
  overwritten. When the shipped skill changed after the copy, or no base is
  recorded, the command reports `skill_override_outdated`; `--apply` then moves
  only the recorded base (`skill_base_updated`) and never touches the
  operator's files, which is how an operator acknowledges a reviewed change.
  The finding target is `{ client: "skills", scope: "override", alias: <name> }`.
  It works without `--target`, requires `PI_SESSION_MCP_CONFIG`, and follows
  the platform rule of setup. A completely new skill needs no command: create
  `<override dir>/<new-name>/SKILL.md` and reference it as `builtin:<new-name>`.
- **Installation of the controller skill.** `setup --apply` installs
  `pi-session-orchestration` for each target, after the registration, as a real
  copy of the effective skill (override, else shipped). Codex `codex:user` goes
  to `~/.agents/skills/`, Claude Code `user` and `local` share
  `~/.claude/skills/`, and Claude Code `project` goes to
  `<project>/.claude/skills/`, the directory setup runs in. Ownership records
  hold only a content fingerprint and, while an update is pending, the
  fingerprint it replaces; a project record is bound to an opaque project
  identity, never a path. Setup never replaces or deletes a modified installed
  copy, hidden operator entries inside it, a foreign skill of the same name or a
  linked or non-directory entry; it reports `skill_divergent`, which does not
  block the registration. A link to exactly the effective skill is the
  operator's own equivalent setup (`skill_linked`) and is never owned. In the home directory the client's skills
  directory may be the operator's own link and is followed. Inside a project,
  which may be untrusted, any link below the project root makes the slot
  divergent, so setup never writes outside the project. Setup installs only
  `pi-session-orchestration` into clients; the worker skills are for Pi
  profiles through `builtin:`, and controller skills of the operator's own
  belong in the clients' native skill directories. The operator customizes the
  controller skill through the override and runs `--apply` again, and never
  edits the installed copy.
- **Doctor.** The warning check `skill_override_outdated` has the subject
  `skill:<name>` when a shipped skill's current fingerprint differs from the
  recorded base, with a remediation that names the customize command. A
  corrupt bases file reports the subject `skill:bases`. Doctor stays offline
  and executes nothing.
- **Fallback.** Where setup does not run, the operator copies the controller
  skill directory into the client's documented skill directory. There is no
  symlink instruction.

## Compatibility change

Previously, with Pi SDK 1.1.0, an allowlisted extension package's bundled
skills, prompt templates and themes reached the session although `noSkills`
was set. Now an extension allowlist alone makes none of its skills available.
A skill is available only through the catalog plus the profile's explicit
selection.

Migration: add a catalog entry with the absolute path to the package's
`SKILL.md` inside Pi's install (normally under
`<Pi agent dir>/npm/node_modules/<package>/…`; `~` is not expanded) and select
it in the profile. Prompt templates and themes that packages ship are now also
closed through the SDK's public overrides. They were already never expanded
for MCP prompts. This does not mean every previous profile behaves unchanged:
a profile that used a package's skills needs the migration above.

## Consequences

- Skills are operator-managed prompt content. In `coding` profiles a skill's
  instructions are executed with the profile's tools. A skill grants no rights.
- Skill selection limits the regular skill catalog only. An allowlisted
  extension stays trusted executable code and can still read files or inject
  prompt text. This is no sandbox.
- Three states stay distinct: configured (capabilities list the alias; intent
  only), available in the SDK catalog (validated at session start and listed
  to the model in its system prompt), and actually read by the model (the model
  decides; not guaranteed). Task success is separate again.
- Skill files can change under a running session. Operators carry that
  discipline; the server does not enforce it.
- Setup now writes into client skill directories, in the home directory and in
  a project. It copies only from the package or the operator's override
  directory, never follows a link inside a project, and never replaces what it
  did not install or what the operator modified. The override directory and its
  bases file are operator-trusted configuration, not a workspace. Installed
  skill content becomes instructions for the controlling agent.
- The server needs a name check of its own for selected files, because
  `loadSkills` dedupes by name before `skillsOverride`.
- Sessions of profiles with extensions each have their own model runtime
  (ADR 0006). Skill loading does not change that.

## Versioning

ADR 0003 requires a minor release for a public contract change. The new
`skills` capability field and the new `skill_load_failed` error code are such a
change, and so are the new setup findings, the `--customize-skill` option and
the controller skill that `setup --apply` installs, so the next release after
0.7.1 is 0.8.0. The change is recorded under
`## Unreleased` in the changelog. Implementing it does not itself release or
bump the version.
