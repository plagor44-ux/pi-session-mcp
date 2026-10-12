// Runs the harness's supervisor against the controlled client and prints one JSON summary. It never calls
// process.exit: the test checks that this process ends by itself, which needs every timer, interval and
// listener of the supervisor to be gone. Usage: node supervise-driver.mjs <mode> <dir>
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot, superviseProcess } from "../../../scripts/multi-session-acceptance.mjs";

const [mode, dir] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const statePath = join(dir, "state.json");
const signals = new EventEmitter();
const budgets = { timeoutMs: 2500, graceMs: 600, killWaitMs: 2000, drainMs: 600, intervalMs: 50 };
const info = { entry: join(dir, "no-such-entry.js") };
const scan = (rootPid, rootStart) => snapshot(rootPid, dir, info, rootStart);
let poll;
let options;
if (mode === "spawn-failure") options = { file: join(dir, "no-such-client") };
else {
  const childMode = mode === "abort" ? "ignore-term" : mode;
  options = { file: process.execPath, args: [join(here, "stubborn-client.mjs"), statePath, childMode] };
  if (mode === "leaks-pipe") budgets.timeoutMs = 20_000;
  // Once the controlled client published its processes, deliver a SIGTERM "to the harness".
  if (mode === "abort") { budgets.timeoutMs = 20_000; poll = setInterval(() => { if (existsSync(statePath)) { clearInterval(poll); signals.emit("SIGTERM"); } }, 20); }
}
const result = await superviseProcess({ ...options, cwd: dir, budgets, scan, signals });
clearInterval(poll);
const roles = {};
for (const p of result.seen.values()) roles[p.role] = (roles[p.role] ?? 0) + 1;
process.stdout.write(`${JSON.stringify({
  exitCode: result.exitCode, timedOut: result.timedOut, spawnFailed: result.spawnFailed, harnessAborted: result.harnessAborted,
  abortSignal: result.abortSignal, drainDestroyed: result.drainDestroyed, unterminated: result.unterminated,
  elapsedMs: result.elapsedMs, output: result.output.toString("utf8"), roles,
})}\n`);
