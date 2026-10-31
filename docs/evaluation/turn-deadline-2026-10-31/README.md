# Turn-deadline prototype

This provider-free experiment for
[issue #212](https://github.com/plagor44-ux/pi-session-mcp/issues/212)
supports [ADR 0017](../../adr/0017-turn-duration-limit.md). A
development-only `DeadlineSupervisor` (`eval/turn-deadline/supervisor.ts`)
wraps the real `SessionRegistry` from outside: it arms one monotonic deadline
when `registry.prompt` resolves, and on expiry calls `registry.abort` once if
the turn is still running. Nothing in `src/` changes. The tests use Vitest
fake timers (`setTimeout`, `clearTimeout`, `Date`, `performance`) and the
`FakeAdapter` of `test/fake-adapter.ts`; one further test drives a relayed
session through the existing fake inner server of `test/writer-relay.test.ts`.

Run from the repository root:

```sh
npx vitest run test/turn-deadline-prototype.test.ts test/writer-relay.test.ts
```

## Recorded runs

Run 1, by the implementing worker (`code`, OpenAI `gpt-6.1-sol`) in container
writer `pi-session-mcp-w2` on base `614a8db`, commit `b266b75` (integrated as
`e30c3c2`): 16 prototype tests and the relay test passed. The controller
re-ran both files on the host: 53 of 53 passed; `tsc --noEmit` clean.

Cross-family review (`review-sonnet`, Anthropic Sonnet 5.5, read-only, on
`e30c3c2`): `NON_BLOCKING_ONLY`, no race defect. Two findings were confirmed
by the controller with mutations, each of which left all 16 tests green:

- replacing the default clock `performance.now()` with `Date.now()`: the
  wall-clock test only jumped forward, and fake timers shift pending timers on
  `setSystemTime`, so a Date-based deadline also fired at 60 s;
- removing the guard that skips arming a deadline for a turn already terminal
  at publication: the test asserted only after advancing the clock.

Further findings adopted: an unhandled rejection path in the expiry callback,
a stale deadline entry on an early return, over-claiming test names, a missing
"shutdown before expiry" case and a 1 s `waitFor` against a real child process
in the relay test. Findings recorded for the ADR instead of the prototype: the
anchor is microtasks after publication; `aborted` means the adapter's abort
call returned, not that the provider stopped; a manual abort also yields
`aborted`; a snapshot lease check can let an expiry abort a turn whose inner
side already completed; after `abort_failed` or `abort_timeout` the session
stays unusable for good.

Run 2, fix round (`code`, fresh session, writer `pi-session-mcp-w2` on
`e6af800`, commit `ffe94ef`, integrated as `cdd63bc`). The controller re-ran
on the host (Node `v26.12.1`, `uname -sr` `Linux 7.3.0-5-cachyos`): both files
56 of 56 passed. Both mutations above now fail exactly one test each (1 failed,
18 passed of the 19 prototype tests); reverted afterwards.

Prototype tests at run 2, all passed:

- parses only integers within bounds
- does nothing when the turn completes before the deadline
- completion one tick before expiry wins
- completion at the deadline wins when its callback runs first
- expiry aborts exactly once
- completion during the expiry abort stays completed
- manual abort before expiry cancels the deadline
- manual abort during expiry is coalesced
- a rejected expiry abort claims nothing
- an unexpected expiry read failure records uncertainty without an unhandled rejection
- an expiry abort timeout claims nothing until it settles
- a close notice before expiry clears the deadline
- shutdown before expiry clears the deadline
- shutdown racing expiry yields one notice per turn
- a parallel session is unaffected
- a wall-clock jump of 3600000 ms does not move the deadline
- a wall-clock jump of -3600000 ms does not move the deadline
- anchors the deadline at publication rather than admission
- does not arm a deadline for a turn already terminal at publication

Relay (in `test/writer-relay.test.ts`, Linux only): expiry on a relayed
session aborts the inner turn once.

In the container writers, the full suite showed the eight lock, skill
concurrency and wake-hook timeouts that AGENTS.md expects there; they are not
related to these files.

## Limits

- An external supervisor, not the in-registry design: its deadline starts
  when `registry.prompt` resolves, it is not `unref`'d, it does not refuse
  prompts sent around it, and it has no capability field or relay comparison.
- No real provider, so nothing here shows whether a provider stops generating
  after an abort.
- The relay test drives only the deadline callback by hand; child I/O and
  polling are real, but the 60 s timer itself is not waited for.
- No real child-process termination or launcher cleanup after an expiry.
