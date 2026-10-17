// Run one exact installed extension through the repository's real SDK adapter.
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
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  const realExecFile = childProcess.execFile;
  const realSpawn = childProcess.spawn;
  const allowedSpawnChildren = [];
  const childGuardTotals = { provider_calls: 0, network_attempts: 0, child_process_attempts_denied: 0 };
  let safeOutput = process.stdout;
  const blockNetwork = () => { deniedNetwork += 1; throw Object.assign(new Error('offline_network_denied'), { code: 'OFFLINE_NETWORK_DENIED' }); };
  const blockChild = (method, ...args) => {
    const executable = typeof args[0] === 'string' ? args[0] : '';
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const options = args[2] && typeof args[2] === 'object' ? args[2] : {};
    const fixtureWorkspace = join(scope, 'workspace');
    if (method === 'execSync' && /^command -v [a-z][a-z0-9-]*$/i.test(executable)) {
      return realExecFileSync('/bin/sh', ['-c', executable], {
        encoding: 'utf-8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: dirname(process.execPath), HOME: scope },
      });
    }
    if (method === 'exec' && (executable === 'getconf CLK_TCK' || executable === 'getconf PAGESIZE')) {
      const key = executable.endsWith('CLK_TCK') ? 'CLK_TCK' : 'PAGESIZE';
      const callback = args.slice(1).find((item) => typeof item === 'function');
      const child = realExecFile('/usr/bin/getconf', [key], {
        cwd: fixtureWorkspace,
        encoding: 'utf-8',
        timeout: 1000,
        maxBuffer: 8192,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin', HOME: scope },
      }, callback);
      const receipt = { method, executable_basename: 'getconf', argv_pattern: [key], timeout_ms: 1000, cwd: 'owned_fixture', result: 'started' };
      allowedMetadataCommands.push(receipt);
      allowedSpawnChildren.push({ child, receipt });
      child.once('close', (code) => {
        receipt.result = code === 0 ? 'completed' : 'nonzero_exit';
        receipt.exit_code = code;
      });
      return child;
    }
    const candidateServerBundle = join(npmAgent, 'npm', 'node_modules', packageName, 'server.bundle.mjs');
    if (method === 'spawn' && executable === process.execPath && argv.length === 1
      && argv[0] === candidateServerBundle && JSON.stringify(options.stdio) === JSON.stringify(['pipe', 'pipe', 'pipe'])
      && options.env?.HOME === scope && options.env?.CONTEXT_MODE_BRIDGE_DEPTH === '1') {
      const childGuard = join(dirname(fileURLToPath(import.meta.url)), 'child-guard.mjs');
      const guardOutput = join(scope, `child-guard-${process.pid}.json`);
      const child = realSpawn(executable, ['--import', childGuard, argv[0]], {
        ...options,
        env: { ...options.env, PI_AUDIT_SCOPE: scope, PI_AUDIT_CHILD_GUARD_OUTPUT: guardOutput },
        detached: false,
      });
      const receipt = { method, executable_basename: 'node-v24', argv_pattern: ['--import', '<owned-child-guard>', '<owned-context-mode>/server.bundle.mjs'], cwd: 'owned_fixture', result: 'started' };
      allowedMetadataCommands.push(receipt);
      allowedSpawnChildren.push({ child, receipt });
      child.once('exit', (code) => { receipt.result = 'exited'; receipt.exit_code = code; });
      return child;
    }
    const readOnlyGitIndex = method === 'spawn' && executable === 'git'
      && options.cwd === fixtureWorkspace && (options.timeout === undefined || options.timeout === 10_000)
      && (JSON.stringify(argv) === JSON.stringify(['ls-files'])
        || JSON.stringify(argv) === JSON.stringify(['ls-files', '--others', '--ignored', '--exclude-standard']));
    if (readOnlyGitIndex) {
      const child = realSpawn('/usr/bin/git', ['-C', fixtureWorkspace, ...argv], {
        ...options, cwd: fixtureWorkspace,
        env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        detached: false, windowsHide: true,
      });
      const receipt = { method, executable_basename: 'git', argv_pattern: argv, cwd: 'owned_fixture', timeout_ms: 1500, result: 'started' };
      allowedMetadataCommands.push(receipt);
      allowedSpawnChildren.push({ child, receipt });
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        const hardKill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 500);
        child.once('close', () => clearTimeout(hardKill));
      }, 1500);
      child.once('exit', (code) => { clearTimeout(timeout); receipt.result = code === 0 ? 'completed' : 'nonzero_exit'; receipt.exit_code = code; });
      return child;
    }
    const isOwnedGitMetadata = method === 'execFileSync'
      && executable === 'git'
      && ((argv.length === 4
      && argv[0] === '-C'
      && argv[1] === fixtureWorkspace
      && argv[2] === 'rev-parse'
      && argv[3] === '--show-toplevel')
        || (argv.length === 5
          && argv[0] === '-C'
          && argv[1] === fixtureWorkspace
          && argv[2] === 'worktree'
          && argv[3] === 'list'
          && argv[4] === '--porcelain'));
    if (isOwnedGitMetadata) {
      // Permit only this fixed, read-only metadata query in the fresh fixture.
      // No global/system Git config or optional locks; cap execution at 1.5s.
      try {
      const safeArgs = ['-C', fixtureWorkspace, ...argv.slice(2)];
      const result = realExecFileSync('/usr/bin/git', safeArgs, {
          cwd: fixtureWorkspace,
          encoding: 'utf-8',
          timeout: 1500,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        });
        allowedMetadataCommands.push({ method, executable_basename: 'git', argv_pattern: ['-C', '<owned-fixture>', ...argv.slice(2)], timeout_ms: 1500, cwd: 'owned_fixture', result: 'completed' });
        return result;
      } catch (error) {
        allowedMetadataCommands.push({ method, executable_basename: 'git', argv_pattern: ['-C', '<owned-fixture>', ...argv.slice(2)], timeout_ms: 1500, cwd: 'owned_fixture', result: error?.killed ? 'timed_out' : 'nonzero_exit' });
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
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const wrapper = (...args) => blockChild(method, ...args);
    if (method === 'exec') {
      wrapper[promisify.custom] = (...args) => new Promise((resolve, reject) => {
        blockChild('exec', ...args, (error, stdout, stderr) => {
          if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
          else resolve({ stdout, stderr });
        });
      });
    }
    childProcess[method] = wrapper;
  }
  syncBuiltinESMExports();

  const cwd = join(scope, 'workspace');
  const home = process.env.HOME;
  const packageFixtureDir = join(extensionAgent, 'npm', 'node_modules', 'pi-extension-fixture');
  const candidateSpec = `npm:${packageName}@${packageVersion}`;
  let diagnostics = [];
  let capturedRuntime;
  let functionCheck = null;
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
      extensionSdk: {
        createServices: (await import('@earendil-works/pi-coding-agent')).createAgentSessionServices,
        createSessionFromServices: (await import('@earendil-works/pi-coding-agent')).createAgentSessionFromServices,
        createRuntime: async (...args) => {
          capturedRuntime = await (await import('@earendil-works/pi-coding-agent')).createAgentSessionRuntime(...args);
          return capturedRuntime;
        },
      },
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
      const loaded = capturedRuntime.services.resourceLoader.getExtensions();
      assert.equal(loaded.errors.length, 0);
      assert.equal(loaded.extensions.length, 2);
      const allExtensionTools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]).sort();
      assert.ok(allExtensionTools.includes('fixture_tool'));
      const candidateTools = allExtensionTools.filter((name) => name !== 'fixture_tool');
      const activeTools = capturedRuntime.session.getActiveToolNames().sort();
      const allowedTools = [...PROFILE_TOOLS[profileName], ...(profileName === 'coding' ? allExtensionTools : [])];
      assert.ok(activeTools.every((name) => allowedTools.includes(name)));
      if (profileName === 'read-only') assert.deepEqual(activeTools, [...PROFILE_TOOLS[profileName]].sort());

      const extensions = globalThis.__piExtensionFixtureEvents ?? [];
      assert.ok(extensions.includes('session_start'));
      assert.ok(!extensions.includes('tool'));
      functionCheck = { status: 'NOT_APPLICABLE' };
      if (packageName === 'pi-lens') {
        const session = capturedRuntime?.session;
        assert.ok(session, 'public_runtime_session_captured');
        const tool = session.getToolDefinition('symbol_search');
        assert.ok(tool, 'symbol_search_registered');
        assert.ok(session.getActiveToolNames().includes('symbol_search'), 'symbol_search_active_in_coding_profile');
        const toolContext = session.extensionRunner.createToolContext('fixture-symbol-search-1', undefined);
        functionCheck = { status: 'RUNNING', function: 'symbol_search' };
        let result = await tool.execute('fixture-symbol-search-1', { query: 'FixtureAuthNeedle', limit: 5 }, undefined, undefined, toolContext);
        let text = (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        let resultJson = JSON.stringify(result.details ?? result.structuredContent ?? {});
        let retries = 0;
        while (/Word index is building in the background/.test(text) && retries < 5) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          retries++;
          result = await tool.execute(`fixture-symbol-search-${retries + 1}`, { query: 'FixtureAuthNeedle', limit: 5 }, undefined, undefined, session.extensionRunner.createToolContext(`fixture-symbol-search-${retries + 1}`, undefined));
          text = (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
          resultJson = JSON.stringify(result.details ?? result.structuredContent ?? {});
        }
        functionCheck = { status: 'EXECUTED', function: 'symbol_search', retries, result_is_error: Boolean(result.isError), result_has_fixture_name: /auth-fixture\.ts/.test(`${text}\n${resultJson}`), output_excerpt: text.slice(0, 400) };
        if (/auth-fixture\.ts/.test(`${text}\n${resultJson}`)) {
          assert.doesNotMatch(`${text}\n${resultJson}`, /outside-canary\.ts/);
          functionCheck = { status: 'PASS', function: 'symbol_search', behavior: 'fixture search returned expected in-scope source and excluded outside canary', invocations: retries + 1, fixture_hit_seen: true, outside_fixture_excluded: true, result_is_error: Boolean(result.isError) };
        } else {
          assert.match(text, /Word index is building in the background/);
          assert.match(text, /retry this query shortly/);
          functionCheck = { status: 'PASS', retrieval_status: 'INCONCLUSIVE', function: 'symbol_search', behavior: 'cold-cache response accurately reports building state and retry hint', invocations: retries + 1, fixture_search_result: 'not_yet_available', result_is_error: true };
        }
        const reportTool = session.getToolDefinition('project_report');
        assert.ok(reportTool, 'project_report_registered');
        const reportResult = await reportTool.execute(
          'fixture-project-report-1',
          { limit: 1, focus: 'FixtureAuthNeedle', view: 'compact' },
          undefined,
          undefined,
          session.extensionRunner.createToolContext('fixture-project-report-1', undefined),
        );
        const reportText = (reportResult.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        const reportDetails = reportResult.details ?? reportResult.structuredContent ?? {};
        functionCheck = {
          ...functionCheck,
          project_report: {
            status: reportResult.isError || reportDetails.available === false ? 'COLD_CACHE_UNAVAILABLE' : 'RESULT_RETURNED',
            result_is_error: Boolean(reportResult.isError),
            available: reportDetails.available ?? null,
            output_excerpt: reportText.slice(0, 250),
          },
          invocations: (functionCheck.invocations ?? 0) + 1,
        };
      } else if (packageName === 'context-mode') {
        const session = capturedRuntime?.session;
        assert.ok(session, 'public_runtime_session_captured');
        functionCheck = { status: 'RUNNING', function: 'tool_result capture' };
        const syntheticRule = '# Synthetic fixture policy\nMarker: CM_FN_CANARY_42\n';
        const emitted = await session.extensionRunner.emitToolResult({
          type: 'tool_result', toolCallId: 'fixture-read-rule-1', toolName: 'read',
          input: { path: 'AGENTS.md' }, params: { path: 'AGENTS.md' },
          content: [{ type: 'text', text: syntheticRule }], result: syntheticRule,
          isError: false, details: undefined,
        });
        functionCheck = { status: 'EVENT_EMITTED', function: 'tool_result capture', sdk_event_emission: true };
        functionCheck = { status: 'DEPENDENCY_RESOLVED', function: 'tool_result capture' };
        const { DatabaseSync } = await import('node:sqlite');
        const sessionDbDir = join(home, '.pi', 'context-mode', 'sessions');
        const dbFiles = [];
        async function collectDbFiles(dir) {
          let entries = [];
          try { entries = await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) await collectDbFiles(fullPath);
            else if (entry.isFile() && entry.name.endsWith('.db')) dbFiles.push(fullPath);
          }
        }
        await collectDbFiles(sessionDbDir);
        functionCheck = { status: 'DB_FILES_DISCOVERED', function: 'tool_result capture', database_files_found: dbFiles.length };
        const stored = [];
        const attributed = [];
        for (const dbPath of dbFiles) {
          functionCheck = { status: 'DB_QUERY', function: 'tool_result capture' };
          const db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false, timeout: 1000 });
          stored.push(...db.prepare('SELECT data, project_dir FROM session_events WHERE data LIKE ? AND project_dir = ?').all('%CM_FN_CANARY_42%', cwd));
          attributed.push(...db.prepare('SELECT project_dir FROM session_events WHERE data LIKE ?').all('%CM_FN_CANARY_42%'));
          db.close();
        }
        functionCheck = { status: 'EVENT_STORED_QUERY', function: 'tool_result capture', stored_count: stored.length, project_attribution_matches_fixture: attributed.some((entry) => entry.project_dir === cwd) };
        assert.ok(stored.length > 0, 'synthetic_read_rule_captured_in_isolated_session_database');
        assert.ok(attributed.some((entry) => entry.project_dir === cwd), 'event_has_fixture_project_attribution');
        functionCheck = { status: 'PASS', function: 'tool_result capture', hook_invocations: 1, candidate_tools_invoked: 0, behavior: 'synthetic AGENTS.md read result reached the real SDK event handler and was persisted with fixture project attribution', canary_persisted: true, fixture_project_scope_attribution_verified: true, retrieval_or_compression_tested: false, sdk_event_modifications: Boolean(emitted?.content || emitted?.details) };
        functionCheck = { ...functionCheck, status: 'EVENT_CAPTURE_PASS' };
        const sessionForMcp = capturedRuntime.session;
        const systemPromptOptions = { cwd, selectedTools: sessionForMcp.getActiveToolNames(), hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: '', contextFiles: [], skills: [] };
        await sessionForMcp.extensionRunner.emitBeforeAgentStart({
          type: 'before_agent_start', messageType: 'user', prompt: 'Synthetic local fixture check',
          systemPrompt: sessionForMcp.systemPrompt, systemPromptOptions,
        }, systemPromptOptions);
        const registered = sessionForMcp.getAllTools().map((item) => item.name);
        const searchName = registered.find((name) => /(?:^|_)ctx_search$/.test(name));
        const searchTool = searchName ? sessionForMcp.getToolDefinition(searchName) : undefined;
        if (!searchTool) {
          functionCheck = { ...functionCheck, status: 'PASS', mcp_bridge_status: 'INCONCLUSIVE', reason_code: 'ctx_search_not_registered_after_direct_hook_emission', before_agent_start_emitted: true, context_tools_registered: registered.filter((name) => /ctx_/.test(name)), registered_tool_names: registered };
        } else {
          const ctx = sessionForMcp.extensionRunner.createToolContext('fixture-context-search-1', undefined);
          const searchResult = await searchTool.execute('fixture-context-search-1', { queries: ['CM_FN_CANARY_42'] }, undefined, undefined, ctx);
          const searchText = (searchResult.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
          assert.match(searchText, /CM_FN_CANARY_42/);
          functionCheck = { ...functionCheck, status: 'PASS', function: 'MCP bridge ctx_search retrieval', candidate_tools_invoked: 1, hook_invocations: 1, mcp_bridge_status: 'PASS', before_agent_start_emitted: true, context_search_returned_canary: true, context_tools_registered: registered.filter((name) => /ctx_/.test(name)), registered_tool_names: registered };
        }
      }
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
      for (const { child, receipt } of allowedSpawnChildren) {
        if (child.exitCode === null && !child.signalCode) {
          child.kill('SIGTERM');
          const exited = await Promise.race([
            new Promise((resolve) => child.once('close', () => resolve(true))),
            new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
          ]);
          if (!exited && child.exitCode === null) {
            child.kill('SIGKILL');
            await Promise.race([
              new Promise((resolve) => child.once('close', () => resolve(true))),
              new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
            ]);
          }
        }
        if (child.exitCode === null && !child.signalCode) {
          throw Object.assign(new Error('owned_candidate_child_did_not_exit'), { code: 'OWNED_CANDIDATE_CHILD_CLEANUP_FAILED' });
        }
        if (packageName === 'context-mode') {
          try {
            receipt.child_guard = JSON.parse(await readFile(join(scope, `child-guard-${child.pid}.json`), 'utf8'));
          } catch {
            throw Object.assign(new Error('child_guard_receipt_missing'), { code: 'CHILD_GUARD_RECEIPT_MISSING' });
          }
          childGuardTotals.provider_calls += receipt.child_guard.provider_calls ?? 0;
          childGuardTotals.network_attempts += receipt.child_guard.network_attempts_denied ?? 0;
          childGuardTotals.child_process_attempts_denied += receipt.child_guard.child_process_attempts_denied ?? 0;
          if (receipt.child_guard.network_attempts_denied > 0) {
            throw Object.assign(new Error('context_server_network_api_blocked_by_child_guard'), { code: 'OFFLINE_NETWORK_DENIED' });
          }
          if (receipt.child_guard.child_process_attempts_denied > 0) {
            throw Object.assign(new Error('context_server_child_process_blocked_by_child_guard'), { code: 'OFFLINE_CHILD_PROCESS_DENIED' });
          }
        }
        receipt.cleanup = 'PASS';
      }

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
        candidate_tools_invoked: functionCheck.status.startsWith('PASS') ? (functionCheck.invocations ?? 0) : 0,
        function_check: functionCheck,
        provider_calls: 0,
        lifecycle: { session_start: 'PASS', session_shutdown: 'PASS' },
        cleanup: 'PASS',
        network_attempts_denied: deniedNetwork + childGuardTotals.network_attempts,
        child_process_attempts_denied: deniedChildProcess + childGuardTotals.child_process_attempts_denied,
        allowed_metadata_commands: allowedMetadataCommands,
        raw_stdout_suppressed_writes: suppressed.reduce((sum, item) => sum + item.writes, 0),
        diagnostic_codes: diagnostics.map((item) => item.code),
        limitation: functionCheck.status === 'NOT_APPLICABLE' ? 'Headless load, registration, allowlist selection, and shutdown only. No candidate functions invoked.' : 'Bounded synthetic SDK function/event invocation only. No prompts, model/provider calls, mutations, UI claims, real-world retrieval claims, or broad efficacy claims.',
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
      failure_detail: typeof error?.message === 'string' ? error.message.replaceAll(scope ?? '', '<isolated>').replaceAll(npmAgent ?? '', '<isolated-npm>').slice(0, 180) : null,
      failure_stage: diagnostics.at(-1)?.stage ?? null,
      diagnostic_codes: diagnostics.map((item) => item.code),
      provider_calls: 0,
      network_attempts_denied: deniedNetwork + childGuardTotals.network_attempts,
      child_process_attempts_denied: deniedChildProcess + childGuardTotals.child_process_attempts_denied,
      allowed_metadata_commands: allowedMetadataCommands,
      child_process_diagnostics: childDiagnostics,
      function_check: functionCheck,
      limitation: 'Probe failed before a qualified function result; private error text and paths are omitted.',
    }) + '\n');
    process.exitCode = status === 'PASS' ? 0 : 1;
  });
}
