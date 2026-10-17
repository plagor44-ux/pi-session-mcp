// Bounded supervisor: publishes evidence only after the worker closes and its
// process group and temporary scope are observed clean.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = process.cwd();
const node = process.execPath;
if (!node.includes('node-v24.22.0')) throw new Error('approved_node_24_22_0_required');
const dossier = dirname(fileURLToPath(import.meta.url));
const worker = join(dossier, 'permission-gate-worker.mjs');
const archivePath = process.argv[2] ? resolve(process.argv[2]) : join(dossier, 'permission-gates-result.json');
try { await lstat(archivePath); throw new Error('fresh_archive_path_required'); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
const tempHome = `/tmp/pi-permission-gate-supervisor-${randomUUID()}`;
const env = { HOME: tempHome, PATH: `${dirname(node)}:/usr/bin:/bin`, DO_NOT_TRACK: '1' };
await mkdir(tempHome, { mode: 0o700 });
const child = spawn(node, [worker], { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
let output = '';
let outputOverflow = false;
let spawnFailed = false;
let terminal = null;
const timeoutMs = 45_000;
let escalation;
let timedOut = false;
const deadline = setTimeout(() => {
  timedOut = true;
  void signalGroup('SIGTERM');
  escalation = setTimeout(() => { void signalGroup('SIGKILL'); }, 1_000);
}, timeoutMs);
child.stdout.on('data', (chunk) => {
  if (outputOverflow) return;
  if (Buffer.byteLength(output) + chunk.length > 65_536) {
    outputOverflow = true;
    void signalGroup('SIGKILL');
  } else output += chunk;
});
terminal = await new Promise((resolvePromise) => {
  child.once('error', () => { spawnFailed = true; resolvePromise({ code: null, signal: null }); });
  child.once('exit', (code, signal) => resolvePromise({ code, signal }));
});
clearTimeout(deadline);
if (escalation) clearTimeout(escalation);

async function groupMembers(pgid) {
  let entries;
  try { entries = await readdir('/proc'); } catch { return null; }
  const members = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return null;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') members.push(Number(entry));
    } catch { /* a process may exit while /proc is scanned */ }
  }
  return members;
}

async function signalGroup(signal) {
  try { process.kill(-child.pid, signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
}

async function waitForGroupEmpty(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const members = await groupMembers(child.pid);
    if (members && members.length === 0) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
  }
  return false;
}

let processGroupClean = await waitForGroupEmpty(1_500);
if (!processGroupClean) {
  await signalGroup('SIGTERM');
  processGroupClean = await waitForGroupEmpty(1_000);
}
if (!processGroupClean) {
  await signalGroup('SIGKILL');
  processGroupClean = await waitForGroupEmpty(1_500);
}

let workerReceipt;
try {
  const lines = output.trim().split('\n');
  if (lines.length !== 1) throw new Error('receipt_line_count');
  workerReceipt = JSON.parse(lines[0]);
} catch { workerReceipt = null; }

// Remove the supervisor-only HOME after the child has terminated.
let supervisorHomeRemoved = false;
try {
  const { rm, stat } = await import('node:fs/promises');
  await rm(tempHome, { recursive: true, force: false });
  try { await stat(tempHome); } catch (error) { supervisorHomeRemoved = error?.code === 'ENOENT'; }
} catch { supervisorHomeRemoved = false; }

const processClean = !spawnFailed && !outputOverflow && !timedOut && terminal?.code === 0 && terminal?.signal === null && processGroupClean;
const cleanupClean = workerReceipt?.cleanup?.dispose_promise_resolved === true
  && workerReceipt?.cleanup?.fixture_session_shutdown_observed === true
  && workerReceipt?.cleanup?.temporary_scope_removed === true
  && supervisorHomeRemoved;
const pass = processClean && cleanupClean && workerReceipt?.status === 'PASS';
const receipt = {
  ...workerReceipt,
  schema_version: '1.0.0',
  status: pass ? 'PASS' : 'FAIL',
  process_supervision: {
    worker_exit_observed: terminal !== null,
    worker_exit_code: terminal?.code ?? null,
    worker_signal: terminal?.signal ?? null,
    spawn_failed: spawnFailed,
    timeout_ms: timeoutMs,
    timeout_triggered: timedOut,
    output_limit_exceeded: outputOverflow,
    process_group_empty_observed: processGroupClean,
    supervisor_home_removed: supervisorHomeRemoved,
  },
};

const outputDir = resolve(repo, 'eval/results');
await mkdir(outputDir, { recursive: true });
const fileName = `permission-gates-${randomUUID()}.json`;
await writeFile(join(outputDir, fileName), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
await writeFile(archivePath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ status: receipt.status, evidence: `eval/results/${fileName}`, policy_checks: Object.keys(receipt.policy_checks ?? {}).length, in_memory_counter: receipt.synthetic_dispatch?.in_memory_counter ?? null, process_group_empty: processGroupClean, scope_removed: receipt.cleanup?.temporary_scope_removed ?? false }) + '\n');
if (!pass) process.exitCode = 1;
