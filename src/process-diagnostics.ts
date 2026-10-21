import { ConfigError, type ConfigErrorCode } from "./config.js";
import { EventSpoolError } from "./event-spool.js";

export interface StartupDiagnostic {
  readonly level: "error";
  readonly event: "startup_failed";
  readonly stage: "startup";
  readonly code: ConfigErrorCode | "event_spool_unavailable" | "startup_failed";
}

export function startupFailureDiagnostic(error: unknown): StartupDiagnostic {
  return {
    level: "error",
    event: "startup_failed",
    stage: "startup",
    code: error instanceof ConfigError ? error.code : error instanceof EventSpoolError ? error.code : "startup_failed",
  };
}
