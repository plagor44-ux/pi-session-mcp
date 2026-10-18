# Tool definitions: behavior hints (#88) and UUID pattern (#90), 2026-10-18

Evidence for two changes to the `tools/list` definitions in `src/server.ts`.
No tool name, argument, result, state, annotation or error semantics changed.
Nothing under `docs/evaluation/token-footprint-2026-10-17/` was modified.

## Result

| Issue | Change | Status |
| --- | --- | --- |
| #88 | Short factual behavior hints appended to the descriptions of `pi_capabilities_get`, `pi_session_prompt`, `pi_session_close`, `pi_turn_get` | Implemented, +255 description bytes |
| #90 | The six UUID input fields no longer repeat the zod `pattern` (179 bytes per occurrence as a JSON member) in the input JSON Schema; `format: "uuid"` is kept | Implemented, -1,074 bytes; 156 compared cases byte-identical |

New descriptions (the other four are unchanged):

- `pi_capabilities_get`: "... This reports configured intent, not provider or runtime availability. Call once at the start of a run."
- `pi_session_prompt`: "Accept a prompt after Pi preflight and run the turn in the background. Returns a running turn at once; poll pi_turn_get with pauses."
- `pi_session_close`: "Abort if needed, dispose, and remove a Pi session. Idempotent; close every started session."
- `pi_turn_get`: "Get the normalized observable result of a Pi turn. completed, failed and aborted are terminal and never change: read a terminal turn once. completed is not task success."

The hints restate existing behavior (`docs/tool-contracts.md`, the
`pi-session-orchestration` skill): `pi_session_close` returns the stored view for
an already closed session (`SessionRegistry.close`), terminal turns are final, and
`completed` only means the Pi turn finished.

## Source and environment

- Base: `612fbcb` (main, PR #85 merged). #88 commit `e8c65ea`, #90 commit `22eb9de`
  on branch `s5/d`; this evidence is committed after them.
- Package 0.8.3, `@modelcontextprotocol/server` 2.3.1, `zod` 4.6.5 (all pinned in `package.json`).
- Node v26.11.1 on Linux for the scripts below (the package supports >=22.19.0; byte counts do not depend on it).
- Codex CLI installed on the workstation: `codex-cli 0.162.1`.

## Observation versus measurement

- Measurement (reproducible, this directory): UTF-8 byte counts of the `tools/list`
  frame and of JSON serializations of tool definitions of the built server, and the
  JSON-RPC validation responses. They depend only on the source tree.
- Observation (not re-measured, quoted from the 2026-10-17 evidence): the Codex request
  figures 2,246 bytes (eight pi definitions) and 21,412 bytes (whole Codex `tools`
  array, `current-client-projection.json`). Byte counts are not token counts; no model
  usage, tokenizer or cost is claimed here.

## (a) `tools/list` wire bytes

Whole JSON-RPC response frame including the trailing LF, read from stdout of
`node dist/main.js` with a throwaway configuration (no Pi session is started).
The `tools` array is 45 bytes smaller than the frame (envelope).

| State | Frame bytes | `tools` array bytes | Delta frame |
| --- | ---: | ---: | ---: |
| Base `612fbcb` | 19,962 | 19,917 | |
| After #88 (`e8c65ea`) | 20,217 | 20,172 | +255 |
| After #90 (`22eb9de`) | 19,143 | 19,098 | -1,074 (vs #88), -819 (vs base) |

The base `tools` array of 19,917 bytes reproduces the figure in
`token-footprint-2026-10-17/README.md`.

## (b) Eight pi definitions as the model sees them (name + description + inputSchema)

Formula used here: for each tool `JSON.stringify({name, description, inputSchema})`, UTF-8
bytes, summed over the eight tools. The existing meter
(`eval/profiles/token-meter.ts`, `definition_bytes`) serializes the whole tool object
(including `outputSchema` and `annotations`) and does not compute this projection.

| Tool | Base | After #88 | After #90 |
| --- | ---: | ---: | ---: |
| `pi_capabilities_get` | 307 | 340 | 340 |
| `pi_session_start` | 410 | 410 | 410 |
| `pi_session_list` | 216 | 216 | 216 |
| `pi_session_get` | 456 | 456 | 277 |
| `pi_session_prompt` | 567 | 629 | 450 |
| `pi_session_abort` | 480 | 480 | 301 |
| `pi_session_close` | 477 | 518 | 339 |
| `pi_turn_get` | 703 | 822 | 464 |
| **Sum** | **3,616** | **3,871** | **2,797** |

Description bytes alone: 488, 743, 743. The whole-definition sizes in the existing meter
(for example `pi_session_prompt` 5,025 bytes at base) reproduce.

**Not reproduced:** the quoted 2,246 bytes for the eight pi definitions. The formula
above gives 3,616 at base. Variants tried (same base state): without `$schema` 3,160;
without `$schema` and `additionalProperties` 2,928; name and description only 836;
`inputSchema` only 2,660. None gives 2,246, so the definition behind that figure is
unknown here and the figure is not used as a target. Compare only like with like:
the deltas above (+255, -1,074) are exact for this formula, and the whole-frame
numbers in (a) are exact.

## (c) Codex projection: open measurement gate

The provider-free loopback probe exists:
`npm run --silent eval:profiles -- --footprint-client-offline --output <new dir>`.
It runs the actual Codex CLI against a no-auth loopback Responses endpoint and records
`tools_bytes` of each request. Before and after the changes it stops immediately with
exit code 1 and `{"event":"profile_evaluation_stopped","code":"invalid_input_or_failed_gate"}`
because `measureClientProjection` in `eval/profiles/token-client-projection.ts` requires
exactly `codex-cli 0.162.0` and this workstation has `codex-cli 0.162.1`
(`unsupported_fixture_client`). No request was sent and nothing was recorded.

Per the task rules the pin was not edited (outside the allowed paths) and no
substitute probe was improvised. The actual Codex `tools` array size, and its eight pi
definitions, for these changes are therefore **unmeasured**. Closing the gate needs
either `codex-cli 0.162.0` or an approved change of the version pin (then re-run
before and after). Expected direction only: the projection shrinks by the pattern
removal (up to 1,074 bytes before any Codex re-encoding) and grows by the 255 description
bytes; the Codex-side encoding was not measured.

## #90 compatibility finding

Public APIs only: `z.string().meta({ format: "uuid" }).pipe(z.string().uuid())`.
The SDK converts input schemas through the standard-schema `jsonSchema.input()` of
zod, which, for a pipe, emits the schema of the input stage (`type: "string"`,
`format: "uuid"`). Validation still runs the unchanged `z.string().uuid()` as the second
stage, so the accepted set and every zod issue are produced by the same code as before;
no copied regex exists. `.pipe`, `.meta` and `z.string().uuid()` are documented zod 4 API.
Output schemas keep `z.string().uuid()` and are unchanged.

Comparison of the base build and the candidate build (`compare-validation.mjs`,
`diff-validation.mjs`): 26 values for each of the six fields (`sessionId` in
`pi_session_get`, `pi_session_prompt`, `pi_session_abort`, `pi_session_close`,
`pi_turn_get`; `turnId` in `pi_turn_get`), 156 calls. Each call is the raw JSON-RPC
response over a linked in-memory transport with a counting fake adapter and one live
running session.

- Raw responses (including JSON-RPC ids, `content`, `structuredContent`, `isError`) are
  byte-identical in all 156 cases; the three read-only calls on the live session are identical.
- Valid UUIDs of unknown sessions or turns (v4 and a variant-9 value, upper case,
  mixed case, nil, max) yield the existing domain error `unknown_session` or
  `unknown_turn` with `isError: true` and `structuredContent`.
- Invalid values yield the SDK's `isError: true` text result without
  `structuredContent`, for example
  `Input validation error: Invalid arguments for tool pi_turn_get: turnId: Invalid UUID`,
  or `... sessionId: Invalid input: expected string, received number`. Wrong length, trailing
  newline, no hyphens, version nibble 0 or 9, variant nibble 7 or c, non-hex, empty string,
  number, null, boolean, object, array and a missing field are all rejected the same way.
  In SDK 2.3.1 this is a tool result with `isError`, not a JSON-RPC error object.
- Side effects: 0 of 156 rejected or unknown calls changed `pi_session_list`, `pi_turn_get`
  or `pi_session_get` of the live session; the adapter saw only the two expected calls
  (`create`, `prompt`).
- The accepted set is the zod regex: upper-case hex digits are accepted
  (`AAAAAAAA-...` reached `unknown_session`), nil and max are accepted in lower case,
  but upper-case max `FFFFFFFF-FFFF-...` is rejected. This is unchanged.
- Differences in `tools/list`: only the six `pattern` members of the UUID fields are gone
  (patterns in input schemas 8 to 2; the two left are the workspace and execution-profile alias
  patterns). Output schemas and annotations are identical.

The unit test `keeps strict UUID input validation while the input schemas omit the
repeated pattern` (`test/mcp-contract.test.ts`) pins this contract.

Residual effect: a client that validates arguments against the published input schema
before sending, and relies on `pattern` rather than `format`, no longer rejects a malformed
UUID locally. The server rejects it exactly as before.

## ADR 0003 classification

ADR 0003: changes that keep the public MCP contract (tools, fields, states, error codes)
ship as patch releases; any contract change needs a minor release and its own decision.

- #88 changes description text only. No tool, field, state or error code changes: patch.
- #90 changes the published input JSON Schema, but accepted values and every error are
  identical (evidence above), so no tool, field, state or error code changes: patch.
  Had the accepted set or any error differed, it would have been a minor change needing its
  own decision; it did not.
- No version bump is part of this work.

## Reproduce

```sh
# in a checkout of the state to measure (base: git worktree at 612fbcb)
npm ci && npm run build
node docs/evaluation/tool-definitions-2026-10-18/measure-wire.mjs "$PWD" /tmp/wire.json
node docs/evaluation/tool-definitions-2026-10-18/compare-validation.mjs "$PWD" /tmp/validation.json
node docs/evaluation/tool-definitions-2026-10-18/diff-validation.mjs /tmp/validation-base.json /tmp/validation.json
```

`compare-validation.mjs` loads `dist/` and `node_modules` of the root it is given; a base
checkout therefore needs its own build. The measurements here used a copy of the base `dist/`
next to a symlinked `node_modules`. The scripts write only to the given output path and a
temporary directory.

Checks run for the code commits: `npm run typecheck` (exit 0), `npm run build` (exit 0),
`vitest run test/mcp-contract.test.ts` (27 tests passed) and, additionally,
`test/mcp-sdk-integration.test.ts`, `test/install-smoke.test.ts`,
`test/token-footprint.test.ts`, `test/client-adapters.test.ts` (125 tests passed in total
with the contract file). The full suite was not run.
