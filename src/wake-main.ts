#!/usr/bin/env node
import { isEntryPoint } from "./entry-point.js";
import { claimsRoot, eventsRoot } from "./turn-events.js";
import { acquireWaiterLock, cleanupOldClaims, parentAliveCheck, parseBudgetArgs, isNoSpace, isSupportedPlatform, parseHookInput, prepareClaimsDir, releaseClaim, releaseWaiterLock, waitForTurn, WAITER_LOCK_GRACE_MS } from "./wake-hook.js";

/**
 * `pi-session-mcp-wake [--budget-ms <n>]`: a Claude Code PostToolUse asyncRewake command hook. It reads the hook
 * JSON on stdin and, for a running turn of this product's servers, waits for that turn's spool event.
 * Exit 2 plus one stderr line wakes the controller (event claimed, or budget reached); every other path exits 0
 * silently. SIGTERM (the client's hook timeout) releases an undelivered claim and exits 143.
 * Event delivery is Linux-first (ADR 0011): on any other platform, or without `/proc/self/fd`, the program exits 0 at once.
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
let heldLock: string | undefined;

/** The waiter lock goes on every exit path; a claim only when its wake was not delivered. */
function releaseLock(): void { releaseWaiterLock(heldLock); heldLock = undefined; }

let exit: (code: number) => void = (code) => process.exit(code);

function finish(code: number, line?: string): void {
  if (line === undefined) { releaseLock(); exit(code); return; }
  process.stderr.write(`${line}\n`, (error) => {
    // A wake that could not be written was not delivered: give the claim back for a later waiter.
    releaseLock();
    if (error) { releaseClaim(heldClaim); exit(0); return; }
    exit(code);
  });
}

/** Test seams: the platform to judge, the `/proc/self/fd` directory to look for, and how the process ends. */
export interface WakeMainDependencies { readonly platform?: string; readonly procFd?: string; readonly exit?: (code: number) => void }

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, dependencies: WakeMainDependencies = {}): Promise<void> {
  if (dependencies.exit !== undefined) exit = dependencies.exit;
  // Nothing else happens on an unsupported platform: stdin is not even read.
  if (!isSupportedPlatform(dependencies.platform, dependencies.procFd)) return finish(0);
  process.once("SIGTERM", () => { releaseClaim(heldClaim); heldClaim = undefined; releaseLock(); process.exit(143); });
  const parentAlive = parentAliveCheck(); // records the original parent before anything else
  try {
    const budgetMs = parseBudgetArgs(argv);
    const text = await readStdin();
    const target = text === undefined ? undefined : parseHookInput(text);
    const root = eventsRoot(env), claims = claimsRoot(env);
    if (target === undefined || root === undefined || claims === undefined) return finish(0);
    // A full runtime directory (ENOSPC, EDQUOT) must not drop the wake: carry on without claims dir and lock; the budget wake needs neither.
    let locked = true;
    try { prepareClaimsDir(claims); cleanupOldClaims(claims); } catch (error) { if (!isNoSpace(error)) throw error; locked = false; }
    // One waiter per turn: a poll of a still running turn re-arms the hook, and each of those must not start another long wait.
    if (locked) {
      try { heldLock = acquireWaiterLock(claims, target.namespace, target.sessionId, target.turnId, { maxAgeMs: budgetMs + WAITER_LOCK_GRACE_MS }); } catch (error) { if (!isNoSpace(error)) throw error; locked = false; }
      if (locked && heldLock === undefined) return finish(0);
    }
    const result = await waitForTurn({
      eventsRoot: root, namespace: target.namespace, claimsDir: claims, sessionId: target.sessionId, turnId: target.turnId, budgetMs, isParentAlive: parentAlive,
      onClaim: (path) => { heldClaim = path; },
    });
    if (result.action === "wake") return finish(2, result.message);
    return finish(0);
  } catch { return finish(0); } // a hook must never print a stack trace or fail the host
}

if (isEntryPoint(import.meta.url, process.argv[1])) void main().catch(() => process.exit(0));
