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

Cause as first stated here (the selected implementation skill's report replaced
the JSON receipt) was **falsified by [attempt 3](../attempt-3/README.md)**, which
failed the same way without worker skills. The receipt check requires a JSON-only
`assistantText`, while the T2 implementer prompt asks for no JSON receipt.
No retry was made within this
approval. 2 worker starts and 2 work turns ran.
