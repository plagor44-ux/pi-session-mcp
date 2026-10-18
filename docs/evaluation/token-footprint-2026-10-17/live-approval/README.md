# Exact M1 pilot proposal — not approved

The generated [manifest](manifest.json), [budget](budget.json) and
[decision](decision.json) bind current source
`sha256:33c450601727e38cf63b1874df0fcadc158c3d06af3b472b3d1603da6383c929`.
The [full package](../live-package.json) includes metadata inventory, fixture/task
hashes, routes and exact build/skill/matrix bindings. No real provider path ran.

| Fresh Codex controller | Worker route | Starts | Work turns | Independent acceptance |
| --- | --- | ---: | ---: | --- |
| L1 | `review`: openai-codex / gpt-6.1-sol / high, read-only | 1 | 1 | T1 source claims and unchanged fixture |
| L2 | `code`: openai-codex / gpt-6.1-sol / medium, coding | 1 | 1 | T2 fail before, pass after, only contract.mjs changed |
| L3 | `review`, two sessions sharing immutable disposable T1 | 2 | 3 | Both reads, one follow-up in the first session, re-fetch original turn after follow-up and verify invariance |

Controller: Codex 0.162.0 / openai / gpt-6.1-sol / high, with the hash-bound
repository orchestration skill. Evaluation workers select no skills, extensions
or external MCP grants. Production profiles and registrations are untouched.
One pilot, three sequential fresh controllers, four starts/five work turns,
zero whole-run retries. Turn supervision is 180 seconds after acceptance,
case/controller 600 seconds, wave 1,800 seconds. Poll pauses are advisory;
actual practice is measured. Cleanup uses separately bounded waits totaling
60,500 configured milliseconds, plus process-table observation; no aggregate
wall-clock hard cap or arbitrary subprocess containment is claimed.

All approval flags are false; the advisory amount is null and unmetered use is
not acknowledged. The existing gate requires an explicit current decision for
this exact matrix/routes/budget, a positive **operator-selected advisory** USD
amount and acknowledgment that subscription usage is unmetered. No reliable
per-run cost or provider hard cap is available. An advisory is neither a tariff
estimate nor a cap. Historical approval files are not reusable.

After that decision, approve copies and recompute hashes of normalized validated
manifest/budget objects, then bind the decision. No checked-in proposal can pass
the live gate as it stands. Additional repetitions, A/B and Claude comparison
require separate current approval. This package does not authorize publication
or a production change.
