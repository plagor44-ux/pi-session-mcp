import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderTaskMarkdown, validateLedger, type RunLedger } from "./ledger.js";
import { LedgerStore } from "./ledger-store.js";

const HEADER = "pi-session-mcp run ledger after compaction: do not send a task again that already has a turn; verify every result marked awaiting review before you end the run.";
export const COMPACT_CONTEXT_MAX_BYTES = 8 * 1024;

/** Pure SessionStart output: ledger metadata only, bounded at a complete line. */
export function compactContext(ledger: RunLedger): ReturnType<typeof renderContext> | undefined {
  try { return validateLedger(ledger).ok ? renderContext(ledger) : undefined; } catch { return undefined; }
}

function renderContext(ledger: RunLedger): { hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string } } {
  let text = `${HEADER}\n${renderTaskMarkdown(ledger)}`;
  if (Buffer.byteLength(text, "utf8") > COMPACT_CONTEXT_MAX_BYTES) {
    const marker = "[Ledger context truncated.]\n";
    const lines: string[] = [];
    let bytes = Buffer.byteLength(marker, "utf8");
    for (const line of text.split("\n")) {
      const size = Buffer.byteLength(`${line}\n`, "utf8");
      if (bytes + size > COMPACT_CONTEXT_MAX_BYTES) break;
      lines.push(line);
      bytes += size;
    }
    text = `${lines.join("\n")}\n${marker}`;
  }
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
}

/** Fail open, including missing configuration and a busy or stale ledger lock. */
export async function runCompactHook(dir?: string): Promise<string> {
  try {
    if (!dir) return "";
    const ledger = await new LedgerStore(dir, { lockTimeoutMs: 0 }).readLocked();
    const output = compactContext(ledger);
    return output ? JSON.stringify(output) : "";
  } catch { return ""; }
}

function isEntryPoint(argvPath: string): boolean {
  try { return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (process.argv[1] && isEntryPoint(process.argv[1])) {
  try {
    const output = await runCompactHook(process.env.BRIDGE_LEDGER_DIR);
    if (output) process.stdout.write(`${output}\n`);
  } catch { /* Hooks are an aid, not a policy; never emit diagnostics or input. */ }
  // Let the event loop drain so a piped stdout frame is never truncated, like ledger-cli.
  process.exitCode = 0;
}
