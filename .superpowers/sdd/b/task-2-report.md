# Task 2 report: boundary commands and clone layout

## Status

DONE_WITH_CONCERNS. Implemented the boundary argument builders, rootless Podman probes, image resolution, safe-ref predicate, clone-layout verification, and provider-free tests. The required full-suite run encountered only the environment failures named in the worker rules.

## Commit

One Task 2 commit on `feature/execution-modes-b`, with subject `feat(writers): build boundary commands and check clone layout`, contains this report and the three implementation/test files. The resulting SHA is supplied in the worker's final response. Starting HEAD was verified as `e13b1db`; the starting worktree was clean.

## Changed files

- `src/writer-boundary.ts`: pinned Node image reference; serving and throwaway argv; sanitized boundary errors; bounded injected-runner probes and image resolution; no-follow layout checks; ref-name predicate.
- `test/writer-boundary.test.ts`: 15 provider-free tests covering boundary restrictions, optional Go cache, positional hostile input, layout redirects and non-regular hooks, probe failures, local IDs, image pulls, and invalid inspect output.
- `test/writer-boundary.podman.test.ts`: conditional local-image smoke test with explicit offline/no-provider execution and printed skip reasons.
- `.superpowers/sdd/b/task-2-report.md`: implementation and validation evidence.

## Commands and checks

- `git rev-parse --short HEAD && git branch --show-current && git status --short`: passed; expected HEAD and branch, clean worktree.
- `npx vitest run test/writer-boundary.test.ts` before implementation: expected failure; 1 failed suite, 0 collected tests, missing boundary module. This established the TDD red step.
- `npx vitest run test/writer-boundary.test.ts test/writer-boundary.podman.test.ts && npm run typecheck`: passed; 15 tests passed, 1 skipped; TypeScript returned exit 0. Smoke test printed `podman unavailable: rootless Podman probe failed`.
- `npx vitest run > /tmp/task-2-vitest.log 2>&1; result=$?; tail -n 110 /tmp/task-2-vitest.log; exit "$result"`: failed with the known environment limitations; 1,711 tests passed, 8 failed, 7 skipped (72 files passed, 3 failed, 1 skipped).
  - Three waiter tests in `test/override-lock.test.ts` timed out.
  - Four process concurrency tests in `test/skill-customize-concurrency.test.ts` timed out.
  - `test/package-contents.test.ts` failed because its `npm pack --dry-run --json --ignore-scripts` subprocess encountered ENOSPC.
- `git diff --check && git status --short && git diff --stat && node --version`: passed; only the three new task files were present at that point; Node was `v22.23.3`. The report was added afterward.

- Initial `git add src/writer-boundary.ts test/writer-boundary.test.ts test/writer-boundary.podman.test.ts .superpowers/sdd/b/task-2-report.md && ...`: stopped at staging because `.superpowers` is ignored. The three code/test files were staged; no commit occurred. The explicitly requested report is force-added below.
- Final staging/commit command: `git add -f .superpowers/sdd/b/task-2-report.md && git diff --cached --check && git diff --cached --stat && git -c user.name=pi-worker -c user.email=pi-worker@example.invalid commit -m "feat(writers): build boundary commands and check clone layout" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git rev-parse HEAD && git status --short`. The final response records its observed outcome.

## Self-review

- No dependencies added and no existing implementation or test files changed.
- Both argv builders use explicit environment values and never forward the host environment or enable privilege escalation. Serving uses the recorded immutable image ID and read-only Git hooks/config submounts.
- Throwaway clone mounts preserve the absolute clone path and set that workdir; requested bundles mount at `/bundles` read-write. Optional base mounts at `/base` read-only. No agent/config/credential mounts enter throwaways. Scripts remain caller-provided constants; argument values are appended after the `sh` argument following `-c`.
- Every Podman invocation receives a timeout signal using the existing runner timeout constant. Errors suppress command output and return stable boundary codes (or an unusable probe result without version).
- Image inspection accepts full lowercase 64-hex IDs with an optional `sha256:` prefix and returns the bare ID. Only `node` with an explicit pull permission can trigger a pull after a failed inspection.
- Layout checks use `lstat`, including forbidden metadata entries and hook files, so dangling symlinks are not treated as absent. Symlinked hook directories are refused as well. This is a layout check, not a race-free filesystem snapshot.

## Concerns and remaining verification

- Real Podman execution and the accepted local image were not verified: the rootless probe failed in this environment. No container mutation or dogfooding is claimed.
- The full suite is not green due to the explicitly documented environment failures; no unrelated fixes were attempted.
- The brief did not specify the optional base mount destination; the helper uses `/base:ro`, with `/bundles:rw` matching the downstream provisioning and collection scripts. Callers should use those destinations.
- Timeout enforcement relies on the injected runner honoring its abort signal, as required by the CommandRunner contract.
