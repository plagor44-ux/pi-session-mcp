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

## Decision

The operator may register skills in a catalog and select them per execution
profile.

- **Catalog.** An optional top-level `skillCatalog` maps a skill alias
  (`^[a-z][a-z0-9_-]{0,63}$`, at most 64 entries) to the path of exactly one
  `SKILL.md` (at most 4096 characters). Directories, globs, URLs,
  scheme-prefixed sources, `~` and backslashes are invalid. Relative paths
  resolve against the configuration file's directory. A missing catalog is
  empty. A skill folder needs no `package.json` and no extension.
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
  explicit-only flags are checked only at session start.
- **Diagnostics.** Stderr gets the new stage `skill_load` and an optional
  `skill` field with the catalog alias, never a path.
- **Snapshot semantics.** Profile and skill selection are fixed per session.
  The content is not snapshotted: the SDK keeps file paths and later reads may
  see changed files. Operators manage skill files and companion files, do not
  change them during active sessions, and close affected sessions before an
  update. The configuration fingerprint covers configuration bytes, not skill
  contents. There is no hot reload, watcher, copy store or versioning.
- **Shipped skills.** The package ships `pi-session-orchestration`,
  `pi-session-implementation` and `pi-session-review` under `skills/`, one
  canonical copy each. They are ordinary skill files. The two worker skills are
  registered through the catalog like any operator skill. The orchestration
  skill is for the controlling client agent and is not a Pi worker skill.

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
- The server needs a name check of its own for selected files, because
  `loadSkills` dedupes by name before `skillsOverride`.
- Sessions of profiles with extensions each have their own model runtime
  (ADR 0006). Skill loading does not change that.

## Versioning

ADR 0003 requires a minor release for a public contract change. The new
`skills` capability field and the new `skill_load_failed` error code are such a
change, so the next release after 0.7.1 is 0.8.0. The change is recorded under
`## Unreleased` in the changelog. Implementing it does not itself release or
bump the version.
