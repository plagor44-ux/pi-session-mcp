import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = process.cwd();
const home = process.env.HOME;
const installedAgentDir = process.env.PI_AUDIT_AGENT_DIR;
if (!home || !installedAgentDir) throw new Error('isolated_environment_required');

let networkAttempts = 0;
let childProcessAttempts = 0;
let deniedIo = 0;
const rows = [];
const diagnostics = [];
let activeHandle;
let guard;
let phase = 'install-instrumentation';
let observation;
const denyNetwork = () => { networkAttempts += 1; throw new Error('network_denied'); };
const denyChild = () => { childProcessAttempts += 1; throw new Error('child_process_denied'); };

globalThis.fetch = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
net.connect = denyNetwork;
net.createConnection = denyNetwork;
tls.connect = denyNetwork;
http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
dns.lookup = denyNetwork;
dns.resolve = denyNetwork;
dns.resolve4 = denyNetwork;
dns.resolve6 = denyNetwork;
dns.promises.lookup = denyNetwork;
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[key] = denyChild;
}
syncBuiltinESMExports();

const suppressed = [];
try {
  const [{ ModelRuntime, createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime },
    { SdkPiSessionAdapter, PROFILE_TOOLS }, { parseExtensionSpec }, { resolvePiExtension }, { installStdoutGuard }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import(pathToFileURL(join(root, '.profile-eval/src/sdk-pi-adapter.js')).href),
    import(pathToFileURL(join(root, '.profile-eval/src/extension-spec.js')).href),
    import(pathToFileURL(join(root, '.profile-eval/src/pi-extensions.js')).href),
    import(pathToFileURL(join(root, '.profile-eval/src/stdout-guard.js')).href),
  ]);

  guard = installStdoutGuard({ report: (line) => suppressed.push(JSON.parse(line)) });
  process.stderr.write = (_chunk, _encoding, callback) => {
    deniedIo += 1;
    if (typeof _encoding === 'function') _encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };

  phase = 'prepare-synthetic-fixture';
  const fixtureAgent = join(home, 'fixture-agent');
  await mkdir(join(fixtureAgent, 'npm/node_modules'), { recursive: true });
  await import('node:fs/promises').then(({ cp }) => cp(
    join(root, 'test/fixtures/pi-extension-fixture'),
    join(fixtureAgent, 'npm/node_modules/pi-extension-fixture'),
    { recursive: true, errorOnExist: true },
  ));

  const fixtureEvents = (globalThis.__piExtensionFixtureEvents ??= []);
  for (const permissionProfile of ['read-only', 'coding']) {
    phase = `create-${permissionProfile}-session`;
    fixtureEvents.length = 0;
    const cwd = join(home, `workspace-${permissionProfile}`);
    await mkdir(cwd);
    await writeFile(join(cwd, 'README.md'), 'Synthetic Cursor SDK extension binding probe.\n');
    let sdkSession;
    const adapter = new SdkPiSessionAdapter({
      modelRuntimeFactory: () => ModelRuntime.create({
        refreshOnCreate: false,
        allowModelNetwork: false,
        modelsPath: null,
        authPath: join(home, 'absent-auth-store.json'),
        modelsStorePath: join(home, 'absent-model-store.json'),
      }),
      resolveExtension: (spec) => resolvePiExtension(spec, {
        agentDir: spec.name === 'pi-extension-fixture' ? fixtureAgent : installedAgentDir,
      }),
      extensionSdk: {
        createServices: createAgentSessionServices,
        createSessionFromServices: async (options) => {
          const result = await createAgentSessionFromServices(options);
          sdkSession = result.session;
          return result;
        },
        createRuntime: createAgentSessionRuntime,
      },
      diagnosticSink: (diagnostic) => diagnostics.push({ stage: diagnostic.stage, code: diagnostic.code, extension: diagnostic.extension ?? null }),
    });

    activeHandle = await adapter.create({
      cwd,
      executionProfile: {
        alias: 'isolated-cursor-registration',
        permissionProfile,
        provider: 'fixture-ext',
        model: 'fixture-ext-model',
        thinkingLevel: 'off',
        extensions: [
          parseExtensionSpec('npm:pi-cursor-sdk@0.5.3'),
          parseExtensionSpec('npm:pi-extension-fixture@1.0.0'),
        ],
        skills: [],
      },
    });

    phase = `verify-${permissionProfile}-binding`;
    assert.ok(sdkSession);
    const loaded = sdkSession.resourceLoader.getExtensions();
    phase = `verify-${permissionProfile}-extension-loader`;
    assert.equal(loaded.errors.length, 0);
    assert.equal(loaded.extensions.length, 2);
    const candidateTools = loaded.extensions
      .flatMap((extension) => [...extension.tools.keys()])
      .filter((name) => name !== 'fixture_tool')
      .sort();
    const allowedActive = [
      ...PROFILE_TOOLS[permissionProfile],
      ...(permissionProfile === 'coding' ? ['fixture_tool', ...candidateTools] : []),
    ].sort();
    const activeBeforeDispose = sdkSession.getActiveToolNames().sort();
    const mandatoryActive = [
      ...PROFILE_TOOLS[permissionProfile],
      ...(permissionProfile === 'coding' ? ['fixture_tool'] : []),
    ].sort();
    observation = { permission_profile: permissionProfile, candidate_tools: candidateTools, active_tools: activeBeforeDispose, allowed_active_tools: allowedActive };
    phase = `verify-${permissionProfile}-active-tool-selection`;
    assert.ok(mandatoryActive.every((name) => activeBeforeDispose.includes(name)));
    assert.ok(activeBeforeDispose.every((name) => allowedActive.includes(name)));
    const actual = activeHandle.appliedSelection;
    phase = `verify-${permissionProfile}-model-selection`;
    assert.deepEqual(actual, { provider: 'fixture-ext', model: 'fixture-ext-model', thinkingLevel: 'off' });
    phase = `verify-${permissionProfile}-resources`;
    assert.deepEqual(sdkSession.resourceLoader.getSkills().skills, []);
    assert.deepEqual(sdkSession.resourceLoader.getPrompts().prompts, []);
    assert.deepEqual(sdkSession.resourceLoader.getThemes().themes, []);

    const eventsBeforeShutdown = [...fixtureEvents];
    phase = `verify-${permissionProfile}-no-turn-or-tool-execution`;
    assert.ok(eventsBeforeShutdown.includes('load'));
    assert.ok(eventsBeforeShutdown.includes('session_start'));
    assert.ok(!eventsBeforeShutdown.includes('stream'));
    assert.ok(!eventsBeforeShutdown.includes('tool'));
    phase = `dispose-${permissionProfile}-session`;
    await activeHandle.dispose();
    activeHandle = undefined;
    assert.ok(fixtureEvents.includes('session_shutdown'));
    rows.push({
      permission_profile: permissionProfile,
      status: 'PASS',
      candidate: 'pi-cursor-sdk@0.5.3',
      fixture: 'pi-extension-fixture@1.0.0',
      candidate_registered_tool_count: candidateTools.length,
      candidate_tools: candidateTools,
      active_tools: activeBeforeDispose,
      applied_model_selection: actual,
      skills_loaded: 0,
      prompts_loaded: 0,
      themes_loaded: 0,
      fixture_provider_turns: 0,
      candidate_tool_calls: 0,
      session_shutdown: 'PASS',
    });
  }

  assert.equal(networkAttempts, 0);
  phase = 'record-package-provenance';
  const packageRoot = join(installedAgentDir, 'npm/node_modules/pi-cursor-sdk');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(installedAgentDir, 'npm/package-lock.json'), 'utf8'));
  const lockEntry = lock.packages?.['node_modules/pi-cursor-sdk'];
  const fileHashes = {};
  for (const relative of ['package.json', ...packageJson.pi.extensions]) {
    const bytes = await readFile(join(packageRoot, relative));
    fileHashes[relative] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  }
  const resolvedPeers = {};
  for (const [name, path] of Object.entries({
    '@earendil-works/pi-coding-agent': join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'),
    '@earendil-works/pi-ai': join(root, 'node_modules/@earendil-works/pi-ai/package.json'),
    '@earendil-works/pi-tui': join(root, 'node_modules/@earendil-works/pi-tui/package.json'),
    typebox: join(root, 'node_modules/typebox/package.json'),
    '@cursor/sdk': join(installedAgentDir, 'npm/node_modules/@cursor/sdk/package.json'),
  })) {
    try {
      const peer = JSON.parse(await readFile(path, 'utf8'));
      resolvedPeers[name] = peer.version;
    } catch {
      resolvedPeers[name] = 'not-present-at-recorded-location';
    }
  }
  guard.flush();
  guard.transportStdout.write(JSON.stringify({
    kind: 'cursor-node24-headless-component-test',
    status: 'PASS',
    node: process.versions.node,
    candidate: { name: packageJson.name, version: packageJson.version, peers: packageJson.peerDependencies },
    lock_entry: { version: lockEntry?.version ?? null, resolved: lockEntry?.resolved ?? null, integrity: lockEntry?.integrity ?? null },
    resolved_peer_versions: resolvedPeers,
    entry_hashes: fileHashes,
    rows,
    network_attempts: networkAttempts,
    denied_child_process_attempts: childProcessAttempts,
    external_provider_calls: 0,
    cursor_model_turns: 0,
    fixture_provider_turns: 0,
    cursor_tools_invoked: 0,
    stdout_guard_suppressed_fixture_writes: suppressed.reduce((count, item) => count + item.writes, 0),
    raw_stderr_suppressed: true,
    raw_errors_recorded: false,
    limitation: 'Actual resolver, SDK extension load/bind, provider and tool registration, active tool selection and shutdown only. No Cursor tool, Cursor model/provider request, cloud/MCP operation or fixture model turn was invoked. Two child-process API attempts were denied by instrumentation. JavaScript denials are not an OS sandbox.',
  }) + '\n');
} catch (error) {
  if (activeHandle) await activeHandle.dispose().catch(() => undefined);
  const safeCode = typeof error?.code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(error.code)
    ? error.code
    : typeof error?.name === 'string' && /^[a-z0-9_-]{1,64}$/i.test(error.name)
      ? error.name
      : 'probe_failed';
  const failure = JSON.stringify({
    kind: 'cursor-node24-headless-component-test',
    status: 'INCONCLUSIVE',
    node: process.versions.node,
    phase,
    diagnostic_code: safeCode,
    completed_rows: rows,
    observation,
    network_attempts: networkAttempts,
    child_process_attempts: childProcessAttempts,
    external_provider_calls: 0,
    cursor_model_turns: 0,
    cursor_tools_invoked: 0,
    diagnostics,
  }) + '\n';
  if (guard) {
    guard.flush();
    guard.transportStdout.write(failure);
  } else process.stdout.write(failure);
  process.exitCode = 1;
}
