# Live pairs L1 (L4): two real controller pairs

Date: 2026-10-21. Two operator-approved pairs of case L1 (task T1, the M1 read
task with its independent oracle):

- arm A: skill cadence, polling;
- arm C: event bridge with `asyncRewake`.

Each arm ran once per pair. This is a small sample: it tests the critical
assumption and the pre-registered rule, nothing more.

## Binding

| | Pair 1 ([`run/`](run/)) | Pair 2 ([`run-2/`](run-2/)) |
| --- | --- | --- |
| Approval | [`run/approval.json`](run/approval.json) | [`run-2/approval.json`](run-2/approval.json) |
| Worker route | `explore-fast` values (`openai` / `gpt-6-luna` / low) | `review` values (`openai` / `gpt-6.1-sol` / high, as in the M1 A/B) |
| Order | A, then C | C, then A (counterbalanced) |
| Source | `8d355cc` (failed attempt: `cbbde55`) | `222dde5` |

Common to both pairs:

- Controller: Claude Code 2.1.306 (the client had auto-updated from 2.1.303; probe attempt 5 showed the same L3 behavior on 2.1.306) running `claude-sonnet-5-5`. It ran with a fresh, empty client configuration: no user settings, hooks, plugins or session persistence.
- Authentication: an API key from an owner-only file, passed only to the child process. The operator declined a subscription OAuth token.
- Worker: read-only, no skills, through the real `SdkPiSessionAdapter` behind `BridgedRegistry`, using the operator's existing Pi login.
- Clean worktree; the compiled build digest is recorded per run.

The operator decided each step in the Claude Code session:

- run the smallest test first;
- use an API key;
- bind to 2.1.306;
- raise pair 1's cap to 3 after the failed attempt;
- run pair 1's arm C despite the stop rule;
- run a repeat pair on the M1 worker route.

## Runs

| Run | Outcome |
| --- | --- |
| [run/01-L1-A](run/01-L1-A.json) | **Failed attempt, kept.** The API rejected the key (HTTP 400: key not scoped to a workspace) after 215 ms, with 0 tokens and 0 USD; no session started. The runner then waited for its 20-minute deadline. That harness defect is fixed in `8d355cc`. |
| [run/02-L1-A](run/02-L1-A.json) | Completed; lifecycle checks true; **oracle FAIL**. The worker answer was wrong in `api-data-flow`. |
| [run/03-L1-C](run/03-L1-C.json) | Completed; all checks true; oracle PASS. |
| [run-2/01-L1-C](run-2/01-L1-C.json) | Completed; all checks true; oracle PASS. |
| [run-2/02-L1-A](run-2/02-L1-A.json) | Completed; all checks true; oracle PASS. |

A one-request diagnostic call confirmed the new key before pair 1's second run.
It cost 0.006 USD.

## Measures

| | P1 A | P1 C | P2 C | P2 A |
| --- | ---: | ---: | ---: | ---: |
| Controller model requests (distinct assistant messages) | 8 | 7 | 8 | 8 |
| Running `pi_turn_get` polls | 2 | 0 | 0 | 2 |
| Terminal reads | 1 | 1 | 1 | 1 |
| `Bash` sleeps between polls | 3 | 0 | 0 | 3 |
| Wakes (`asyncRewake` exit 2 → new turn while idle) | 0 | 1 | 1 | 0 |
| Turn end (bridge event) → next controller message | 10,386 ms | 1,756 ms | 2,240 ms | 20,741 ms |
| Input not from cache (`input_tokens` + `cache_creation_input_tokens`) | 13,456 | 12,703 | 12,849 | 10,231 |
| Cache-read input tokens | 78,937 | 66,531 | 79,541 | 81,861 |
| Output tokens | 1,888 | 1,144 | 1,168 | 1,661 |
| Reported cost, `total_cost_usd` (cumulative per client session) | 0.0604 USD | 0.0498 USD | 0.0517 USD | 0.0504 USD |
| Wall time | 70 s | 29 s | 33 s | 80 s |
| Worker answer passes the T1 oracle | **no** | yes | yes | yes |
| Sessions closed, no leftover process, temp removed | yes | yes | yes | yes |

Reported controller cost in total: about 0.22 USD for the four completed runs,
plus 0.006 USD for the diagnostic call. Worker usage and cost were not measured.

Notes on reading the numbers:

- The detection row is the time from the bridge's terminal event to the
  controller's next message. In arm A the bridge also ran and wrote its events,
  but no hook listened to them, so the row shows how late polling noticed the
  end.
- Wall time includes the worker's own run time, which differs between runs, so
  wall time is not a controller effect on its own.
- `total_cost_usd` is cumulative across the turns of one client session; use
  `total_cost_usd_last`. `total_cost_usd_sum` in the files double counts in arm
  C.
- The `uncached_input_tokens` field in pair 1's files used the Codex formula,
  which is wrong for Anthropic usage. The table uses the corrected formula,
  which pair 2's files already contain.

## Against the pre-registered rules

- **Critical assumption (a woken real model reads once and does not poll):**
  held in both C runs. Each time the controller ended its turn after
  `pi_session_prompt`, was woken once, read the terminal turn once and closed
  the session, with no poll and no sleep.
- **Recommendation rule for product work** (quality in every pair, fewer
  controller model requests than A in every pair, no higher uncached input):
  **not met.** It fails on three counts:
  - pair 1 failed the quality criterion (worker answer in arm A);
  - pair 2 had equal requests (8 and 8);
  - pair 2 had higher uncached input in C (12,849 against 10,231).

  Cost was mixed: C was cheaper in pair 1 and slightly dearer in pair 2. The
  polls and sleeps that C removes are offset by the extra client turn that the
  wake opens.
- **What C did improve consistently** is the delay until the controller acts on
  a finished turn: 1.8 s and 2.2 s, against 10.4 s and 20.7 s with polling.

## Interpretation

For short read tasks like T1 (worker turns of roughly 20–60 s), the rewake does
not save controller requests or tokens. It saves latency and removes polls and
sleeps. The model-based expectation predicts a request saving only for longer
worker turns, where polling needs many more polls. Those were not measured.

## Limits

- Two pairs, one short case, one client version and one controller model.
- In pair 1 the worker outcomes differ between the arms.
- No interactive or VS Code run, no question round trip with a real model, no
  Codex.
