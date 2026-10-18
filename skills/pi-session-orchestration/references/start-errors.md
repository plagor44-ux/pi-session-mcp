# Start errors of `pi_session_start`

Load this file only after a `pi_session_start` call has failed. Classify the error by its `code` alone. Never decide by the message, provider text or any other free text, and never infer a cause. Each code below is in exactly one class.

- Operator needed (do not retry and do not switch to another profile; report the code and stop that task): `unknown_execution_profile`, `unknown_workspace`, `unknown_provider`, `unknown_model`, `model_unavailable`, `thinking_level_unavailable`, `local_authentication_missing`, `execution_selection_mismatch`, `skill_load_failed`, `extension_not_installed`, `extension_version_mismatch`, `extension_tool_conflict`, `external_mcp_no_tools`, `external_mcp_grant_tool_missing`, `external_mcp_activation_mismatch`, `server_stopping`. The last code means the server is shutting down: a new server process is needed, not a retry.
- Transient (retry at most once after a pause, then report): `external_mcp_unavailable` (an external MCP server that cannot connect, times out or breaks the protocol), `extension_load_failed` (an invalid package, but also a start timeout), `local_authentication_unavailable` (local authentication could not be resolved within its deadline).
- Unknown (report the code; at most one retry in a fresh session): `pi_session_creation_failed`. Any code not listed above is also unknown.
