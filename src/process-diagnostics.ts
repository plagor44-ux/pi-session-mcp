import { ConfigError, type ConfigErrorCode } from "./config.js";

export interface StartupDiagnostic {
  readonly level: "error";
  readonly event: "startup_failed";
  readonly stage: "startup";
  readonly code: ConfigErrorCode | "startup_failed";
}

export function startupFailureDiagnostic(error: unknown): StartupDiagnostic {
  return {
    level: "error",
    event: "startup_failed",
    stage: "startup",
    code: error instanceof ConfigError ? error.code : "startup_failed",
  };
}
