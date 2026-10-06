# ADR 0002: embedded Pi SDK

**Status:** Accepted

## Decision

Embed Pi through documented package-root SDK exports and encapsulate it behind `PiSessionAdapter`. Each managed embedded session owns an `AgentSession` created with `SessionManager.inMemory`, `SettingsManager.inMemory`, an explicit profile tool allowlist, and a `DefaultResourceLoader` that disables executable extensions and all project resources except non-executable `AGENTS.md` context.

## Rationale and consequences

Embedding avoids subprocess/RPC translation and exposes the documented preflight callback needed for non-blocking MCP prompts. The adapter makes lifecycle tests deterministic and credential-free. Pi shares the MCP process and OS privileges; this is management, not process isolation, and a crash or runaway operation affects the server. `AGENTS.md` remains model-influencing, untrusted context. Undocumented internal imports are prohibited, so transcript/result retrieval remains out of scope until supported publicly.
