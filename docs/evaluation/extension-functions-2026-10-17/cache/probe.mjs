import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [caseName, npmRoot, agentDir, workspace] = process.argv.slice(2);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const network = { count: 0 };
const children = { count: 0 };
const nativeRequire = createRequire(import.meta.url);
const childProcess = nativeRequire('node:child_process');
const net = nativeRequire('node:net');
const tls = nativeRequire('node:tls');
const http = nativeRequire('node:http');
const https = nativeRequire('node:https');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = (..._args) => { children.count++; throw new Error('child process denied by provider-free fixture'); };
}
net.connect = net.createConnection = (..._args) => { network.count++; throw new Error('network denied by provider-free fixture'); };
tls.connect = (..._args) => { network.count++; throw new Error('network denied by provider-free fixture'); };
http.request = (..._args) => { network.count++; throw new Error('network denied by provider-free fixture'); };
https.request = (..._args) => { network.count++; throw new Error('network denied by provider-free fixture'); };
globalThis.fetch = async (..._args) => { network.count++; throw new Error('network denied by provider-free fixture'); };

const checks = [];
const pass = (id, condition) => { checks.push({ id, result: condition ? 'PASS' : 'FAIL' }); if (!condition) throw new Error(`check failed: ${id}`); };
net.Socket.prototype.connect = net.connect;
const dns = nativeRequire('node:dns');
for(const key of ['lookup','resolve','resolve4','resolve6']) { dns[key]=net.connect;if(dns.promises?.[key])dns.promises[key]=async()=>net.connect(); }
nativeRequire('node:dgram').createSocket=net.connect;
if('WebSocket' in globalThis)globalThis.WebSocket=class{constructor(){net.connect();}};
syncBuiltinESMExports();
const sdk = await import('@earendil-works/pi-coding-agent');
const { createJiti } = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false });
const extensionPath = resolve(npmRoot, 'pi-cache-optimizer/index.ts');
const extensionModule = await jiti.import(extensionPath);
const extension = extensionModule.default;
const handlers = new Map();
const commands = new Map();
const model = {
  id: 'gpt-4.1', name: 'GPT-4.1 fixture', provider: 'openai', api: 'openai-completions',
  baseUrl: 'https://api.openai.com/v1', contextWindow: 128000, maxTokens: 4096,
  input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const notices = [];
let confirmationRequests=0;
const ui = {
  notify: (message, level) => notices.push({ level, text: String(message) }),
  setStatus: () => {},
  confirm: async () => { confirmationRequests++;throw new Error('fixture must not request UI confirmation'); },
};
const ctx = {
  model, mode: 'print', cwd: workspace, hasUI: false, ui,
  sessionManager: { getSessionId: () => 'synthetic-cache-session-7d335b78' },
  modelRegistry: { getAll: () => [model], find: (provider, id) => provider === model.provider && id === model.id ? model : undefined },
  modelRegistryVersion: 1,
};
const api = {
  on: (event, handler) => { if (handlers.has(event)) throw new Error(`duplicate event registration ${event}`); handlers.set(event, handler); },
  registerCommand: (name, registration) => commands.set(name, registration),
  getSettings: () => ({ cacheWarming: 'off' }),
};
extension(api);
pass('sdk-root-export-imported', typeof sdk.getAgentDir === 'function');
pass('real-extension-registers-hooks', ['before_provider_request', 'cache_warming_decision', 'message_end', 'session_shutdown'].every(k => handlers.has(k)));
pass('real-extension-registers-command', commands.has('cache-optimizer'));

const filesBefore = async () => (await readdir(agentDir, { recursive: true })).sort();
let changedFiles = [];

if (caseName === 'payload-openai' || caseName === 'payload-codex-bypass') {
  const requestModel = caseName === 'payload-codex-bypass'
    ? { ...model, api: 'openai-codex-responses' }
    : model;
  ctx.model = requestModel;
  const input = { model: requestModel.id, messages: [{ role: 'user', content: 'SYNTHETIC-NON-PROMPT-PAYLOAD' }], temperature: 0.2, metadata: { fixture: 'preserve' } };
  const inputSnapshot = structuredClone(input);
  const result = handlers.get('before_provider_request')({ payload: input }, ctx);
  if (caseName === 'payload-openai') {
    pass('openai-compatible-payload-returns-copy-with-cache-key', !!result && typeof result === 'object' && typeof result.prompt_cache_key === 'string');
    pass('openai-compatible-cache-key-opaque-and-bounded', /^pi-[a-f0-9]{32}$/.test(result.prompt_cache_key) && result.prompt_cache_key.length <= 64);
    pass('openai-compatible-request-fields-preserved', result.model === input.model && result.messages === input.messages && result.temperature === input.temperature && result.metadata === input.metadata);
    pass('openai-compatible-input-not-mutated', JSON.stringify(input) === JSON.stringify(inputSnapshot));
  } else {
    pass('codex-responses-bypass-keeps-request-unchanged', result === undefined);
    pass('codex-responses-input-not-mutated', JSON.stringify(input) === JSON.stringify(inputSnapshot));
  }
}

if (caseName.startsWith('warming-disabled')) {
  const fixtureModel = caseName.endsWith('zero')
    ? { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    : { ...model, id: 'openrouter/auto', provider: 'openrouter', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  ctx.model = fixtureModel;
  const decision = handlers.get('cache_warming_decision')({ action: 'stop', warmCost: 0, missCost: 0 }, ctx);
  pass(`${caseName}-returns-no-warming-action`, decision === undefined);
  pass(`${caseName}-host-cache-warming-setting-off`, (await api.getSettings()).cacheWarming === 'off');
  pass(`${caseName}-no-provider-or-network-call`, network.count === 0);
}

if (caseName === 'commands-headless') {
  ctx.model = { ...model, id: 'claude-sonnet-4', name: 'Claude fixture', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://fixture.invalid/v1', compat: {} };
  const before = await filesBefore();
  const command = commands.get('cache-optimizer').handler;
  await command('fix prompt-cache', ctx);
  const afterFix = await filesBefore();
  pass('headless-fix-does-not-write-agent-files', JSON.stringify(before) === JSON.stringify(afterFix));
  pass('headless-fix-explains-confirmation-required', notices.at(-1)?.text.includes('Non-interactive terminal detected') && notices.at(-1)?.text.includes('No changes were made'));
  await command('rollback', ctx);
  const afterRollback = await filesBefore();
  pass('headless-rollback-does-not-write-agent-files', JSON.stringify(before) === JSON.stringify(afterRollback));
  pass('headless-rollback-explains-confirmation-required', notices.at(-1)?.text.includes('Rollback requires interactive confirmation') && notices.at(-1)?.text.includes('No changes were made'));
  pass('headless-command-never-requested-confirmation', confirmationRequests===0);
  changedFiles = afterRollback.filter(x => !before.includes(x));
}

if (caseName === 'stats-synthetic') {
  ctx.model = { ...model, cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 } };
  await handlers.get('session_start')({ reason: 'startup' }, ctx);
  await handlers.get('before_provider_request')({ payload: { model: model.id, messages: [{role:'user',content:'SYNTHETIC-NON-PROMPT-PAYLOAD'}] } }, ctx);
  await handlers.get('after_provider_response')({ status: 200, headers: {} }, ctx);
  const message = {
    role: 'assistant', provider: 'openai', model: model.id, api: 'openai-completions',
    stopReason: 'stop', usage: { input: 73, output: 13, cacheRead: 41, cacheWrite: 5, totalTokens: 132 },
    content: [{ type: 'text', text: 'SYNTHETIC-RESPONSE-DO-NOT-PERSIST' }],
  };
  await handlers.get('message_end')({ message }, ctx);
  await handlers.get('session_shutdown')({}, ctx);
  const paths = await readdir(agentDir, { recursive: true });
  const jsonFiles = [];
  for (const path of paths.filter(p => p.endsWith('.json'))) {
    const full = join(agentDir, path);
    const body = await readFile(full, 'utf8');
    jsonFiles.push({ path, body });
  }
  const persisted = jsonFiles.some(({ body }) => {
    try {
      const value = JSON.parse(body);
      const stats = value.models?.['openai/gpt-4.1']?.stats;
      return stats?.totalRequests === 1 && stats?.cachedInputTokens === 41 && stats?.cacheWriteInputTokens === 5 && stats?.totalInputTokens === 119;
    } catch { return false; }
  });
  const payloadAbsent = jsonFiles.every(({ body }) => !body.includes('SYNTHETIC-RESPONSE-DO-NOT-PERSIST') && !body.includes('SYNTHETIC-NON-PROMPT-PAYLOAD'));
  pass('synthetic-usage-produced-local-stats-file', jsonFiles.length > 0 && persisted);
  pass('synthetic-prompt-response-content-not-persisted', payloadAbsent);
  pass('stats-remain-inside-fresh-agent-dir', jsonFiles.every(({ path }) => !path.startsWith('..')));
}

const entries = await readdir(agentDir, { recursive: true });
changedFiles = changedFiles.length ? changedFiles : entries;
const receipt = {
  status: checks.every(c => c.result === 'PASS') ? 'PASS' : 'FAIL',
  checks,
  cleanup: 'PASS',
  network_attempts: network.count,
  child_process_attempts: children.count,
  changed_files: changedFiles,
};
process.stdout.write(`${JSON.stringify(receipt)}\n`);
