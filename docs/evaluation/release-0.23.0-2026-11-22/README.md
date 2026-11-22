# Pre-release checks on the 0.23.0 release candidate (2026-11-22)

Level 1 and Level 2 checks on the release candidate `c5859ec` of `0.23.0`,
run on 2026-11-22 from 12:07 to 12:12 UTC on Linux 7.3 (`x64`) with Node.js
`26.13.1`, npm `12.2.3`, Git `2.56.1`, Codex CLI `0.171.0` and Claude Code
`2.1.330`. The release moves the Pi SDK family from `1.5.2` to `1.6.0`. No
live check ran on this build: there is no Level 3 cycle and no targeted live
check on Pi SDK `1.6.0`. A result for this build is not evidence for another
one. The record commits change files that the package contains (`docs/` and
the README), so Level 1 and the packed-tarball Level 2 were repeated on the
head commit of the release pull request. The pull request names that head,
its results, the `dist/` digest and the tarball checksum; this file does not
hold the checksum, because recording it here would change the archive that it
describes. The summary is in the
[acceptance record](../../acceptance.md#v0230-pre-release-acceptance).

## Candidate

- `c5859ec` is the version commit `chore(release): 0.23.0` of the branch
  `chore/release-0.23.0`, on top of `main` at `f47ca69` (merge of the Pi SDK
  update, [#314](https://github.com/plagor44-ux/pi-session-mcp/pull/314)). The
  commits after it change only this record, the acceptance record and the
  README status text.
- Since `v0.22.2`, `main` changed twelve files: the README header, logo and
  social preview image
  ([#313](https://github.com/plagor44-ux/pi-session-mcp/pull/313)), the Pi SDK
  pins and the lockfile, the changelog, the README, the pinned version named in
  the architecture and tool contract documents and in ADR 0022, and the
  amendment to ADR 0013 that records the abort handling of `read` under Pi SDK
  `1.6.0`. No file under `src/`, `test/`,
  `scripts/` or `skills/` differs between `v0.22.2` and the candidate
  (`git diff --stat v0.22.2 HEAD -- src test scripts skills` printed nothing).
  The version commit adds the version to the manifest, the lockfile, the
  installer, the README and the capability example, and the changelog heading.
- The maintainer decided on a minor release. The public MCP contract is
  unchanged, which [ADR 0003](../../adr/0003-post-mvp-maintenance.md) would
  accept as a patch.

## Level 1

Run in the release worktree of the candidate, after `npm ci`, in the order CI
uses. The checkout was clean: `git status --short` printed nothing after the
run and the build, and `git diff --check` exited with `0`.

| Command | Exit | Result |
| --- | ---: | --- |
| `npm ci` | 0 | |
| `npm run typecheck` | 0 | |
| `npm run build:cli` | 0 | |
| `NODE_OPTIONS=--unhandled-rejections=strict npm test` | 0 | 197 files passed; 5375 tests passed, 15 skipped; 54.6 s; load average 1.5 at the start |
| `npm run build` | 0 | |
| `npm run --silent doctor -- --json` | 2 | `packageVersion` `0.23.0`; the only failing check is `config_missing`, because no configuration was set; the other six checks are `ok` |
| `npm audit` | 0 | 0 vulnerabilities |
| `npm audit --omit=dev` | 0 | 0 vulnerabilities |
| `git diff --check` | 0 | |

The exit status `2` of Doctor is the same one that the record of `0.22.2`
reports for a run without a configuration. The lockfile still resolves
`picomatch` `4.0.7`, as `v0.22.2` does, but the advisory that the record of
`0.22.2` names for that version is not reported at the time of this run. The
audit result follows from the advisory database at that moment.

## Package

- `npm pack` of the candidate listed 1081 files. A second `npm pack` of the
  same commit, later in the run, produced the same SHA-256 and shasum as the
  first. The digests of the archive of the release pull request's head are in
  the pull request.
- The file list holds no `docs/superpowers/` file. A scan of the unpacked
  files for the absolute home path of the build host and for the maintainer's
  e-mail address found none.
- The SHA-256 over the sorted `sha256sum` listing of `dist/` is
  `f9956f5b62fdd7efd497fa674cf9c6404de5d20bf7f16b29f02fcc2c9df9b9cc`. It is the
  same for the working tree before and after the Level 2 runs and for the
  package installed from the tarball.

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
  registrations unchanged, no leftover process, the leak check passed (36
  reports, 0 hits), the build unchanged and the disposable directory removed.
  The working-tree runs counted 284 built files and the packed runs 283.
- The packed runs used a prefix from `mktemp -d` below the cache directory of
  the user, outside `/tmp`, and ran the installed `pi-session-mcp-setup`
  against the installed package. The prefix and the tarball were removed
  after the runs. A second install of the same tarball into a new prefix
  served the install smoke and the version listing below, and was removed
  in the same way.
- The install smoke (`scripts/install-smoke.mjs`) on that installation
  reported `smoke_passed` with version `0.23.0` and exited with `0`.
- The install resolves, without our lockfile, all eight `@earendil-works`
  packages of the SDK family at `1.6.0` (`pi-coding-agent`, `pi-ai`,
  `pi-agent-core`, `pi-mcp`, `pi-tui`, `pi-codemode`, `pi-telemetry` and
  `pi-schema`), `undici` `8.12.4`, `minimatch` `11.0.3`, `openai` `7.59.0` and
  `@google/genai` `2.32.0`. It contains no `picomatch` and no `hono`. npm
  printed its warning that the install scripts of `@google/genai` and
  `protobufjs` did not run because `allowScripts` does not cover them; the
  smoke and the Level 2 runs passed with that state.

## Isolation

- Level 2 used its own disposable homes and a configuration without a
  credential. No real repository, workspace alias or client registration took
  part, and the harness checked that the real registrations of both clients
  were the same before and after each run.
- Level 1 and the packing ran in the release worktree. No session, writer or
  provider took part in any check.

## Not covered

Everything that needs a live provider or another host. Specifically:

- A Level 3 cycle and any targeted live check on Pi SDK `1.6.0`. The last
  full ten-task cycle ran on the `0.22.2` release candidate with Pi SDK
  `1.5.2`.
- The upstream changes of `1.6.0` that the changelog names and that only a
  live turn shows: the new GPT-6.2 models and their thinking levels, the
  `find` pattern semantics and the reworded tool descriptions the model sees,
  the wider provider retries, the tool results of an aborted batch, and the
  per-plan key variables of the Qwen Token Plan providers.
- An abort during a coding session's `read` against a real provider. The
  server keeps its own `read` for coding sessions
  ([ADR 0013](../../adr/0013-hardened-read-only-profiles.md#amendment-2026-11-22-abort-handling-of-read-under-pi-sdk-160)).
- A profile with `maxOutputTokens` against a real provider, tier routing with
  real routed starts, a provider store with a stored key, the Claude Code
  wake, container writers, the server host, and macOS outside CI.
- The published-release Level 2 (fresh clone of the tag and the published
  package) and the upgrades of real installations, which follow after
  publishing.
