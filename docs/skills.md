# Pi skills in execution profiles

Status: decided in [ADR 0007](adr/0007-profile-skill-selection.md), issue
[#46](https://github.com/plagor44-ux/pi-session-mcp/issues/46).

A Pi skill is a `SKILL.md` file with instructions that Pi lists to the model in
its system prompt. The model may read the file when a task matches the skill's
description. Pi Session MCP lets the operator register skill files in a catalog
and select them per execution profile. MCP callers never choose skills.

## Configuration

Two optional parts of `pi-session-mcp.json`:

```json
{
  "workspaces": {
    "my-project": "/absolute/path/to/my-project"
  },
  "skillCatalog": {
    "pi-session-implementation": "/opt/pi-session-mcp/skills/pi-session-implementation/SKILL.md",
    "pi-session-review": "/opt/pi-session-mcp/skills/pi-session-review/SKILL.md",
    "release-notes": "skills-local/release-notes/SKILL.md"
  },
  "executionProfiles": {
    "safe-readonly": {
      "default": true,
      "permissionProfile": "read-only",
      "provider": "your-configured-provider",
      "model": "your-configured-model",
      "thinkingLevel": "medium",
      "skills": ["pi-session-review"]
    },
    "coding-worker": {
      "default": false,
      "permissionProfile": "coding",
      "provider": "your-configured-provider",
      "model": "your-configured-model",
      "thinkingLevel": "high",
      "skills": ["pi-session-implementation", "release-notes"]
    }
  }
}
```

### Catalog: `skillCatalog`

- An optional top-level object that maps a skill alias to the path of a
  `SKILL.md` file. A missing catalog is an empty catalog.
- At most 64 entries. An alias matches `^[a-z][a-z0-9_-]{0,63}$`, like every
  other alias.
- Each value names exactly one regular, readable file whose last path segment
  is `SKILL.md`. Directories, globs, URLs and scheme-prefixed sources
  (`npm:`, `git+…`, `https:`) are rejected. So are `~` and backslashes. A value
  has at most 4096 characters.
- A relative path resolves against the directory of the configuration file,
  like a workspace. It never resolves against a workspace or the shell's
  working directory. `~` is not expanded: write an absolute path.
- A skill folder needs no `package.json` and no extension. The file can live
  anywhere the server's OS user can read.
- The catalog alias is only the public handle. It may differ from the `name` in
  the skill's own frontmatter. Nothing is renamed.

### Selection: `executionProfiles.<alias>.skills`

- An optional list of catalog aliases, at most 16, no duplicates.
- Missing or empty means no skills for that profile. There is no inheritance
  between profiles and no default skill.
- All other profile fields and the rule that unknown fields are rejected are
  unchanged.

### Invalid configuration

These make the whole configuration invalid. The server does not start, and
Doctor reports `config_invalid`. Stderr shows the stable startup code
`invalid_execution_profile_config`:

- a selected alias that is not in the catalog;
- a duplicate alias in one profile's list;
- two selected aliases of one profile whose paths resolve to the same path;
- a catalog value that violates the rules above, or more than 64 entries;
- more than 16 selected aliases.

## What happens at session start

The server loads exactly the selected files through the Pi SDK's public
`loadSkills`, without any default directories, and validates them completely.
The SDK's skill override returns exactly that set, also after an extension adds
resources later (`resources_discover`). A profile without skills gets no
skills, whatever is installed on the machine or shipped by an extension.

The start fails with `skill_load_failed` (message `Configured Pi skill could
not be loaded`) if:

- a selected file is missing, unreadable, or larger than 256 KiB;
- the SDK reports the skill as invalid, for example a missing description or an
  invalid name;
- two selected files declare the same Pi skill name;
- two aliases point at the same canonical file, for example through a symlink;
- the skill sets `disable-model-invocation: true`.

The message is fixed. It never contains a path, a skill name or SDK text.
Stderr gets a structured diagnostic with the stage `skill_load` and the
catalog alias in a `skill` field, never a path.

Explicit-only skills (`disable-model-invocation: true`) are incompatible in
this version. Pi hides such skills from the model, and MCP prompts never run
`/skill:` commands, so the skill could never be used. The server does not
rewrite the flag. The same Pi skill name in different sessions is fine.

## Doctor boundary

Doctor stays offline and never parses or executes a skill. For each profile and
selected alias it adds three checks after the extension checks, with the
subject `<profile>:<skill-alias>`:

| ID | Condition |
| --- | --- |
| `skill_missing` | The selected file does not exist. |
| `skill_unreadable` | The path is not a regular file, is over 256 KiB, or cannot be read. |
| `skill_duplicate` | Two selected aliases of one profile resolve to the same canonical file. |

Frontmatter, name rules, name collisions and the explicit-only flag are checked
only at session start by the SDK contract. A clean Doctor run therefore does
not promise that the skill loads.

## Three states, and a fourth thing

Keep these apart:

1. **Configured.** `pi_capabilities_get` lists the alias under the profile's
   `skills`. This is configuration intent only. It says nothing about the file.
2. **Available in the SDK catalog.** The skill passed validation at session
   start and Pi lists it to the model in the system prompt.
3. **Actually read by the model.** The model decides to read the `SKILL.md`
   with its `read` tool. This is not guaranteed.

Task success is separate from all three. A skill that the model read can still
produce a bad result, and a task can succeed without the skill.

## Snapshot semantics

The profile and its skill selection are fixed per session. The skill content
is not snapshotted: the SDK keeps file paths, and the model's later reads may
see changed files. This also applies to companion files that a skill refers
to.

- Manage skill files and companion files as operator content. Do not change
  them while sessions that use them are active.
- Close the affected sessions before an update. New sessions then load the new
  content.
- The configuration fingerprint covers the configuration bytes, not skill
  contents.
- There is no hot reload, no watcher, no copy store and no versioning. A change
  to `skillCatalog` or `skills` needs a new server process like any other
  configuration change.

## Trust and limits

Skills are operator-managed prompt content. In a `coding` profile a skill's
instructions are executed with that profile's tools, so review a skill like
code. A skill grants no rights: the tools of the permission profile stay the
limit.

Skill selection limits the regular skill catalog only. An allowlisted
extension remains trusted executable code. It can still read files or inject
prompt text. This is not a sandbox.

No MCP tool and no tool argument takes a skill. `pi_session_start` and
`pi_session_prompt` are unchanged.

## Migration: profiles that relied on package skills

With Pi SDK 1.1.0, an allowlisted extension package's bundled skills reached
the session although `noSkills` was set. The same held for prompt
templates and themes that a package shipped. Now an extension allowlist alone
makes none of its skills available. Prompt templates and themes that packages
ship are closed as well, through the SDK's public overrides. They were never
expanded for MCP prompts. Profiles without extensions are not affected.

If a profile used a skill that a package shipped:

1. Find the package's `SKILL.md` inside Pi's install, normally
   `<Pi agent dir>/npm/node_modules/<package>/…`.
2. Add a catalog entry with the absolute path of that file. `~` is not
   expanded.
3. Select the alias in the profile's `skills`.
4. Run Doctor and start a session to confirm.

Keep in mind that a package update can move or change the file. The catalog
path then needs a check.

## Skills shipped with this package

The package ships three skills under `skills/`. Each has one canonical copy and
frontmatter with only `name` and `description`.

| Skill | For | Use |
| --- | --- | --- |
| `pi-session-implementation` | A Pi worker | One bounded implementation task and a fixed final report. Register it in the catalog and select it on coding profiles. |
| `pi-session-review` | A Pi worker | A review of a fixed target with findings and evidence. Register it and select it on read-only profiles. |
| `pi-session-orchestration` | The controlling Claude Code or Codex agent | How to run Pi worker sessions through this server. It is not a Pi worker skill and is not registered in `skillCatalog`. |

### Register the worker skills

The shipped example configuration already registers the two worker skills with
paths relative to the example file and selects them on its two profiles. After
you copy the file to its own location, those relative paths no longer point to
the package. Use absolute paths into the installation:

```json
"skillCatalog": {
  "pi-session-implementation": "/absolute/path/to/pi-session-mcp/skills/pi-session-implementation/SKILL.md",
  "pi-session-review": "/absolute/path/to/pi-session-mcp/skills/pi-session-review/SKILL.md"
}
```

For an npm installation the directory is `$(npm root -g)/pi-session-mcp`; write
the expanded absolute path, because the configuration does not expand `~` or
shell variables. Then select the aliases in the profiles that should use them:
`pi-session-implementation` on coding profiles, `pi-session-review` on
read-only ones. Run `pi-session-mcp-doctor` to check availability. If a copied
configuration keeps the relative example paths without a matching `skills/`
directory beside the file, Doctor reports `skill_missing` and the session start
fails with `skill_load_failed`.

A package update can change the shipped skills. Close affected sessions before
you update.

## Using the orchestration skill in Claude Code and Codex

<!-- client-install: filled by orchestrator after verifying client conventions -->
