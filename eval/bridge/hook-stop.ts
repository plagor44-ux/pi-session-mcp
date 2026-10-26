import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateLedger, type RunLedger } from "./ledger.js";
import { LedgerStore } from "./ledger-store.js";

function stopActive(input: unknown): boolean {
  return typeof input === "object" && input !== null && "stop_hook_active" in input && input.stop_hook_active === true;
}

/** Only the latest turn of the latest attempt decides whether a task still needs verification. */
export function stopDecision(input: unknown, ledger: RunLedger): ReturnType<typeof verificationDecision> {
  try {
    if (stopActive(input) || !validateLedger(ledger).ok) return undefined;
    return verificationDecision(ledger);
  } catch { return undefined; }
}

const group = (ids: readonly string[]): string => `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ` and ${ids.length - 10} more` : ""}`;

/**
 * A completed, consumed result without a decision blocks until a decision is recorded.
 * A failed or aborted latest turn blocks only while its session cleanup is still open;
 * closing the session (cleanup closed/close_failed) clears it. An unread completed
 * result never blocks, because no decision or closure could consume it.
 */
function verificationDecision(ledger: RunLedger): { decision: "block"; reason: string } | undefined {
  const completed: string[] = [];
  const recovery: string[] = [];
  for (const task of ledger.tasks) {
    if (task.decision) continue;
    const attempt = task.attempts.at(-1);
    const turn = attempt?.turns.at(-1);
    if (!attempt || !turn) continue;
    if (turn.runtime === "completed" && turn.result) completed.push(task.taskId);
    else if ((turn.runtime === "failed" || turn.runtime === "aborted") && attempt.cleanup === "open") recovery.push(task.taskId);
  }
  if (completed.length === 0 && recovery.length === 0) return undefined;
  const parts: string[] = [];
  if (completed.length > 0) parts.push(`Verification needed for ${group(completed)}: record a decision with ledger-cli apply (type decision).`);
  if (recovery.length > 0) parts.push(`Verification needed for ${group(recovery)}: inspect the workspace or collected refs, then close the session (pi_session_close) or start a new attempt.`);
  return { decision: "block", reason: `Results awaiting verification. ${parts.join(" ")}` };
}

/** Invalid input, unavailable ledger and lock contention all fail open without output. */
export async function runStopHook(text: string, dir?: string): Promise<string> {
  try {
    const input: unknown = JSON.parse(text);
    if (stopActive(input) || !dir) return "";
    const ledger = await new LedgerStore(dir, { lockTimeoutMs: 0 }).readLocked();
    const output = stopDecision(input, ledger);
    return output ? JSON.stringify(output) : "";
  } catch { return ""; }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
function isEntryPoint(argvPath: string): boolean {
  try { return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (process.argv[1] && isEntryPoint(process.argv[1])) {
  try {
    const output = await runStopHook(await readStdin(), process.env.BRIDGE_LEDGER_DIR);
    if (output) process.stdout.write(`${output}\n`);
  } catch { /* Never print input, paths or stack traces. */ }
  // Let the event loop drain so a piped stdout frame is never truncated, like ledger-cli.
  process.exitCode = 0;
}
