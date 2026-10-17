// Bounded outer supervisor for isolated-extensions-probe.mjs.
// Run with the approved Node 24 binary from the repository root.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = process.cwd();
const node = process.execPath;
if (!node.includes('node-v24.22.0')) throw new Error('approved_node_24_22_0_required');
const npmAgent = process.env.PI_AUDIT_NPM_AGENT_DIR;
if (!npmAgent) throw new Error('isolated_npm_agent_path_required');
const versions = [
  ['pi-lens', '4.4.3'],
  ['context-mode', '1.0.169'],
  ['pi-cache-optimizer', '2.9.3'],
  ['@gotgenes/pi-permission-system', '40.3.0'],
];
const selectedName = process.argv[2];
const selectedProfile = process.argv[3];
const selectedVersions = selectedName ? versions.filter(([name]) => name === selectedName) : versions;
const selectedProfiles = selectedProfile ? [selectedProfile] : ['read-only', 'coding'];
if (!selectedVersions.length || selectedProfiles.some((profile) => !['read-only', 'coding'].includes(profile))) throw new Error('invalid_probe_selection');
const evidenceDir = dirname(fileURLToPath(import.meta.url));
const probe = join(evidenceDir, 'isolated-extensions-probe.mjs');
const rows = [];
const timeoutMs = 35_000;

function parseProcStat(text) {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const fields = text.slice(close + 2).trim().split(/\s+/);
  return { ppid: Number(fields[1]), pgrp: Number(fields[2]), start: fields[19] };
}

async function groupMembers(pgid) {
  const out = [];
  let pids;
  try { pids = await readdir('/proc'); } catch { return null; }
  for (const name of pids) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const parsed = parseProcStat(await readFile(`/proc/${name}/stat`, 'utf8'));
      if (parsed?.pgrp === pgid) out.push({ pid: Number(name), start: parsed.start });
    } catch { /* process ended between /proc enumeration and stat read */ }
  }
  return out;
}

async function signalOwnedGroup(pgid, signal) {
  try { process.kill(-pgid, signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
}

async function waitForGroupEmpty(pgid, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const members = await groupMembers(pgid);
    if (members && members.length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return false;
}

async function runOne(name, version, permissionProfile) {
  const scope = await mkdtemp('/tmp/pi-ext-node24-');
  await mkdir(join(scope, 'config'), { mode: 0o700 });
  await mkdir(join(scope, 'cache'), { mode: 0o700 });
  await mkdir(join(scope, 'data'), { mode: 0o700 });
  const agent = join(scope, 'agent');
  const workspace = join(scope, 'workspace');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(join(agent, 'npm', 'node_modules'), { recursive: true, mode: 0o700 });
  await writeFile(join(agent, 'settings.json'), '{"cacheWarming":"off"}\n', { flag: 'wx', mode: 0o600 });
  const env = {
    HOME: scope,
    PATH: `${dirname(node)}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(scope, 'config'),
    XDG_CACHE_HOME: join(scope, 'cache'),
    XDG_DATA_HOME: join(scope, 'data'),
    PI_CODING_AGENT_DIR: agent,
    PI_AUDIT_AGENT_DIR: agent,
    // Pi's agentDir is one level above npm/node_modules.
    PI_AUDIT_NPM_AGENT_DIR: dirname(npmAgent),
    PI_AUDIT_SCOPE: scope,
    PI_AUDIT_REPO: repo,
    PI_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING: '1',
    PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE: '1',
    DO_NOT_TRACK: '1',
  };
  const child = spawn(node, ['--experimental-import-meta-resolve', probe, name, version, permissionProfile], {
    cwd: workspace,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let stdout = '';
  let overflow = false;
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 32_768) overflow = true;
  });
  let maxSampledGroupMembers = 0;
  const sampler = setInterval(async () => {
    const members = await groupMembers(child.pid);
    if (members) maxSampledGroupMembers = Math.max(maxSampledGroupMembers, members.length);
  }, 50);
  let timeout = false;
  let spawnError = false;
  let exit;
  const timer = setTimeout(() => { timeout = true; void signalOwnedGroup(child.pid, 'SIGTERM'); }, timeoutMs);
  const terminal = await new Promise((resolve) => {
    child.once('error', () => { spawnError = true; resolve({ code: null, signal: null }); });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  clearInterval(sampler);
  let groupEmpty = await waitForGroupEmpty(child.pid, 1_000);
  if (!groupEmpty) {
    await signalOwnedGroup(child.pid, 'SIGKILL');
    groupEmpty = await waitForGroupEmpty(child.pid, 1_500);
  }
  let receipt;
  try {
    const lines = stdout.trim().split('\n');
    receipt = JSON.parse(lines.at(-1));
  } catch { receipt = { status: 'INCONCLUSIVE', failure_code: 'sanitized_receipt_missing' }; }
  const status = !timeout && !spawnError && !overflow && terminal.code === 0 && groupEmpty && receipt.status === 'PASS'
    ? 'PASS'
    : receipt.status === 'BLOCKED' && !timeout && !spawnError && groupEmpty ? 'BLOCKED' : 'FAIL';
  const row = {
    ...receipt,
    status,
    package: `${name}@${version}`,
    permission_profile: permissionProfile,
    process: { exit_code: terminal.code, signal: terminal.signal, timeout, spawn_error: spawnError, output_limit_exceeded: overflow },
    process_group_cleanup: groupEmpty ? 'PASS' : 'FAIL',
    max_observed_group_members: maxSampledGroupMembers,
    evidence_id: randomUUID(),
  };
  try { await rm(scope, { recursive: true, force: true }); row.isolated_scope_removed = true; }
  catch { row.isolated_scope_removed = false; row.status = 'FAIL'; }
  return row;
}

let fatal = false;
for (const [name, version] of selectedVersions) {
  for (const permissionProfile of selectedProfiles) {
    const row = await runOne(name, version, permissionProfile);
    rows.push(row);
    if (row.status !== 'PASS') fatal = true;
  }
}
const report = {
  schema_version: '1.0.0',
  kind: 'node24-isolated-extension-headless-followup',
  node_version: process.versions.node,
  created_at: new Date().toISOString(),
  package_count: selectedVersions.length,
  profile_count_per_package: selectedProfiles.length,
  prompt_or_provider_calls: 0,
  candidate_tool_invocations: 0,
  cache_warming: 'disabled in isolated settings and environment',
  installation: 'preinstalled exact pins; runner does not install or modify candidate packages',
  results: rows,
  claims_limit: 'Headless extension loading, hook binding/lifecycle, registered tool discovery, active-tool selection and process cleanup only; no package efficacy, UI behavior, provider behavior, or tool-call mediation claim.',
};
const outputName = `isolated-extensions-results-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
const outputPath = join(evidenceDir, outputName);
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ evidence: outputName, packages: rows.length / 2, probes: rows.length, pass: rows.filter((row) => row.status === 'PASS').length, blocked: rows.filter((row) => row.status === 'BLOCKED').length, fail: rows.filter((row) => row.status === 'FAIL').length }) + '\n');
if (fatal) process.exitCode = 1;
