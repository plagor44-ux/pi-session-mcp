# Ledger, event bridge and controller rewake: evaluation report

Date: 2026-10-21. Base main `0922d98f0fb33d3c493dc428dfef932443bfa4fa`, package
0.10.0, Pi SDK 1.3.0, MCP SDK 2.3.1, Claude Code CLI 2.1.303 (VS Code extension
2.1.304), Codex 0.162.1, Node 26.11.1, Linux. Tracking:
[#104](https://github.com/plagor44-ux/pi-session-mcp/issues/104); sprint file:
[Sprint 6](../../sprints/2026-10-21-s6-ledger-event-bridge.md).

Companion files: [pre-registration](pre-registration.md) (fixed before any
comparative run, commit `569c89f`), [design](design.md), [inventory](inventory.md)
(source and documentation facts), [live plan](live-plan.md) (not approved) and
the probe evidence in [`probe/`](probe/).

Each claim names its evidence level: L0 source or docs, L1 unit test, L2 host
event, L3 client wake with a scripted fake model, L4 real controller model.
Everything up to L3 is provider-free. **L4 was reached for two approved
pairs** (case L1, arm A and arm C, one run each per pair; see
[`live/`](live/README.md)).

## Verdict

**The current procedure stays.** That means the controller skill's internal
ledger with consume-once and the #86 cadence. **A lean event bridge from the
existing SDK completion, with a targeted Claude Code integration, is
technically viable at the client level (L3)**, and in two real-model pairs (L4)
the woken controller read each turn once, without polling or sleeping. It does
**not** pay off in controller requests or tokens for short tasks:

- requests were 7 against 8 and 8 against 8;
- uncached input and cost were mixed;
- the pre-registered product rule is **not met**.

What it does improve consistently is latency: the controller acted on a
finished turn after about 2 s instead of 10–21 s with polling. The
recommendation is therefore **not to build it now**
([ADR 0011](../../adr/0011-turn-events-and-controller-wake.md) stays Proposed,
with a recommendation to defer). Revisit if long worker turns, worker
questions or reaction time become the bottleneck. The request saving that the
model predicts for long turns is still unmeasured.

- **File ledger:** not recommended as a product feature. It helps a human
  overview and context continuity after compaction. It does nothing for tokens
  or notification. A hook can keep it current without the model (L2: a
  host-side write during real client runs); that is a development aid, not a
  monitor.
- **Deterministic supervisor:** not recommended. The registry already has
  exactly one terminal transition. Periodic reading adds latency and a second
  trigger, and still needs the same delivery path to reach the controller.
- **Bounded wait (#91):** stays rejected. Rewake is a separate mechanism; this
  evaluation does not reopen #91.
- **Question channel:** a structured worker question works end to end on L1
  (real `AgentSession`) and L3 (real client). It needs a new answer path (a
  tool), which is a public contract change: its own decision and a minor
  release.

## Verified orchestration today

As of `0922d98`, the controller starts sessions and prompts. `pi_session_prompt`
returns a running turn at once, and the controller polls `pi_turn_get`
(10 s, then every 15–30 s), reads a terminal turn once, verifies the result
itself and closes the session. Nothing tells the controller that a turn ended
(L0). The registry's terminal transition is already the settled end of the SDK
run, including retries, compaction and queued follow-ups. `agent_settled` comes
before `prompt()` resolves, and `agent_end` can occur several times per run (L0
and L1, order observed on the faux provider:
`agent_end(willRetry=true) > auto_retry_start > … > agent_end(willRetry=false) > agent_settled > prompt resolved`).
Extension UI dialogs return their no-op defaults. A worker cannot ask a
question that waits for an answer. Separate client processes have separate
registries (L1 in process, and X6 with two real stdio server processes
driven by the MCP SDK client: the second returns `unknown_session` and an empty
list).

## Answers

### 4.1 Is a ledger needed?

| Information | Covered today by | Gap |
| --- | --- | --- |
| a) task state (scope, base, dependencies, acceptance) | skill ledger in the controller context; sprint documents for humans | lost from context on compaction unless re-derived; nothing machine-readable |
| b) last observed runtime state | `pi_turn_get` (authoritative) | none while connected; after a client or server restart all IDs are history |
| c) verified acceptance | controller's own checks | not recorded anywhere structured |
| d) event delivery and controller resume | **nothing** | the controller must poll; an idle controller is never told |

Several sessions, follow-ups and retries fit the skill's ledger as long as the
context holds. The real gap is d), and for a) only compaction. Several
independent controllers cannot share sessions at all (separate registries), so
a shared ledger would only list dead references. A restart or resume use case
is not documented (ADR 0003 trigger D not met). A snapshot would not restore Pi
sessions anyway.

### 4.2 Format and owner

| Option | Fit |
| --- | --- |
| Internal ledger (skill) | enough for one controller; no cost; lost on compaction |
| Native client task tools | not available in the evaluated Claude Code session; not assessed |
| `task.md` by hand | model writes it: costs model output and drifts |
| `run.json` + generated `task.md` | prototype: pure reducer, one locked writer, revision check, atomic rename, content-free validation, generated view (L1, 25 tests) |
| JSONL journal | no shown benefit over a snapshot with `appliedEventIds` |
| SQLite | no multi-writer or query need |
| OMO Boulder | unlocked `writeFileSync`, last writer wins; re-prompts the same session on idle; not a monitor (L0, summarized reads) |

Owner: the controller, through one serialized writer. The prototype's hook
writer is the integration route that needs no model. Pi stays authoritative for
runtime state; only `controller` events may accept or reject (L1).

### 4.3 Automatic status updates

| Option | Owns connection and sessions | Source of transitions | LLM per poll | Reaches a busy/idle controller | Loss, EOF, cleanup | New surface |
| --- | --- | --- | --- | --- | --- | --- |
| SDK completion bridge in the owning server | the existing server | registry terminal transition, once per turn | no | via a client adapter (rewake) | `instance_ended`; running turns become unresolved | internal observer + local event spool |
| Controller hooks after Pi calls | client | only what the controller already read | no (hook), but still polls | no | no own state | client config |
| Deterministic supervisor | must be the same process, or it sees an empty registry | periodic reads | no | needs the same adapter | as bridge | timer, second trigger |
| Proxy on the existing connection | proxy | MCP traffic | no | only by injecting into the client | proxy lifetime = connection | protocol proxy |
| Bounded wait | server | registry | one blocking call | yes, inside a call | client tool timeouts | public argument; rejected in #91 |
| MCP notifications, subscriptions, tasks | server | registry | no | not in Claude Code: no notification starts a turn; tasks not supported; channels gated preview | — | protocol features the client lacks |

A second stdio client gets its own empty registry (L1, X6). A supervisor
therefore has to live in the owning server. There it is a timer around the same
registry. The bridge covers the same ground without polling the registry.

Polling does not disappear entirely; it moves out of the model. The
host-side waiter is a model-free local poller: one sleeping process per armed
turn, with `fs.watch` on the spool directories plus a full directory scan every
200 ms. In the probe the watch path delivered (16–34 ms). The 200 ms scan alone
was not measured. The cost is one process and a few inotify watches per waiting
turn, and no model request.

### 4.4 Controller resume without model polling (Claude Code 2.1.303, L2/L3)

Probe on a loopback fake Messages API with a dummy key, inside a fresh user and
network namespace, four attempts preserved ([`probe/`](probe/)). Attempt 1 had
harness defects (wake parsing, missing waiter signal log). Attempts 2 and 3
produced the same results on the frozen review head. Attempt 4 ran after the
review fixes: same outcomes, and in S8 the close-generated `turn_terminal` now
comes before `instance_ended`.

| Scenario (attempt 3) | Result |
| --- | --- |
| S1 completion, idle stream-json session | one wake (own model request) **16 ms** after the bridge event; one terminal read; 0 running polls (by construction: the scripted model never polls) |
| S2 two concurrent turns | two wakes in completion order, each matched to its turn (16, 17 ms); no missing or duplicate wake |
| S3 controller question round trip | question wake (17 ms) → `eval_question_get` → `eval_question_answer` → the scripted worker's waiting ask continued → terminal wake (34 ms) → one read; the answer digest reached the worker's final text. The worker is the scripted adapter; continuation of a real Pi tool call is L1 (faux provider) only |
| S4 control with plain `async: true` | hook exited 2, **no wake** |
| S5 one-shot `-p "<prompt>"` | **pre-registered expectation not met** (attempts 2 and 3): the client held the next model request until the hook ended (8.4 s) and delivered the wake text with the tool result, then exited; no leftover |
| S6 hook timeout 4 s, worker 15 s | client killed the waiter at 4 s (exit 143); the completion 11 s later woke nobody; no leftover |
| S8 stream-json, stdin closed after one message | client exited after about 0.4 s; the server closed the running turn as aborted; the waiter claimed that close-generated event and exited 2 before the client exited, but no model request followed (no wake at L3); no leftover |
| X6 two server processes, same aliases | no shared registry |

Every run: no leftover hook or server process, temporary root removed, no path
or canary in any output. In the Claude scenarios the client ended the server
by signal (`instance_ended` = `server_exit`).

The four kinds of evidence stay separate. A spool file is a host-side record
(L1). A hook start or exit in the stream is L2. A new model request at the fake
is L3. A real model choosing the right call is L4. That was tested twice
for completion (arm C of both live pairs). It was not tested for questions.

Interactive TUI and the VS Code extension were not tested. The extension uses
the same stream-json input, which S1–S3 exercised, but that is an inference.
Codex has no documented wake path (L0).

### 4.5 Earlier cost measurement

#91 stands: 1–3 running polls per turn on the Codex route, no consistent uncached
difference. That A/B did not compare push, rewake, a supervisor or a ledger.
The rewake makes running polls unnecessary for delivery: in S1–S3 the turn
end and the question reached an idle client without any poll. Those runs show
0 polls only because the scripted model never polls. Whether a real model stops
polling is the L4 question. Each event costs one wake request. A model-based expectation from the skill cadence (not a
measurement): for a turn of `T` seconds the skill gives `ceil((T − 10) / c)`
running polls for `T > 10 s`, with `c` = 15–30 s. That is 1–3 for the M1 cases
(about 50–100 s), so C saves at most about two model requests per turn there. A
10-minute turn would need about 20–40 polls against one wake. The benefit grows
with turn length and with questions; for short turns it is close to neutral.
This expectation was the reason for the L4 pairs. On the short case they confirmed it: no request saving (see [`live/`](live/README.md)).

### 4.6 Completion and questions

**A. Completion.** The bridge emits one content-free `turn_terminal` per turn from
the registry read model (L1, 22 bridge tests: concurrent turns, follow-ups,
duplicates, late settlements, `abort_timeout` with a later outcome, close,
shutdown, many activity callbacks with no early event). `agent_settled` is not
used as a second source. The independent review found that the first version
filled a `close` race from the adapter outcome and could report `completed`
for a turn the registry had aborted after `abort_timeout`. The bridge now
reports only read-model states, or `turn_unobserved` when close removed the
turn first (see *Independent review*). A side check against the real
`SdkPiSessionAdapter` (scratch test, not committed) found that an abort during a
running tool ends the SDK run with `stopReason: "error"`, yet the public turn is
`aborted` in 60 of 60 runs per variant. The abort path completes first by
microtask order, and the later `failed` outcome is ignored. Correct today, but
it depends on that order.

**B. Questions.** Human questions: MCP elicitation reaches the user or an
`Elicitation` hook, never the model. Under protocol 2026-07-28 it is only
possible inside a pending `tools/call`, so a question that arises long after
`pi_session_prompt` returned cannot be sent (L0). Controller questions: an
explicit worker tool (`ask_controller`, evaluation only) on a separate broker
works. On a real `AgentSession` (faux provider, L1), `prompt()` stays pending
and `isStreaming` stays true while the tool waits. The answer reaches exactly
the waiting call. Abort fires the tool's signal and cancels the question. A
prompt on the same session is rejected with `session_running`, so it cannot
deadlock as an answer path. The broker tests cover concurrent questions, wrong
instance, duplicates, late answers, deadlines, limits and content-free events.
A host UI context (`bindExtensions({ uiContext })`) would serve only extension
dialogs, needs about 30 members and gives the worker model no way to ask. The
explicit tool is smaller. Normal assistant questions in result text stay plain
text; no text is interpreted as a signal.

**C. Real resume.** Bridge event → correlation → spool → `asyncRewake` waiter
claims the event exactly once → exit 2 → client starts a new model request
(L3) → `eval_question_answer` → broker → waiting tool call continues → final
wake → one terminal read (S3). The real-model edge is untested.

A waiter exists only while a hook armed it. It is armed after
`pi_session_prompt`, after `eval_question_answer`, and (after the review) after
a `pi_turn_get` that shows a running turn. These gaps remain. The client kills
the waiter at its hook `timeout` (S6), so the timeout must cover the task
budget. A failed MCP call is likely routed to `PostToolUseFailure`, which is not
armed or tested. A controller that ends its turn without an armed waiter is
never woken.

## Comparison matrix

| | A current | B hook ledger | C bridge + rewake | D supervisor |
| --- | --- | --- | --- | --- |
| Overview and context continuity | context only | `run.json`/`task.md` survive compaction | same as A, plus B if wanted | none |
| LLM in status checks | every poll | every poll | none for running turns | none |
| Real notification and resume | none | none | client wake L3 (stream-json; `-p` blocks); real model L4 in two pairs (completion) | needs C's delivery |
| State and connection owner | server | server; ledger by hook | server; spool per instance | must be the same server |
| Restart and cleanup | IDs become history | ledger marks unresolved | `instance_ended`; waiter ends at budget, parent loss or claim loss | as C |
| Client dependency | none | Claude Code hooks (Codex has hooks too) | Claude Code `asyncRewake`; not Codex | as C |
| Implementation and maintenance | none | small | observer, spool, setup-managed hook, waiter | timer plus C |
| Decision or contract needed | none | none (dev aid) | ADR; spool is a new local surface; question tool = minor release | ADR |
| Evidence | M1 A/B (Codex); two L4 runs (Claude) | L1, L2 | L1, L3; two L4 pairs | L1 partial; detection-only arm skipped |

## Prototype

`eval/bridge/` (about 3,000 lines) with 91 provider-free tests in five files.
Not in the runtime path or the npm package. No `src/` change.

- `ledger.ts`, `ledger-store.ts`, `ledger-cli.ts`: reducer, locked store,
  generated `task.md`, CLI.
- `bridge.ts`: `EventBridge`, `SpoolSink`, `BridgedRegistry` (subclass of the
  real registry).
- `questions.ts`, `ask-tool.ts`: broker and the `ask_controller` tool.
- `scripted-adapter.ts`: deterministic worker scripts.
- `server-main.ts`: evaluation stdio server (real `createServer`, plus
  `eval_question_get` and `eval_question_answer`).
- `hook-waiter.ts`: `asyncRewake` waiter with claim files, budget and
  parent-loss exit.
- `hook-ledger.ts`: PostToolUse ledger projection, storing result hashes only.
- `claude-probe.ts`, `cli.ts`: the L3 probe.
- `live/`: the approval-bound runner for the L4 pair, with a provider-free dry
  run.

Tests: 163 in `bridge-ledger`, `bridge-ledger-lock`, `bridge-events`,
`bridge-sdk-faux`, `bridge-hooks` and `bridge-live`.

Ledger limits that are deliberate:

- `abort_unconfirmed` is not sticky. After `abort_timeout` the turn may still
  finish normally, so a later `completed` from the read model is recorded.
- `decision` after `instance_ended` is allowed only for a result that was
  consumed (hash recorded) while connected.
- A lock left by a killed writer is never broken automatically. The ledger hook
  waits at most 1 s for it and skips. `run.json` and `task.md` are separate
  renames, so a crash between them leaves a stale view until the next write.

## Independent review

Two independent reviews of the frozen head `1289137`:

- a Claude reviewer (Opus 5.5) with test runs and reproductions;
- a read-only Pi worker on `review-grok` (xAI Grok 4.7, another model family).
  It ran 15 minutes; the controller needed 6 running polls and one terminal
  read for that one turn. That is an anecdote for arm A, not a measurement.

Both found the same defect: after `abort_timeout`, `close` could report
`completed` for a turn the registry had aborted, a hidden second status source.
It is fixed by `turn_unobserved` and has a regression test. Confirmed and
fixed:

- `instance_ended` was emitted before the close terminals at shutdown.
- Re-arm gaps: an answer error carried no IDs, and nothing re-armed after a
  running `pi_turn_get`.
- A claimed but undelivered wake stayed claimed when the client killed the
  hook.
- A lock was left behind when the pid write failed.
- Spool write failures were uncounted.
- A non-`EEXIST` claim error was unhandled.
- An empty budget was read as zero.
- A question was not re-checked before its wake.

Documentation was corrected in these places:

- the S5 expectation is stated as not met;
- S8 is described correctly;
- the 200 ms local scan is disclosed;
- "0 polls" is stated as true by construction;
- the verdict is made conditional per the pre-registration;
- the evidence levels of S3 and the ledger hook are fixed.

Open and accepted as limits: overlapping waiters of one turn can both send a
budget wake; a hook killed between claim and exit can still lose a terminal
wake that a sibling waiter already gave up on; `PostToolUseFailure` routing is
untested.

## Not measured, not tested, unknown

L4 beyond two pairs (completion only, short case L1, one client version and
model); long worker turns; a
question round trip with a real model; worker usage; interactive
TUI and VS Code wake; Codex; a supervisor-only detection arm (S7 skipped: the
registry subclass has no supported way to switch off its event trigger);
`PostToolUseFailure` projection into the ledger; a worker finishing before its
waiter starts (handled by the persistent spool, not exercised in a client run);
why S5 (positional prompt) blocks while S8 (stream-json, stdin closed) exits.

## Strongest objection, critical assumption, simpler alternative, next test

- **Strongest objection:** polling already costs only 1–3 calls per turn on the
  measured route. The rewake works only in Claude Code. And it needs a new local
  surface (event spool), an installed client hook and, for questions, a new
  public tool: a lot of surface for a saving that may be small.
- **Critical assumption:** a real controller model, once woken, reads the turn
  once and does not poll anyway. Hook budgets also have to fit long tasks, since
  the client kills the waiter at its timeout (S6).
- **Simpler alternative:** keep the skill cadence and add one rule: for long
  tasks, poll at the long end of the cadence. No mechanism, no contract.
- **Critical assumption, checked twice:** it held in both live C runs (one
  wake, one read, no poll, no sleep).
- **Smallest next test, only if revisited:** one pair with a long worker turn
  (several minutes), where the model predicts a request saving, rather than the
  full short-task matrix.

## Reproduction

```sh
npm ci
npx tsc -p tsconfig.bridge.json
npx vitest run test/bridge-ledger.test.ts test/bridge-events.test.ts test/bridge-sdk-faux.test.ts test/bridge-hooks.test.ts
# L3 probe: Linux with unprivileged user namespaces, `unshare` and `ip`;
# Claude Code exactly 2.1.303 unless --client-version is given.
node .bridge-eval/eval/bridge/cli.js probe --out <empty directory>
```

The probe runs inside `unshare -rn` with only loopback, a dummy API key and a
throwaway client home. It writes only allowlisted fields and refuses outputs
containing its temporary root or synthetic canaries.
