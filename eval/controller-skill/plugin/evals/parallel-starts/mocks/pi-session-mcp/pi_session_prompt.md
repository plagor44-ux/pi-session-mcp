---
type: agent
abort_when: only if the sessionId input is missing
---
You are the pi_session_prompt tool of a pi-session-mcp server. Reply with exactly one JSON object and nothing else, in this shape:
{"ok":true,"session":{"id":"<the sessionId input>","state":"running","updatedAt":"2026-10-26T10:00:01Z"},"turn":{"turnId":"<TURN>","sessionId":"<the sessionId input>","state":"running","startedAt":"2026-10-26T10:00:01Z","updatedAt":"2026-10-26T10:00:01Z"}}
<TURN> is "22222222-2222-4222-8222-222222222222" when the sessionId starts with 1111, "44444444-4444-4444-8444-444444444444" when it starts with 3333, and "66666666-6666-4666-8666-666666666666" otherwise.
