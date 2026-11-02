# Sprint 24: v0.16.1 acceptance and a read-only Go module cache

Planning basis: main `6c533ac` (the merge of PR #246, tag `v0.16.1`),
published 0.16.1, installed 0.16.0, 2026-11-02.

Entry: the maintainer's work order of 2026-11-02.

- Accept the published 0.16.1 (Pi SDK 1.5.0) independently: source and
  dependency checks, the published package, Level 2, one Level 3 cycle, a
  live turn deadline and a live recovery export.
- [#243](https://github.com/plagor44-ux/pi-session-mcp/issues/243): let
  read-only reviewers with the sandboxed shell run offline Go tests against a
  read-only module cache, under a proposed ADR, without a release.

Branch `feat/243-go-module-cache`: one pull request with one commit series
per topic, no release. The post-release records of 0.16.1 ride along, as
[Releasing](../releasing.md) asks for records that follow a release.

## Results

| Item | Result |
| --- | --- |
| 0.16.1 source and dependencies | Level 1 on the tag clone; the full suite passed on its second and third run (the first, at a load average near 30, had four 5 s timeouts that passed alone). Canary 1.5.0 passed; one copy per SDK family package. |
| 0.16.1 package | Fresh-prefix install, `smoke_passed`, published shasum reproduced from the tag, consumer audit 0 vulnerabilities. |
| 0.16.1 Level 2 | Tag clone and npm package, each 160/160 (off) and 228/228 (spool). |
| 0.16.1 Level 3 | One ten-task cycle, 10 of 10, gate passed ([record](../evaluation/level3-2026-11-02/README.md)). |
| Turn deadline, live | Host sandbox 60.03 s and container writer 60.49 s, `abortReason: "deadline"`, session reusable ([record](../evaluation/live-deadline-recovery-2026-11-02/README.md)). |
| Recovery export, live | `writer_recovered` against a real conflicted writer, all five refs and their content as ADR 0016 describes (same record). |
| `/compact` with running read-only workers | Blocked: it needs an operator to type `/compact` in an interactive Claude Code session. |
| #243 | Implemented under [ADR 0018](../adr/0018-sandbox-go-module-cache.md), merged in #247; the maintainer accepted the ADR on 2026-11-02. Unreleased. |

## #243

Design decisions, with the host experiments behind them, are in ADR 0018:
a per-profile field `goModuleCache`, the fixed target `/go/pkg/mod`, the Go
variables `GOPROXY=off`, `GOSUMDB=off`, `GOTOOLCHAIN=local`, `GOENV=off`, a
build cache in the sandbox's `/tmp`, `GOFLAGS` unset (with `-mod=mod` Go
silently rewrites a missing `go.sum` entry), no capabilities field, the new
Doctor check `sandbox_go_cache_unavailable`, and the protected set.

Work and review:

1. A coding worker (`code-terra`, container writer) implemented the field,
   the sandbox arguments, the adapter wiring, Doctor and unit tests on
   `6c533ac`; the controller integrated it and wrote the native test
   `test/sandbox-shell.go-cache.bwrap.test.ts` against real bubblewrap and
   Go. On unchanged main that test fails 7 of 12; on the candidate it passes
   12 of 12.
2. Two independent reviews of different families (Anthropic, with 14
   mutation checks; Zhipu GLM) both answered `NON_BLOCKING_ONLY`. The
   Anthropic review found the main defect: the candidate bound the resolved
   path string, and a container writer, which owns its own Go cache and is
   not a trusted local peer, could swap a path component between check and
   mount. Both found that Doctor built its protected set differently from
   the adapter and reported `ok` without a probe.
3. Fix round 1 binds the checked directory descriptor
   (`--ro-bind-fd 5 /go/pkg/mod`), shares one protection helper between
   Doctor and the adapter, makes the unproven case an error, and adds the
   tests whose absence three mutations had shown.
4. A third review, OpenAI on a review snapshot of the fix head, answered
   `NON_BLOCKING_ONLY`: a workspace at or above `/go/pkg/mod` would hide the
   bind, and no test proved the swap race closed. Fix round 2 refuses such
   overlays and adds a native test that swaps the source after the check and
   before the spawn; a mutation that reopens the path makes it fail.
5. A fourth review, Zhipu GLM on that diff, answered `NON_BLOCKING_ONLY`: the
   workspace branch of the overlap rule was untested. Fix round 3, the last,
   exports the predicate and tests it. Its other suggestion, a distinct error
   text for the overlap, was not taken: the start error keeps the fixed
   `sandbox_unavailable` message of the contract, and new codes are out of
   scope.

Not covered: macOS (the sandbox is Linux-only), CI (its Go lives outside
`/usr`, so the native test skips), toolchains outside `/usr`, and nested user
namespaces, which `--disable-userns` keeps refused.

The first CI run of the pull request failed: the native test ran on Ubuntu,
where `/usr/bin/go` resolves to a tool cache that the sandbox does not bind,
and seven unit tests of the cache resolution ran on macOS, which has no
`/proc/self/fd`. The local gates had run on Linux only. The native test now
requires a toolchain inside `/usr`, and those unit tests skip outside Linux.

## Rollout and rollback

- Release line: the MCP contract is unchanged, so ADR 0003 allows a patch;
  the maintainer accepted ADR 0018 on 2026-11-02 and decides between patch
  and minor.
- Rollout: after a release, upgrade as in
  [Installation](../installation.md#upgrade); then add `goModuleCache` to one
  sandboxed review profile, point it at a dedicated cache, run Doctor and one
  review with `go test ./...` before using it widely. No writer needs
  re-provisioning, because coding profiles cannot carry the field.
- Rollback: remove `goModuleCache` from every profile first (older releases
  reject the field at startup), then reinstall the last safe release, 0.16.1
  (or 0.16.0, which the installations run today). Keep a copy of the
  configuration before the change.
