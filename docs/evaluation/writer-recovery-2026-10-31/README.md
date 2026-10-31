# Writer recovery export prototype

This is the provider-free experiment for
[issue #213](https://github.com/plagor44-ux/pi-session-mcp/issues/213). It
supports [ADR 0016](../../adr/0016-writer-recovery-export.md).

The development-only `recoverWriter` (`eval/recovery/recover.ts`) does five
things:

- takes the writer lease;
- reads the writer state and checks the alias;
- runs a container script through the existing throwaway-container arguments
  with the recorded image;
- imports the resulting bundle into the operator checkout under
  `refs/recovery/writer-<name>/<slot>/`;
- removes the bundle.

Nothing in `src/` changes.

The tests (`test/writer-recover-real-git.test.ts`) use the real-Git harness of
`test/writer-collect-real-git.test.ts`, which this sprint extracted to
`test/real-git-writer-fixture.ts`. That harness runs the container script
locally against a real writer clone and a real operator checkout.

Run from the repository root:

```sh
npx vitest run test/writer-recover-real-git.test.ts test/writer-collect-real-git.test.ts
```

## Recorded runs

**Run 1.** The implementing worker was `code-terra` (OpenAI `gpt-6.1-terra`) in
container writer `pi-session-mcp-w1`, on base `614a8db`.

- The first turn ended `BLOCKED`. The worker had read the boundary rule as
  forbidding host Git in a test fixture, and this was clarified in the same
  session.
- The next turn stopped early, after about 70 s, having only extracted the
  fixture. One follow-up restated the goal.
- Commits `014d026` and `5055e7a` were integrated as `374050b` and `554dd61`.
- The controller re-ran both files on the host: 14 recovery tests and 31
  collect tests passed.

**Cross-family review.** The reviewer was `review-sonnet` (Anthropic Sonnet
5.5, read-only) on `554dd61`. The verdict was `NON_BLOCKING_ONLY`: no defect
that lets the prototype change the writer or a collection digest.

The controller checked these test weaknesses against the code and confirmed
them:

- The deleted-side test could not tell a missing stage ref from a stage tree
  without the file.
- The refusal test asserted only `failed`, with no code.
- The byte-identity snapshot left out `.git/objects`, `.git/config` and the
  other files.
- The manifest was checked only by its line count.

It also confirmed these prototype gaps:

- no state or alias check;
- the image was the default rather than the recorded one;
- the manifest was imported first;
- forced refspecs were used;
- no slot was given on a partial import;
- the manifest was a newline list instead of `-z`.

The remaining findings went into the ADR as decisions or open points. These
were:

- fence and lock order;
- the filter and attributes policy;
- unsupported content classes;
- the slot cap;
- fsck on import;
- the bundle left after a kill.

**Run 2: fix round.** The worker was `code` in a fresh session on writer
`pi-session-mcp-w1`, base `b23d979`. Commit `635074b` was integrated as
`c248bf1`.

The controller re-ran on the host:

- Node `v26.12.1`, Git `2.56.0`;
- `uname -sr`: `Linux 7.3.0-5-cachyos`;
- result: 21 recovery tests and 31 collect tests, 52 of 52 passed;
- `tsc --noEmit`: clean.

Mutations on the host. Each was reverted afterwards:

| Mutation | Result |
| --- | --- |
| Manifest written newline-separated instead of `-z` | 6 of 21 failed |
| Container script also writes a file into the clone's `.git` | 6 of 21 failed (byte-identity snapshots) |
| Alias check removed | 1 of 21 failed |

Exact refusal codes after a recovery, as pinned by the tests:

| Operation | Code |
| --- | --- |
| collect | `writer_collect_failed` |
| finish | `writer_collect_failed` |
| remove | `writer_inspect_failed` |
| reset | `writer_inspect_failed` |
| recreate | `writer_inspect_failed` |

The clone stays byte-identical across all five.

## Recovery tests at run 2, all passed

- recovers the worktree and all three index stages into a new slot
- leaves the writer byte-identical
- keeps collect, finish, remove, reset and recreate refused after recovery
- adds a second slot without touching the first
- plans without writing
- reports nothing_to_recover without an unmerged index
- records a deleted side
- handles conflicted names with spaces and newlines
- recovers a symlink conflict
- recovers an add/add conflict without a stage1 ref
- recovers two conflicted paths in every applicable stage tree
- does not export staged-only content (known limit)
- rejects an alias mismatch without running commands or importing refs
- rejects missing state without running commands or importing refs
- uses the recorded image and imports the manifest last without forced refspecs
- fails and rolls back rather than overwriting an existing destination
- refuses a gitlink in conflict
- fails cleanly on a missing stage object
- refuses while the writer lease is held
- leaves no bundle behind
- rolls back a partial import

In the container writer, the full suite showed the eight lock,
skill-concurrency and wake-hook timeouts that AGENTS.md expects there. They
are unrelated to these files.

## Review of ADR 0016

Two independent read-only reviews of the ADR, one from a Pi `review` session
(OpenAI `gpt-6.1-sol`) and one from a Claude reviewer, both returned
`BLOCKING_FINDINGS`. The controller checked each finding against the code,
or with Git, before revising the ADR.

- **Create-only import.** The ADR claimed that a fetch without `+` fails on
  an existing ref. It does not. With Git 2.56.0, the controller made a
  non-forced fetch into a ref that held an ancestor of the fetched commit,
  and Git fast-forwarded it with exit 0. The prototype's test "fails and
  rolls back rather than overwriting an existing destination" passes only
  because `recover.ts` checks each destination before fetching, and that
  check races with the fetch.
- **Revised import.** The ADR now fetches objects only, by bundle head name
  with no destination and `--no-write-fetch-head`, and creates all refs in
  one `update-ref --stdin` transaction of `create` commands. The controller
  checked both with Git 2.56.0:
  - the fetch wrote no ref and no `FETCH_HEAD`;
  - a transaction whose second `create` hit an existing ref failed at
    `prepare` and left the first ref uncreated.
- **Gaps closed in the ADR.** The ADR had left these open:
  - the manifest cross-check had no defined place before the import;
  - an untracked nested repository becomes a gitlink under `add -A`;
  - the rollback outcome was undefined;
  - the inherited codes were not listed;
  - the bundle-removal failure was not covered;
  - the script's `node` requirement was not stated.
- **Wrong facts.** These have been corrected:
  - finish collects without inspecting;
  - the digest is cleared at `writer-lifecycle.ts:396`;
  - Doctor ignores `base.bundle`;
  - reset and create mount the clone read-write;
  - the dry run only resolves the alias.
- **Versioning.** ADR 0003 covers only the MCP contract. The revised ADR says
  so and recommends a minor release from precedent.
- **Re-review** (`review`, OpenAI `gpt-6.1-sol`, read-only): seven of the
  eight earlier findings were resolved and one partly. Three new findings
  were checked by the controller, two of them with Git 2.56.0:
  - Without `--no-deref`, `create` followed a dangling symbolic ref at the
    destination and created `refs/heads/sentinel` outside the recovery
    namespace, with exit 0.
  - With `--no-deref`, a dangling and a live symbolic ref were both refused
    at `prepare`.
  - A ref transaction is not crash-atomic in the files backend, so "a
    complete slot or none" was wrong.
  - The Doctor gate runs before the lifecycle's state and alias check, not
    after it.

  The second revision imports the parts in one `--no-deref` transaction,
  then the manifest ref in a second one, as the completion marker. It
  defines and reports incomplete slots, and states the Doctor-gate order. No
  third review was run, per the plan's limit of one re-review.

## Limits

- **No real container boundary.** The harness runs the script on the host,
  without the read-only clone mount, `--network=none` or the 1 GiB `/tmp`. No
  Podman case ran.
- **Not the full operation.** There is no setup lock, no fence (`ensureWriterAbsent`)
  and no Doctor gate. The prototype takes only the lease.
- **Lease fd not checked.** `realRunner` ignores `inheritFds`, so nothing
  shows the lease descriptor reaching the commands.
- **Uncovered cases.** There is no D/F conflict, no non-UTF-8 path bytes, no
  worktree larger than the scratch space, and no FIFO in the worktree.
