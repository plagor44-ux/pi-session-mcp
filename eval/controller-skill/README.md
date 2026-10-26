# Controller skill eval suite

## Purpose

A provider-free eval suite for the controller skill `skills/pi-session-orchestration/SKILL.md`, run with `claude plugin eval` (Sprint 10 task S10-1 in [the Sprint 10 file](../../docs/sprints/2026-10-26-s10-orchestration-reliability.md)). It checks whether a Claude Code controller that uses the skill:

- discovers capabilities first and prompts independent tasks before waiting,
- reads a terminal turn once and closes every session, also after a failure,
- does not retry a start error and reports its code,
- checks a worker's claim itself,
- follows up once on an early stop or an unstructured report.

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
