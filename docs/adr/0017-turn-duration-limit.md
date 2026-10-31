# ADR 0017: Per-profile maximum turn duration

**Status:** Proposed (2026-10-31). Issue
[#212](https://github.com/plagor44-ux/pi-session-mcp/issues/212). Planning
basis: branch `feat/s17-design-evaluations` on main `41ae199`, published
0.14.3. This ADR changes no production contract by itself; implementation
follows only if the maintainer accepts it.

## Context

The controller skill asks the controller to set a time budget per task and
says plainly that the server enforces none
(`skills/pi-session-orchestration/SKILL.md`, section 4). The server bounds
admission, abort, close and shutdown, but never the total duration of an
accepted turn:

| Bound | Value | Where |
| --- | --- | --- |
| Preflight | 5 s (relay 15 s) | `src/session-registry.ts:56`, `src/writer-relay.ts:17` |
| Abort | 5 s (relay 15 s) | `src/session-registry.ts:57`, `src/writer-relay.ts:18` |
| Close cleanup | 5 s (relay 10 s) | `src/session-registry.ts:58`, `src/writer-relay.ts:19` |
| Shutdown | 12 s, process 15 s | `src/session-registry.ts:59`, `src/shutdown.ts:1` |
| Relay start budget | 60 s | `src/writer-relay.ts:14` |

A turn whose controller stops supervising, for example because the client
lost its context or crashed while the server process lives on, can run as long
as the provider keeps it going. No incident motivates this ADR and no saving
is claimed; it decides whether an optional operator policy is worth a minor
release and what exactly it would promise.

Relevant registry facts (`src/session-registry.ts`):

- One `turn.terminal` flag decides every terminal transition; the first
  writer wins (`completeTurn`, `finishTurn`, `close`). `beginAbort` coalesces
  concurrent aborts on `turn.abortPromise`.
- A rejected abort returns `abort_failed` and leaves the turn and session
  `running`; a timed-out abort returns `abort_timeout` while the abort keeps
  running, and a late success still ends the turn `aborted` once.
- `close()` marks a running turn `aborted` and emits its terminal notice
  **before** the abort result is known (`:266-292`). That is an existing case
  of a cancellation claim that was not observed. This ADR records it and does
  not change it.
- The registry does not keep the resolved profile after `start()`;
  timestamps are wall-clock, deadlines are `setTimeout`.
- The failed turn view has one code, `turn_failed`. Turn events accept only
  `completed|failed|aborted` with `via: registry|close`
  (`src/turn-events.ts:52`); any new value is a spool contract change.
- Profiles are a strict zod schema (`src/config.ts:24-72`). A raw profile
  field is copied into a container writer's inner configuration
  (`src/writer-lifecycle.ts:102`), but relay admission compares only the ten
  published capability fields (`src/writer-relay.ts:77-86`).

## Options

### A. No server limit (status quo)

Controllers keep their own budgets and abort. Nothing changes. A turn of an
unsupervised controller has no bound.

### B. Per-profile limit enforced by the server that owns the Pi session (recommended)

An optional profile field; the registry arms one monotonic deadline per
published turn and, on expiry, runs the same abort path as
`pi_session_abort`. On a container workspace, the inner server in the writer
enforces it; the outer server compares the field like the other published
profile fields.

### C. Per-profile limit enforced by the outer (host) server only

Same field, but the host registry enforces it for relayed sessions too, and
the inner server ignores it. One clock for every route, but the outer abort
reaches the inner turn only through the relay, whose abort failure already
marks the session lost (ADR 0012 section 7); an expiry on a relayed session
would then mostly end in `writer_session_lost` rather than an observed abort.

### D. Client-selected budget per prompt

A `maxSeconds` argument on `pi_session_prompt`. Rejected: the issue requires
that clients cannot select arbitrary larger budgets or bypass the configured
policy, and a per-call value adds a contract surface without solving the
unsupervised-controller case.

## Decision (proposed)

Option B.

### 1. Configuration

- New optional profile field `maxTurnSeconds`: an integer from 60 to 86,400
  (24 hours). 86,400,000 ms stays below Node's `setTimeout` limit of
  2,147,483,647 ms. Fractions, strings, zero, negative and out-of-range values
  fail startup with `invalid_execution_profile_config`, like every other
  profile field; no clamping.
- Absent means **no limit**. That is today's behavior and the default; the
  documentation states it explicitly.
- `pi_capabilities_get` publishes it as an eleventh profile field,
  `maxTurnSeconds: number | null` (`null` = no limit), so controllers can read
  the policy and relay admission compares it. A mismatch between outer and
  inner configuration counts as `settingsChanged`, like a changed model.

### 2. Deadline

- **Anchor:** the moment the turn is published (preflight accepted,
  `publishTurn`). Before that no public turn exists and preflight has its own
  bound; anchoring at admission would let a slow preflight eat into the turn's
  budget without a visible turn. The alternative is recorded under
  "Consequences".
- **Clock:** one monotonic deadline per turn (`performance.now()` plus
  `maxTurnSeconds * 1000`). A timer that fires early re-arms for the
  remainder; a wall-clock change does not move the deadline.
- The timer is cleared by every terminal transition and by `close` and
  `shutdown`, and it is `unref`'d so it never keeps the process alive.

### 3. Expiry

- If the turn is still `running` when the deadline passes, the registry calls
  `beginAbort` once. It coalesces with a manual abort or a close abort already
  in flight; expiry never issues a second abort.
- **Abort succeeds** (`handle.abort()` resolves): the turn ends `aborted`
  through the normal path, with one terminal notice. The turn view gains an
  additive field `abortReason: "deadline"`; a manual abort leaves it absent.
  `aborted` means what it means today: the adapter's abort call returned. It
  is not proof that the provider stopped generating.
- **Completion wins:** if the turn completes before or while the expiry abort
  runs, it stays `completed` (first writer wins). No `abortReason` is set.
- **Abort rejected or timed out:** nothing is claimed. The turn stays
  `running` until it settles; the session becomes **not reusable**: further
  prompts are refused with a new code `turn_deadline_uncertain`, while
  `pi_session_get`, `pi_turn_get` and `pi_session_close` keep working. A late
  settlement ends the turn once as usual, but the session stays not reusable;
  the controller closes it. This mirrors `writer_session_lost`.
- **Container writers:** the inner server enforces. An inner expiry reaches the
  outer server as an ordinary `aborted` turn through the relay poll. If the
  inner abort fails, the inner session refuses prompts, and the writer stays
  fenced by its lease as today; expiry never collects, discards, resets or
  reallocates a clone.
- **Turn events:** unchanged. An expiry abort emits `state: "aborted"`,
  `via: "registry"`. No new `via` value, so the spool contract stays as it is.

### 4. What is not guaranteed

Termination of a provider request, rollback of side effects a turn already
caused (file edits, tool calls), and any cost cap. Exact enforcement to the
second: expiry lands within the timer resolution plus the abort deadline.

### 5. Controller skill

The skill keeps per-task budgets: the server limit is a backstop for an
unsupervised turn, not a replacement for supervision. It gains one paragraph:
read `maxTurnSeconds` from capabilities, treat `abortReason: "deadline"` like
an aborted turn, and close a session that answers `turn_deadline_uncertain`.

## Evidence

A development-only supervisor (`eval/turn-deadline/supervisor.ts`) wraps the
real `SessionRegistry` from outside and applies the deadline as decided above,
with fake-timer tests (`test/turn-deadline-prototype.test.ts`) and one relayed
session through the existing fake inner server (`test/writer-relay.test.ts`).
Run records and the test list are in
[the evaluation record](../evaluation/turn-deadline-2026-10-31/README.md).

The prototype proves, against today's registry, that an external deadline
using only `beginAbort` cannot produce a second terminal transition or a
second supervisor abort in the tested races, that an abort failure or timeout
leaves the turn `running` without a cancellation claim, and that a parallel
session is unaffected. It does not prove the in-registry anchor (it anchors
when `registry.prompt` resolves, microtasks later), `unref`, the capability
field, or the relay comparison, and it covers no real child-process
termination.

A cross-family review (Sonnet 5.5) of the prototype found no race defect. It
named two test weaknesses that the controller confirmed with mutations (a
Date-based clock and a missing publication guard both left every test green);
a fix round made each mutation fail a test. See the evaluation record.

## Contract change and versioning

Additive but public: a new profile configuration field, an eleventh published
profile field in `pi_capabilities_get`, an additive turn-view field
`abortReason`, and a new error code `turn_deadline_uncertain`. Under ADR 0003
this needs a minor release. Strict configuration means a configuration that
uses the field cannot be loaded by an older release (downgrade breaks), which
the release notes must say. Doctor validates the field offline. The setup
verifier's 65,536-byte capability-frame bound must be rechecked with the
extra field.

Files to change on implementation: `src/config.ts`, `src/execution-profile.ts`,
`src/capabilities.ts`, `src/tool-schemas.ts`, `src/session-registry.ts`,
`src/writer-relay.ts` (comparison), Doctor checks,
`docs/tool-contracts.md`, `docs/installation.md`, `docs/client-setup.md`,
`docs/execution-modes.md`, `pi-session-mcp.example.json`, the controller
skill and the changelog.

Test matrix for the implementation: the prototype cases moved into registry
tests; schema bounds; capability projection and relay `settingsChanged`;
`unref`; a real stdio test that an expired turn on a fake adapter ends
`aborted` and refuses no further prompt; a relayed expiry through a real
inner server; an inner abort failure leading to `turn_deadline_uncertain`
inside and `writer_session_lost` or `turn_deadline_uncertain` outside.

## Consequences

- An operator can bound unsupervised turns per profile; profiles without the
  field behave as today.
- An `aborted` turn can now also come from the server; `abortReason`
  distinguishes it, but the outcome of a concurrent manual abort and expiry is
  attributed to whichever `beginAbort` started first.
- Anchoring at publication excludes preflight (at most 5 s, relay 15 s) from
  the budget. Anchoring at admission would include it and was rejected for
  that reason; the difference is small against a 60 s minimum.
- A snapshot session's completed turn becomes terminal only after the lease
  check; an expiry in that window can call abort on a turn that the inner side
  already finished. The turn still ends once; the docs must not promise "no
  abort call when the turn completes at the deadline".
- The existing early `aborted` in `close()` stays a known overstatement; a
  separate issue can decide it.

## Open questions

- Whether a minimum of 60 s is right for review profiles that are expected to
  finish in seconds. Lower bounds risk aborting legitimate tool-heavy turns.
- Whether `turn_deadline_uncertain` should instead reuse a generic
  "session not reusable" code shared with `writer_session_lost`.
