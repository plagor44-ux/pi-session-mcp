/** Public, deliberately path-free setup result model. */
export type SetupOperation = "dry-run" | "apply" | "verify" | "rollback" | "remove" | "inspect";
export type SetupStatus = "ok" | "planned" | "unchanged" | "absent" | "divergent" | "unsupported" | "failed";
export type RegistrationState = "absent" | "equivalent" | "divergent" | "unsupported";

export interface SetupTarget {
  readonly client: string;
  readonly scope: string;
  readonly alias: string;
}

/** One planned change of a guided dry run: where (file kind and key path made of field names and aliases) and what, never a value. */
export interface SetupChange {
  readonly file: "config" | "routing" | "modes" | "client";
  readonly kind: "add" | "change" | "remove";
  readonly path: string;
}
const CHANGE_FILES: readonly string[] = ["config", "routing", "modes", "client"];
const CHANGE_KINDS: readonly string[] = ["add", "change", "remove"];
const CHANGE_PATH = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}){0,5}$/;

export interface SetupFinding {
  readonly target: SetupTarget;
  readonly status: SetupStatus;
  readonly code: string;
  /** Recovery slot, never a filesystem path. */
  readonly slot?: number;
  /** Code of the reported cause, for example the probe outcome that made guided setup drop a profile. */
  readonly cause?: string;
  /** Path-free counters of an inspection, for example how many commits a writer holds beyond its base. */
  readonly counts?: Readonly<Record<string, number>>;
}

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const COUNT_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,31}$/;

/** Only plain counters pass: a key that is not a short word or a value that is not a count is left out, so no text can travel through it. */
function sanitizedCounts(counts: Readonly<Record<string, number>> | undefined): Readonly<Record<string, number>> | undefined {
  if (counts === undefined) return undefined;
  const entries = Object.entries(counts).filter(([key, value]) => COUNT_KEY_PATTERN.test(key) && Number.isSafeInteger(value) && value >= 0);
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries));
}

export interface SetupResult {
  readonly schemaVersion: 1;
  readonly operation: SetupOperation;
  readonly status: SetupStatus;
  readonly findings: readonly SetupFinding[];
  readonly exitCode: 0 | 1 | 64 | 130 | 143;
  /** The planned changes of a guided dry run; absent when there are none to show. */
  readonly changes?: readonly SetupChange[];
}

export function result(
  operation: SetupOperation,
  findings: readonly SetupFinding[],
  status: SetupStatus = findings.some((finding) => finding.status === "failed" || finding.status === "divergent" || finding.status === "unsupported") ? "failed" : "ok",
  exitCode: 0 | 1 | 64 | 130 | 143 = status === "failed" ? 1 : 0,
  changes?: readonly SetupChange[],
): SetupResult {
  // An entry that is not a plain file kind, change kind and dotted key path is left out, so no value or path can pass through it.
  const reported = (changes ?? []).filter((change) => CHANGE_FILES.includes(change.file) && CHANGE_KINDS.includes(change.kind) && CHANGE_PATH.test(change.path)).map((change) => Object.freeze({ file: change.file, kind: change.kind, path: change.path }));
  const normalized = findings.map((finding) => { const counts = sanitizedCounts(finding.counts); return Object.freeze({
    target: Object.freeze({ ...finding.target }),
    status: finding.status,
    code: CODE_PATTERN.test(finding.code) ? finding.code : "operation_failed",
    ...(Number.isSafeInteger(finding.slot) && finding.slot! >= 0 ? { slot: finding.slot } : {}),
    // A cause that is not a plain code is left out rather than replaced, so no value can pass through it.
    ...(finding.cause !== undefined && CODE_PATTERN.test(finding.cause) ? { cause: finding.cause } : {}),
    ...(counts === undefined ? {} : { counts }),
  }); });
  return Object.freeze({ schemaVersion: 1, operation, status, findings: Object.freeze(normalized), exitCode, ...(reported.length === 0 ? {} : { changes: Object.freeze(reported) }) });
}
