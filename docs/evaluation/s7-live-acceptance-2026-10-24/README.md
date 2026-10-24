# Sprint 7 live acceptance of the #118 candidate (2026-10-24)

Part of [Sprint 7](../../sprints/2026-10-24-s7-stabilization-live-acceptance.md).
Every result below is bound to the candidate, not to the published 0.11.2.

## Source binding

| Item | Value |
| --- | --- |
| Candidate commit | `6651a47096ad515c8075b374fd5775ee965e6067` (branch `fix/118-zombie-thread-group`), clean detached checkout |
| Package version string | `0.11.2`, unchanged on purpose; the candidate is identified by commit and digests |
| `dist/main.js` | `eebfe6ff59cfadec385ce90b58e6083c236cc83b5f18115c3368f20b80151fc4` |
| `dist/` tree (kit digest, 123 files) | `00ce08b967edf57671a7f7d75aa6dd57ef543897914eb301a699dc51ec603102` |
| `package-lock.json` | `a1390d69f83444889e9688ab0ea477fe3ec03746d908c0b20c933714a1e6c7db` |
| Packed tarball | `f897e11509b69e62397c93e022163010c9dd97bf4ee487075b28e15492e160bb` |
| Difference to the published 0.11.2 `dist/` | only `setup-platform.js` and `setup-platform.d.ts` (122 files compared); the wake path (`wake-main`, turn events, hook) is byte-identical. Runtime dependency difference: `zod` 4.6.7 instead of 4.6.5 |
| Pi SDK | 1.4.0, all family packages 1.4.0 |
| Clients | Claude Code 2.1.308, Codex CLI 0.162.1 |
| Runtime | Node.js 26.11.1, npm 12.2.1, Podman 6.1.4 (rootless, runc), Linux 7.2.10 x86-64 |
| Controller models | Claude Code `claude-sonnet-5-5` (pinned); Codex built-in default under `--ignore-user-config` (not exposed by `codex exec --json`) |
| Worker routes | read-only `explore-fast` (openai, gpt-6-luna, low); coding `code-deepseek` (deepseek, deepseek-flash, high) |
| Live limits (maintainer) | 20 worker starts, 32 worker turns, 120 minutes, one targeted rerun; no money limit was set |
| Used | 20 worker starts, 23 worker turns, about 48 minutes; the one rerun was used (W2r) |

The kit (fixtures, oracles, driver, leak scan) was prepared per cycle outside
the repository, as `docs/acceptance.md` prescribes for Level 3. The checksums
of its scripts and prompts are in [`evidence/kit.sha256`](evidence/kit.sha256);
the pre-registration was fixed before the first model turn, with an addendum
also fixed before that turn (E3b, E6b, isolation mode, budgets).

## Level 1

On the candidate checkout: `npm ci`, `npm run typecheck`, `npm run build:cli`,
`NODE_OPTIONS=--unhandled-rejections=strict npm test` (114 files, 3348 passed,
13 skipped), `npm run build`, `git diff --check` and an empty `git status`
all exit 0.

**`npm audit` fails:** 1 high (`undici` 8.10.2, pinned exactly by Pi SDK
1.4.0, [#120](https://github.com/plagor44-ux/pi-session-mcp/issues/120)) and 1
moderate (the SDK package as its dependent). The same run on the earlier
candidate `e80679e` also reported `zod` (high) and `fast-uri` (moderate); this
sprint patched those. Level 1 is therefore not green.

## Level 2

`scripts/setup-acceptance.mjs`, all four exit 0 with zero failures, real
registrations unchanged, no leftover process, no path leak, disposable homes
removed:

| Run | Checks |
| --- | --- |
| Working tree, delivery off | 160/160 |
| Working tree, `--events spool` | 228/228 |
| Packed tarball, delivery off | 160/160 |
| Packed tarball, `--events spool` | 228/228 |

Files: `evidence/l2-*.json`.

## Level 3 (ten tasks, two clients)

Strictly sequential, three invocations per client, per-invocation MCP
definitions (`--strict-mcp-config` for Claude Code, `-c` overrides for Codex),
delivery off, synthetic fixtures with baseline digests, hidden acceptance
tests outside the fixtures, a snapshot barrier before every coding follow-up.

| Task | Claude Code | Codex |
| --- | --- | --- |
| 1 Capability-led read-only analysis | passed | passed |
| 2 Same-session read-only follow-up | passed | passed |
| 3 Bounded coding change | passed | passed |
| 4 Same-session coding follow-up | passed | passed |
| 5 Abort and recovery | passed | passed |

10 of 10 tasks reached their intended outcome; every oracle check passed.
Leak scan: 0 hits, no undocumented error code. Read-only fixtures unchanged.
No candidate process and no session left after any invocation (checked at
exit and 10 s later). No `LATE.txt` or leftover `slow.mjs` 135 s after each
abort. Real MCP registrations and the production hook count unchanged.

Polling (descriptive; both clients could `sleep`): `pi_turn_get` calls per
turn 1–3, running polls 0–1.

**Gate:** every row of the [Level 3 gate](../../acceptance.md#gate) holds
except "Level 1 is green for the release source", which fails on
`npm audit` (#120). The cycle is therefore **not accepted as a release
gate**; its ten task outcomes stand as recorded.

Preflight P0 (two routes, PONG) failed once on a kit defect before any worker
started: the runbook pointed the preflight at the Level 3 configuration, whose
aliases differ, and the server answered `unknown_workspace` as documented. The
corrected preflight passed. Both attempts are in `evidence/` (`p0a-*` is the
failed one).

## Event delivery

Claude Code runs in stream-json sessions held open by the driver,
`--setting-sources project,local` (the production user-scope hook does not
take part), a private `XDG_RUNTIME_DIR`. Setup ran with a disposable home, so
ownership state stayed disposable.

| Scenario | Outcome | Observed |
| --- | --- | --- |
| E1 setup path, one turn | passed | Setup `--dry-run`, `--apply` (`applied`, `skill_installed`, `hook_added`) and `--verify` as expected; hook exactly once in the project settings. The waiter exited 2 at 16.8 s; a new controller request started 1.6 s later while idle and read the turn once; no poll, no sleep |
| E2 two concurrent turns | passed | Wakes at 22.5 s (short) and 86.1 s (long), each its own controller request about 2.1 s later; each turn read once; 0 running polls; both check ids correct |
| E3b budget wake (manual hook: 40 s budget, 100 s timeout) | passed | Budget wakes at 45.5 s and 87.5 s, each followed by exactly one read that returned `running` and re-armed the hook; terminal wake at 107.8 s, one terminal read; turn 102 s; id correct. A manual hook, not evidence for the setup path |
| E4 abort and close | passed (see note) | Abort `ok`; exactly one waiter exit 2 (A, `aborted`); closing the running B woke nothing (its waiter exited 0); A read once, B never; list empty; nothing left after 135 s |
| E5 Codex without `XDG_RUNTIME_DIR` | passed | The server environment had no runtime directory; capabilities `off`; one inactive warning, no startup failure; turn completed by polling; no wake claimed |
| E6b hook pickup, running stream-json session (CLI) | picked up | The hook was installed by setup 6 s after the session started; the next `pi_session_prompt` armed it and the wake started a new request 1.4 s after the waiter exited |

E4 note: the kit's oracle also checked that the wake started its own
controller request. Here the wake arrived while the controller was still in
its own round (closing B) and was delivered with that round's tool result.
The pre-registered E4 criteria do not require an own request, so the verdict
follows them; the oracle's extra check is recorded as failed in
`evidence/e4-oracle.json`.

### VS Code extension (E6)

The candidate was not loaded into a VS Code session: that would have replaced
a production registration, which this sprint may not do. Evidence on the
reference build only: the integrator's own Claude Code session in the VS Code
extension, with the published 0.11.2 and its setup-installed user-scope hook,
received two wakes while idle. Each started a new controller round that read
the turn once without polling (worker turns of the #118 fix and of its review,
10:03–10:22 UTC). The candidate's wake path is byte-identical to that build.
Not checked in VS Code: whether a running extension session picks up a newly
installed hook. Shortest operator check: open a project with no hook in a
VS Code window, start Claude Code there, run `pi-session-mcp-setup --apply
--target claude-code:local:pi-session-mcp` from that project in a terminal,
then ask the running session to start a worker turn and end its turn; a wake
without a restart or `/hooks` review answers the question.

## Container writer with delivery

A writer created only for this sprint: synthetic repository, alias `s7wfix`,
profile `code-deepseek`, `events.delivery` spool, installed from the packed
candidate tarball, real home (writer state, a project-local Claude Code
registration and ownership records are created there by design and were
removed).

| Step | Outcome |
| --- | --- |
| Dry runs, isolation control | planned; control `isolation_control_passed` |
| Provisioning, first apply | `writer_provisioned`, then **`writer_acceptance_failed`** |
| Provisioning, second apply | `writer_accepted` (`pass`, network `not_limited`), `writer_registered`, `hook_added` |
| `--writer --verify` | `mcp_verified`, `hook_verified` |
| W2 coding delegation by Claude Code | passed: turn 72 s, one terminal wake at 78.4 s, own request 2.2 s later, one read, no poll; worker committed `multiply` on a new branch |
| Collect, review, finish | `writer_collected`; the imported ref changes only `math.js` and `math.test.mjs`; an independent check and `node --test` on an export of the ref pass; `writer_reset` |
| W2r (the one rerun) | the delegation passed again the same way; collect, review and finish passed |
| Remove | `writer_removed`, `hook_removed`; registration gone; ownership file byte-identical to before; no container, process or writer state left |

The first acceptance failure could not be diagnosed: setup keeps only the
code and removes the harness report. The harness, run by hand with the same
arguments, passed twice. Tracked as
[#121](https://github.com/plagor44-ux/pi-session-mcp/issues/121).

Boundary checks, provider-free, with `podman inspect` and `podman exec` in a
container started through the writer's own wrapper:

- Mounts: clone (rw), clone hooks and Git config (ro), contained config (ro),
  agent copy (rw), `/pi/events` (rw, the writer's own `events/`), release (ro).
- The writers root shows only the own writer, and that only `clone`; a decoy
  namespace `s7decoy-w9` with a canary was not reachable (0 finds). Of the
  host home only the path scaffold is visible; `.ssh`, the runtime directory
  and the ownership file are not.
- Writes to `/`, `/pi`, the release and the contained config fail
  (read-only file system); `/pi/events` is one mount.

Crafted events in the writer's live instance directory (server mode, written
from inside the container), against the candidate's `wake-main` with a
synthetic running turn:

| Input | Hook result |
| --- | --- |
| Nothing | budget wake (exit 2, budget text) |
| Junk name, invalid JSON, 2000-byte file, symlinked event file, extra key, unknown state, event in a subdirectory, symlinked "instance directory" | ignored; only the budget wake |
| Well-formed `via: close` for the turn | silent at once (no wake for a closed session) |
| Well-formed forged `completed` for the turn | terminal wake (exit 2) telling the controller to read the turn once: a spurious wake, as documented |
| A second waiter for that claimed event | silent (no double delivery) |
| Next launch | removed the leftover files and the symlink |

**Not run:** the forged event during a real controller turn. In W2 and W2r
the kit's oracle ran `podman exec` with the system runtime directory, while
the client had started Podman with the private one; rootless Podman keeps its
runtime state there, so `exec` found no container and nothing was placed.
Shown afterwards provider-free (the same `exec` succeeds with the client's
runtime directory). The rerun allowance and the start limit were used up, so
it was not repeated. The controller rule it would test, that a wake is only a
trigger and the read state decides, was exercised in E3b, where each budget
wake led to one read that returned `running` and to further waiting.

## Cleanup

All sessions started by this sprint were closed. No candidate server, waiter,
worker or setup process, no container of the test writer, no spool instance
directory, no hook entry written by this sprint and no writer state remain.
The production MCP registrations, the production hook count, the controller
skills in the homes and the ownership file are unchanged. The test run
directory, the disposable homes and the installed candidate prefixes were
removed after the evidence was copied. Claude Code keeps its own project
entries for the scratch directories in `~/.claude.json` (no MCP servers);
`claude purge` can drop them and was left to the operator.

## Limits

- Ten small synthetic tasks and targeted wake scenarios on one host, one pair
  of client versions and two worker routes; not model capability on larger
  work.
- No token, cache or money figures: Claude Code reports cost only on the API
  key route, and Codex exposes no per-request count. No saving is claimed.
- Wake reaction times are single observations.
- macOS, Codex wake and the TUI were not part of this cycle.
