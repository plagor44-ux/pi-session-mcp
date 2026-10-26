# Controller ledger hooks (2026-10-26)

## Purpose and scope

This development-only operator aid implements K3 (compaction context) and K9
(verification Stop gate) from the [Sprint 10 plan](../../sprints/2026-10-26-s10-orchestration-reliability.md).
Decision D1 starts outside the package: these hooks are run from a checkout,
not installed by setup, and do not change the public MCP contract.

`hook-ledger` projects PostToolUse results into `run.json` and generated
`task.md`. `hook-compact` restores a short reminder and the rendered task table
after compaction. `hook-stop` asks for verification when a task's latest turn
is completed with a consumed result and the task has no decision, or when its
latest turn failed or aborted and the latest attempt's session cleanup is still
open. A completed turn whose result was never read does not block, and closing
the session (`pi_session_close`, recorded as `session_closed` with cleanup
`closed` or `close_failed`) clears the failed/aborted case. Running turns and
open sessions alone never block, so the wake hook can continue its work.

## Run from a checkout

Use the existing bridge evaluation compilation workflow, with Node.js 22.19.0
or newer and the checkout's installed dependencies:

```sh
npm ci
npx tsc -p tsconfig.bridge.json
export BRIDGE_LEDGER_DIR="$HOME/.local/state/pi-ledger/run-unique-id"
export BRIDGE_LEDGER_INSTANCE=ctl-local
export BRIDGE_LEDGER_RUN=run-unique-id
# Each program consumes the corresponding Claude Code hook JSON on stdin:
node .bridge-eval/eval/bridge/hook-ledger.js
node .bridge-eval/eval/bridge/hook-compact.js
node .bridge-eval/eval/bridge/hook-stop.js
```

Run each command separately with its hook input (or let Claude Code invoke it).
The projection hook initializes a missing ledger on the first relevant tool
result. The other hooks never initialize one. Recompile after source changes.
Use a separate `BRIDGE_LEDGER_DIR` **per run**, consistently for all three hooks;
do not share the same directory across unrelated controller runs.

Merge this example into `~/.claude/settings.json`; replace `/CHECKOUT` and
`/RUN-LEDGER` with absolute local paths. Preserve any existing wake hook and
other hooks. The PostToolUse matcher follows `WAKE_MATCHER` in
`src/setup-hooks.ts`, adding start, abort and close. Adjust server-name prefixes
if your configured MCP server has a different name.

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "mcp__pi-session-mcp__pi_(session_(prompt|start|abort|close)|turn_get)|mcp__pi-coding-.*__pi_(session_(prompt|start|abort|close)|turn_get)",
      "hooks": [{
        "type": "command",
        "command": "BRIDGE_LEDGER_DIR='/RUN-LEDGER' BRIDGE_LEDGER_INSTANCE=ctl-local BRIDGE_LEDGER_RUN=run-unique-id node '/CHECKOUT/.bridge-eval/eval/bridge/hook-ledger.js'"
      }]
    }],
    "SessionStart": [{
      "matcher": "compact",
      "hooks": [{
        "type": "command",
        "command": "BRIDGE_LEDGER_DIR='/RUN-LEDGER' node '/CHECKOUT/.bridge-eval/eval/bridge/hook-compact.js'"
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "BRIDGE_LEDGER_DIR='/RUN-LEDGER' node '/CHECKOUT/.bridge-eval/eval/bridge/hook-stop.js'"
      }]
    }]
  }
}
```

After checking the workspace or collected refs, record a controller decision
with the existing CLI (substitute actual task ID, timestamp and evidence):

```sh
printf '%s\n' '{"type":"decision","eventId":"review-001","at":"2026-10-26T12:00:00.000Z","source":"controller","taskId":"t-example","outcome":"accepted","evidence":["Targeted tests passed; diff reviewed"]}' |
  node .bridge-eval/eval/bridge/ledger-cli.js apply --dir "$BRIDGE_LEDGER_DIR"
```

A decision can be accepted or rejected; the current reducer requires a completed,
consumed result. Failed or aborted turns therefore need recovery rather than a
fabricated accepted decision: inspect the workspace or collected refs, then close
the session with `pi_session_close` or start a new attempt. Closing a session is
cleanup, not a task decision; it clears the failed/aborted Stop case but does not
create a decision. There is no separate task-close event in the current ledger.
The Stop reason separates both cases into their own groups.

## Limits

- Claude Code only; not a Codex or generic MCP lifecycle integration.
- Fail-open operator guidance, not authorization or policy enforcement. Missing,
  invalid, unreadable or locked ledgers produce no compaction/Stop output; both
  programs exit 0. Stop also emits nothing when `stop_hook_active` is true, so
  the gate fires at most once per stop cycle.
- Compaction context is at most 8 KiB UTF-8, truncated at a complete line with a
  marker. Stop names at most ten task IDs per reason group, then counts the
  remainder.
- No assistant text or prompts are stored by the projection hook: result text
  contributes only a hash, byte count and truncation flag. Context contains
  ledger metadata, not result bodies, paths, prompts or stack traces.
- Projection is only as current as observed tool results; it is not a background
  monitor. A busy/stale lock skips the read instead of waiting or breaking it.
- This file ledger is an evaluation aid outside the package. The product remains
  local stdio with in-memory state; this does not add product persistence/resume.

## Not yet verified

The live test with **three running tasks, then `/compact` has not run**.
No live compaction continuity, client installation, or provider-backed
orchestration success is claimed here. Unit tests use temporary directories and
no provider; they do not substitute for the Sprint 11 live test.
