// Run after npm run build. Only documented package-root SDK exports are used.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import childProcess from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const scratch = await mkdtemp(join(tmpdir(), 'pi-prompt-probe-'));
const cwd = join(scratch, 'workspace');
const output = process.stdout.write.bind(process.stdout);
let networkAttempts = 0;
let childAttempts = 0;
let providerCalls = 0;
const denyNetwork = () => { networkAttempts++; throw new Error('offline_network_denied'); };
const denyChild = () => { childAttempts++; throw new Error('offline_child_denied'); };
globalThis.fetch = denyNetwork;
if (typeof globalThis.WebSocket === 'function') globalThis.WebSocket = class { constructor() { denyNetwork(); } };
net.Socket.prototype.connect = denyNetwork;
net.connect = net.createConnection = tls.connect = denyNetwork;
http.request = http.get = https.request = https.get = denyNetwork;
dns.lookup = dns.resolve = dns.resolve4 = dns.resolve6 = dns.promises.lookup = denyNetwork;
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = denyChild;
syncBuiltinESMExports();
// Isolate credentials and discovered resources before importing Pi.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, {
  PATH: originalEnv.PATH ?? '', HOME: join(scratch, 'home'), TMPDIR: scratch,
  XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
  XDG_DATA_HOME: join(scratch, 'data'), PI_CODING_AGENT_DIR: cwd,
});
// Do not allow SDK diagnostics to leak paths or complete prompts.
process.stdout.write = process.stderr.write = (_chunk, encoding, callback) => {
  if (typeof encoding === 'function') encoding();
  else if (typeof callback === 'function') callback();
  return true;
};
let handle;
let defaultSession;
const deadline = setTimeout(() => { output('{"error":"probe_timeout"}\n'); process.exit(1); }, 30_000);
try {
  await mkdir(join(cwd, 'skills/prompt-marker'), { recursive: true });
  await mkdir(process.env.HOME);
  await writeFile(join(cwd, 'AGENTS.md'), '# Probe workspace\nWORKSPACE_CONTEXT_MARKER_26OCT\n');
  const skillPath = join(cwd, 'skills/prompt-marker/SKILL.md');
  await writeFile(skillPath, '---\nname: prompt-marker\ndescription: SKILL_DESCRIPTION_MARKER_26OCT\n---\n# Probe skill\nSKILL_BODY_MARKER_26OCT\n');
  process.chdir(cwd);
  const { ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession } =
    await import('@earendil-works/pi-coding-agent');
  const { SdkPiSessionAdapter } = await import(pathToFileURL(join(repo, 'dist/sdk-pi-adapter.js')).href);
  const sdkVersion = JSON.parse(await readFile(join(repo, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')).version;
  const runtime = await ModelRuntime.create({
    refreshOnCreate: false, allowModelNetwork: false, modelsPath: null,
    authPath: join(scratch, 'absent-auth.json'), modelsStorePath: join(scratch, 'absent-models.json'),
  });
  // Faux provider satisfies the adapter's local model/auth checks; no turn is sent.
  runtime.registerProvider('prompt-fixture', {
    name: 'Offline prompt fixture', api: 'prompt-fixture-api', baseUrl: 'http://127.0.0.1:9', apiKey: 'not-a-credential',
    models: [{ id: 'prompt-fixture-model', name: 'Fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple: () => { providerCalls++; throw new Error('provider_call_forbidden'); },
  });
  const model = runtime.getModel('prompt-fixture', 'prompt-fixture-model');
  assert.ok(model);
  const rows = [];
  const prompts = new Map();
  function summarize(kind, permissionProfile, session) {
    // SDK docs/sdk.md: read-only current effective prompt, including unsent changes.
    const prompt = session.systemPrompt;
    // The skill catalogue has nested XML tags; it is not a separate prompt section.
    const outer = prompt.replace(/<skills>[\s\S]*?<\/skills>/g, '<skills>');
    const sections = ['preamble', ...[...outer.matchAll(/^<([a-z][a-z0-9_]*)>$/gm)].map(match => match[1])];
    const row = {
      kind, permissionProfile, characters: prompt.length, sections,
      markdownHeadings: prompt.split('\n').filter(line => /^#{1,6} /.test(line)),
      placeholder: prompt.includes('phase-0-system-prompt-disabled'),
      defaultPreamble: prompt.startsWith('You are an expert coding assistant operating inside pi,'),
      contextMarker: prompt.includes('WORKSPACE_CONTEXT_MARKER_26OCT'),
      skillName: prompt.includes('<name>prompt-marker</name>'),
      skillDescriptionMarker: prompt.includes('SKILL_DESCRIPTION_MARKER_26OCT'),
      skillLocation: prompt.includes(skillPath),
      skillBodyMarker: prompt.includes('SKILL_BODY_MARKER_26OCT'),
      toolSummary: prompt.includes('- read: Read file contents'),
      fullReadDescription: prompt.includes('Read the contents of a file. Supports text files and images'),
      behaviorGuidance: prompt.includes('Be concise in your responses'),
      activeTools: session.getActiveToolNames().sort(),
      loadedSkills: session.resourceLoader.getSkills().skills.length,
      contextFiles: session.resourceLoader.getAgentsFiles().agentsFiles.length,
    };
    assert.equal(row.placeholder, false);
    for (const key of ['defaultPreamble', 'contextMarker', 'skillName', 'skillDescriptionMarker', 'skillLocation', 'toolSummary', 'behaviorGuidance']) assert.equal(row[key], true);
    assert.equal(row.skillBodyMarker, false);
    assert.equal(row.fullReadDescription, false);
    assert.equal(row.loadedSkills, 1);
    assert.equal(row.contextFiles, 1);
    prompts.set(`${kind}:${permissionProfile}`, prompt);
    rows.push(row);
  }
  for (const permissionProfile of ['read-only', 'coding']) {
    let session;
    const adapter = new SdkPiSessionAdapter({
      modelRuntimeFactory: async () => runtime,
      createSession: async options => {
        const result = await createAgentSession(options);
        session = result.session;
        return result;
      },
    });
    handle = await adapter.create({ cwd, executionProfile: {
      alias: 'prompt-probe', permissionProfile, provider: model.provider, model: model.id, thinkingLevel: 'off',
      extensions: [], skills: [{ alias: 'marker', path: skillPath }],
    } });
    assert.equal(session.resourceLoader.getSystemPrompt(), undefined);
    summarize('adapter', permissionProfile, session);
    const tools = session.getActiveToolNames();
    await handle.dispose();
    handle = undefined;
    // Actual default loader options: no systemPrompt, overrides or discovery flags.
    // Keep cwd, agentDir, in-memory settings and tools identical for a fair comparison.
    const settingsManager = SettingsManager.inMemory(undefined, { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager });
    await resourceLoader.reload();
    ({ session: defaultSession } = await createAgentSession({
      cwd, agentDir: cwd, modelRuntime: runtime, model, thinkingLevel: 'off', tools,
      resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd),
    }));
    summarize('default-loader', permissionProfile, defaultSession);
    assert.equal(prompts.get(`adapter:${permissionProfile}`), prompts.get(`default-loader:${permissionProfile}`));
    defaultSession.dispose();
    defaultSession = undefined;
  }
  assert.equal(networkAttempts, 0);
  assert.equal(childAttempts, 0);
  assert.equal(providerCalls, 0);
  output(`${JSON.stringify({ sdkVersion, nodeVersion: process.versions.node, rows,
    adapterEqualsDefaultByProfile: true, networkAttempts, childAttempts, providerCalls })}\n`);
} catch {
  output(`${JSON.stringify({ error: 'probe_failed', networkAttempts, childAttempts, providerCalls })}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (handle) await handle.dispose().catch(() => undefined);
  defaultSession?.dispose();
  process.chdir(originalCwd);
  await rm(scratch, { recursive: true, force: true });
}
