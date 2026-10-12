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
validated `<profile>:<package>` or `<profile>:<skill-alias>` pairs; paths, configuration values, errors,
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
| `extension_missing` | Pi has no user install of a package that a profile's `extensions` names | `<profile>:<package>` |
| `extension_version_mismatch` | The installed manifest's version differs from the pinned version, or the manifest or its `pi.extensions` entries are invalid | `<profile>:<package>` |

| `skill_missing` | The `SKILL.md` file that a profile's selected skill alias names does not exist | `<profile>:<skill-alias>` |
| `skill_unreadable` | A selected skill path is not a regular file, is larger than 256 KiB, or cannot be read | `<profile>:<skill-alias>` |
| `skill_duplicate` | Two selected skill aliases of one profile resolve to the same canonical file | `<profile>:<skill-alias>` |

Doctor reads extension manifests from Pi's user install location only; it never installs packages and never imports extension code.

The skill checks run after the extension checks. They look only at file availability: Doctor never reads a skill's frontmatter, never parses or executes it, and the subject carries the catalog alias, never a path. Frontmatter, skill-name rules, name collisions and explicit-only flags (`disable-model-invocation`) are checked only at session start by the Pi SDK contract, so a clean Doctor run does not promise that a skill loads. Unknown or duplicate aliases and two selected aliases with one path are configuration errors and surface as `config_invalid`. See [Pi skills](skills.md).

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
