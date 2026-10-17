// Provider-free permission-policy and tool_call probe. The candidate package is
// loaded by the real Pi SDK adapter; the SDK's public ExtensionRunner seam is
// used to invoke its actual registered gate hook with synthetic events.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const repo = process.cwd();
const scope = await mkdtemp('/tmp/pi-permission-gates-');
const workspace = join(scope, 'workspace');
const agent = workspace;
const npmAgent = resolve(repo, 'eval/results/node24-extension-followup-04470d85-3a99-47e3-b356-ce96e77de0dd/extension-agent');
const packageRoot = join(npmAgent, 'npm/node_modules/@gotgenes/pi-permission-system');
const candidateMeta = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(candidateMeta.version, '40.3.0');
process.env.HOME = scope;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_AUDIT_AGENT_DIR = agent;
process.env.XDG_CONFIG_HOME = join(scope, 'config');
process.env.XDG_CACHE_HOME = join(scope, 'cache');
process.env.XDG_DATA_HOME = join(scope, 'data');
process.env.DO_NOT_TRACK = '1';
const fixtureRoot = join(agent, 'npm/node_modules/pi-extension-fixture');
const companionRoot = join(agent, 'npm/node_modules/pi-permission-probe-companion');
let deniedNetwork = 0;
let deniedChildren = 0;
const blockNetwork = () => { deniedNetwork++; throw Object.assign(new Error('offline_network_denied'), { code: 'OFFLINE_NETWORK_DENIED' }); };
for (const [target, names] of [
  [net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']], [tls, ['connect']],
  [http, ['request', 'get']], [https, ['request', 'get']], [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [dnsPromises, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [dnsPromises.Resolver.prototype, ['resolve', 'resolve4', 'resolve6']], [dgram, ['createSocket']],
]) for (const name of names) target[name] = blockNetwork;
globalThis.fetch = blockNetwork;
if ('WebSocket' in globalThis) globalThis.WebSocket = class { constructor() { blockNetwork(); } };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => { deniedChildren++; throw Object.assign(new Error('offline_child_process_denied'), { code: 'OFFLINE_CHILD_PROCESS_DENIED' }); };
}
syncBuiltinESMExports();
let handle;
let guard;
let capturedSession;
let receipt;
let disposePromiseResolved = false;
let sessionShutdownObserved = false;
let scopeRemoved = false;
try {
  await mkdir(join(scope, 'config'), { recursive: true, mode: 0o700 });
  await mkdir(join(scope, 'cache'), { recursive: true, mode: 0o700 });
  await mkdir(join(scope, 'data'), { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, 'extensions/pi-permission-system'), { recursive: true, mode: 0o700 });
  await mkdir(join(companionRoot, 'node_modules/@gotgenes'), { recursive: true, mode: 0o700 });
  await cp(join(repo, 'test/fixtures/pi-extension-fixture'), fixtureRoot, { recursive: true, errorOnExist: true });
  await symlink(packageRoot, join(companionRoot, 'node_modules/@gotgenes/pi-permission-system'));
  await writeFile(join(workspace, 'extensions/pi-permission-system/config.json'), JSON.stringify({ permission: {
    '*': 'deny', read: 'allow', write: 'deny', bash: 'ask', fixture_tool: 'allow',
    mcp: { '*': 'deny', 'fixture_server:fixture_read': 'allow' },
    path: { '*': 'allow', '*.env': 'deny' }, external_directory: 'allow',
  } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(companionRoot, 'package.json'), JSON.stringify({ name: 'pi-permission-probe-companion', version: '1.0.0', type: 'module', pi: { extensions: ['./index.ts'] } }) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(companionRoot, 'index.ts'), `
    import { getPermissionsService } from '@gotgenes/pi-permission-system';
    export default function permissionProbe(pi) {
      pi.on('session_start', (_event, ctx) => {
        globalThis.__permissionProbeService = getPermissionsService(ctx.sessionManager.getSessionId());
      });
    }
  `, { flag: 'wx', mode: 0o600 });

  const build = join(repo, '.profile-eval/src');
  const { installStdoutGuard } = await import(pathToFileURL(join(build, 'stdout-guard.js')));
  const suppressed = [];
  guard = installStdoutGuard({ report: (line) => suppressed.push(JSON.parse(line)) });
  const { SdkPiSessionAdapter } = await import(pathToFileURL(join(build, 'sdk-pi-adapter.js')));
  const { parseExtensionSpec } = await import(pathToFileURL(join(build, 'extension-spec.js')));
  const { resolvePiExtension } = await import(pathToFileURL(join(build, 'pi-extensions.js')));
  const fixtureSpec = parseExtensionSpec('npm:pi-extension-fixture@1.0.0');
  const candidateSpec = parseExtensionSpec('npm:@gotgenes/pi-permission-system@40.3.0');
  const companionSpec = parseExtensionSpec('npm:pi-permission-probe-companion@1.0.0');
  assert.ok(fixtureSpec && candidateSpec && companionSpec);
  const resolveExtension = (spec) => resolvePiExtension(spec, { agentDir: spec.name === '@gotgenes/pi-permission-system' ? npmAgent : agent });
  const diagnostics = [];
  const {
    ModelRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
  } = await import('@earendil-works/pi-coding-agent');
  const adapter = new SdkPiSessionAdapter({
    modelRuntimeFactory: () => ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false, modelsPath: null, authPath: join(scope, 'absent-auth.json'), modelsStorePath: join(scope, 'absent-models.json') }),
    resolveExtension,
    extensionSdk: {
      createServices: createAgentSessionServices,
      createSessionFromServices: createAgentSessionFromServices,
      createRuntime: async (factory, options) => {
        const runtime = await createAgentSessionRuntime(factory, options);
        // AgentSessionRuntime.session is a documented public getter. Capture
        // the SDK result through the injected public adapter seam; never read
        // private fields from the PiSessionAdapter handle.
        capturedSession = runtime.session;
        return runtime;
      },
    },
    diagnosticSink: (item) => diagnostics.push({ stage: item.stage, code: item.code }),
  });
  const profile = {
    alias: 'permission-gates-isolated', permissionProfile: 'coding', provider: 'fixture-ext', model: 'fixture-ext-model', thinkingLevel: 'off',
    extensions: [fixtureSpec, candidateSpec, companionSpec], skills: [],
  };
  handle = await adapter.create({ cwd: workspace, executionProfile: profile });
  assert.ok(capturedSession, 'public SDK runtime seam must expose its public session result');
  const loaded = capturedSession.resourceLoader.getExtensions();
  assert.equal(loaded.errors.length, 0);
  assert.ok(capturedSession.getActiveToolNames().includes('fixture_tool'));
  const service = globalThis.__permissionProbeService;
  assert.ok(service, 'documented package root API must resolve the live node service');

  const checks = {
    general_allow: service.checkPermission('read').state,
    general_deny: service.checkPermission('write').state,
    path_allowed: service.checkPermission('path', join(workspace, 'notes.txt')).state,
    path_denied: service.checkPermission('path', join(workspace, 'secrets.env')).state,
    mcp_allowed: service.checkPermission('mcp', 'fixture_server:fixture_read').state,
    mcp_unmatched: service.checkPermission('mcp', 'unknown_server:unknown_tool').state,
    headless_ask: service.checkPermission('bash', 'echo synthetic').state,
  };
  assert.deepEqual(checks, { general_allow: 'allow', general_deny: 'deny', path_allowed: 'allow', path_denied: 'deny', mcp_allowed: 'allow', mcp_unmatched: 'deny', headless_ask: 'ask' });

  const runner = capturedSession.extensionRunner;
  const extensionContext = runner.createContext();
  assert.equal(extensionContext.hasUI, false, 'print adapter must expose no dialog-capable UI');
  let syntheticExecutorCounter = 0;
  async function fakeDispatch(toolName, input, id) {
    const decision = await runner.emitToolCall({ type: 'tool_call', toolName, input, toolCallId: id });
    const reachedSyntheticExecutor = !decision?.block;
    if (reachedSyntheticExecutor) syntheticExecutorCounter++;
    return { decision: decision ?? {}, reachedSyntheticExecutor };
  }
  const allowed = await fakeDispatch('fixture_tool', {}, 'synthetic-allow');
  const denied = await fakeDispatch('write', { path: join(workspace, 'out.txt'), content: 'synthetic' }, 'synthetic-deny');
  const ask = await fakeDispatch('bash', { command: 'echo synthetic' }, 'synthetic-ask');
  const unknown = await fakeDispatch('not_registered', {}, 'synthetic-unregistered');
  assert.equal(allowed.reachedSyntheticExecutor, true);
  assert.equal(denied.reachedSyntheticExecutor, false);
  assert.equal(ask.reachedSyntheticExecutor, false, 'headless ask must fail closed');
  assert.equal(unknown.reachedSyntheticExecutor, false, 'unregistered tool must fail closed');
  assert.equal(syntheticExecutorCounter, 1, 'only the allowed call reaches the in-memory synthetic counter');
  assert.equal(deniedNetwork, 0);
  assert.equal(deniedChildren, 0);

  receipt = {
    schema_version: '1.0.0', kind: 'pi-permission-system-policy-hook-probe', status: 'PASS',
    package: `${candidateMeta.name}@${candidateMeta.version}`, node: process.versions.node,
    loading: 'real SDK adapter and actual candidate package entry',
    hook: 'public AgentSession.extensionRunner.emitToolCall() invoked the registered actual tool_call handler',
    policy_checks: checks,
    synthetic_dispatch: {
      allowed_tool_reached_counter: allowed.reachedSyntheticExecutor,
      denied_write_blocked: Boolean(denied.decision.block),
      headless_ask_blocked: Boolean(ask.decision.block),
      unregistered_tool_blocked: Boolean(unknown.decision.block),
      in_memory_counter: syntheticExecutorCounter,
    },
    harness_model_prompts_submitted: 0, provider_calls: 0,
    ui_mode: 'print', has_dialog_capable_ui: extensionContext.hasUI,
    denied_network_attempts: deniedNetwork, denied_child_process_attempts: deniedChildren,
    stdout_suppressed_writes: suppressed.reduce((sum, row) => sum + row.writes, 0),
    diagnostics: diagnostics.map((row) => row.code), evidence_id: randomUUID(),
    limits: [
      'An in-memory synthetic counter advances only after an unblocked hook result. No actual executor was attached or invoked; no operating-system command, file write, MCP connection, or external tool was executed.',
      'These checks cover deterministic policy resolution and registered-hook mediation under a provider-free SDK harness. They do not prove operating-system sandboxing, collector or inner-method enforcement, live UI behavior, MCP transport enforcement, or interactive-client integration.',
    ],
  };
} finally {
  if (handle) {
    try {
      await handle.dispose();
      disposePromiseResolved = true;
    } catch { /* Cleanup status remains failed and prevents a PASS receipt. */ }
    sessionShutdownObserved = globalThis.__piExtensionFixtureEvents?.includes('session_shutdown') ?? false;
  }
  delete globalThis.__permissionProbeService;
  guard?.flush();
  try {
    await rm(scope, { recursive: true, force: false });
    scopeRemoved = true;
  } catch { scopeRemoved = false; }
  if (receipt) {
    receipt.cleanup = {
      dispose_promise_resolved: disposePromiseResolved,
      fixture_session_shutdown_observed: sessionShutdownObserved,
      temporary_scope_removed: scopeRemoved,
    };
    receipt.status = disposePromiseResolved && sessionShutdownObserved && scopeRemoved ? 'PASS' : 'FAIL';
    guard.transportStdout.write(JSON.stringify(receipt) + '\n');
    if (receipt.status !== 'PASS') process.exitCode = 1;
  }
}
