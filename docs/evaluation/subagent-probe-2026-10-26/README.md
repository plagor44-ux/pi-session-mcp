# Claude Code subagent probe (K7): session sharing and wake target

Date: 2026-10-26. Base `d93a6d6`, Sprint 11, task T5/K7. Provider-free,
dev-only: everything runs on the loopback fake Messages API with a dummy key
inside `unshare -rn`, like the existing L3 probe (see the
[ledger event bridge evaluation](../ledger-event-bridge-2026-10-21/README.md)).

## Questions

- **Q1.** When a Claude Code subagent (the Agent/Task tool) starts a
  pi-session-mcp session and prompts it, does `pi_session_list` called
  afterwards by the main conversation list that session? The docs say a
  subagent that references a configured MCP server shares the parent's
  connection; that is unverified. A shared connection means one server process
  and one registry; a separate connection means a second registry whose
  sessions the main conversation cannot list (the X6 result).
- **Q2.** When the shipped wake hook (`dist/wake-main.js`, an asyncRewake
  PostToolUse hook) fires for the subagent's `pi_session_prompt` and later
  exits 2, which conversation receives the wake reminder: the main
  conversation, the subagent, or none? Hook inputs inside subagents carry
  `agent_id` and `agent_type`; the docs do not say whom asyncRewake wakes.

## Harness

The product probe is extended, not replaced: scenario `K7` runs in
`eval/bridge/product-probe.ts` against the product-wired server
(`product-server-main.ts`: product config, `TurnEventSpool`, `createServer`,
scripted worker adapter) and the hook that the product setup installer
(`src/setup-hooks.ts`) wrote into the client's settings. The scripted main
model calls the Agent/Task tool (the scenario leaves the client's built-in
tools on; every other scenario keeps them off); the scripted subagent calls
`pi_session_start`, then `pi_session_prompt` (the scripted worker completes
that turn after 4 s), then finishes; the main model calls `pi_session_list`
after the subagent returns; the probe then waits a bounded window (10 s after
the main script ends, 45 s overall) for the wake.

Subagent requests are recognized from the request body alone, by the first
rule that fires (the matched rule is recorded per request):

1. `exit_tool`: the tool list contains the subagent-only exit tool
   (`ExitAgentTool` / `ExitTaskTool`);
2. `system_marker`: the system prompt carries the sentence
   "You are an agent for Claude Code";
3. `request_class`: the client's `x-claude-code-request-class` header names an
   agent class (not the main classes);
4. `fresh_history`: the request offers this product's tools but its history
   lacks the seed user message that every main-conversation request still
   carries, and it has no Agent/Task spawner tool.

The `agent_id` observation uses a second, probe-owned PostToolUse entry with
the product's matcher, added to the probe's own disposable settings file after
the product installer ran (`eval/bridge/k7-hook-observe.ts`). It receives the
same hook input JSON as the shipped waiter and records only the tool name and
whether the input carried `agent_id` / `agent_type` (booleans). The product's
own hook entry is not modified.

The scenario is record-only: `passed_expectation` reflects a clean run
(MCP connected, a subagent conversation seen, its session started, the main
list called), not the answers, which are unknown until run.

## Recorded fields (`K7.json`, `subagent.*`)

| Field | Meaning |
| --- | --- |
| `q1_main_lists_subagent_session` | true when the main conversation's `pi_session_list` result contains the session the subagent started |
| `subagent_session_started`, `subagent_prompted` | whether the subagent's start/prompt calls succeeded at all (a false here means the sharing premise failed earlier than the registry) |
| `q2_wake_target` | `main`, `subagent`, `auxiliary` or `none`: the conversation of the first request that carried the `pi-session-mcp:` reminder |
| `q2_wake_request_ordinal`, `q2_wake_request_scope`, `q2_wake_request_role` | that request's ordinal, subagent classification and client role |
| `q2_hook_input_agent_id`, `q2_hook_input_agent_type` | whether the hook input seen for the subagent's `pi_session_prompt` carried `agent_id` / `agent_type` (booleans only, values never recorded) |
| `hook_observer_entries`, `hook_observer_prompt_entries`, `hook_observer_added` | how many entries the observation hook wrote for this product's tools in total (main and subagent together), how many of them were for `pi_session_prompt`, and whether the observation entry was installed |
| `subagent_requests`, `subagent_rules` | how many requests were classified as subagent and by which rule |

## Running only K7

```sh
npm ci
npm run build
npx tsc -p tsconfig.bridge.json
npx vitest run test/bridge-subagent.test.ts
node .bridge-eval/eval/bridge/cli.js product-probe --out <empty directory> --only K7
```

Linux with unprivileged user namespaces, `unshare` and `ip` required; the
probe re-executes itself inside `unshare -rn` with loopback only. The product
probe accepts any available Claude Code client (no pinned version; the
repository records 2.1.310 — the `2.1.303` pin lives only in the older `probe`
command, which this scenario does not use). Results land in
`<dir>/K7.json`; the command's exit code is 0 only when the record-only
expectations held.

## Results

One run by the controller on 2026-10-26 from 19:19:23 to 19:19:34 UTC, on the
host, Claude Code `2.1.310`, Node.js `26.12.1`, from a temporary worktree of
the worker's commit `bed44bf` after `npm ci`, `npm run build` and
`npx tsc -p tsconfig.bridge.json`. The record-only expectations held (exit
`0`, clean teardown, no leftover process). Result files:
[`results/K7.json`](results/K7.json), [`results/summary.json`](results/summary.json).

| Run | Q1: main lists the subagent session | Q2: wake target | Reminder request | Hook input carried `agent_id` |
| --- | --- | --- | --- | --- |
| 1 | yes | `main` (kind `terminal`, 23 ms after the event) | request 8 of 9, main conversation | yes (and `agent_type`) |

- Three requests were classified as subagent requests, all by rule
  `system_marker`; the other rules did not fire. The rule is therefore
  observed once on 2.1.310, not shown to hold on other client versions.
- The observation hook recorded two entries for this product's tools, one of
  them for the subagent's `pi_session_prompt`; the counts are not scoped to
  the subagent (the other entry can be the main conversation's `pi_turn_get`).
- Request order: the main conversation sent its next request (request 3, at
  411 ms) while the subagent was still running (its requests 2, 4 and 5 at
  366, 412 and 433 ms), so the Agent tool returned before the subagent ended.
  The main conversation's `pi_session_list` therefore raced the subagent. A
  race can only make Q1 read "no" although the server is shared; it cannot
  make it read "yes", so the recorded "yes" stands. The wake (request 8, at
  4449 ms) came after the subagent's last request.

What this means for K7 (a dispatcher subagent per Pi task): the subagent's
sessions live in the main conversation's server, so the main conversation can
list, read and close them, and a wake for a subagent's turn that ends after
the subagent has returned reaches the main conversation. Whether a subagent
that is still running when its turn ends would receive the wake itself was
not tested.

Limits of this probe, from its cross-family review:
- The main conversation's list is not gated on the subagent having started
  its session, so a later run can record a false "no" for Q1 (see above).
- A subagent request that carries neither the exit tool nor the system marker
  nor an agent request class, but inherits the seed history, is classified as
  main; such a request carrying the wake would be reported as `main`. In this
  run every subagent request matched `system_marker`.
- One run on one client version.
