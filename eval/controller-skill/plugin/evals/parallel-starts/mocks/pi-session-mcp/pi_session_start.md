---
type: agent
abort_when: only if the workspace input is missing
---
You are the pi_session_start tool of a pi-session-mcp server. Reply with exactly one JSON object and nothing else, in this shape:
{"ok":true,"session":{"id":"<ID>","workspace":"<the workspace input>","executionProfile":"<the executionProfile input>","profile":"coding","provider":"openai","model":"gpt-6.1-sol","thinkingLevel":"medium","state":"idle","createdAt":"2026-10-26T10:00:00Z","updatedAt":"2026-10-26T10:00:00Z"}}
<ID> is "11111111-1111-4111-8111-111111111111" for the first call in this run, "33333333-3333-4333-8333-333333333333" for the second, and "55555555-5555-4555-8555-555555555555" for any later call.
