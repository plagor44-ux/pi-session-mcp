import { syncBuiltinESMExports } from 'node:module';
import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import childProcess from 'node:child_process';

// Install guards before importing the SDK or any extension. Child processes are
// also denied so extensions cannot bypass the in-process network guard.
let networkAttempts = 0;
let childAttempts = 0;
let providerAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw new Error('probe_network_denied'); };
const denyChild = () => { childAttempts++; throw new Error('probe_child_process_denied'); };
globalThis.fetch = denyNetwork;
if (typeof globalThis.WebSocket === 'function') globalThis.WebSocket = class { constructor() { denyNetwork(); } };
net.Socket.prototype.connect = denyNetwork;
net.connect = net.createConnection = denyNetwork;
tls.connect = denyNetwork;
http.request = http.get = denyNetwork;
https.request = https.get = denyNetwork;
dns.lookup = dns.resolve = dns.resolve4 = dns.resolve6 = denyNetwork;
dns.promises.lookup = denyNetwork;
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = denyChild;
syncBuiltinESMExports();

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const argument = process.argv[2];
if (!argument || process.argv.length !== 3) throw new Error('usage: probe.mjs <throwaway-agentDir>');
const agentDir = await realpath(argument);
if (!/^pi-lens-probe\.[A-Za-z0-9]+$/.test(agentDir.split('/').at(-1))) throw new Error('throwaway_directory_required');

// Do not inherit credentials, provider configuration, fixture log destinations,
// or personal resource paths. All user-state and temporary writes stay here.
const path = process.env.PATH;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, {
  PATH: path ?? '', HOME: join(agentDir, 'home'), TMPDIR: join(agentDir, 'tmp'),
  XDG_CONFIG_HOME: join(agentDir, 'home/config'), XDG_CACHE_HOME: join(agentDir, 'home/cache'),
  XDG_DATA_HOME: join(agentDir, 'home/data'), PI_CODING_AGENT_DIR: agentDir,
});
const cwd = join(agentDir, 'workspace');
for (const directory of [cwd, process.env.HOME, process.env.TMPDIR]) await mkdir(directory, { recursive: true });
process.chdir(cwd);
const fixture = join(agentDir, 'npm/node_modules/pi-extension-fixture');
const lens = join(agentDir, 'npm/node_modules/pi-lens');
await cp(join(repo, 'test/fixtures/pi-extension-fixture'), fixture, { recursive: true });
const manifest = JSON.parse(await readFile(join(lens, 'package.json'), 'utf8'));
if (manifest.name !== 'pi-lens' || manifest.version !== '4.4.3') throw new Error('wrong_lens_version');
const sdkManifest = JSON.parse(await readFile(join(repo, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
if (sdkManifest.version !== '1.3.0') throw new Error('wrong_sdk_version');

// The fixture intentionally writes raw stdout. Reserve stdout for the single
// result line and suppress third-party diagnostics rather than persist paths.
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write = (_chunk, encoding, callback) => {
  if (typeof encoding === 'function') encoding();
  else if (typeof callback === 'function') callback();
  return true;
};
const deadline = setTimeout(() => { output('{"error":"probe_timeout"}\n'); process.exit(1); }, 30_000);
let runtime;
try {
  const { ModelRuntime, SettingsManager, SessionManager, createAgentSessionServices,
    createAgentSessionFromServices, createAgentSessionRuntime } = await import('@earendil-works/pi-coding-agent');
  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false, allowModelNetwork: false, modelsPath: null,
    authPath: join(agentDir, 'auth.json'), modelsStorePath: join(agentDir, 'models-store.json'),
  });
  // Guard public model-call methods before loading third-party code.
  for (const key of ['stream', 'streamSimple', 'complete', 'completeSimple',
    'streamDeferred', 'fetchDeferred', 'cancelDeferred', 'generateImages', 'classify']) {
    modelRuntime[key] = () => { providerAttempts++; throw new Error('provider_call_forbidden'); };
  }
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime,
    settingsManager: SettingsManager.inMemory(undefined, { projectTrusted: false }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fixture, lens],
      systemPrompt: 'Offline registration probe. No prompt will be submitted.', appendSystemPrompt: [],
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      promptsOverride: () => ({ prompts: [], diagnostics: [] }),
      themesOverride: () => ({ themes: [], diagnostics: [] }),
    },
  });
  const snapshot = () => {
    const loaded = services.resourceLoader.getExtensions();
    if (loaded.errors.length || loaded.extensions.length !== 2 || services.diagnostics.some(d => d.type === 'error')) {
      throw new Error('extension_load_failed');
    }
    // Preserve attribution by asserting the fixture's exact set; every other
    // name in the recorded flattened list belongs to pi-lens.
    if ([...loaded.extensions[0].tools.keys()].join(',') !== 'fixture_tool') throw new Error('unexpected_fixture_tools');
    return loaded.extensions.flatMap(extension => [...extension.tools.keys()]).sort();
  };
  const loadTools = snapshot();
  const model = modelRuntime.getModel('fixture-ext', 'fixture-ext-model');
  if (!model) throw new Error('fixture_model_missing');
  const tools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', ...loadTools];
  runtime = await createAgentSessionRuntime(async ({ sessionManager }) => ({
    ...(await createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: 'off', tools })),
    services, diagnostics: services.diagnostics,
  }), { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  let bindErrors = 0;
  await runtime.session.bindExtensions({ mode: 'print', onError: () => { bindErrors++; } });
  if (bindErrors) throw new Error('extension_bind_failed');
  const boundTools = snapshot();
  const activeCoding = runtime.session.getActiveToolNames().sort();
  await runtime.dispose();
  runtime = undefined;
  if (childAttempts) throw new Error('child_process_attempted');
  if (providerAttempts) throw new Error('provider_call_attempted');
  if (globalThis.__piExtensionFixtureEvents?.includes('stream')) throw new Error('provider_was_called');
  clearTimeout(deadline);
  output(`${JSON.stringify({ loadTools, boundTools, activeCoding, networkAttempts })}\n`);
} catch {
  if (runtime) await runtime.dispose().catch(() => undefined);
  clearTimeout(deadline);
  output(`${JSON.stringify({ error: 'probe_failed', networkAttempts, childAttempts, providerAttempts })}\n`);
  process.exitCode = 1;
}
