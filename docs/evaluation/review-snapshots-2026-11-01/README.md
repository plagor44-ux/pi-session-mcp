# Review snapshot acceptance on Linux

This record covers the acceptance steps of
[#217](https://github.com/plagor44-ux/pi-session-mcp/issues/217) that were not
run before PR #219 merged, tracked as
[#220](https://github.com/plagor44-ux/pi-session-mcp/issues/220). It follows
[ADR 0015](../../adr/0015-review-snapshots.md) and
[Execution modes](../../execution-modes.md#review-snapshots).

All runs took place on 2026-11-01 from 12:20 to 12:40 UTC on the Linux
workstation, with the installed release `pi-session-mcp@0.15.0` from npm, not a
development checkout. Clients: Claude Code `2.1.316` and Codex CLI `0.166.0`.
Git was the system Git (2.56.0). Outputs below are the setup report lines,
with paths, prompts and transcripts left out as AGENTS.md requires. A first
busy retarget call failed with `usage_invalid` because of an operator quoting
error and was repeated correctly; it is not listed.

## Configuration

- A new read-only execution profile `review-snapshot`: the shape of the
  existing `review` profile (provider `openai`, model `gpt-6.1-sol`, thinking
  `high`, skill `pi-session-review`) without its three external MCP servers.
  Every other read-only profile of this installation configures external MCP
  servers, which a snapshot workspace refuses with
  `snapshot_profile_unsupported`. The profile followed the
  `pi-session-profiles` controller skill: a candidate beside the live file,
  Doctor and `--probe-profile review-snapshot` as a dry run, then one provider
  probe (`probe_passed`, 1 provider turn, usage `unknown`), a timestamped
  backup and an atomic rename.
- A new workspace alias `pi-session-mcp-snap` with the derived path
  `~/.local/state/pi-session-mcp/snapshots/pi-session-mcp-snap/worktree`.
- `pi-session-mcp-setup --repo pi-session-mcp-snap --mode snapshot --source pi-session-mcp --apply`
  reported `mode_applied` and `controllers_restart_required`.
- Doctor then reported `snapshot_path_mismatch` and `snapshot_incomplete` ok
  and `snapshot_unavailable` as a warning, before any materialization. Its
  other findings were the known `workspace_gitfile` and `workspace_mode_unset`
  warnings of unrelated aliases.

Frozen commits, both full commit object IDs:

| Name | Commit | Meaning |
| --- | --- | --- |
| H1 | `4f5cadbeb1aa0852b20261e74907eaf2d9cde1b4` | merge of #227, tagged `v0.15.0` |
| B1 | `aed783e2f023f0aeaf3f294c8bd4376e5f977c62` | merge of #226 |
| B2 | `b0a1535a7bce58f752768cba3621505800de7d90` | first parent of B1 |

## Level 2 setup acceptance

Each line is one `pi-session-mcp-setup --snapshot pi-session-mcp-snap …` call
and its report code.

| Step | Arguments | Result |
| --- | --- | --- |
| Plan | `--head H1 --base B1` | `snapshot_planned`, exit 0 |
| Apply | `--head H1 --base B1 --apply` | `snapshot_applied`, exit 0 |
| Same target | `--head H1 --base B1 --apply` | `unchanged`, exit 0 |
| Retarget plan | `--head B1 --base B2` | `snapshot_planned`, exit 0 |
| Retarget | `--head B1 --base B2 --apply` | `snapshot_applied`, exit 0 |
| Modified slot | tracked edit to `README.md` in the slot, then `--head H1 --base B1 --apply` | `snapshot_modified`, exit 1; the edit was still present |
| Discard | `--head H1 --base B1 --apply --discard` | `snapshot_applied` and `snapshot_discarded`, exit 0; the edit was gone and the slot `HEAD` was H1 |
| Busy remove | while an idle Claude Code session held the slot: `--remove` | `snapshot_busy`, exit 1 |
| Busy retarget | same session still holding the slot: `--head B1 --base B2 --apply` | `snapshot_busy`, exit 1; the slot `HEAD` stayed H1 |
| Remove a modified slot | after the negative checks below left a tracked edit: `--remove` | `snapshot_modified`, exit 1 |
| Discard again | `--head H1 --base B1 --apply --discard` | `snapshot_applied` and `snapshot_discarded`, exit 0 |
| Remove | `--remove` | `snapshot_removed`, exit 0; the slot directory was absent and the source checkout listed no worktree for the slot |
| Plan writes nothing | `--head H1 --base B1` after the removal | `snapshot_planned`, exit 0; the slot directory stayed absent |
| Remove again | `--remove` | `absent`, exit 0 |

Doctor afterwards exited with `1` (warnings only): 261 checks ok, 30 warnings,
no error. The snapshot alias was back to `snapshot_path_mismatch` and
`snapshot_incomplete` ok and `snapshot_unavailable` as a warning. Other
warnings were the known `workspace_gitfile` and `workspace_mode_unset`, and
`writer_dirty` (five writers) and `writer_off_default_base` (two repositories)
for writers of two other repositories. Those two did not appear in the Doctor
run before materialization; this run did not use or change those writers.

## Real-controller reviews

Both controllers reviewed the same frozen head H1 against base B1, the
0.15.0 release commit. The worker prompt was identical: check the version
strings in the seven changed files and the issue references of the 0.15.0
changelog section, and answer with a `VERDICT:` line and findings. Both used
`pi_session_start` on `pi-session-mcp-snap` with `review-snapshot`.

| | Codex CLI (`codex exec`, read-only sandbox) | Claude Code (interactive, wake hook) |
| --- | --- | --- |
| Start | `ok`, 12:28 UTC | `ok`, 12:29:04 UTC |
| `session.snapshot.head` | H1, compared before the first prompt | H1, compared before the first prompt |
| `session.snapshot.tree` | `2201243aa83c65bac532413bef519bf7d36595e0` | `2201243aa83c65bac532413bef519bf7d36595e0` |
| Turn | `completed`, `completion` `stop`, `truncated` false | `completed`, `completion` `stop`, `truncated` false, 34 s |
| Waiting | 2 `pi_turn_get` polls | one wake, one `pi_turn_get` read |
| Session after the turn | `idle` (`pi_session_get`) | `idle` (`pi_session_get`) |
| Close | `ok` | `ok` |
| Worker verdict | `NO_FINDINGS` | `NO_FINDINGS` |

A snapshot session verifies the slot after every turn and publishes a turn
that would be `completed` as `failed` when that verification fails. Both
`completed` turns therefore show that the slot verified after the turn. The
Codex controller ran with the three per-run tool approvals from
[Client setup](../../client-setup.md#run-codex-without-prompts).

The controller checked the verdict against the commit: `package.json`, both
version fields of `package-lock.json`, `README.md` and
`docs/tool-contracts.md` say 0.15.0, and #210, #211, #217, #222, #223 and #224
each appear in the 0.15.0 section of `CHANGELOG.md`.

## Negative live checks

With Claude Code as the controller:

1. **Edit before a prompt.** In the review session above, after its
   completed turn, a tracked edit to `README.md` in the slot made the next
   `pi_session_prompt` fail with `snapshot_modified`. After the edit was
   reverted, a further prompt still failed with `snapshot_modified`: the
   session stays tainted. The session was then closed.
2. **Revert, then a new session.** With the edit reverted, a new session
   started on the slot (`ok`, same head and tree). A change that is made and
   reverted between two checks is not detected, as the
   [tool contracts](../../tool-contracts.md#session-start) state.
3. **Edit during a turn.** In that new session, a tracked edit to `README.md`
   was made in the same second as the prompt that started a turn. The turn
   ended `failed` (`turn_failed`) after 104 s. The session was closed, and the
   edit was the modified slot that the setup table refuses to remove.
4. **Control for check 3.** On a clean slot (the documentation commit of this
   record, materialized after the removal), a fresh session ran the same
   prompt with no edit. The turn ended `completed` (`completion` `stop`,
   `truncated` false) after 106 s. The failed view of check 3 carries no
   cause, so the two runs show that the same task completed on a clean slot
   and failed on a modified one; they do not prove which verification step
   failed it.

## Not covered

- macOS (#221).
- `snapshot_profile_unsupported` with a live profile; it is covered by unit
  tests.
- The server; snapshots were accepted on the workstation only.
