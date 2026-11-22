# Pre-release checks on the 0.23.1 release candidate (2026-11-22)

Level 1 and Level 2 checks on the release candidate `b8d5835` of `0.23.1`,
run on 2026-11-22 from 15:09 to 15:25 UTC on Linux 7.3 (`x64`) with Node.js
`26.13.1`, npm `12.2.3`, Git `2.56.1`, Codex CLI `0.171.0` and Claude Code
`2.1.330`. The release ships two merged pull requests that change the setup
CLI, its documentation and one bundled skill. No live check ran on this build:
there is no Level 3 cycle and no targeted live check on Pi SDK `1.6.0`, and
`--inspect` was not run against a container writer that Podman provisioned. A
result for this build is not evidence for another one. The record commits
change files that the package contains (`docs/` and the README), so Level 1 and
the packed-tarball Level 2 were repeated on the head commit of the release pull
request. The pull request names that head, its results, the `dist/` digest and
the tarball checksum; this file does not hold the checksum, because recording
it here would change the archive that it describes. The summary is in the
[acceptance record](../../acceptance.md#v0231-pre-release-acceptance).

## Candidate

- `b8d5835` is the version commit `chore(release): 0.23.1` of the branch
  `chore/release-0.23.1`, on top of `main` at `219d0d4` (merge of
  [#320](https://github.com/plagor44-ux/pi-session-mcp/pull/320)). The commits
  after it change only this record, the acceptance record and the README
  status text.
- Level 1 and the working-tree Level 2 ran on the working tree that became that
  commit, before it was committed; the content is the same. The packed-tarball
  runs ran on the commit itself.
- Since `v0.23.0`, `main` gained two merged pull requests:
  [#316](https://github.com/plagor44-ux/pi-session-mcp/pull/316) (documentation
  only: the writer image guides, the README section "Recommended setup for
  coding agents" and the post-release records of `0.22.2` and `0.23.0`) and
  [#320](https://github.com/plagor44-ux/pi-session-mcp/pull/320) (issues
  [#317](https://github.com/plagor44-ux/pi-session-mcp/issues/317),
  [#318](https://github.com/plagor44-ux/pi-session-mcp/issues/318) and
  [#319](https://github.com/plagor44-ux/pi-session-mcp/issues/319)).
- `git diff --stat v0.23.0 HEAD` changes nine files under `src/` (the guided
  setup, `setup-cli.ts`, `setup-result.ts`, `setup-writers.ts` and
  `writer-lifecycle.ts`), eight files under `test/`, one file under `skills/`
  (`pi-session-profiles`) and none under `scripts/`. No MCP tool definition,
  tool input or output field, state or error code changes: the additions are
  in the setup CLI (`--writer <name> --inspect`, per-rule findings, the
  `changes` preview) and its exit status. A `tools/list` comparison of the two
  builds was not run.
- The maintainer decided on a patch release. The public MCP contract is
  unchanged, which [ADR 0003](../../adr/0003-post-mvp-maintenance.md) accepts
  as a patch. **Exit status:** `--guided --answers` exits with `64` instead of
  `1` for `answers_invalid` and the new `answers_unreadable`; the changelog
  names this under "Changed".

## Level 1

Run in the release worktree of the candidate, after `npm ci`, in the order CI
uses. The checkout held only the version changes after the runs, and
`git diff --check` exited with `0`.

| Command | Exit | Result |
| --- | ---: | --- |
| `npm ci` | 0 | |
| `npm run typecheck` | 0 | |
| `npm run build:cli` | 0 | |
| `NODE_OPTIONS=--unhandled-rejections=strict npm test`, first run | 1 | 202 files; 5482 tests passed, 1 failed, 15 skipped; 54.9 s; load average 2.5 at the start. The failure is `test/install-smoke.test.ts`, "ends promptly and kills a descendant that holds the server's pipes": `expect(await isAlive(holder)).toBe(false)` at line 245, after 30 polls of 100 ms |
| `npx vitest run test/install-smoke.test.ts`, three times | 0 | 16 of 16 passed each time |
| `NODE_OPTIONS=--unhandled-rejections=strict npm test`, second run | 0 | 202 files passed; 5483 tests passed, 15 skipped; 55.1 s; load average 7.0 at the start |
| `npm run build` | 0 | |
| `npm run --silent doctor -- --json` | 2 | `packageVersion` `0.23.1`; the only failing check is `config_missing`, because no configuration was set; the other six checks are `ok` |
| `npm audit` | 0 | 0 vulnerabilities |
| `npm audit --omit=dev` | 0 | 0 vulnerabilities |
| `git diff --check` | 0 | |

- The first test run failed once and the second passed, with no change between
  them. The failing test and `scripts/install-smoke.mjs` are byte-identical to
  `v0.23.0` (`git diff --stat v0.23.0 HEAD` on both printed nothing), and the
  test passed three times in isolation. The cause was not investigated further;
  it is a timing-sensitive wait for a descendant process to end and is not
  related to a changed file. It is recorded here because the first run was red.
- Doctor's exit status `2` is the one that the records of `0.22.2` and
  `0.23.0` report for a run without a configuration.
- The full run includes `test/writer-lifecycle.podman.test.ts` and
  `test/writer-boundary.podman.test.ts`. On this host Podman is usable and the
  pinned image is present, so they ran (15 and 1 tests; the 15 skipped tests
  of the run are others). In CI they are skipped
  (`Podman is unavailable or is not usable rootless`, 15 skipped on the Linux
  runner of the latest run on `main`). Neither file calls `inspectWriter`,
  the function behind `--inspect`.

## Package

- `npm pack` of the candidate listed 1084 files. A second `npm pack` of the
  same commit, later in the run, produced the same SHA-256 and shasum as the
  first. The digests of the archive of the release pull request's head are in
  the pull request.
- The file list holds no `docs/superpowers/` file. A scan of the unpacked
  files for the absolute home path of the build host and for the maintainer's
  e-mail address found none.
- The SHA-256 over the sorted `sha256sum` listing of `dist/` is
  `ab39f9b8e86d4511f84299e4a4f65b1486fd525a1fd969180ca3ece0ed11fa2a`. It is the
  same for the working tree before and after both working-tree Level 2 runs and
  for the package installed from the tarball.

## Level 2

`scripts/setup-acceptance.mjs`, with Codex CLI `0.171.0` and Claude Code
`2.1.330`, as in
[Acceptance](../../acceptance.md#level-2-setup-acceptance).

| Run | Exit | Checks | Failures |
| --- | ---: | ---: | ---: |
| Working tree, delivery off | 0 | 160 of 160 | 0 |
| Working tree, `--events spool` | 0 | 228 of 228 | 0 |
| Packed tarball, delivery off | 0 | 160 of 160 | 0 |
| Packed tarball, `--events spool` | 0 | 228 of 228 | 0 |

- Each run covered the four targets (Codex `user`; Claude Code `user`,
  `project` and `local`) with the nine steps each, and reported the real client
  registrations unchanged, no leftover process, the leak check passed and the
  build unchanged.
- The packed runs used a prefix from `mktemp -d` below the cache directory of
  the user, outside `/tmp`, and ran the installed `pi-session-mcp-setup`
  against the installed package. The prefix and the tarball were removed
  after the runs.
- The install smoke (`scripts/install-smoke.mjs`) on that installation
  reported `smoke_passed` with version `0.23.1` and exited with `0`.
- The install resolves, without our lockfile, all eight `@earendil-works`
  packages of the SDK family at `1.6.0` (`pi-coding-agent`, `pi-ai`,
  `pi-agent-core`, `pi-mcp`, `pi-tui`, `pi-codemode`, `pi-telemetry` and
  `pi-schema`), `undici` `8.12.4`, `minimatch` `11.0.3`, `openai` `7.59.0` and
  `@google/genai` `2.32.0`. It contains no `picomatch` and no `hono`. npm
  printed its warning that the install scripts of `@google/genai` and
  `protobufjs` did not run because `allowScripts` does not cover them; the
  smoke and the Level 2 runs passed with that state.
- Level 2 exercises the install, verify and removal of client registrations. It
  does not call `--writer <name> --inspect`, `--guided` or `--answers`.

## What covers the new setup behaviour

- `--inspect` counting runs against real Git: `test/writer-inspect.test.ts`
  and `test/writer-inspect-matrix.test.ts` build real clones in temporary
  directories (the matrix has one row per clone state and ties each verdict to
  the safety predicate of a non-discard `--remove`). They run in CI on Linux
  and on both macOS runners. `inspectWriter` reads the recorded writer state
  and runs Git on the host against the clone directory; it starts no container.
- The command-line path (`--writer <name> --inspect [--json]`, the exit
  status and the report) is tested against a mocked lifecycle in
  `test/setup-writers.test.ts`.
- The guided findings, the `changes` preview and the exit status `64` are
  covered by `test/guided-answers.test.ts`, `test/guided-preview.test.ts`,
  `test/guided-docs.test.ts` and `test/guided-run.test.ts`, all provider-free.

## Isolation

- Level 2 used its own disposable homes and a configuration without a
  credential. No real repository, workspace alias or client registration took
  part, and the harness checked that the real registrations of both clients
  were the same before and after each run.
- Level 1 and the packing ran in the release worktree. The two Podman test
  files ran against local Podman on this host, as in every full run on a host
  with Podman; no session, provider or operator writer took part in any check.

## Not covered

Everything that needs a live provider or another host. Specifically:

- A Level 3 cycle and any targeted live check on Pi SDK `1.6.0`. The last
  full ten-task cycle ran on the `0.22.2` release candidate with Pi SDK
  `1.5.2`.
- `pi-session-mcp-setup --writer <name> --inspect` against a writer that
  Podman provisioned, end to end through the real command line. No test or run
  of this release does that.
- `--guided` with a real answers file against an installed package, and a
  script that checks the exit status `64`; the tests assert the status, no
  run of the installed package does.
- The upstream changes of Pi SDK `1.6.0` that only a live turn shows (see the
  record of `0.23.0`), an abort during a coding session's `read` against a real
  provider, a profile with `maxOutputTokens` against a real provider, tier
  routing with real routed starts, a provider store with a stored key, the
  Claude Code wake, container writers in operation, the server host, and macOS
  outside CI.
- The published-release Level 2 (fresh clone of the tag and the published
  package) and the upgrades of real installations, which follow after
  publishing.
