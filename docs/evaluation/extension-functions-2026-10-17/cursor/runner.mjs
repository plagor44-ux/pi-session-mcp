import { spawn } from 'node:child_process';
import { mkdir, rm, stat, writeFile, readFile, symlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, '../../../..');
const node = process.execPath;
if (process.versions.node !== '24.22.0') throw new Error('run_with_node_24_22_0');
const sourcePackage = join(homedir(), '.pi/agent/npm/node_modules/pi-cursor-sdk');
const scopeId = randomUUID();
const scope = join(repo, `eval/results/extension-functions-cursor-${scopeId}`);
const agentDir = join(scope, 'home/.pi/agent');
const workspace = join(scope, 'workspace');
const reportDir = scriptDir;
const receiptDir = join(scope, 'attempts');

await mkdir(scope,{mode:0o700});
await writeFile(join(scope,'.owner'),scopeId,{flag:'wx',mode:0o600});
await mkdir(workspace, { recursive: true, mode: 0o700 });
await mkdir(receiptDir, { recursive: true, mode: 0o700 });

const probe = join(scriptDir, 'probe.mjs');
const outcomes = [];
for (const testCase of ['activation-and-resources', 'bridge-disabled']) {
  const id = randomUUID();
  const home = join(scope, `case-${id}/home`);
  const caseAgent = join(home, '.pi/agent');
  const caseWorkspace = join(scope, `case-${id}/workspace`);
  await mkdir(caseAgent, { recursive: true, mode: 0o700 });
  await writeFile(join(scope,`case-${id}/.owner`),scopeId,{flag:'wx'});
  const caseModules = join(caseAgent, 'npm/node_modules');
  await mkdir(join(caseModules, '@earendil-works'), { recursive: true, mode: 0o700 });
  await mkdir(join(caseModules, '@cursor'), { recursive: true, mode: 0o700 });
  await mkdir(join(caseModules, '@bufbuild'), { recursive: true, mode: 0o700 });
  await mkdir(join(caseModules, '@connectrpc'), { recursive: true, mode: 0o700 });
  await mkdir(join(caseModules, '@statsig'), { recursive: true, mode: 0o700 });
  await symlink(join(repo, 'node_modules/@earendil-works/pi-coding-agent'), join(caseModules, '@earendil-works/pi-coding-agent'), 'dir');
  const globalModules = join(homedir(), '.pi/agent/npm/node_modules');
  for (const dep of ['@bufbuild/protobuf', '@connectrpc/connect', '@connectrpc/connect-web', '@statsig/js-client', 'zod']) {
    const [scopeName, packageName] = dep.startsWith('@') ? dep.split('/') : ['', dep];
    const target = scopeName ? join(caseModules, scopeName, packageName) : join(caseModules, packageName);
    await symlink(join(globalModules, dep), target, 'dir');
  }
  await symlink(join(globalModules, '@cursor/sdk'), join(caseModules, '@cursor/sdk'), 'dir');
  await symlink(sourcePackage, join(caseModules, 'pi-cursor-sdk'), 'dir');
  await mkdir(caseWorkspace, { recursive: true, mode: 0o700 });
  const child = spawn(node, ['--preserve-symlinks', probe, testCase, join(caseModules, 'pi-cursor-sdk'), caseAgent, caseWorkspace], {
    cwd: caseWorkspace,
    env: {
      PATH: `${dirname(node)}:/usr/bin:/bin`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      PI_CODING_AGENT_DIR: caseAgent,
      PI_CURSOR_PI_TOOL_BRIDGE: testCase === 'bridge-disabled' ? '0' : '1',
      PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS: '3000',
      NODE_OPTIONS: '',
      LANG: 'C.UTF-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  let overflow = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 128 * 1024) {
      overflow = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    } else stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { if(stderr.length<4096)stderr+=chunk.slice(0,4096-stderr.length); });
  let timedOut = false, escalation;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    escalation=setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
  }, 30000);
  const exitCode = await new Promise(resolveExit => child.once('close', resolveExit));
  let processGroupEmpty = true;
  try { process.kill(-child.pid, 0); processGroupEmpty = false; } catch (error) { if (error?.code !== 'ESRCH') processGroupEmpty = false; }
  clearTimeout(timer);if(escalation)clearTimeout(escalation);
  if(!processGroupEmpty){
   try{process.kill(-child.pid,'SIGTERM');}catch{}
   await new Promise(r=>setTimeout(r,100));
   try{process.kill(-child.pid,'SIGKILL');}catch{}
   await new Promise(r=>setTimeout(r,100));
   try{process.kill(-child.pid,0);}catch(e){if(e.code==='ESRCH')processGroupEmpty=true;}
  }
  let ownedCaseRemoved=false;
  if(processGroupEmpty&&await readFile(join(scope,'.owner'),'utf8')===scopeId&&await readFile(join(scope,`case-${id}/.owner`),'utf8')===scopeId){
   await rm(join(scope,`case-${id}`),{recursive:true});
   try{await stat(join(scope,`case-${id}`));}catch(e){ownedCaseRemoved=e.code==='ENOENT';}
  }
  let result;
  try { result = JSON.parse(stdout.trim()); } catch { result = { status: 'HARNESS_ERROR', checks: [], network_attempts: null, child_process_attempts: null }; }
  const attempt = {
    schema: 'pi-cursor-activation-attempt.v1',
    attempt_id: id,
    case: testCase,
    node: process.versions.node,
    package: 'pi-cursor-sdk@0.5.3',
    outcome: timedOut ? 'TIMEOUT' : overflow ? 'RECEIPT_LIMIT' : exitCode === 0 ? result.status : 'HARNESS_ERROR',
    exit_code: exitCode,
    checks: result.checks ?? [],
    network_attempts: result.network_attempts ?? null,
    denied_child_process_attempts: result.denied_child_process_attempts ?? null,
    cleanup: result.cleanup === 'PASS' && processGroupEmpty && ownedCaseRemoved ? 'PASS' : 'FAIL',
    process_group_empty_after_close: processGroupEmpty,
    owned_case_removed:ownedCaseRemoved,
    ...(result.component ? { component: result.component } : {}),
    stdout_sha256: createHash('sha256').update(stdout).digest('hex'),
  };
  const attemptText = `${JSON.stringify(attempt, null, 2)}\n`;
  const attemptPath = join(receiptDir, `${testCase}-${id}.json`);
  await writeFile(attemptPath, attemptText, { mode: 0o600, flag: 'wx' });
  const errorLines = stderr.split('\n').filter(line => line.includes('Cannot find package') || line.includes('ERR_MODULE_NOT_FOUND') || line.startsWith('Error:')).slice(-2);
  outcomes.push({ ...attempt, ...(attempt.outcome === 'HARNESS_ERROR' ? { diagnostic: (errorLines.join(' | ') || stderr.split('\n').slice(-8).join(' ')).replaceAll(repo, '<repo>').replaceAll(sourcePackage, '<cursor-package>').slice(0, 500) } : {}), receipt: `attempts/${testCase}-${id}.json`, receipt_sha256: createHash('sha256').update(attemptText).digest('hex') });
}

const candidateMeta = JSON.parse(await readFile(join(sourcePackage, 'package.json'), 'utf8'));
const entryHash = createHash('sha256').update(await readFile(join(sourcePackage, candidateMeta.pi.extensions[0]))).digest('hex');
let cleanup=outcomes.every(r=>r.cleanup==='PASS'&&r.owned_case_removed)?'PASS':'FAIL';
if(cleanup==='PASS'&&await readFile(join(scope,'.owner'),'utf8')===scopeId){await rm(workspace,{recursive:true});try{await stat(workspace);cleanup='FAIL';}catch(e){if(e.code!=='ENOENT')cleanup='FAIL';}}
const status = outcomes.length === 2 && outcomes.every(x => x.outcome === 'PASS' && x.cleanup === 'PASS') && cleanup === 'PASS' ? 'PASS' : 'INCONCLUSIVE';
const harness=[];for(const name of ['runner.mjs','probe.mjs'])harness.push({path:name,sha256:createHash('sha256').update(await readFile(join(scriptDir,name))).digest('hex')});
const evidence = {
  harness,
  schema: 'pi-cursor-activation-evidence.v1',
  created_at: new Date().toISOString(),
  package: { name: candidateMeta.name, version: candidateMeta.version, entry: candidateMeta.pi.extensions[0], entry_sha256: entryHash },
  node: process.versions.node,
  scope: `eval/results/extension-functions-cursor-${scopeId}`,
  status,
  attempts: outcomes,
  cleanup,
  constraints: ['real public package entrypoint', 'synthetic ExtensionAPI and ctx', 'no prompts or model/provider turns', 'no Cursor cloud/tool calls'],
};
const text = `${JSON.stringify(evidence, null, 2)}\n`;
const file = `evidence-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${scopeId}.json`;
await writeFile(join(reportDir, file), text, { mode: 0o644, flag: 'wx' });
console.log(JSON.stringify({ status, evidence: file, sha256: createHash('sha256').update(text).digest('hex'), cases: outcomes.map(x => ({ case: x.case, outcome: x.outcome, diagnostic: x.diagnostic, checks: x.checks.filter(c => c.result !== 'PASS') })) }));
if (status !== 'PASS') process.exitCode = 1;
