import type { CommandRunner } from "../src/client-adapters/types.js";
import { probeRecoveryRefTransactions } from "../src/writer-recovery-capability.js";
import { spawn } from "./real-git-writer-fixture.js";

export const recoveryProbeRunner: CommandRunner = {
  run: (command, args, signal, options) => spawn(command, args, { signal, env: { ...process.env, ...options?.env } }),
};
// Real behavior, not a version check or a simulated successful Git transaction.
export const recoveryRefTransactionsSupported = await probeRecoveryRefTransactions({ runner: recoveryProbeRunner, checkout: process.cwd() });
