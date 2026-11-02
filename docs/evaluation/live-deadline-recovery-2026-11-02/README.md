# Live turn deadline and recovery export on v0.16.1 (2026-11-02)

Targeted live checks of [ADR 0017](../../adr/0017-turn-duration-limit.md)
(turn deadline) and [ADR 0016](../../adr/0016-writer-recovery-export.md)
(recovery export) against the published release `0.16.1`, installed with
`npm install` into a fresh prefix. Run from 18:46 to 18:56 UTC. They are not a
Level 3 cycle.

## Setup

- Host: Linux 7.3 (`x64`), Node.js `26.13.0`, Podman `6.1.4` rootless,
  bubblewrap `0.13.1`, systemd `262`.
- Configuration: temporary, credential-free, with two synthetic workspaces: a
  plain directory in mode `read-only`, and a one-commit Git repository in mode
  `container` with one persistent writer on the built-in `node` image, created
  for this check with `--repo <alias> --mode container --profiles … --writers 1
  --apply` (`writer_provisioned`, `writer_accepted`; `--writer <name>
  --verify` `mcp_verified`). Doctor reported `ok` without warnings.
- Profiles: a `read-only` profile with `shell: "sandboxed"` on `openai`
  `gpt-6-luna` and `maxTurnSeconds: 60`; a `coding` profile on `deepseek`
  `deepseek-flash` with `maxTurnSeconds: 60`; a `coding` profile on the same
  model with `maxTurnSeconds: 900`. Capabilities reported 60, 60 and 900.
- Driver: a scripted MCP stdio client that polled `pi_turn_get` every
  5 seconds. Event delivery off. No production registration, writer or
  configuration was used or changed.

## Turn deadline

One deadline attempt and one control turn per placement, in the same session.
The worker was asked to run `sleep 150` through its shell.

| Placement | Deadline turn | Duration | Control turn | Close, list |
| --- | --- | --- | --- | --- |
| Host, sandboxed shell | `aborted`, `abortReason: "deadline"` | 60.03 s | `completed`, `completion: "stop"`, 1.9 s | ok, empty |
| Container writer | `aborted`, `abortReason: "deadline"` | 60.49 s | `completed`, `completion: "stop"`, 2.0 s | ok, empty |

- The session stayed reusable after the deadline abort in both placements;
  neither start nor prompt returned `turn_deadline_uncertain`.
- No `sleep` process and no sandbox scope remained on the host after the host
  check, and no container remained after the writer check.
- The writer start reported the writer and the base `main` at the fixture's
  commit. After the session closed, `--writer <name> --collect --apply`
  reported `nothing_to_collect` and `--finish --apply` `writer_reset`: the
  deadline left no change in the clone.

## Recovery export

- A coding session on the same writer (profile with 900 s) ran one Git command
  line inside the writer: create a branch, commit a change to one line, switch
  back, commit a different change to the same line, merge. The turn ended
  `completed` in 3 s with the merge stopped on a content conflict and the
  path unmerged. The session was closed and the list was empty.
- `--writer <name> --collect --apply`: `writer_collect_failed`, exit 1. Collect
  refuses an unmerged index, as designed.
- `--writer <name> --recover` (dry run): `writer_recover_planned`; the
  operator checkout's refs were byte-identical before and after.
- `--writer <name> --recover --apply`: `writer_recovered`, slot 1. The operator
  checkout gained exactly five refs under `refs/recovery/writer-<name>/1/`:
  `stage1`, `stage2`, `stage3`, `worktree` and `manifest`.
- Content, read in the operator checkout only:
  - `stage1` held the merge base, `stage2` the current branch's side and
    `stage3` the merged branch's side of the conflicted file;
  - `worktree` held the file with conflict markers naming both sides;
  - the manifest held `HEAD`, `MERGE_HEAD` and the three raw unmerged index
    entries; the `HEAD` commit and its parent were present as history. The
    merged branch's commit itself was not imported, as ADR 0016 section 5
    lists other local branches as not exported; its content is preserved in
    `stage3`.
- After recovery, `--finish --apply` was still refused
  (`writer_collect_failed`), as ADR 0016 section 6 requires.

## Cleanup

The recovered content was synthetic and verified above, so the writer was
then reset with `--reset --discard --apply` (`writer_reset`) and removed with
`--writer <name> --remove` (`writer_removed`). The writer's state directory
and container no longer existed, and the count of other writers on the host
was unchanged. The temporary configuration, fixtures and prefix were deleted
afterwards.

## Not covered

A deadline that the server cannot confirm (`turn_deadline_uncertain`), a
deadline during a provider stream that ignores cancellation, recovery of
untracked or stage-0 content beyond the conflicted file, more than one
recovery slot, and macOS.
