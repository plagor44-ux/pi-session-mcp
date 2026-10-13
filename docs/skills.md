# Pi skills in execution profiles

Status: decided in [ADR 0007](adr/0007-profile-skill-selection.md), issue
[#46](https://github.com/plagor44-ux/pi-session-mcp/issues/46).

A Pi skill is a `SKILL.md` file with instructions that Pi lists to the model in
its system prompt. The model may read the file when a task matches the skill's
description. Pi Session MCP lets the operator register skill files in a catalog
and select them per execution profile. MCP callers never choose skills.

The package ships three skills and keeps them in a skill library together with
the operator's own overrides. `pi-session-mcp-setup --apply` also installs the
controller skill into Claude Code and Codex. Nothing needs to be linked by hand.
Sections: [Configuration](#configuration), [The skill library](#the-skill-library),
[Customize and add skills](#customize-and-add-skills), [Install the
orchestration skill into Codex and Claude Code](#install-the-orchestration-skill-into-codex-and-claude-code)
and [Upgrade from 0.8.0](#upgrade-from-080).

## Configuration

Two optional parts of `pi-session-mcp.json`:

```json
{
  "workspaces": {
    "my-project": "/absolute/path/to/my-project"
  },
  "skillCatalog": {
    "pi-session-implementation": "builtin:pi-session-implementation",
    "pi-session-review": "builtin:pi-session-review",
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
- Each value is either `builtin:<name>` or names exactly one regular, readable
  file whose last path segment is `SKILL.md`. `builtin:<name>` refers to a
  skill of the [skill library](#the-skill-library); `<name>` must follow the
  skill name rule below, and `builtin:` followed by anything else is rejected.
  Directories, globs, URLs and every other scheme-prefixed source (`npm:`,
  `git+…`, `https:`) are rejected. So are `~` and backslashes. A value has at
  most 4096 characters.
- A relative path resolves against the directory of the configuration file,
  like a workspace. It never resolves against a workspace or the shell's
  working directory. `~` is not expanded: write an absolute path, or use
  `builtin:<name>` for a library skill.
- A skill folder needs no `package.json` and no extension. The file can live
  anywhere the server's OS user can read. Keep catalog files outside every
  configured workspace: a `coding` session can change any file in its
  workspace, and a changed skill reaches other sessions too (see
  [snapshot semantics](#snapshot-semantics)).
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
- two selected aliases of one profile whose paths resolve to the same path,
  for example two aliases for `builtin:pi-session-review`;
- a catalog value that violates the rules above (including a malformed
  `builtin:` name), or more than 64 entries;
- more than 16 selected aliases.

## The skill library

The skill library has two sources and nothing else:

1. **Shipped skills.** The package's `skills/` directory.
2. **Operator overrides.** A `skills/` directory next to the configuration
   file, that is, in the directory of the path in `PI_SESSION_MCP_CONFIG`. For
   the default location `~/.config/pi-session-mcp/pi-session-mcp.json` it is
   `~/.config/pi-session-mcp/skills/<name>/SKILL.md`.

An override with the same name replaces the shipped skill. A name that is not
shipped adds a skill. A name follows the Agent Skills rule: lowercase letters
and digits in hyphen-separated groups, 1 to 64 characters. No other directory
is searched: not the current directory, not a workspace and not a client's
skill directory.

### `builtin:<name>` in the catalog

A catalog value `builtin:<name>` resolves to `<override dir>/<name>/SKILL.md`
if that file exists, else to the shipped skill of that name. If neither
exists, the value keeps the shipped location. Nothing fails when the
configuration loads, but Doctor then reports `skill_missing` for the profile
that selects it, and a session start fails with `skill_load_failed`.

Resolution happens when the server loads the configuration. Adding or removing
an override therefore needs a server restart, like any configuration change.
Edits to a skill file that already resolves reach new sessions, as described
under [snapshot semantics](#snapshot-semantics). Deleting a resolved override
leaves the catalog pointing at a missing file until the restart.

The shipped example configuration registers the two worker skills with
`builtin:`. After you copy the example, its skill entries need no path edits.

### Shipped skills

The package ships three skills under `skills/`. Each has one canonical copy and
frontmatter with only `name` and `description`.

| Skill | For | Use |
| --- | --- | --- |
| `pi-session-implementation` | A Pi worker | One bounded implementation task and a fixed final report. Register it as `builtin:pi-session-implementation` and select it on coding profiles. |
| `pi-session-review` | A Pi worker | A review of a fixed target with findings and evidence. Register it as `builtin:pi-session-review` and select it on read-only profiles. |
| `pi-session-orchestration` | The controlling Claude Code or Codex agent | How to run Pi worker sessions through this server. `setup --apply` installs it into the clients. It is not a Pi worker skill: do not select it in a profile. |

A package update can change the shipped skills. Close affected sessions before
you update, as for any skill change.

## Customize and add skills

Do not edit the files inside the installed package: an update replaces them.
Put your version in the override directory.

### Customize a shipped skill

```bash
export PI_SESSION_MCP_CONFIG="$HOME/.config/pi-session-mcp/pi-session-mcp.json"
pi-session-mcp-setup --customize-skill pi-session-review            # dry-run
pi-session-mcp-setup --apply --customize-skill pi-session-review
```

The dry-run reports what would happen, for example:

```text
dry-run: planned
skills/override/pi-session-review: planned (skill_customize_planned)
```

`--apply` copies the shipped skill directory into the override directory as a
starting point and records the fingerprint of the shipped skill in
`<override dir>/.pi-session-mcp-bases.json`. Then edit
`<override dir>/pi-session-review/SKILL.md`, restart the server so that the new
override is picked up, and start new sessions.

- The command works without `--target`; it touches no client. It cannot be
  combined with `--target`, `--verify`, `--rollback` or `--remove`, which are
  usage errors (exit 64).
- It requires `PI_SESSION_MCP_CONFIG` (otherwise `config_required`) and the
  same platform as the rest of `setup`: Linux or macOS, otherwise
  `platform_unsupported`. It takes no ownership lock. `--apply` takes the
  [override lock](#concurrent-runs-and-the-override-lock); the dry-run takes no
  lock.
- It never overwrites an existing override and never edits your files.
- Only regular files are copied: at most 32 files, 1 MiB and 8 directory
  levels, no links, and entries whose name starts with `.` are skipped.

The finding target is `{ client: "skills", scope: "override", alias: <name> }`:

| Code | Status | Meaning |
| --- | --- | --- |
| `skill_customize_planned` | planned | Dry-run: no override exists, or an existing override equals the shipped skill but has no recorded base; `--apply` would copy the shipped skill if it is absent and record the base. |
| `skill_customized` | ok | The override was created and its base recorded, or an existing override that equals the shipped skill got its missing base. The second case completes a customization whose bases commit failed. |
| `skill_override_current` | unchanged | The override exists and its recorded base equals the current shipped skill. Of two concurrent applies for the same skill, the later one reports this. |
| `skill_override_outdated` | planned | The shipped skill changed since the copy, or no base is recorded for an existing override that differs from the shipped skill, or a 0.8.0 base names a released shipped skill that is not the current one. |
| `skill_base_migration_planned` | planned | Dry-run: a 0.8.0 base names the current shipped skill; `--apply` would record it as a version 2 base. |
| `skill_base_migrated` | ok | `--apply` after `skill_base_migration_planned`: the base is recorded as version 2. |
| `skill_base_unverified` | planned | Dry-run: a 0.8.0 base names no released shipped skill, so it cannot be confirmed. `--apply` records the current shipped skill as the base after you reviewed it. |
| `skill_base_updated` | ok | `--apply` after `skill_override_outdated` or `skill_base_unverified`: only the recorded base moved. |
| `skill_not_shipped` | failed | The name is not valid or the package ships no such skill. |
| `skill_bases_corrupt` | failed | The bases file is not valid. Repair or remove it. |
| `skill_override_invalid` | failed | The override entry is not a directory, or its tree is unusable (no `SKILL.md`, a link, too large). |
| `skill_customize_lock_busy` | failed | Another run held the override lock for the whole wait of 30 seconds. Run the command again. |
| `skill_customize_lock_unavailable` | failed | The lock cannot be taken: the platform, the filesystem or the `flock` binary is not supported. |
| `skill_customize_failed` | failed | Any other failure while copying or recording. |

### Concurrent runs and the override lock

`--apply --customize-skill` is one transaction per override directory. It takes
an exclusive kernel lock on `<override dir>/.pi-session-mcp-bases.lock` (mode
`0600`, never deleted), reads and validates the bases file under the lock,
copies the shipped skill if no override exists, merges the base, and replaces
the bases file atomically: an fsynced temporary file, a rename and a directory
fsync. The lock is released on every path. Two runs for different skills
therefore cannot lose each other's base. If the commit of the bases file
fails, the previous file stays; a retry then completes the customization
without overwriting your files (`skill_customized` for an override that equals
the shipped skill and has no base).

- The lock wait is bounded at 30 seconds, then the result is
  `skill_customize_lock_busy`. A lock that cannot be taken at all is
  `skill_customize_lock_unavailable`.
- On Linux the lock needs the trusted util-linux `flock` at `/usr/bin/flock` or
  `/bin/flock`; on macOS it uses `O_EXLOCK`. Both need a supported local
  filesystem.
- A holder that is killed releases the lock through the kernel. It may leave a
  stale hidden temporary bases file `.pi-session-mcp-bases.json.<hex>.tmp` or
  hidden temporary copy directory `.<skill>.<hex>.tmp` in the override
  directory. Both are harmless: they are hidden and never resolved as skills.
  Nothing removes them automatically; you may delete them while no
  customization runs.
- The dry-run takes no lock and writes nothing: no directory, lock file or
  temporary file.
- Doctor stays offline, read-only and lock-free.

The bases file is `{"schemaVersion":2,"bases":{"<name>":"<fingerprint>"}}`. A
value is a `v2:` fingerprint, or a legacy 64-hex value that could not be
migrated. A version 1 file (0.8.0) is still read. Every write produces version
2 and migrates each legacy value that names a released 0.8.0 shipped skill; any
other legacy value is kept as it is. See [Upgrade from
0.8.0](#upgrade-from-080).

### Follow a changed shipped skill

After a package update, `skill_override_outdated` (from the command above, or
as a [Doctor](#doctor-boundary) warning) means that the shipped skill differs
from the one your override was copied from. Review the shipped text, merge what
you want into your override by hand, and then acknowledge it:

```bash
pi-session-mcp-setup --apply --customize-skill pi-session-review
```

That moves only the recorded base (`skill_base_updated`). It never touches your
files. The override keeps winning until you delete it; the base only decides
whether Doctor warns.

### Add a new skill

No command is needed. Create `<override dir>/<new-name>/SKILL.md` (a valid
Agent Skills file with `name` and `description` frontmatter), reference it as
`builtin:<new-name>` in `skillCatalog`, select its alias in a profile, and
restart the server. Companion files belong in the same directory. A name that
equals a shipped skill replaces that skill instead of adding one.

Where `setup` is unsupported, create an override by copying a shipped skill
directory by hand. Doctor does not track a copy that has no recorded base.

## Install the orchestration skill into Codex and Claude Code

The orchestration skill is for the controlling agent, not for a Pi worker.
`pi-session-mcp-setup --apply --target <target>` installs it after the
registration, as a real copy of the effective skill: your override if you have
one, else the shipped skill. Clients discover it without further steps.

| Target | Skill directory |
| --- | --- |
| `codex:user:pi-session-mcp` | `~/.agents/skills/pi-session-orchestration` |
| `claude-code:user:pi-session-mcp` and `claude-code:local:pi-session-mcp` | `~/.claude/skills/pi-session-orchestration` (one shared directory) |
| `claude-code:project:pi-session-mcp` | `<project>/.claude/skills/pi-session-orchestration`, where `<project>` is the directory in which `setup` runs |

Claude Code reads personal skills in `~/.claude/skills/<name>/SKILL.md` and
project skills in `.claude/skills/<name>/SKILL.md`
([Claude Code skills](https://code.claude.com/docs/en/skills)). Codex reads user
skills in `~/.agents/skills`
([Codex skills](https://learn.chatgpt.com/docs/build-skills)).

Every `setup` result has a second finding per target, with the same client and
scope and the alias `pi-session-orchestration`. A skill problem never blocks
the registration, but a `divergent` or `failed` skill finding makes the overall
status `failed` (exit 1), so it is not overlooked.

| Operation | Code (status) |
| --- | --- |
| `--dry-run` | `skill_absent` (absent), `skill_equivalent` (unchanged), `skill_linked` (unchanged), `skill_update_planned` (planned), `skill_recovery_planned` (planned), `skill_divergent` (divergent), `skill_legacy_unverified` (divergent), `skill_source_invalid` (failed) |
| `--apply` | `skill_installed` (ok), `skill_already_equivalent` (unchanged), `skill_recovered` (ok), `skill_linked` (unchanged), `skill_updated` (ok), `skill_divergent` (divergent), `skill_legacy_unverified` (divergent), `skill_recovery_retained` (divergent), `skill_source_invalid` (failed), `skill_install_failed` (failed) |
| `--verify` | `skill_verified` (ok), `skill_missing` (failed), `skill_not_equivalent` (failed) |
| `--rollback`, `--remove` | `skill_removed` (ok), `skill_kept_shared` (unchanged), `skill_not_owned` (unchanged), `skill_absent` (ok), `skill_divergent` (divergent), `skill_legacy_unverified` (divergent), `skill_recovery_retained` (divergent) |

- `--apply` installs the skill only when the registration finding is `ok` or
  `unchanged`; `--rollback` and `--remove` handle it only after the
  registration was removed.
- `skill_updated` means that setup replaced its own unmodified copy after a
  package update or a changed override.
- `skill_recovered` means that `--apply` settled an interrupted update of
  setup's own copy (it renamed an intermediate into place or deleted one, or
  finished the pending ownership record) and needed no further update.
  If the settled copy still needs the new version, `--apply` continues and
  reports `skill_installed` or `skill_updated`.
- `skill_recovery_planned` means that the ownership record is pending for an
  update that `--apply` would settle. The dry-run does not write or delete
  anything and does not look at the intermediate directories, so `--apply` can
  still find a modified or foreign intermediate, keep it and report
  `skill_recovery_retained`. A divergent or
  foreign copy keeps `skill_divergent`, and a 0.8.0 record keeps its own code.
- `skill_kept_shared` means that the other Claude Code registration (`user` or
  `local`) still uses the shared directory. The last one removes the skill.
- A copy that already equals the effective skill but was not created by `setup`
  is reported as equivalent and stays unowned; a later `--remove` reports
  `skill_not_owned`.
- `--verify` compares the installed copy with the effective skill and does not
  look at ownership.

### What setup never replaces or deletes

Setup reports `skill_divergent` and leaves the entry alone when it finds:

- an installed copy that was modified after setup wrote it;
- a skill of the same name that setup did not install and that differs from the
  effective skill;
- any entry whose name starts with `.` inside an installed copy, such as your
  own notes or a `.DS_Store` that macOS Finder adds: setup never writes such
  entries, so it treats them as yours; delete them to let setup manage the copy
  again;
- a link at the skill entry that points anywhere but the effective skill, or a
  non-directory there.

A link at the skill entry that points exactly at the effective skill (your
override, else the shipped skill) is your own equivalent setup: setup reports
`skill_linked` (unchanged), `--verify` reports `skill_verified`, and removal
leaves the link alone (`skill_not_owned`). If you replace setup's own copy with
such a link, setup forgets its copy on the next `--apply` or `--remove`. A link
counts only while the effective skill itself is valid.

A project copy belongs to its project: setup records an opaque project
identity, so a `--remove` in another project never deletes it.

Links in the path to the entry are handled by place. In your home directory,
the client's skill directory may be your own link, for example into a dotfiles
checkout, and is followed. Inside a project, which may be untrusted, any link
below the project root makes the entry divergent, so setup never writes outside
the project.

### Interrupted updates

An update first writes a pending ownership record, then works in intermediate
directories in the parent of the skill directory. They are named after the
record's transaction id: `.pi-session-mcp-<skill>-<transactionId>.staging`,
`.backup` and `.trash`. The order is: pending record, staging directory, rename
of the old copy to the backup, install, verification, rename of the backup to
the trash, deletion of the trash entry by entry, owned record.

If an update is interrupted, for example by a full disk or a signal, setup
still recognizes the old copy as its own. `--apply`, `--remove` and
`--rollback` settle a pending transaction first:

- `--apply` finishes forward when a complete staging directory is left, or
  moves the verified backup back, and then continues.
- `--remove` and `--rollback` delete the verified intermediates and then remove
  the copy as usual.
- A trash directory is deleted only when its current contents are the
  complete, unchanged copy that the update replaced: its tree fingerprint
  equals the replaced fingerprint in the pending record. A partial trash
  directory (for example after an interruption during the entry-by-entry
  deletion, including an empty one), a modified or added-to one, a foreign one,
  and any trash when the record names no usable replaced fingerprint are
  retained, because their contents cannot be proven to be setup's own. A
  directory name or a structural check alone never proves that. The
  fingerprint covers the paths and contents of regular files, not empty
  directories or file modes: an empty directory or a mode change inside an
  otherwise complete trash is deleted with it, but no file content is lost.
- A partially written staging directory is deleted only when every file in it
  is a prefix-consistent part of the current library tree, and that tree is the
  record's target.
- Anything modified or foreign stays and is reported as
  `skill_recovery_retained` (divergent). This includes the trash directory.
  A retained intermediate leaves the pending record and the skill directory
  unchanged, and nothing is reported as settled. A retained trash directory
  stops recovery before any other intermediate is touched; a retained backup
  or staging directory can follow the deletion of a proven own trash
  directory.

To settle a retained trash directory:

1. Inspect the `.pi-session-mcp-<skill>-<transactionId>.trash` directory next
   to the skill directory.
2. Move any content of your own elsewhere.
3. Delete that directory.
4. Run the same setup command again.

`--dry-run` still announces `skill_recovery_planned` without inspecting the
intermediates, so a later `--apply` can still retain one
([#60](https://github.com/plagor44-ux/pi-session-mcp/issues/60) tracks making
the dry-run predict that). Setup deliberately no
longer deletes a partial trash tree automatically; before this rule it did
after a structural recheck.

A failed update leaves its staging directory until the next run settles it.
The directories of updates by 0.8.0 had random names. Setup never searches for
or deletes them; you may delete them by hand. `--dry-run` and `--verify` do not
report leftover intermediates.

### Customize the controller skill

Never edit the installed copy: it becomes divergent. Instead:

1. `pi-session-mcp-setup --apply --customize-skill pi-session-orchestration`
2. Edit `<override dir>/pi-session-orchestration/SKILL.md`.
3. `pi-session-mcp-setup --apply --target <target>` again. The unmodified
   installed copy is replaced (`skill_updated`).

To recover after editing the installed copy, move your edits into the override,
delete the installed copy, and run `--apply` again.

### Scope of what setup installs

Setup installs only `pi-session-orchestration` into clients. The worker skills
are for Pi profiles and are used through `builtin:`. Controller skills of your
own belong in the clients' native skill directories; setup does not manage
them.

### Install by hand where setup is unsupported

Where `setup` does not run, copy the directory; do not link it. Copy
`skills/pi-session-orchestration` from the installed package (in an npm
installation `"$(npm root -g)/pi-session-mcp/skills/pi-session-orchestration"`)
to `~/.claude/skills/` or `.claude/skills/` of a project for Claude Code, or to
`~/.agents/skills/` for Codex. Repeat the copy after a package update; nothing
keeps a manual copy current. Do not replace an existing skill of the same name
without checking it first.

Neither client needs a skill to call the Pi Session MCP tools; the skill only
describes the working method. Headless `codex exec` runs still need the
per-tool approvals for `pi_session_prompt`, `pi_session_abort` and
`pi_session_close` that [client
setup](client-setup.md#run-codex-without-prompts) describes.

### Pi workers

Pi workers never discover skills on their own in Pi Session MCP. Register the
worker skills with `builtin:` and select them on profiles, as described above.
Do not select the orchestration skill for a Pi worker: a worker has only the
tools of its profile and is not a controller of other Pi sessions.

## What happens at session start

The server loads exactly the selected files through the Pi SDK's public
`loadSkills`, without any default directories, and validates them completely.
The SDK's skill override returns exactly that set, also after an extension adds
resources later (`resources_discover`). A profile without skills gets no
skills, whatever is installed on the machine or shipped by an extension.

The start fails with `skill_load_failed` (message `Configured Pi skill could
not be loaded`) if:

- a selected file is missing, unreadable, or larger than 256 KiB (also a
  `builtin:` value that resolved to no skill);
- the SDK reports the skill as invalid, for example a missing description or an
  invalid name;
- two selected files declare the same Pi skill name;
- two aliases point at the same canonical file, for example through a symlink;
- the skill sets `disable-model-invocation: true`.

The message is fixed. It never contains a path, a skill name or SDK text.
Stderr gets a structured diagnostic. A selected file that fails validation
reports the stage `skill_load` and, when one alias is to blame, that catalog
alias in a `skill` field. If the session's actual skill catalog differs from
the selection after construction, the stage is `postcheck`, or
`extension_load` and `extension_bind` for a profile with extensions. Neither
carries a path.

If the session's prompt-template or theme catalog is not empty after
construction, which the overrides should prevent, the start fails with
`pi_session_creation_failed`.

Explicit-only skills (`disable-model-invocation: true`) are incompatible in
this version. Pi hides such skills from the model, and MCP prompts never run
`/skill:` commands, so the skill could never be used. The server does not
rewrite the flag. The same Pi skill name in different sessions is fine.

## Doctor boundary

Doctor stays offline and never parses or executes a skill. For each profile and
selected alias it adds three checks after the extension checks, with the
subject `<profile>:<skill-alias>`. A `builtin:` alias is checked at the
location it resolved to:

| ID | Condition |
| --- | --- |
| `skill_missing` | The selected file does not exist. |
| `skill_unreadable` | The path is not a regular file, is over 256 KiB, or cannot be read. |
| `skill_duplicate` | Two selected aliases of one profile resolve to the same canonical file. |

Frontmatter, name rules, name collisions and the explicit-only flag are checked
only at session start by the SDK contract. A clean Doctor run therefore does
not promise that the skill loads.

A fourth check concerns overrides, not profiles:

| ID | Severity | Subject | Condition |
| --- | --- | --- | --- |
| `skill_override_outdated` | warning | `skill:<name>` | The shipped skill's current fingerprint differs from the base recorded in `<override dir>/.pi-session-mcp-bases.json`. A 0.8.0 base counts as the released shipped skill that it names. |
| `skill_override_outdated` | warning | `skill:<name>` | The recorded base is a 0.8.0 value that names no released shipped skill. The remediation says that the base predates version 2 fingerprints and cannot be confirmed: review the shipped skill, then run `pi-session-mcp-setup --apply --customize-skill <name>`. |
| `skill_override_outdated` | warning | `skill:bases` | The bases file is corrupt. |

It is `ok` for a recorded base that still matches. The remediation for a
changed skill names the command
`pi-session-mcp-setup --apply --customize-skill <name>`, after you reviewed the
change (see [Follow a changed shipped skill](#follow-a-changed-shipped-skill)).
Only skills with a recorded base are compared. Doctor reads the bases file and
the shipped files and executes nothing. A warning gives exit status `1`; it does
not block `setup`.

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
- There is no hot reload, no watcher, no copy store for sessions and no
  versioning. A change
  to `skillCatalog` or `skills` needs a new server process like any other
  configuration change. So does adding or removing an override of a library
  skill, because `builtin:` is resolved when the configuration loads. Editing
  the file of an override that already resolves needs no restart for new
  sessions.

## Trust and limits

Skills are operator-managed prompt content. The override directory and its
bases file are operator-trusted configuration next to the configuration file,
never a workspace; keep them out of every workspace and writable only by you.
Setup copies the effective orchestration skill into the clients' skill
directories, where it becomes instructions for the controlling agent, so review
an override like code. In a `coding` profile a skill's
instructions are executed with that profile's tools, so review a skill like
code. A skill grants no rights: the tools of the permission profile stay the
limit.

Skill selection limits the regular skill catalog only. An allowlisted
extension remains trusted executable code. It can still read files or inject
prompt text. This is not a sandbox.

No MCP tool and no tool argument takes a skill. `pi_session_start` and
`pi_session_prompt` are unchanged.

Pi lists each available skill to the model with the absolute path of its
`SKILL.md`, so that the model can read it. The model may repeat that path in
its answer. Capabilities, errors and diagnostics stay path-free, but completed
`assistantText` is model output and is not sanitized.

## Upgrade from 0.8.0

### Skill tree fingerprints

A fingerprint identifies a skill tree by content. Version 2, stored as
`v2:<64 hex>`, is a SHA-256 over a domain and version tag, the file count, and
for each file in path byte order the length-prefixed UTF-8 path and the
length-prefixed content. The size and file type limits are unchanged. Version 1
(0.8.0) hashed `path NUL content NUL` for each file. Content may contain NUL
bytes, so two different trees could share a version 1 value.

A version 1 value never proves identity alone. It counts only when a trusted
reference has that version 1 value and is byte-identical, by its version 2
value, to the tree in question. The trusted references are the shipped skills of
the 0.8.0 release (a fixed table in the code) and, for setup's installed copies,
the current library tree.

### What to do after the upgrade

1. Run `pi-session-mcp-setup` as a dry-run for your targets, then with
   `--apply`. An unchanged copy of the 0.8.0 controller skill is proven against
   the 0.8.0 table, its ownership record is migrated, and the copy is updated to
   the new shipped skill. A copy that cannot be proven stays untouched, and
   dry-run, apply, remove and rollback report `skill_legacy_unverified` for it.
   Inspect the copy. If it is unchanged setup content that you no longer need,
   delete it yourself and run the operation again: an absent slot clears the
   record. Otherwise keep it.
2. For customized skills, Doctor resolves 0.8.0 bases against the 0.8.0 table.
   The next `--apply --customize-skill` for any skill rewrites the bases file as
   version 2.

Ownership records of skill copies hold `v2:` values in `fingerprint` and
`replaces`. Registration records are unchanged.

### Downgrade

0.8.0 rejects the new formats, so it never acts on them. It treats a version 2
bases file as corrupt (`skill_bases_corrupt`, and the Doctor warning with the
subject `skill:bases`). It validates the ownership file as a whole and treats a
skill record with a `v2:` value as invalid, so it rejects the entire file as
corrupt, registration records included. Before you run 0.8.0 again, repair or
remove those files.

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
