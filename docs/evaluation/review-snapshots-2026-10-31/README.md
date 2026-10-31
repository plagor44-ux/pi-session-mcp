# Synthetic review snapshot proof

This provider-free experiment for [issue #209](https://github.com/plagor44-ux/pi-session-mcp/issues/209) exercises a possible read-only review snapshot using real Git objects and detached linked worktrees. It binds a selected base, head and tree, reads the selected head with the built package's actual confined `read` tool, and checks that subsequent operator edits do not change that view. Verification detects changes to the snapshot, a moved head, missing objects and gitlinks. The script creates only synthetic repositories and cleans its temporary root on exit.

Run from the repository root:

```sh
npm run build && node docs/evaluation/review-snapshots-2026-10-31/snapshot-proof.mjs
```

## Recorded run

The run was inside a container writer: Node `v22.23.3`, Git `2.39.5`, `uname -sr`: `Linux 7.3.0-5-cachyos`. Both build and script exited 0. The script output was:

```jsonl
{"case":"setup","expected":"ok","observed":"ok","pass":true}
{"case":"reads-selected-head","expected":"feature","observed":"feature","pass":true}
{"case":"operator-edits-do-not-leak","expected":"feature","observed":"feature","pass":true}
{"case":"snapshot-edit-detected","expected":"snapshot_modified","observed":"snapshot_modified","pass":true}
{"case":"head-moved-detected","expected":"snapshot_head_changed","observed":"snapshot_head_changed","pass":true}
{"case":"missing-object-fails-before-start","expected":"snapshot_object_missing","observed":"snapshot_object_missing","pass":true}
{"case":"symlink-escape-rejected","expected":"rejected","observed":"rejected","pass":true}
{"case":"git-metadata-outside-roots","expected":"rejected","observed":"rejected","pass":true}
{"case":"submodule-detected","expected":"snapshot_submodule_present","observed":"snapshot_submodule_present","pass":true}
{"case":"cleanup-preserves-operator-work","expected":"preserved","observed":"preserved","pass":true}
```

The `.git` file itself is readable within the snapshot; the tested common Git directory's `HEAD` and `config` paths are outside the allowed roots. Clean removal preserved the operator's branches and dirty edit, while removal without force refused a modified worktree.

## Limits

This is provider-free and starts no Pi session or network activity. It uses host Git from `PATH`, not a trusted fixed binary. A detached linked worktree shares the operator's object store and refs. Its files remain writable by the host user: verification detects changes rather than preventing them. Confined read tools are not OS isolation. Extension/MCP grants and the sandboxed shell were not exercised. This synthetic run does not establish a production implementation or protection against concurrent or adversarial host changes.
