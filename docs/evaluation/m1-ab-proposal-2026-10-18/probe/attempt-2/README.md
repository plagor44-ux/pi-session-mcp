# A/B technical probe, attempt 2 (2026-10-18): FAIL in arm A, L2

After attempt 1 the operator chose to move the worker route to the Pi provider
`openai` (OAuth subscription login on this workstation), keeping the approved
matrix, the 10 USD operator-selected advisory and the unmetered-use
acknowledgment. Before this run, a session start without a model request
succeeded for both profiles with the selected worker skills. Arm A: commit
`fec673e` (harness of `1dfa1ec`, `skills/` and `src/server.ts` of `612fbcb`).

| Arm | Case | Result | Note |
| --- | --- | --- | --- |
| A | L1 | PASS | receipt present, oracle passed |
| A | L2 | **FAIL** | turn `completed`; independent T2 oracle **passed**, scope and cleanup passed; `completed-receipts-present` and `unique-turn-receipts` failed |
| A | L3 | not run | stop rule |
| B | — | not run | stop rule |

Cause: the harness accepts a receipt only when the worker's `assistantText` is
one complete JSON object (`receiptFromTurn`). With the selected
`pi-session-implementation` skill the coding worker ended with the skill's
five-part final report instead, so no receipt could be read, although the repair
itself was correct. With the selected `pi-session-review` skill (L1) the JSON
receipt came through.

Consequence: prerequisite P2 (worker skills selected in both arms) conflicts with
the harness's JSON-only receipt. The A/B cannot measure #87 until that is
resolved; how is a decision for the operator. No retry was made within this
approval. 2 worker starts and 2 work turns ran.
