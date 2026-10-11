import { installStdoutGuard } from "./stdout-guard.js";

/**
 * Installed when this module is evaluated. `main.ts` imports it first, so the guard is
 * in place before any other module, the Pi SDK or an extension, can write to stdout.
 */
export const stdoutGuard = installStdoutGuard();
