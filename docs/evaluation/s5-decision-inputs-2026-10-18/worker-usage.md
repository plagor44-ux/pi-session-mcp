# Research note: worker token usage on terminal turns (#92)

Date: 2026-10-18. Source: main `612fbcb`, pinned `@earendil-works/pi-coding-agent`,
`pi-agent-core` and `pi-ai` **1.2.0** (versions read from the installed
`package.json` files after `npm ci`). Research only: no MCP field, no runtime
change and no internal import follows from this note. Any new public field needs
its own decision and a minor release under ADR 0003.

A read-only Pi worker did the first pass; its line references came from a stale
`node_modules` tree that still held 1.1.0 although the lockfile pins 1.2.0. The
statements below were rechecked by the integrator against the 1.2.0 artifacts.
Package-relative paths: **AI** = `pi-ai`, **CA** = `pi-coding-agent`,
**AC** = `pi-agent-core`.

## What the public root exports carry

- `Usage` is reachable from the package roots (`exports["."]` only). It has
  `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` and
  `cost.{input,output,cacheRead,cacheWrite,total}`, plus two optional fields
  (AI `dist/types.d.ts:274-295`).
- Assistant messages always carry `usage` (AI `dist/types.d.ts:370`;
  CA `docs/message-types.md:69`). Tool results may carry `usage` for nested model
  work, which "is not part of the main model-call usage" (CA
  `docs/message-types.md:170-177`).
- `compaction_end.result` can carry the summary call's `usage`
  (CA `dist/core/agent-session.d.ts:73`, `dist/core/compaction/compaction.d.ts:24`,
  `docs/compaction.md:153,165`). Automatic retries are separate session events
  (`auto_retry_start` / `auto_retry_end`, CA `dist/core/agent-session.d.ts:80,86`).
- `AgentSession.getSessionStats()` is cumulative over the whole session,
  including compacted history (CA `dist/core/agent-session.d.ts:883-886`), so it
  is not a per-turn value.
- The adapter already subscribes to root-exported `AgentSessionEvent`s and keeps
  the last assistant message, but reads no usage today (`src/sdk-pi-adapter.ts`).

## Documented semantics versus inference

| Topic | Documented | Not documented or inferred |
| --- | --- | --- |
| `reasoning` | Subset of `output`, already included; `undefined` when the provider gives no breakdown (AI `types.d.ts:281-286`; CA `docs/message-types.md:90`) | — |
| `cacheWrite1h` | Subset of `cacheWrite` (same places) | — |
| `input` vs `cacheRead` overlap, `totalTokens` formula | — | Not defined by the declarations; summing fields would risk double counting |
| Scope of one record | One assistant response, i.e. one model request; streaming `usage` is the latest cumulative value **within that response** and may stay zero until completion (CA `docs/json.md:95`) | — |
| One pi-session-mcp turn | — | Inferred: one `pi_session_prompt` turn spans several model requests (tool loop, AC `README.md:72-105`), possibly retries and compaction; no documented per-prompt aggregate exists |
| Missing vs zero | — | Not specified provider-wide; a reported 0 cannot be told apart from "not reported" |
| `cost` | Catalog price of the model (AI `types.d.ts:493`) | Not an invoice and not subscription cost |

## Consequence for a possible proposal

A terminal turn could carry optional usage only if it is named precisely, for
example "sum of the `usage` of the assistant responses observed in this turn",
with each field summed separately, `reasoning` never added to `output`,
`cacheWrite1h` never added to `cacheWrite`, nested tool usage and compaction
usage reported separately or excluded, and `null` when no assistant response was
observed. Whether that sum equals what the provider bills is **not** established,
and retries, compaction and nested tool calls make "per turn" a derived figure,
not an SDK-provided one.

Unsupported SDK need, recorded rather than worked around: a documented per-prompt
usage aggregate (covering retries, compaction and nested tool work) and a
documented distinction between "not reported" and zero.

Next step only with a separate decision: a proposal with exact field semantics,
null rules and a minor release. Nothing in this sprint implements it.
