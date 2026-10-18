# A/B technical probe, attempt 3 (2026-10-18): FAIL in arm A, L2

Operator decision after attempt 2: run the A/B without worker skills. Same arms
(`fec673e`, `1dfa1ec`), `openai` worker route, Codex 0.162.1, 10 USD
operator-selected advisory, unmetered use acknowledged.

| Arm | Case | Result |
| --- | --- | --- |
| A | L1 | PASS |
| A | L2 | **FAIL**: turn completed, independent T2 oracle passed, but `completed-receipts-present` and `unique-turn-receipts` failed |
| A | L3, B | not run (stop rule) |

The same L2 failure without any worker skill **falsifies the explanation given
for attempt 2**. Cause, from the code: the harness accepts a receipt only when
the worker's `assistantText` parses as one JSON object, but the T2 implementer
prompt (`eval/profiles/oracles.ts`) asks for a fix and specifies no JSON receipt.
Whether a receipt appears therefore depends on how the controller phrases the
worker prompt and on the route's model behavior; the pilot passed this check on
the `openai-codex` route. The worker text is not stored, so this is the
mechanism, not an observed transcript.

Stopped: three probe attempts have failed; no further run without a fixed
receipt contract and a new approval.
