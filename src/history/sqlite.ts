type SqliteModule = typeof import("node:sqlite");

let loaded: Promise<SqliteModule> | undefined;

function isSqliteExperimentalWarning(warning: unknown, type: unknown): boolean {
  const message = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  const kind = typeof type === "string" ? type : typeof type === "object" && type !== null ? (type as { type?: unknown }).type : warning instanceof Error ? warning.name : undefined;
  return kind === "ExperimentalWarning" && message.startsWith("SQLite");
}

/**
 * Loads `node:sqlite` lazily. Node 22 prints an unstructured `ExperimentalWarning` to stderr on the
 * first import; stderr carries only structured JSON lines, so exactly that warning is dropped while
 * the import runs. Every other warning passes, and `process.emitWarning` is restored afterwards.
 * `during` runs inside the filtered window; tests use it because the module is imported only once.
 */
export async function loadSqlite(during?: () => void): Promise<SqliteModule> {
  const original = process.emitWarning;
  const filtered = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    loaded ??= import("node:sqlite");
    const sqlite = await loaded;
    during?.();
    return sqlite;
  } catch (error) {
    loaded = undefined;
    throw error;
  } finally {
    if (process.emitWarning === filtered) process.emitWarning = original;
  }
}
