# pi-lens registration gate — 2026-10-19

## Result: PASS

With `pi-lens@4.4.3` and `@earendil-works/pi-coding-agent@1.3.0`, both
`symbol_search` and `project_report` are registered **during extension load,
before `bindExtensions`**. Both remain registered and are active after bind in
the coding tool profile. The registered set does not change across bind. The
lazy-registration stop condition is not hit; this gate permits the remaining
implementation work.

The exact one-line output is in [`result.json`](result.json). Its arrays are
sorted, flattened tool names from the two loaded extensions:

| Extension | Tools after load | Tools after bind |
| --- | --- | --- |
| `pi-extension-fixture@1.0.0` | `fixture_tool` | `fixture_tool` |
| `pi-lens@4.4.3` | `ast_grep_outline`, `ast_grep_replace`, `ast_grep_search`, `effective_config`, `lens_diagnostic_mark`, `lens_diagnostics`, `lsp_navigation`, `module_report`, `pi_lens_activate_tools`, `project_report`, `read_enclosing`, `read_symbol`, `symbol_search` | Identical to load |

`activeCoding` records the actual post-bind active tool names, not merely the
requested set. Some pi-lens tools are registered but inactive after bind;
`symbol_search` and `project_report` are both active.

## Method and safety

- Starting repository commit: `d7897fae470379536d895cf2850a305cc07de373`, branch
  `feat/read-only-extension-tools`. Runtime: Node.js `v26.11.1`.
- Installed the exact pi-lens version into a throwaway agent directory's
  `npm/node_modules/pi-lens`, with lifecycle scripts, audit and funding checks
  disabled. Transitive versions were resolved by npm, not pinned by this record.
  This install was the only permitted network operation.
- Used only SDK package-root imports: `ModelRuntime`, `SettingsManager`,
  `SessionManager`, `createAgentSessionServices`,
  `createAgentSessionFromServices`, and `createAgentSessionRuntime`.
  This follows the adapter's load → create → bind sequence without changing the
  adapter. The coding set starts with all seven built-ins plus the loaded tools.
- Copied the repository fixture to the throwaway agent's npm layout. Its offline
  provider (`fixture-ext` / `fixture-ext-model`) supplies model metadata only.
  No prompt, tool execution, command dispatch, or provider turn was started.
- Before extension loading, replaced the public runtime model-call methods with
  counting throwers. The fixture's stream event is also checked. Success requires
  zero provider and child-process attempts.
- Before SDK import, denied `fetch`, WebSocket, net, TLS, HTTP(S), and DNS entry
  points as in the earlier cursor evaluation probe; counted **0 network
  attempts**. Denied child-process entry points as well to prevent subprocess
  network bypass. These are in-process guards, not a general OS sandbox or a
  claim about every possible native networking API.
- Cleared inherited environment variables before SDK import. Redirected HOME,
  XDG state, temporary files, credentials storage and Pi's agent directory to the
  throwaway tree; disabled catalog refresh and model networking. No personal Pi,
  Claude or Codex directories were used. Workspace was an empty throwaway
  directory, `projectTrusted: false`, matching production trust policy.
  In-memory settings/session history and disabled resource discovery avoid
  personal/project configuration, skills, prompts, themes and context files.
- Suppressed third-party stdout/stderr (the fixture intentionally emits stdout)
  so the probe emits only its JSON result and records no incidental paths.
  Disposed the session runtime, including shutdown hooks. Removed the throwaway
  tree after recording and checking the result.

## Reproduction

Run from this clone with its installed SDK 1.3.0 and Node.js 22.19.0 or newer:

```bash
agentDir=$(mktemp -d "$HOME/.cache/pi-lens-probe.XXXXXX")
mkdir -p "$agentDir/home" "$agentDir/tmp"
touch "$agentDir/user.npmrc" "$agentDir/global.npmrc"
env -i PATH="$PATH" HOME="$agentDir/home" TMPDIR="$agentDir/tmp" \
  npm_config_cache="$agentDir/npm-cache" \
  npm_config_userconfig="$agentDir/user.npmrc" \
  npm_config_globalconfig="$agentDir/global.npmrc" \
  npm install --ignore-scripts --no-audit --no-fund \
  --prefix "$agentDir/npm" pi-lens@4.4.3
node --check docs/evaluation/pi-lens-registration-2026-10-19/probe.mjs
node docs/evaluation/pi-lens-registration-2026-10-19/probe.mjs "$agentDir" \
  > docs/evaluation/pi-lens-registration-2026-10-19/result.json
rm -rf -- "$agentDir"
```

Observed checks: syntax check exit 0; probe exit 0 with one JSON line. The probe
was run twice (the second run included the strengthened pre-load model-call
guards), with identical tool arrays and network count. Result assertions passed:
load and bound sets equal; both required names present at both stages and active;
network attempts zero. No general test suite or live/provider acceptance was run:
this is a provider-free registration gate only.

An initial installation command used `/dev/null` for both npm config paths and
failed before configuration resolution (`double-loading config`). Retrying with
two distinct empty config files succeeded (15 packages installed). No lifecycle
scripts ran in either attempt.
