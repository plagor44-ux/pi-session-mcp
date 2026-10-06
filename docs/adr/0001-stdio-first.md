# ADR 0001: stdio first

**Status:** Accepted

## Decision

Phase 0 serves MCP exclusively with the server SDK's `serveStdio` helper. stdout is reserved for MCP and diagnostics use stderr.

## Rationale and consequences

Inherited stdio keeps the server local, gives the launcher control of process lifetime, and avoids prematurely designing HTTP authentication, origin validation, tenancy, and deployment. Only one trusted local peer is supported. Remote clients and browser access require a future security review and ADR.

