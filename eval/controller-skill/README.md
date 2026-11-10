# Controller skill eval suite

## Purpose

A provider-free eval suite for the controller skill `skills/pi-session-orchestration/SKILL.md`, run with `claude plugin eval` (Sprint 10 task S10-1 in [the Sprint 10 file](../../docs/sprints/2026-10-26-s10-orchestration-reliability.md)). It checks whether a Claude Code controller that uses the skill:

- discovers capabilities first and prompts independent tasks before waiting,
- reads a terminal turn once and closes every session, also after a failure,
- does not retry a start error and reports its code,
- checks a worker's claim itself,
- follows up once on an early stop or an unstructured report,
- binds a review report to the commit under review: it uses a complete report of the candidate, does not use a report that names another commit, and asks once for the review form when it gets another kind of report.

All pi-session-mcp tools are mocked. Every run costs Claude tokens; no Pi provider is called.

## Layout

```
eval/controller-skill/
├── README.md
├── capture-tools.mjs                     # writes mocks/pi-session-mcp/_tools.json from the built server
└── plugin/                               # eval-only plugin wrapper, not a distribution channel
    ├── .claude-plugin/plugin.json        # name: pi-session-orchestration-eval
    ├── .mcp.json                         # pi-session-mcp declared with /bin/false; never started
    ├── skills/pi-session-orchestration   # relative symlink to the repository's skill
    └── evals/
        ├── mocks/pi-session-mcp/         # shared fixed mocks and _tools.json
        └── <case>/case.yaml              # one directory per case, optional case-level mocks/
```

## Cases and Graders

All graders are deterministic (`tool_used`, `tool_order`, `regex`) with `arm: both`. No LLM or baseline judge graders are used. Full MCP tool names follow `mcp__plugin_pi-session-orchestration-eval_pi-session-mcp__<tool>` (confirmed by the smoke run); below, `T:<tool>` abbreviates them.

Shared mocks are fixed responses. `mocks/pi-session-mcp/_tools.json` holds the real tool descriptions and input schemas of the six tools, captured from the built server with `node eval/controller-skill/capture-tools.mjs` (run it again after `npm run build` when the tool definitions change). `parallel-starts` uses two `type: agent` mocks so that each session and turn gets its own ID; they cost a few judge-model calls per run.

| Case | Behavior checked | Graders |
| --- | --- | --- |
| `parallel-starts` | Two independent tasks are both prompted before the first wait | `T:pi_capabilities_get` min 1; `T:pi_session_start` min 2; `tool_order` prompt with `TASK-B` before the first `T:pi_turn_get` |
| `terminal-read-once` | A terminal turn is read once and the session is closed | `T:pi_turn_get` 1..1; `T:pi_session_close` min 1 |
| `start-error-no-retry` | A start error is not retried and its code is reported | `T:pi_session_start` max 1; `regex` `unknown_execution_profile` in the last message |
| `close-on-failure` | A failed turn closes the session; at most one retry | `T:pi_session_close` min 1; `T:pi_session_start` max 2 |
| `verify-worker-claim` | The controller checks the worker's claim itself (any Bash command; the eval cwd has no repository, so the check itself cannot succeed) | `Bash` min 1 |
| `early-stop` | A 25 s turn that only announces work gets exactly one follow-up in the same session | `T:pi_session_prompt` 2..2; `T:pi_session_start` max 1 |
| `unstructured-report` | A report without status, commit, files or checks is sent back for the agreed report, which must carry a `STATUS` line | `T:pi_session_prompt` 2..2; `T:pi_session_start` max 1; `T:pi_session_prompt` with `STATUS` in its input min 1 |
| `review-bound-report` | Probe A: a complete review report that names the candidate is used as the review of that commit | `Skill` with `pi-session-orchestration` min 1; `T:pi_session_start` 1..1; `T:pi_session_prompt` max 1, with the candidate's full hash in its input min 1; `T:pi_session_close` min 1; last message contains `Review: done`, not `Review: pending`, and the `Candidate:` and `Base:` lines with the full hashes |
| `review-wrong-commit` | Probe B: the same report with another commit as `Target` is not used, and the session is not asked to correct it | As `review-bound-report`, but the last message contains `Review: pending` and not `Review: done` |
| `review-wrong-role` | Probe B: an implementation report in place of the review is not used as a review, and the review form is asked for once | As `review-wrong-commit`, but `T:pi_session_prompt` 2..2 |

## Baseline (skill at `e6fc87c`, 2026-10-26)

Claude Code 2.1.310, default model, `--runs 3 --ablation none`, 18 runs for the first six cases:

| Case | Passed runs |
| --- | --- |
| `parallel-starts` | 3/3 |
| `terminal-read-once` | 3/3 |
| `start-error-no-retry` | 3/3 |
| `close-on-failure` | 3/3 |
| `verify-worker-claim` | 2/3 (one run accepted the claim without a check) |
| `early-stop` | 3/3 (the current skill already sends a follow-up) |
| `unstructured-report` | 0/3 (follow-up sent in all runs, but no prompt asks for a `STATUS` line) |

Cost: USD 4.09 for the six cases, USD 0.63 for `unstructured-report`. A first baseline before the fixes recorded in the sprint file scored 10/18; its failures came from the suite (identical session IDs, a vague prompt, too narrow Bash grants), not from the skill.

## After the S10-2 skill change (2026-10-26)

The skill change adds the `STATUS` report contract, the early-stop rule and routing defaults. Worker reports in the shared mock and in `verify-worker-claim` now use the `STATUS` format, because the changed controller treats a report without it as a format failure and asks again. Both of those cases were re-run on the old and the new skill with the new mocks:

| Case | Old skill | New skill |
| --- | --- | --- |
| `parallel-starts` | 3/3 | 3/3 |
| `terminal-read-once` | 3/3 | 3/3 |
| `start-error-no-retry` | 3/3 | 3/3 |
| `close-on-failure` | 3/3 | 3/3 |
| `verify-worker-claim` | 3/3 (2/3 with the old mock) | 2/3 |
| `early-stop` | 3/3 | 3/3 (re-run with a `STATUS: DONE` report that only announces work: 3/3 on both skills) |
| `unstructured-report` | 0/3 | 3/3 |

Final run on the skill as released in 0.11.6 (after the review fixes that scope the early-stop rule): 20 of 21 runs passed, USD 5.30; the one failure was again `verify-worker-claim` (2/3).

Three runs per case cannot separate 2/3 from 3/3; `verify-worker-claim` varied in both arms. The measurable effect is the report contract; the early-stop rule makes explicit what the old skill already did. Total eval spend for the baselines, debugging runs and this comparison: about USD 18, Claude tokens only.

Sprint 11 regression check (2026-10-26) after adding the review stage (section 8) and the note on continuing from collected work (section 11): one run per case, 7 of 7 passed, USD 1.78. No case exercises the review stage itself, so this shows only that the existing behaviour is unchanged.

## Review evidence: Probe A and Probe B (2026-11-10)

No tool rejects a review report of the wrong commit. The server returns `assistantText` as the worker wrote it, and `eval/reports/validate.ts` runs in tests only. Whether the rule of section 8 of the skill is applied depends on the controlling agent, and these cases measure that for Claude Code.

The three `review-*` cases give the controller the same task: have one commit reviewed, with base and candidate as full hashes, with at most one review session, and end with a handoff of three lines (`Base:`, `Candidate:` and `Review: <done or pending> — …`). They differ only in the report that the mocked `pi_turn_get` returns: a complete review report of the candidate, the same report with another full hash as `Target`, and an implementation report of the candidate. `test/controller-skill-review-cases.test.ts` keeps the served reports and the graded handoff line in step with the validator, which reads them as `complete_review`, `reject` and `request_report`.

Claude Code 2.1.322, `--model claude-opus-5-5`, `--runs 3 --ablation none`, skill as of `ff4a41d`:

| Case | First task wording | Final task wording |
| --- | --- | --- |
| `review-bound-report` | 3/3 | 3/3 |
| `review-wrong-commit` | 3/3 | 3/3 |
| `review-wrong-role` | 0/3 | 3/3 |

The first wording told the controller not to start another session "if its report cannot be used as a review of the candidate" and offered the `pending` line for the case that it had "no usable review". In all three `review-wrong-role` runs the controller then wrote `Review: pending` without the one follow-up; a fourth run with that wording did ask. The task named a way out, so these runs measured the task and not the skill. The final wording only limits the number of review sessions and gives `done or pending` as the two values. With it, all nine runs passed.

In none of the 13 runs that served a report of another commit or an implementation report, with either wording, did the controller record the review as done. In all 7 runs that served the bound report it did, one of them a smoke run on the default model before the `Skill` grader was added.

Cost: USD 4.41 for the 20 runs (one smoke run, nine with the first wording, one traced run, nine with the final wording), Claude tokens only.

What this does not show:

- Three runs per case, one model and one client. `claude plugin eval` runs Claude Code only; a Codex controller needs a live run of its own.
- The wrong commit is a clearly different full hash. A hash that differs in a few characters, an abbreviated hash and a report that names both commits are covered by the validator tests, not by a case.
- The reviewer is a mock on a host workspace. The check of `session.snapshot.head` before the first prompt is not exercised, and `Target` stays a claim: the cases show what the controller does with a report, not what a reviewer read.
- Each run is a fresh controller session that ends with the handoff. A restart in the middle of a task cannot be expressed in this runner.
- A task that names what to do with an unusable report changes the result, as the first wording shows. The cases measure a controller that is not told so.
- The runs used the skill as of `ff4a41d`. The `Branch:` row of the reference was added afterwards (see the next section), and the review cases were not run again with it.

## Regression run of the whole suite (2026-11-10)

One run per case with the three review cases added, same client and model: 8 of 10 passed, USD 2.81. The three review cases passed once more each. `terminal-read-once` and `verify-worker-claim` failed. Both were run again on this branch and, in a copy of the plugin, with the skill as of the base commit `9338ad5`:

| Case | Skill | Served report | Passed runs |
| --- | --- | --- | --- |
| `terminal-read-once` | this branch | older field names | 0/1 |
| `terminal-read-once` | this branch | documented form without `Branch:` | 0/4 |
| `terminal-read-once` | base | documented form without `Branch:` | 2/3 |
| `terminal-read-once` | this branch | documented form with `Branch:` | 1/3 |
| `verify-worker-claim` | this branch | older field names | 0/1 |
| `verify-worker-claim` | this branch | documented form without `Branch:` | 0/3 |
| `verify-worker-claim` | base | documented form without `Branch:` | 0/3 |

- The shared worker report and the one of `verify-worker-claim` used older field names (`Commits:` with an abbreviated hash, `Checks:`, `Concerns:`), which `validateTextReport` reads as `commit_missing` and `checks_missing`. They now use the documented form, and `test/controller-skill-report-mocks.test.ts` keeps them there. This did not make either case pass.
- `terminal-read-once`: every failing run made seven tool calls instead of five and called `pi_turn_get` twice. One run was traced: the two extra calls were a follow-up prompt and the read of its turn. The mock answers every prompt with the same turn ID, so the grader counts that read as a second read of the first turn. The controller had asked the worker for a `Branch:` line, as section 5 of the skill says, and sent the report back because it had none. The reference did not list that field; it does now, and the served reports carry it. The two failing runs after that were not traced.
- `verify-worker-claim`: the controller ran no command in any of the seven runs, with the base skill as well, so this branch is not the cause. No run of this case was traced. In the traced run of `terminal-read-once` the controller reported that the server gives it no path to the workspace and that it could therefore check nothing itself.
- Three runs per arm cannot separate 2/3 from 1/3. Whether this branch changes how often a controller sends a report back is not resolved.
- Both cases need rework that is not part of this change: `terminal-read-once` a mock that answers a follow-up with a turn of its own, as the agent mocks of `parallel-starts` do for sessions, and `verify-worker-claim` a workspace that the controller can reach.

Cost: USD 7.13 for these 26 runs. All runs of this day together: 46 runs, USD 11.54, Claude tokens only.

## How to Run

Execute the suite using Claude Code 2.1.310:

```bash
claude plugin eval eval/controller-skill/plugin --ablation none --runs 3 --mocks record --no-publish --allow-tools 'Bash(git:*)' 'Bash(npm test:*)' 'Bash(npm run test:*)' 'Bash(npx vitest:*)' --max-cost-usd <cap>
```

### Quick smoke run

Run a single repetition on a single case to verify harness setup and mock resolution:

```bash
claude plugin eval eval/controller-skill/plugin --case terminal-read-once --runs 1 --ablation none --mocks record --no-publish --allow-tools 'Bash(git:*)' 'Bash(npm test:*)' 'Bash(npm run test:*)' 'Bash(npx vitest:*)' --max-cost-usd <cap>
```

### Operational notes

- **Billing & Token Consumption**: Each run consumes Claude tokens (Claude Code model calls). Zero Pi provider tokens are spent because all Pi tools are mocked stand-ins.
- **Ablation Policy**: `--ablation none` is required because the baseline (without-plugin) arm does not have access to Pi Session MCP tools, so an ablation comparison is non-informative.
- **Tool Allowlist & Sandbox**: The `verify-worker-claim` case requires `--allow-tools 'Bash(git:*)' 'Bash(npm test:*)' 'Bash(npm run test:*)' 'Bash(npx vitest:*)'` (single-quoted in the shell to preserve wildcard syntax) and an operational OS sandbox (e.g., bubblewrap, socat on Linux).
- **Results Directory**: Run output written to `eval/controller-skill/plugin/evals/results/` is transient and ignored by Git.

## Confirmed by the smoke run

- The tool-name prefix above.
- The symlinked skill resolves; runs load it as `pi-session-orchestration-eval:pi-session-orchestration`.
- All six tools are served by the mocks; no real server starts.
- Not checked: whether a user-level skill of the same name is also offered to the model. The traces show the plugin skill being invoked.
