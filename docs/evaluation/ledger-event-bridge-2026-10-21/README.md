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

No live provider ran. Every result below is provider-free, and each claim
names its evidence level: L0 source or docs, L1 unit test, L2 host event, L3
client wake with a scripted fake model, L4 real controller model. **L4 was not
reached.**

## Verdict

**A lean event bridge from the existing SDK completion, with a targeted Claude
Code integration, is technically viable (L3) and justified for long worker
turns and for worker questions. It is not yet justified as product work.** It
needs an approved L4 measurement and its own decision record (proposed as
[ADR 0011](../../adr/0011-turn-events-and-controller-wake.md)). Until then **the
current procedure stays**: the controller skill's internal ledger with
consume-once and the #86 cadence.

- **File ledger:** not recommended as a product feature. It helps a human
  overview and context continuity after compaction. It does nothing for tokens
  or notification. A hook can keep it current without the model (L3); that is a
  development aid, not a monitor.
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
registries (L1 in process; L3-adjacent X6 with two real stdio server processes:
the second returns `unknown_session` and an empty list).

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
registry, which the bridge already covers without polling.

### 4.4 Controller resume without polling (Claude Code 2.1.303, L2/L3)

Probe on a loopback fake Messages API with a dummy key, inside a fresh user and
network namespace, three attempts preserved ([`probe/`](probe/)). Attempt 1 had
harness defects (wake parsing, missing waiter signal log). Attempts 2 and 3
produced the same results.

| Scenario (attempt 3) | Result |
| --- | --- |
| S1 completion, idle stream-json session | one wake (own model request) **16 ms** after the bridge event; one terminal read; **0 running polls** |
| S2 two concurrent turns | two wakes in completion order, each matched to its turn (16, 17 ms); no missing or duplicate wake |
| S3 controller question round trip | question wake (17 ms) → `eval_question_get` → `eval_question_answer` → worker continued → terminal wake (34 ms) → one read; the answer digest reached the worker's final text |
| S4 control with plain `async: true` | hook exited 2, **no wake** |
| S5 one-shot `-p "<prompt>"` | **the client held the next model request until the hook ended (8.4 s)** and delivered the wake text with the tool result; then exited; no leftover |
| S6 hook timeout 4 s, worker 15 s | client killed the waiter at 4 s (exit 143); no wake; no leftover |
| S8 stream-json, stdin closed after one message | client exited after about 0.4 s; the hook was dropped; the server closed the running turn as aborted; no wake |
| X6 two server processes, same aliases | no shared registry |

Every run: no leftover hook or server process, temporary root removed, no path
or canary in any output. In the Claude scenarios the client ended the server
by signal (`instance_ended` = `server_exit`).

The four kinds of evidence stay separate. A spool file is a host-side record
(L1). A hook start or exit in the stream is L2. A new model request at the fake
is L3. A real model choosing the right call is L4, **not tested**.

Interactive TUI and the VS Code extension were not tested. The extension uses
the same stream-json input, which S1–S3 exercised, but that is an inference.
Codex has no documented wake path (L0).

### 4.5 Earlier cost measurement

#91 stands: 1–3 running polls per turn on the Codex route, no consistent uncached
difference. That A/B did not compare push, rewake, a supervisor or a ledger.
The rewake removes running polls entirely (L3: 0 in S1–S3) and adds one wake
request per event. A model-based expectation from the skill cadence (not a
measurement): for a turn of `T` seconds the skill gives `ceil((T − 10) / c)`
running polls for `T > 10 s`, with `c` = 15–30 s. That is 1–3 for the M1 cases
(about 50–100 s), so C saves at most about two model requests per turn there. A
10-minute turn would need about 20–40 polls against one wake. The benefit grows
with turn length and with questions; for short turns it is close to neutral.
This expectation is the reason L4 is needed before any product decision.

### 4.6 Completion and questions

**A. Completion.** The bridge emits one content-free `turn_terminal` per turn from
the registry read model (L1, 22 bridge tests: concurrent turns, follow-ups,
duplicates, late settlements, `abort_timeout` with a later outcome, close,
shutdown, many activity callbacks with no early event). `agent_settled` is not
used as a second source. One narrow exception is documented in the design: a
terminal transition that races a queued `close`. A side check against the real
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

## Comparison matrix

| | A current | B hook ledger | C bridge + rewake | D supervisor |
| --- | --- | --- | --- | --- |
| Overview and context continuity | context only | `run.json`/`task.md` survive compaction | same as A, plus B if wanted | none |
| LLM in status checks | every poll | every poll | none for running turns | none |
| Real notification and resume | none | none | L3 yes (stream-json); `-p` blocks | needs C's delivery |
| State and connection owner | server | server; ledger by hook | server; spool per instance | must be the same server |
| Restart and cleanup | IDs become history | ledger marks unresolved | `instance_ended`; waiter ends at budget, parent loss or claim loss | as C |
| Client dependency | none | Claude Code hooks (Codex has hooks too) | Claude Code `asyncRewake`; not Codex | as C |
| Implementation and maintenance | none | small | observer, spool, setup-managed hook, waiter | timer plus C |
| Decision or contract needed | none | none (dev aid) | ADR; spool is a new local surface; question tool = minor release | ADR |
| Evidence | M1 A/B (Codex) | L1, L3 | L1, L3; L4 open | L1 partial; detection-only arm skipped |

## Prototype

`eval/bridge/` (about 2,050 lines) with 75 provider-free tests in four files.
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

Tests: `bridge-ledger` 25, `bridge-events` 22, `bridge-sdk-faux` 3,
`bridge-hooks` 25.

## Not measured, not tested, unknown

L4 with a real model; token, cache and money effects; worker usage; interactive
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
- **Smallest next test:** one approved L4 pair of case L1 (arm A and arm C, one
  run each), `explore-fast` worker, Claude Code 2.1.303 controller. It checks
  the critical assumption before the full matrix.

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
