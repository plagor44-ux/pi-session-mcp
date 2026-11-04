/**
 * Forward migrations of the history file. Index i migrates from `user_version` i to i + 1; the
 * statements of one migration run inside the opening transaction (ADR 0019, design call 8).
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE instances (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    proc_start TEXT,
    package_version TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL REFERENCES instances(id),
    sdk_session_id TEXT,
    public_session_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    execution_profile TEXT NOT NULL,
    permission_profile TEXT,
    provider TEXT,
    model TEXT,
    thinking_level TEXT,
    writer TEXT,
    base_ref TEXT,
    base_commit TEXT,
    snapshot_base TEXT,
    snapshot_head TEXT,
    task TEXT,
    package_version TEXT NOT NULL,
    configuration_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    closed_at TEXT,
    final_state TEXT,
    completeness TEXT NOT NULL DEFAULT 'complete' CHECK (completeness IN ('complete', 'incomplete', 'has_gaps')),
    capture_source TEXT NOT NULL CHECK (capture_source IN ('host', 'writer-relay')),
    entry_cursor INTEGER NOT NULL DEFAULT 0,
    header_json TEXT
  );
  CREATE TABLE turns (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    state TEXT NOT NULL,
    abort_reason TEXT,
    completion TEXT,
    entry_count INTEGER NOT NULL DEFAULT 0,
    recorded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, turn_id)
  );
  CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT,
    position INTEGER NOT NULL,
    pi_entry_id TEXT NOT NULL,
    parent_id TEXT,
    entry_type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    role TEXT,
    tool_name TEXT,
    is_error INTEGER NOT NULL DEFAULT 0,
    redacted_json TEXT NOT NULL,
    redactions TEXT NOT NULL,
    dropped_by_path INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    UNIQUE (session_id, pi_entry_id)
  );
  CREATE TABLE verdicts (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    verdict TEXT NOT NULL CHECK (verdict IN ('accepted', 'rejected', 'reworked')),
    reason TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    source TEXT NOT NULL
  );
  CREATE TABLE gaps (
    id INTEGER PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    first_turn_id TEXT,
    last_turn_id TEXT,
    code TEXT NOT NULL CHECK (code IN ('history_locked', 'history_full', 'history_corrupt', 'history_unavailable', 'history_relay_invalid')),
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX sessions_created_at ON sessions(created_at);
  CREATE INDEX sessions_workspace ON sessions(workspace);
  CREATE INDEX sessions_execution_profile ON sessions(execution_profile);
  CREATE INDEX sessions_task ON sessions(task);
  CREATE INDEX sessions_base_commit ON sessions(base_commit);
  CREATE INDEX sessions_public_session_id ON sessions(public_session_id);
  CREATE INDEX entries_session_position ON entries(session_id, position);
  CREATE INDEX entries_tool_name ON entries(tool_name);
  CREATE INDEX turns_session ON turns(session_id);
  CREATE INDEX verdicts_session ON verdicts(session_id);
  CREATE INDEX gaps_session ON gaps(session_id);
  CREATE INDEX gaps_recorded_at ON gaps(recorded_at);
  `,
];
