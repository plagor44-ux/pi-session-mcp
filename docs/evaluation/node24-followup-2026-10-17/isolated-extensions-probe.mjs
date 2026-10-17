// Run one exact installed extension through the repository's real SDK adapter.
// No prompt is submitted and no extension tool is invoked.
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scope = process.env.PI_AUDIT_SCOPE;
const extensionAgent = process.env.PI_AUDIT_AGENT_DIR;
const npmAgent = process.env.PI_AUDIT_NPM_AGENT_DIR;
const packageName = process.argv[2];
const packageVersion = process.argv[3];
const profileName = process.argv[4];
if (!scope || !extensionAgent || !npmAgent || !packageName || !packageVersion || !['read-only', 'coding'].includes(profileName)) {
  process.stdout.write(JSON.stringify({ status: 'BLOCKED', code: 'invalid_probe_parameters' }) + '\n');
  process.exitCode = 2;
} else {
  let deniedNetwork = 0;
  let deniedChildProcess = 0;
  const childDiagnostics = [];
  const allowedMetadataCommands = [];
  const realExecFileSync = childProcess.execFileSync;
  let safeOutput = process.stdout;
  const blockNetwork = () => { deniedNetwork += 1; throw Object.assign(new Error('offline_network_denied'), { code: 'OFFLINE_NETWORK_DENIED' }); };
  const blockChild = (method, ...args) => {
    const executable = typeof args[0] === 'string' ? args[0] : '';
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const options = args[2] && typeof args[2] === 'object' ? args[2] : {};
    const fixtureWorkspace = join(scope, 'workspace');
    const isOwnedGitMetadata = method === 'execFileSync'
      && executable === 'git'
      && argv.length === 4
      && argv[0] === '-C'
      && argv[1] === fixtureWorkspace
      && argv[2] === 'rev-parse'
      && argv[3] === '--show-toplevel'
      && options.timeout === 2000;
    if (isOwnedGitMetadata) {
      // Permit only this fixed, read-only metadata query in the fresh fixture.
      // No global/system Git config or optional locks; cap execution at 1.5s.
      try {
        const result = realExecFileSync('/usr/bin/git', ['-C', fixtureWorkspace, 'rev-parse', '--show-toplevel'], {
          cwd: fixtureWorkspace,
          encoding: 'utf-8',
          timeout: 1500,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        });
        allowedMetadataCommands.push({ method, executable_basename: 'git', argv_pattern: ['-C', '<owned-fixture>', 'rev-parse', '--show-toplevel'], timeout_ms: 1500, cwd: 'owned_fixture', result: 'completed' });
        return result;
      } catch (error) {
        allowedMetadataCommands.push({ method, executable_basename: 'git', argv_pattern: ['-C', '<owned-fixture>', 'rev-parse', '--show-toplevel'], timeout_ms: 1500, cwd: 'owned_fixture', result: error?.killed ? 'timed_out' : 'nonzero_exit' });
        throw error;
      }
    }
    deniedChildProcess += 1;
    if (childDiagnostics.length < 4) {
      const stack = new Error().stack ?? '';
      const candidateRoot = join(npmAgent, 'npm', 'node_modules', packageName);
      const frame = stack.split('\n').map((line) => {
        const marker = line.indexOf(candidateRoot);
        return marker >= 0 ? line.slice(marker + candidateRoot.length).replace(/^[/\\]/, '').split(':').slice(0, 2).join(':') : null;
      }).find(Boolean) ?? null;
      childDiagnostics.push({
        method,
        executable_basename: executable.split(/[\\/]/).at(-1) || 'unknown',
        argv_pattern: argv.map((value) => typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) ? '<path>' : typeof value === 'string' ? value : `<${typeof value}>`),
        candidate_relative_stack_frame: frame,
      });
    }
    throw Object.assign(new Error('offline_child_process_denied'), { code: 'OFFLINE_CHILD_PROCESS_DENIED' });
  };

  // Install the barriers before importing the SDK, resolver, adapter, or package.
  globalThis.fetch = blockNetwork;
  if ('WebSocket' in globalThis) globalThis.WebSocket = class { constructor() { blockNetwork(); } };
  net.Socket.prototype.connect = blockNetwork;
  net.connect = blockNetwork;
  net.createConnection = blockNetwork;
  tls.connect = blockNetwork;
  http.request = blockNetwork;
  http.get = blockNetwork;
  https.request = blockNetwork;
  https.get = blockNetwork;
  dns.lookup = blockNetwork;
  dns.resolve = blockNetwork;
  dns.resolve4 = blockNetwork;
  dns.resolve6 = blockNetwork;
  dnsPromises.lookup = blockNetwork;
  dnsPromises.resolve = blockNetwork;
  dnsPromises.resolve4 = blockNetwork;
  dnsPromises.resolve6 = blockNetwork;
  dnsPromises.Resolver.prototype.resolve = blockNetwork;
  dnsPromises.Resolver.prototype.resolve4 = blockNetwork;
  dnsPromises.Resolver.prototype.resolve6 = blockNetwork;
  dns.promises.lookup = blockNetwork;
  dgram.createSocket = blockNetwork;
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = (...args) => blockChild(method, ...args);
  syncBuiltinESMExports();

  const cwd = join(scope, 'workspace');
  const home = process.env.HOME;
  const packageFixtureDir = join(extensionAgent, 'npm', 'node_modules', 'pi-extension-fixture');
  const candidateSpec = `npm:${packageName}@${packageVersion}`;
  let diagnostics = [];
  const codeToStatus = (code) => {
    const stage = diagnostics.at(-1)?.stage;
    if (code === 'extension_not_installed' || code === 'extension_version_mismatch') return 'BLOCKED';
    if (code === 'OFFLINE_CHILD_PROCESS_DENIED' || code === 'OFFLINE_NETWORK_DENIED') return 'BLOCKED';
    // The adapter deliberately sanitizes SDK loader exceptions. Keep an opaque
    // extension-load failure as NOT QUALIFIED instead of guessing SDK incompatibility.
    if (code === 'extension_load_failed' && stage === 'extension_load') return 'BLOCKED';
    if (code === 'pi_session_creation_failed' && ['runtime', 'provider', 'model', 'check_auth', 'get_auth', 'availability'].includes(stage)) return 'BLOCKED';
    return 'FAIL';
  };

  function findPackageMetadata(start, expectedName) {
    let dir = start;
    for (;;) {
      const candidate = join(dir, 'package.json');
      try {
        const data = JSON.parse(readFileSync(candidate, 'utf8'));
        if (data.name === expectedName) return { version: data.version, resolved_from: candidate.startsWith(join(npmAgent, 'npm', 'node_modules') + '/') ? 'isolated_npm_prefix_or_ancestor' : 'host_sdk_or_ancestor' };
      } catch { /* try the parent */ }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  function resolvedPeerVersions(extensionRoot) {
    const requireFromExtension = createRequire(join(extensionRoot, 'package.json'));
    const versions = {};
    for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
      try {
        const resolved = import.meta.resolve(name, pathToFileURL(join(extensionRoot, 'index.js')).href);
        const entry = fileURLToPath(resolved);
        versions[name] = findPackageMetadata(dirname(entry), name);
      } catch { versions[name] = null; }
    }
    // Also record what a require-based resolver sees, without importing a candidate dependency.
    try { requireFromExtension.resolve('@earendil-works/pi-coding-agent'); } catch { /* ESM-only exports are expected. */ }
    return versions;
  }

  async function run() {
    const repo = process.env.PI_AUDIT_REPO;
    const build = join(repo, '.profile-eval', 'src');
    const { SdkPiSessionAdapter, PROFILE_TOOLS } = await import(pathToFileURL(join(build, 'sdk-pi-adapter.js')).href);
    const { parseExtensionSpec } = await import(pathToFileURL(join(build, 'extension-spec.js')).href);
    const { resolvePiExtension } = await import(pathToFileURL(join(build, 'pi-extensions.js')).href);
    const { installStdoutGuard } = await import(pathToFileURL(join(build, 'stdout-guard.js')).href);
    const suppressed = [];
    const guard = installStdoutGuard({ report: (line) => suppressed.push(JSON.parse(line)) });
    safeOutput = guard.transportStdout;
    process.stderr.write = () => true;

    await mkdir(cwd, { recursive: true });
    await cp(join(repo, 'test', 'fixtures', 'pi-extension-fixture'), packageFixtureDir, { recursive: true, errorOnExist: true });
    const fixtureSpec = parseExtensionSpec('npm:pi-extension-fixture@1.0.0');
    const candidate = parseExtensionSpec(candidateSpec);
    assert.ok(fixtureSpec && candidate);

    const specToRoot = async (spec) => resolvePiExtension(spec, {
      agentDir: spec.name === 'pi-extension-fixture' ? extensionAgent : npmAgent,
    });
    diagnostics = [];
    const adapter = new SdkPiSessionAdapter({
      modelRuntimeFactory: () => import('@earendil-works/pi-coding-agent').then(({ ModelRuntime }) => ModelRuntime.create({
        refreshOnCreate: false,
        allowModelNetwork: false,
        modelsPath: null,
        authPath: join(scope, 'absent-auth.json'),
        modelsStorePath: join(scope, 'absent-models.json'),
      })),
      resolveExtension: specToRoot,
      diagnosticSink: (item) => diagnostics.push({ stage: item.stage, code: item.code, extension: item.extension ?? null }),
    });
    const profile = {
      alias: 'node24-extension-headless-probe',
      permissionProfile: profileName,
      provider: 'fixture-ext',
      model: 'fixture-ext-model',
      thinkingLevel: 'off',
      extensions: [fixtureSpec, candidate],
      skills: [],
    };

    let handle;
    try {
      handle = await adapter.create({ cwd, executionProfile: profile });
      const loaded = handle.session.resourceLoader.getExtensions();
      assert.equal(loaded.errors.length, 0);
      assert.equal(loaded.extensions.length, 2);
      const allExtensionTools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]).sort();
      assert.ok(allExtensionTools.includes('fixture_tool'));
      const candidateTools = allExtensionTools.filter((name) => name !== 'fixture_tool');
      const activeTools = handle.session.getActiveToolNames().sort();
      const allowedTools = [...PROFILE_TOOLS[profileName], ...(profileName === 'coding' ? allExtensionTools : [])];
      assert.ok(activeTools.every((name) => allowedTools.includes(name)));
      if (profileName === 'read-only') assert.deepEqual(activeTools, [...PROFILE_TOOLS[profileName]].sort());

      const extensions = globalThis.__piExtensionFixtureEvents ?? [];
      assert.ok(extensions.includes('session_start'));
      assert.ok(!extensions.includes('tool'));
      if (deniedNetwork > 0) throw Object.assign(new Error('offline_network_denied'), { code: 'OFFLINE_NETWORK_DENIED' });
      if (deniedChildProcess > 0) throw Object.assign(new Error('offline_child_process_denied'), { code: 'OFFLINE_CHILD_PROCESS_DENIED' });

      const candidateRoot = await specToRoot(candidate);
      const manifest = JSON.parse(await readFile(join(candidateRoot, 'package.json'), 'utf8'));
      assert.equal(manifest.name, packageName);
      assert.equal(manifest.version, packageVersion);
      const peers = resolvedPeerVersions(candidateRoot);
      await handle.dispose();
      handle = undefined;
      assert.ok(extensions.includes('session_shutdown'));

      guard.flush();
      guard.transportStdout.write(JSON.stringify({
        kind: 'node24-isolated-extension-headless-probe',
        status: 'PASS',
        package: `${packageName}@${packageVersion}`,
        permission_profile: profileName,
        package_peer_versions_resolved: peers,
        extensions_loaded: 2,
        candidate_tools_registered: candidateTools,
        active_tools: activeTools,
        skills_selected: 0,
        prompts_loaded: 0,
        candidate_tools_invoked: 0,
        provider_calls: 0,
        lifecycle: { session_start: 'PASS', session_shutdown: 'PASS' },
        cleanup: 'PASS',
        network_attempts_denied: deniedNetwork,
        child_process_attempts_denied: deniedChildProcess,
        allowed_metadata_commands: allowedMetadataCommands,
        raw_stdout_suppressed_writes: suppressed.reduce((sum, item) => sum + item.writes, 0),
        diagnostic_codes: diagnostics.map((item) => item.code),
        limitation: 'Headless load, registration, allowlist selection, and shutdown only. No candidate tools, prompt/provider calls, mutation commands, or quality claims.',
      }) + '\n');
    } finally {
      if (handle) await handle.dispose().catch(() => undefined);
    }
  }

  run().catch((error) => {
    const code = typeof error?.code === 'string' ? error.code : typeof error?.name === 'string' ? error.name : 'probe_failed';
    const status = codeToStatus(code);
    safeOutput.write(JSON.stringify({
      kind: 'node24-isolated-extension-headless-probe',
      status,
      package: `${packageName}@${packageVersion}`,
      permission_profile: profileName,
      failure_code: code,
      failure_stage: diagnostics.at(-1)?.stage ?? null,
      diagnostic_codes: diagnostics.map((item) => item.code),
      provider_calls: 0,
      network_attempts_denied: deniedNetwork,
      child_process_attempts_denied: deniedChildProcess,
      allowed_metadata_commands: allowedMetadataCommands,
      child_process_diagnostics: childDiagnostics,
      limitation: 'No candidate tool or model prompt was invoked; private error text and paths are omitted.',
    }) + '\n');
    process.exitCode = status === 'PASS' ? 0 : 1;
  });
}
