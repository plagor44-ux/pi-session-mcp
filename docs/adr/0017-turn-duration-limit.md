# ADR 0017: Per-profile maximum turn duration

**Status:** Accepted (2026-10-31); implemented under [#212](https://github.com/plagor44-ux/pi-session-mcp/issues/212).

- Planning basis: branch `feat/s17-design-evaluations` on main `41ae199`,
  published 0.14.3.
- The production contract implements this accepted decision under #212.

## Context

The controller skill asks the controller to set a time budget per task. It
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
| Snapshot lease check | 30 s | `src/session-registry.ts:84` |
| Relay poll interval | 1 s | `src/writer-relay.ts:15` |

A controller can stop supervising while the server process lives on, for
example when the client lost its context or crashed. Its turn can then run as
long as the provider keeps it going.

No incident motivates this ADR, and no saving is claimed. It decides two
things: whether an optional operator policy is worth a minor release, and
what exactly it would promise.

Relevant registry facts (`src/session-registry.ts`):

- **One terminal flag.** `turn.terminal` decides every terminal transition,
  and the first writer wins (`completeTurn`, `finishTurn`, `close`).
- **Coalesced aborts.** `beginAbort` coalesces concurrent aborts on
  `turn.abortPromise`.
  - `pi_session_abort` reaches it through the serialized public `abort()`.
  - That path bounds the wait with `handle.deadlines?.abortMs ??
    abortDeadlineMs` (`:254`).
- **Abort outcomes.**
  - A rejected abort returns `abort_failed` and leaves the turn and session
    `running`.
  - A timed-out abort returns `abort_timeout` while the abort keeps running.
    A late success still ends the turn `aborted`, once.
- **Prompt refusal order.** `prompt()` refuses `writer_session_lost` first,
  then `session_running` while a turn runs or an abort is pending (`:155-156`).
- **Snapshot sessions.** A completed turn of a snapshot session becomes
  terminal only after the lease check, which can take up to 30 s
  (`turn.finalizing`, `:313-322`).
- **Early `aborted` on close.** `close()` marks a running turn `aborted` and
  emits its terminal notice **before** the abort result is known
  (`:266-292`). That is an existing case of a cancellation claim that was not
  observed. This ADR records it and does not change it.
- **No stored profile.** The registry does not keep the resolved profile
  after `start()`. Timestamps are wall-clock, and deadlines are `setTimeout`.
- **Turn events.**
  - The failed turn view has one code, `turn_failed`.
  - Turn events accept only `completed|failed|aborted` with
    `via: registry|close` (`src/turn-events.ts:52`).
  - Any new value is a spool contract change.

Relevant profile and relay facts:

- **Strict profiles.** Profiles are a strict zod schema
  (`src/config.ts:24-72`).
- **Raw copy into writers.** A raw profile field is copied into a container
  writer's inner configuration when the writer is provisioned
  (`src/writer-lifecycle.ts:102`).
- **Relay admission.** `pi_capabilities_get` publishes ten profile fields,
  and relay admission compares eight of them (`src/writer-relay.ts:77-86`):
  - five exact fields;
  - three sets;
  - not `alias` and `default`.
- **Verifier.** The setup verifier requires exactly the ten published keys
  (`src/client-adapters/mcp-verifier.ts:120`).
- **Relay prompt errors.** An inner prompt refusal reaches the relay as an
  `InnerError`. The relay calls `preflight(false)`
  (`src/writer-relay.ts:180-186`), and the outer registry reports
  `prompt_rejected` (`src/session-registry.ts:222-224`). The inner code is
  lost.
- **Relay turn states.** The relay maps an inner `aborted` turn to
  `{ status: "aborted" }` (`src/writer-relay.ts:162-163`). `PiTurnOutcome`
  has no field for a reason (`src/pi-adapter.ts:7-10`).

## Options

### A. No server limit (status quo)

Controllers keep their own budgets and abort. Nothing changes. A turn of an
unsupervised controller has no bound.

### B. Per-profile limit enforced by the server that owns the Pi session (recommended)

- An optional profile field.
- The server that owns the Pi session arms one monotonic deadline per
  published turn. That is the host server for a host session, or the inner
  server in the writer for a container session.
- On expiry, it runs the same abort path as `pi_session_abort`.
- The outer server compares the field like the other admission fields, does
  not arm a deadline for relayed sessions, and passes the inner outcome
  through.

### C. Per-profile limit enforced by the outer (host) server only

Same field, but the host registry also enforces it for relayed sessions, and
the inner server ignores it. That gives one clock for every route.

The drawback: the outer abort reaches the inner turn only through the relay,
whose abort failure already marks the session lost (ADR 0012 section 7). An
expiry on a relayed session would then mostly end in `writer_session_lost`
rather than an observed abort.

### D. Client-selected budget per prompt

A `maxSeconds` argument on `pi_session_prompt`. Rejected:

- The issue requires that clients cannot select arbitrary larger budgets or
  bypass the configured policy.
- A per-call value adds a contract surface without solving the
  unsupervised-controller case.

## Decision

Option B.

### 1. Configuration

- **Field.** A new optional profile field, `maxTurnSeconds`.
  - It is an integer from 60 to 86,400 (24 hours). 86,400,000 ms stays below
    Node's `setTimeout` limit of 2,147,483,647 ms.
  - Fractions, strings, zero, negative and out-of-range values fail startup
    with `invalid_execution_profile_config`. There is no clamping.
- **Absent means no limit.** That is today's behavior and the default. The
  documentation states it explicitly.
- **Published.** `pi_capabilities_get` publishes it as an eleventh profile
  field, `maxTurnSeconds: number | null`, where `null` means no limit.
  Controllers can read the policy from it.
- **Admission and verifier.**
  - Relay admission adds it to the exact fields: six exact fields and
    three sets, nine compared fields in all.
  - The setup verifier accepts the eleventh key.
- **Mismatch.** A mismatch between outer and inner configuration counts as
  `settingsChanged`, like a changed model.
  - A writer provisioned before the field was set carries an inner
    configuration without it.
  - Every such writer is refused until it is provisioned again. The release
    notes and the docs say so, as for any other profile change.

### 2. Deadline

- **Who arms.** Only the server that owns the Pi session arms a deadline.
  The outer registry never arms one for a relayed session, that is, a session
  with a writer placement.
- **Anchor.** The deadline starts when the turn is published: preflight
  accepted, `publishTurn`.
  - Before that, no public turn exists, and preflight has its own bound.
  - Anchoring at admission would let a slow preflight eat into the turn's
    budget without a visible turn. The alternative is recorded under
    "Consequences".
- **Clock.** One monotonic deadline per turn: `performance.now()` plus
  `maxTurnSeconds * 1000`. A timer that fires early re-arms for the
  remainder, and a wall-clock change does not move the deadline.
- **Clearing.** The timer is cleared by every terminal transition, and by
  `close` and `shutdown`. It is `unref`'d, so it never keeps the process
  alive.

### 3. Expiry

- **No turn left.** When the deadline passes and the turn is no longer
  `running`, expiry does nothing. The same holds when the turn awaits its
  lease check (`turn.finalizing` is set): it has already completed on the
  Pi side.
- **Otherwise.** Inside the session's serialized section, as
  `pi_session_abort` does, the registry starts or joins the adapter abort
  (`beginAbort`).
  - It coalesces with a manual abort or a close abort already in flight.
  - Expiry never issues a second abort.
- **What the deadline bounds.** Expiry waits on the adapter abort alone,
  bounded by `handle.deadlines?.abortMs ?? abortDeadlineMs`. It does not
  reuse the public `abort()` result as is.
  - The public `abort()` also waits for `finishTurn`, and on a snapshot
    session that includes the lease check, up to 30 s
    (`src/session-registry.ts:240-254`, `:313-322`).
  - A healthy lease check that takes longer than the abort deadline must not
    count as abort uncertainty.
  - Once the adapter abort has resolved, the turn finishes through the normal
    path, including the lease check, without a further deadline from expiry.
  - Today's `pi_session_abort` has the same conflation. A snapshot session
    can answer `abort_timeout` although its abort resolved. This ADR records
    that and does not change it.
- **Abort succeeds** (`handle.abort()` resolves):
  - The turn ends `aborted` through the normal path, with one terminal
    notice.
  - The turn view gains an additive field `abortReason: "deadline"`. A
    manual abort leaves it absent. A turn that ends `aborted` after an
    expiry abort timed out also carries `abortReason: "deadline"`, while
    the session stays not reusable.
  - `aborted` means what it means today: the adapter's abort call returned.
    It is not proof that the provider stopped generating.
- **Completion wins.** If the turn completes before or while the expiry abort
  runs, it stays `completed` (first writer wins). No `abortReason` is set.
- **Adapter abort rejected, or not resolved within the abort deadline.**
  Nothing is claimed.
  - The turn stays `running` until it settles.
  - The session becomes **not reusable**. Once the expiry abort has rejected,
    or has timed out, further prompts are refused with a new code,
    `turn_deadline_uncertain`.
  - `pi_session_get`, `pi_turn_get` and `pi_session_close` keep working.
  - A late settlement ends the turn once, as usual, but the session stays not
    reusable. The controller closes it. This mirrors `writer_session_lost`.
- **Refusal order.** `prompt()` refuses in this order:
  1. `writer_session_lost`;
  2. `session_running`, while the turn runs or an abort is pending;
  3. `turn_deadline_uncertain`.

  So a controller that prompts while a timed-out expiry abort is still
  pending sees `session_running` first.
- **Turn events.** Unchanged. An expiry abort emits `state: "aborted"`,
  `via: "registry"`. There is no new `via` value, so the spool contract stays
  as it is.

### 4. Container writers

The inner server enforces the limit. Three relay changes carry its outcome
to the outer controller unchanged:

- **Abort reason.**
  - `PiTurnOutcome`'s `aborted` case gains an optional
    `abortReason: "deadline"` (`src/pi-adapter.ts`).
  - The relay's inner-turn parsing reads the field, and `observe` passes it
    on.
  - The outer registry copies it into the outer turn view.
- **Refusal code.**
  - An inner prompt refusal with `turn_deadline_uncertain` stops being a
    generic `prompt_rejected`.
  - The relay reports it as `turn_deadline_uncertain`, and the outer session
    becomes not reusable as well.
  - Other inner refusal codes keep today's mapping.
- **Writer state.** An inner expiry never collects, discards, resets or
  reallocates a clone. If the inner abort fails, the writer stays fenced by
  its lease, as today.

### 5. What is not guaranteed

- **Not stopped:** a provider request is not guaranteed to terminate.
- **Not undone:** side effects a turn already caused (file edits, tool calls)
  are not rolled back.
- **No cost cap.**
- **No terminal time when the abort fails.** If the adapter abort rejects or
  does not resolve within the abort deadline, the turn stays `running` until
  it settles on its own, which may never happen. Only the session's refusal
  of further prompts is guaranteed (section 3).
- **No exact timing otherwise.** Expiry is not enforced to the second. Only
  when the adapter abort resolves does the turn become terminal, after the
  deadline, within about:
  - the abort deadline (5 s) on a host session;
  - plus up to the lease check (30 s) on a snapshot session;
  - for a relayed session, the inner bound, then until the outer view shows
    it: one poll interval (1 s), plus the `pi_turn_get` call to the inner
    server, which can take up to its 10 s timeout
    (`src/writer-relay.ts:16`). A poll already in flight when the inner turn
    ended can return the earlier `running` state, and that costs one more
    round.

### 6. Controller skill

The skill keeps per-task budgets: the server limit is a backstop for an
unsupervised turn, not a replacement for supervision. It gains one paragraph
that tells the controller to:

- read `maxTurnSeconds` from capabilities;
- treat `abortReason: "deadline"` like an aborted turn;
- close a session that answers `turn_deadline_uncertain`.

## Evidence

A development-only supervisor (`eval/turn-deadline/supervisor.ts`) wraps the
real `SessionRegistry` from outside. On expiry, it calls the public
`registry.abort()`. That shares section 3's serialization and `beginAbort`,
but not its timeout: the public `abort()` bounds the adapter abort and
`finishTurn` together. The prototype is covered by:

- fake-timer tests (`test/turn-deadline-prototype.test.ts`);
- one relayed session through the existing fake inner server
  (`test/writer-relay.test.ts`).

Run records and the test list are in
[the evaluation record](../evaluation/turn-deadline-2026-10-31/README.md).

Against today's registry, the prototype proves four things for the tested
races:

- the expiry abort produces no second terminal transition;
- the supervisor issues no second abort;
- an abort failure or timeout leaves the turn `running`, without a
  cancellation claim;
- a parallel session is unaffected.

It does not prove the following:

- the in-registry anchor (it anchors when `registry.prompt` resolves,
  microtasks later);
- `unref`;
- the skip during `turn.finalizing`;
- the adapter-only abort bound of section 3 (the tested abort failure and
  timeout use the public `abort()` bound);
- the capability field, the verifier change or the relay comparison;
- real child-process termination.

The relayed test runs the supervisor on the **outer** registry, so its abort
travels through the relay. That is Option C's shape. It shows that an outer
abort reaches the inner turn. It does not exercise Option B's inner
enforcement, the `abortReason` propagation or the refusal-code pass-through.

A cross-family review of the prototype (Sonnet 5.5) found no race defect. It
named two test weaknesses, which the controller confirmed with mutations: a
Date-based clock and a missing publication guard both left every test green.
A fix round made each mutation fail a test. See the evaluation record.

## Contract change and versioning

Additive but public:

- a new profile configuration field;
- an eleventh published profile field in `pi_capabilities_get`;
- an additive turn-view field, `abortReason`;
- a new error code, `turn_deadline_uncertain`.

Under ADR 0003, this needs a minor release.

- **Downgrade.** Configuration is strict, so a configuration that uses the
  field cannot be loaded by an older release. The release notes must say so.
- **Re-provisioning.** Writers must be provisioned again after the field is
  set (section 1).
- **Doctor and verifier.** Doctor validates the field offline. The setup
  verifier's 65,536-byte bound on the capability frame must be rechecked with
  the extra field.

Files to change on implementation:

- configuration and profiles: `src/config.ts`, `src/execution-profile.ts`,
  `src/capabilities.ts`;
- schemas: `src/tool-schemas.ts` (turn view, and the relay's inner-turn
  parsing);
- adapter: `src/pi-adapter.ts` (`abortReason` on `PiTurnOutcome`);
- registry: `src/session-registry.ts`;
- relay: `src/writer-relay.ts` (admission comparison, prompt refusal
  pass-through, `observe`);
- verifier: `src/client-adapters/mcp-verifier.ts` (eleventh key);
- Doctor checks;
- docs: `docs/tool-contracts.md`, `docs/installation.md`,
  `docs/client-setup.md`, `docs/execution-modes.md`;
- `pi-session-mcp.example.json`, the controller skill and the changelog.

Test matrix for the implementation:

- **Prototype cases** moved into registry tests, including:
  - early timer firing and re-arming;
  - successive turns;
  - a manual abort that starts before the expiry.
- **Configuration:** schema bounds, the capability projection and verifier
  acceptance.
- **Relay admission:** a `settingsChanged` refusal on a mismatch, and on a
  writer provisioned without the field.
- **Timer:** `unref`.
- **Expiry edge cases:**
  - no abort call while `turn.finalizing` is set;
  - the named abort deadline on expiry;
  - a snapshot session whose adapter abort resolves at once while a healthy
    lease check takes longer than the abort deadline: the turn ends
    `aborted`, and the session stays reusable;
  - the refusal order (`session_running` before `turn_deadline_uncertain`);
  - close during a pending expiry abort.
- **Stdio:** a real stdio test in which an expired turn on a fake adapter
  ends `aborted` and the session accepts the next prompt.
- **Relay route**, through a real inner server:
  - an inner expiry that reaches the outer view as `aborted` with
    `abortReason: "deadline"`;
  - no outer deadline armed for the relayed session;
  - an inner abort failure that answers `turn_deadline_uncertain` both
    inside and outside, never `prompt_rejected`.

## Consequences

- An operator can bound unsupervised turns per profile. Profiles without the
  field behave as today.
- An `aborted` turn can now also come from the server. `abortReason`
  distinguishes it, but when a manual abort and an expiry run concurrently,
  the outcome is attributed to whichever `beginAbort` started first.
- Anchoring at publication excludes preflight (at most 5 s, relay 15 s) from
  the budget. Anchoring at admission would include it, and was rejected for
  that reason. The difference is small against a 60 s minimum.
- Skipping expiry during a snapshot session's lease check avoids aborting a
  turn that has already completed on the Pi side. If the lease check then
  fails, the turn ends `failed` as today, not `aborted`.
- The existing early `aborted` in `close()` stays a known overstatement. A
  separate issue can decide it.

## Open questions

- Is a minimum of 60 s right for review profiles that are expected to finish
  in seconds? A lower bound risks aborting legitimate tool-heavy turns.
- Should `turn_deadline_uncertain` reuse a generic "session not reusable"
  code shared with `writer_session_lost` instead?
