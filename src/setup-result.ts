/** Public, deliberately path-free setup result model. */
export type SetupOperation = "dry-run" | "apply" | "verify" | "rollback" | "remove";
export type SetupStatus = "ok" | "planned" | "unchanged" | "absent" | "divergent" | "unsupported" | "failed";
export type RegistrationState = "absent" | "equivalent" | "divergent" | "unsupported";

export interface SetupTarget {
  readonly client: string;
  readonly scope: string;
  readonly alias: string;
}

export interface SetupFinding {
  readonly target: SetupTarget;
  readonly status: SetupStatus;
  readonly code: string;
}

export interface SetupResult {
  readonly schemaVersion: 1;
  readonly operation: SetupOperation;
  readonly status: SetupStatus;
  readonly findings: readonly SetupFinding[];
  readonly exitCode: 0 | 1 | 64 | 130 | 143;
}

export function result(
  operation: SetupOperation,
  findings: readonly SetupFinding[],
  status: SetupStatus = findings.some((finding) => finding.status === "failed" || finding.status === "divergent" || finding.status === "unsupported") ? "failed" : "ok",
  exitCode: 0 | 1 | 64 | 130 | 143 = status === "failed" ? 1 : 0,
): SetupResult {
  const normalized = findings.map((finding) => Object.freeze({
    target: Object.freeze({ ...finding.target }),
    status: finding.status,
    code: /^[a-z][a-z0-9_]{0,63}$/.test(finding.code) ? finding.code : "operation_failed",
  }));
  return Object.freeze({ schemaVersion: 1, operation, status, findings: Object.freeze(normalized), exitCode });
}
