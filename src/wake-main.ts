#!/usr/bin/env node
import { isEntryPoint } from "./entry-point.js";
import { claimsRoot, eventsRoot } from "./turn-events.js";
import { cleanupOldClaims, parentAliveCheck, parseBudgetArgs, parseHookInput, prepareClaimsDir, releaseClaim, waitForTurn } from "./wake-hook.js";

/**
 * `pi-session-mcp-wake [--budget-ms <n>]`: a Claude Code PostToolUse asyncRewake command hook. It reads the hook
 * JSON on stdin and, for a running turn of this product's servers, waits for that turn's spool event.
 * Exit 2 plus one stderr line wakes the controller (event claimed, or budget reached); every other path exits 0
 * silently. SIGTERM (the client's hook timeout) releases an undelivered claim and exits 143.
 * It never prints a stack trace and never prints anything but event identifiers and states.
 */
const STDIN_MAX_BYTES = 1024 * 1024;
const STDIN_TIMEOUT_MS = 10_000;

async function readStdin(): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  const read = (async (): Promise<string | undefined> => {
    for await (const chunk of process.stdin) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > STDIN_MAX_BYTES) return undefined;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), STDIN_TIMEOUT_MS); timer.unref(); });
  try { return await Promise.race([read, timeout]); } finally { clearTimeout(timer); }
}

let heldClaim: string | undefined;

function finish(code: number, line?: string): void {
  if (line === undefined) { process.exit(code); }
  process.stderr.write(`${line}\n`, (error) => {
    // A wake that could not be written was not delivered: give the claim back for a later waiter.
    if (error) { releaseClaim(heldClaim); process.exit(0); }
    process.exit(code);
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  process.once("SIGTERM", () => { releaseClaim(heldClaim); heldClaim = undefined; process.exit(143); });
  const parentAlive = parentAliveCheck(); // records the original parent before anything else
  try {
    const budgetMs = parseBudgetArgs(argv);
    const text = await readStdin();
    const target = text === undefined ? undefined : parseHookInput(text);
    const root = eventsRoot(env), claims = claimsRoot(env);
    if (target === undefined || root === undefined || claims === undefined) return finish(0);
    prepareClaimsDir(claims);
    cleanupOldClaims(claims);
    const result = await waitForTurn({
      eventsRoot: root, claimsDir: claims, sessionId: target.sessionId, turnId: target.turnId, budgetMs, isParentAlive: parentAlive,
      onClaim: (path) => { heldClaim = path; },
    });
    if (result.action === "wake") return finish(2, result.message);
    return finish(0);
  } catch { return finish(0); } // a hook must never print a stack trace or fail the host
}

if (isEntryPoint(import.meta.url, process.argv[1])) void main().catch(() => process.exit(0));
