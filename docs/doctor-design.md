# Offline doctor contract

`src/doctor-cli.ts` is a separate local entry point. It never imports the MCP
server, initializes transport, creates a Pi session, reads credentials, or
performs network activity.
It checks the package it was loaded from, never the current working
directory: an npm executable can run from any directory.

`runDoctor` returns one frozen result model (`schemaVersion: 1`, `ok`, a
sanitized semver `packageVersion` when metadata is available, ordered `checks`,
and `exitCode`). Human and JSON output are projections of that same model.
Subjects are only fixed component names, validated workspace aliases, or
validated `<profile>:<package>`, `<profile>:<skill-alias>` or `skill:<name>` pairs; paths, configuration values, errors,
credentials, and provider data are never output.

Each check is `{ id, severity, subject, remediation? }`. Severity is `ok`,
`warning`, or `error`; remediation is a fixed safe sentence. The initial IDs
and owners are:

| ID | Blocking condition | Subject |
| --- | --- | --- |
| `doctor_cli_unavailable` | The independent generated Doctor entry point is missing or cannot be loaded by the checked-in bootstrap | `Doctor CLI` |
| `node_version_unsupported` | Runtime does not satisfy `package.json#engines.node` | `Node.js` |
| `package_metadata_unreadable` | Package metadata is missing, unreadable or malformed, or a lockfile is present but malformed | `package metadata` |
| `build_missing` | `dist/main.js` is absent, inaccessible, or not a regular file | `build output` |
| `build_stale` | Package, lock, build configuration, or production TypeScript input is newer than the build output, or freshness cannot be established. Inputs that an npm installation does not contain are skipped. Without any build configuration or TypeScript input, as in an npm installation, the package and lock times are not compared either, because npm writes extracted files with the extraction time | `build output` |
| `version_mismatch` | Package and lock versions differ; this is a warning and does not apply to an npm installation, which has no lockfile | `package version` |
| `config_missing` | `PI_SESSION_MCP_CONFIG` is not set, or the file it names is absent | `configuration` |
| `config_unreadable` | The supported configuration path cannot be read | `configuration` |
| `config_invalid` | Production `loadConfig` rejects the configuration | `configuration` |
| `workspace_missing` | A resolved configured workspace does not exist | validated workspace alias |
| `workspace_not_directory` | A resolved workspace is not a directory | validated workspace alias |
| `workspace_unreadable` | A resolved workspace cannot be read | validated workspace alias |
| `workspace_not_writable` | A workspace is not writable while a coding profile can target it | validated workspace alias |
| `workspace_gitfile` | Warning. A workspace's `.git` is a regular file starting with `gitdir:` while at least one execution profile has the `coding` permission profile | validated workspace alias |
| `extension_missing` | Pi has no user install of a package that a profile's `extensions` names | `<profile>:<package>` |
| `extension_version_mismatch` | The installed manifest's version differs from the pinned version, or the manifest or its `pi.extensions` entries are invalid | `<profile>:<package>` |
| `skill_missing` | The `SKILL.md` file that a profile's selected skill alias names does not exist; a `builtin:<name>` value that matches no override and no shipped skill resolves to the shipped location and is reported here | `<profile>:<skill-alias>` |
| `skill_unreadable` | A selected skill path is not a regular file, is larger than 256 KiB, or cannot be read | `<profile>:<skill-alias>` |
| `skill_duplicate` | Two selected skill aliases of one profile resolve to the same canonical file | `<profile>:<skill-alias>` |
| `skill_override_outdated` | Warning. The current fingerprint of a shipped skill differs from the base recorded in the skill bases file next to the configuration file, or the bases file is corrupt | `skill:<name>`, or `skill:bases` for a corrupt file |

`workspace_gitfile` is advice, not a boundary. A linked Git worktree shares `hooks/` and `config` with its main repository, so a coding worker could plant code that runs in the operator's later Git commands. A `.git` gitfile alone does not prove a linked worktree, however: submodules and `git init --separate-git-dir` use gitfiles too, and the content of the three is indistinguishable without following the pointer. Doctor therefore never follows, resolves, stats or reads the pointer target and never runs Git. It calls `lstat` on `<workspace>/.git` and, for a regular file of at most 4 KiB, reads at most that many bytes (without following a symbolic link) and checks for a `gitdir:` prefix followed by a non-blank value. Every such file warns, including submodule and separate-git-dir gitfiles, with a fixed path-free remediation that says "possible linked worktree or Git metadata stored outside the workspace" and recommends a separate full clone for coding workers. The check runs only when a coding profile exists and emits one entry per workspace alias: a warning, or `ok` when no gitfile pointer was found. A `.git` directory, an absent `.git`, an empty, oversized or malformed file, a symbolic link named `.git` (not followed, so nothing is known about its target), and any `lstat` or read error (for example `EACCES`) produce `ok`, never a failure and never a crash; an unreadable `.git` therefore means "not detected", not "verified clean". The warning cannot mask an error: the exit code stays 2 whenever any error exists.

Doctor reads extension manifests from Pi's user install location only; it never installs packages and never imports extension code.

The skill checks run after the extension checks. They look only at file availability: Doctor never reads a skill's frontmatter, never parses or executes it, and the subject carries the catalog alias, never a path. Frontmatter, skill-name rules, name collisions and explicit-only flags (`disable-model-invocation`) are checked only at session start by the Pi SDK contract, so a clean Doctor run does not promise that a skill loads. Unknown or duplicate aliases and two selected aliases with one path are configuration errors and surface as `config_invalid`. See [Pi skills](skills.md).

`skill_override_outdated` concerns the operator's skill overrides, not a profile. It is `ok` for a recorded base that still matches the shipped skill, and a warning (exit status 1, never blocking `setup`) when the shipped skill changed after the operator ran `pi-session-mcp-setup --customize-skill <name>`; its remediation names `pi-session-mcp-setup --apply --customize-skill <name>` to acknowledge a reviewed change. Only skills with a recorded base are compared, and a recorded name that is no longer shipped is skipped. A recorded base of 0.8.0 (a version 1 fingerprint) is compared through the version 2 value of the released 0.8.0 skill it names; a version 1 base that names no released skill cannot be confirmed and yields a warning that says so, with the same remediation. A corrupt bases file yields a warning with the subject `skill:bases`. Doctor reads the bases file and the shipped skill files only; nothing is executed and the subject is a validated skill name, never a path. The check sorts after `skill_duplicate`.

The Doctor reuses `loadConfig`; it does not duplicate alias, profile, thinking
level, or read-only-default rules. Workspace values are used only for local
filesystem checks and are never copied into the result.

Checks use the table order above, then sort by subject within an ID. Exit
codes are 0 for all checks passing, 1 for warnings only, 2 for blocking
errors, and 64 for CLI misuse. Compilation is a separate explicit
`npm run build:cli` step. `npm run doctor` executes a checked-in bootstrap that
loads only the already-generated independent CLI, so compiler output can never
enter a Doctor report. A missing or unloadable generated entry point produces
the fixed path-free `doctor_cli_unavailable` result with exit code 2; the
bootstrap never forwards raw import or compiler diagnostics.
If a report consumer closes stdout, the bootstrap absorbs the resulting pipe
error and preserves the intended bounded exit status without emitting a stack
trace or path-bearing diagnostic.
