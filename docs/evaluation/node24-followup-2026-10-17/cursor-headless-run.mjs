import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const root = process.cwd();
// Public export: use the selected executable; the exact version gate below remains.
const node24 = process.execPath;
const nodeStatus = await new Promise((resolve) => {
  const child = spawn(node24, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH } });
  let version = '';
  child.stdout.on('data', (chunk) => { version += chunk.toString('utf8'); });
  child.once('error', () => resolve({ version: null, exit: null }));
  child.once('exit', (code) => resolve({ version: version.trim(), exit: code }));
});
if (nodeStatus.exit !== 0 || nodeStatus.version !== 'v24.22.0') throw new Error('requested_node24_unavailable');

const scope = await mkdtemp(join(tmpdir(), 'codex-cursor-headless-'));
const home = join(scope, 'home');
await mkdir(home, { mode: 0o700 });
for (const name of ['agent', 'config', 'cache', 'data']) await mkdir(join(home, name), { mode: 0o700 });

// Get the configured Pi agent directory without reading profile or credential data.
const { getAgentDir } = await import('@earendil-works/pi-coding-agent');
const agentDir = getAgentDir();
const script = join(dirname(fileURLToPath(import.meta.url)), 'cursor-headless-probe.mjs');
const child = spawn(node24, [script], {
  cwd: root,
  env: {
    PATH: `${dirname(node24)}:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'),
    PI_CODING_AGENT_DIR: join(home, 'agent'),
    PI_AUDIT_AGENT_DIR: agentDir,
    NODE_OPTIONS: '--unhandled-rejections=strict',
  },
  stdio: ['ignore', 'pipe', 'ignore'],
});

let stdout = '';
let overflow = false;
child.stdout.on('data', (chunk) => {
  if (stdout.length + chunk.length > 128 * 1024) {
    overflow = true;
    child.kill('SIGTERM');
  } else stdout += chunk.toString('utf8');
});
const deadline = setTimeout(() => child.kill('SIGTERM'), 45_000);
const terminal = await new Promise((resolve) => {
  child.once('error', () => resolve({ exit_code: null, signal: null, spawn_error: true }));
  child.once('exit', (code, signal) => resolve({ exit_code: code, signal, spawn_error: false }));
});
clearTimeout(deadline);

let receipt;
try {
  const lines = stdout.trim().split('\n');
  receipt = JSON.parse(lines.at(-1));
} catch {
  receipt = { kind: 'cursor-node24-headless-component-test', status: 'INCONCLUSIVE', diagnostic_code: overflow ? 'receipt_limit_exceeded' : 'missing_sanitized_receipt' };
}

await rm(scope, { recursive: true, force: false });
let scopeRemoved = false;
try { await stat(scope); } catch (error) { scopeRemoved = error?.code === 'ENOENT'; }
const status = receipt.status === 'PASS' && terminal.exit_code === 0 && scopeRemoved ? 'PASS' : 'INCONCLUSIVE';
const artifact = {
  ...receipt,
  status,
  execution_scope: 'fresh-temporary-home-removed-after-observed-exit',
  execution_scope_removed: scopeRemoved,
  observed_node24_child_exit: !terminal.spawn_error,
  process_exit_code: terminal.exit_code,
  process_signal: terminal.signal,
  receipt_overflow: overflow,
  additional_paid_candidate_runs: 0,
};
const artifactPath = join(root, 'docs/evaluation/node24-followup-2026-10-17/cursor-headless-result-attempt-4.json');
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const serialized = await readFile(artifactPath);
console.log(JSON.stringify({
  artifact: 'docs/evaluation/node24-followup-2026-10-17/cursor-headless-result-attempt-4.json',
  status,
  rows: artifact.rows?.length ?? artifact.completed_rows?.length ?? 0,
  network_attempts: artifact.network_attempts ?? null,
  denied_child_process_attempts: artifact.denied_child_process_attempts ?? artifact.child_process_attempts ?? null,
  external_provider_calls: artifact.external_provider_calls ?? 0,
  cursor_tools_invoked: artifact.cursor_tools_invoked ?? 0,
  execution_scope_removed: scopeRemoved,
  sha256: createHash('sha256').update(serialized).digest('hex'),
}));
if (status !== 'PASS') process.exitCode = 1;
