# Pre-registration: ledger, event bridge and controller rewake

Fixed on 2026-10-21 before any comparative run of the
[#104](https://github.com/plagor44-ux/pi-session-mcp/issues/104) evaluation.
Base main `0922d98`. Later changes to this file are listed under *Amendments*
with their reason; the original text stays.

## Evidence levels

Every claim in the report names exactly one level:

| Level | Meaning |
| --- | --- |
| L0 source | Read in source code or official documentation at the pinned version |
| L1 unit | Provider-free test against the real `SessionRegistry`, a scripted adapter or a faux-model `AgentSession` |
| L2 host event | A real client process received or emitted the event (hook started, hook exited) |
| L3 client wake | A real client process started a new model request on its own after the event (seen at a loopback fake Messages API) |
| L4 controller decision | A real model received the event, chose the right next call and the Pi operation continued |

L3 uses a scripted fake model. It proves that the client starts a model round,
not that a real model reacts correctly. Only L4 proves that, and L4 needs its own
approval (see *Live plan*). A file entry, a desktop notice, a hook event and a
started model round are four different things and are never merged.

## Arms

All arms use the same tasks, the same quality oracle and the same lifecycle
duties (close every session, consume a terminal turn once).

- **A, current procedure:** controller skill as on main (#86 cadence: first poll
  about 10 s after the prompt, then every 15–30 s; consume once). No other
  mechanism. This is the baseline; it must not poll faster than the skill says.
- **B, hook-maintained ledger:** A plus a synchronous PostToolUse hook that
  projects Pi tool results into `run.json`/`task.md`. Polling is unchanged.
- **C, event bridge with rewake:** the server process emits a content-free
  terminal or question event from the registry's terminal transition; an
  `asyncRewake` hook started after `pi_session_prompt` waits for it and wakes the
  controller. The controller does not poll running turns; it reads a terminal
  turn once after the wake. Questions travel through a separate answer path.
- **D, deterministic supervisor:** an in-process periodic reader of the same
  registry (no model per read). It is a comparison option for detection only;
  it still needs C's delivery path to reach the controller.

## Provider-free scenarios (L1–L3)

Fixed list; numbering follows the work order.

1. Two or three concurrent turns, different completion order, no mixing.
2. Technically completed, review fails: task not accepted.
3. Failed turn, abort, and `abort_timeout` with a later outcome.
4. Silent but running turn: no invented hang.
5. Connection or server loss: running entries become unresolved.
6. Separate server process with the same aliases: no shared registry.
7. Follow-up in the same session and retry in a new session.
8. Duplicate or late updates, near-simultaneous completions, concurrent hooks.
9. Terminal result consumed once; cleanup cannot drop an unconsumed result.
10. No forbidden content in ledger, view, events or spool; no leftover processes
    or open sessions.
11. `agent_end` followed by retry: no early completion; one final signal.
12. Structured question during a running turn: the answer reaches exactly the
    waiting call; no competing prompt; no deadlock.
13. Two concurrent questions; late, duplicate and wrongly correlated answers;
    timeout and abort resolve the waiting call.
14. Host stopped or headless run ended: no claimed wake, no unbounded waiting
    process, no silent retry.
15. Real client wake (L3) for completion and for a controller question round
    trip; the real-model edge (L4) is separate.

## Measures

Per scenario run: MCP calls by tool, running polls, first terminal reads,
avoidable repeated terminal reads; model requests seen at the fake (L3 runs);
wakes started, wakes per terminal event, missing or duplicate wakes; delay from
bridge event to the next model request; hook processes still alive after the
run; leftover sessions; ledger outcomes (`applied`, `duplicate`,
`ignored_stale`, `rejected`). Transport bytes are not tokens. Fake runs measure
no token saving.

## Decision rules

- **C is technically viable** only if all of these hold on the installed client:
  an idle session wakes (L3) after a terminal event; exactly one wake per event;
  no wake in the plain `async` control; correct correlation with two concurrent
  turns; a question round trip ends with the waiting Pi call continuing; no
  hook process outlives its run or budget.
- **C is recommended for product work** only if it is technically viable **and**
  an approved L4 measurement keeps quality in every pair and shows fewer
  controller model requests than A without higher uncached controller input.
  Without L4 the verdict stays conditional.
- **A file ledger is recommended** only for a concrete gap the internal ledger
  cannot cover (context compaction, a human overview, several controllers). Its
  token or wake effect is assessed separately and is expected to be none.
- **D is recommended** only if no event source exists for a needed state.
- A public question channel or a new tool needs its own decision record and a
  minor release; this evaluation can only recommend that decision.

## Live plan (not approved)

The L4 measurement is a separate, small plan in the evaluation report. It runs
only after an explicit operator approval of its source, routes, profiles, run
count and budget. Earlier M1 approvals do not apply.

## Amendments

None yet.
