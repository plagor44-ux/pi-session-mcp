/** A stored session as the JSONL export needs it. */
export interface ExportSession { readonly sdk_session_id: string; readonly workspace: string; readonly created_at: string; readonly header_json: string | null; readonly completeness: string }

/**
 * Pi session JSONL, version 3: a session header, then one redacted entry per line. `cwd` is the
 * workspace alias, never a path. Returns whether the export lost content (truncation, gaps or an
 * incomplete session), so the caller can say so.
 */
export function exportJsonl(session: ExportSession, entries: ReadonlyArray<{ redacted_json: string; truncated: number }>, gapCount: number): { text: string; lossy: boolean; truncated: number } {
  let header: { id?: unknown; timestamp?: unknown } = {};
  try { header = session.header_json === null ? {} : (JSON.parse(session.header_json) as typeof header); } catch { header = {}; }
  const id = typeof header.id === "string" ? header.id : session.sdk_session_id;
  const timestamp = typeof header.timestamp === "string" ? header.timestamp : session.created_at;
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: session.workspace })];
  let truncated = 0;
  for (const entry of entries) {
    lines.push(entry.redacted_json);
    if (entry.truncated === 1) truncated += 1;
  }
  return { text: `${lines.join("\n")}\n`, lossy: truncated > 0 || gapCount > 0 || session.completeness !== "complete", truncated };
}
