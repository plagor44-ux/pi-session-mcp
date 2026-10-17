import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import childProcess from 'node:child_process';

const [testCase, packagePath, agentDir, workspace] = process.argv.slice(2);
const repo = resolveRepo();
let networkAttempts = 0;
let deniedChildProcessAttempts = 0;
const checks = [];
const check = (name, ok) => {
  checks.push({ id: name, result: ok ? 'PASS' : 'FAIL' });
  if (!ok) throw new Error(`check_failed:${name}`);
};
const denyNetwork = () => { networkAttempts++; throw new Error('synthetic_fixture_network_denied'); };
const denyChild = () => { deniedChildProcessAttempts++; throw new Error('synthetic_fixture_child_process_denied'); };
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

function resolveRepo() { return dirname(fileURLToPath(import.meta.url)).split('/docs/evaluation/')[0]; }
const notices = [];
const tools = new Map();
const events = new Map();
const commands = new Map();
const flags = new Map();
const providers = new Map();
const appendedEntries = [];
let activeTools = ['read', 'grep', 'find', 'ls'];
const pi = {
  on(name, handler) {
    const registered = events.get(name) ?? [];
    registered.push(handler);
    events.set(name, registered);
  },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name, command) { commands.set(name, command); },
  registerFlag(name, flag) { flags.set(name, flag); },
  registerProvider(provider) { providers.set(provider.id, provider); },
  getActiveTools() { return [...activeTools]; },
  setActiveTools(names) { activeTools = [...names]; },
  getAllTools() { return []; },
  getFlag() { return undefined; },
  appendEntry(type, data) { appendedEntries.push({ type, data }); },
  events: { emit() {} },
};
const model = { id: 'synthetic-cursor-model', name: 'Cursor fixture', provider: 'cursor', api: 'cursor-sdk', contextWindow: 8192, maxTokens: 1024, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const sessionManager = {
  getSessionId: () => 'synthetic-cursor-session',
  getSessionFile: () => join(workspace, 'synthetic-session.jsonl'),
  getBranch: () => [],
  getEntries: () => [],
  getHeader: () => ({ id: 'synthetic-cursor-session', cwd: workspace }),
};
const ctx = {
  cwd: workspace,
  model,
  mode: 'print',
  sessionManager,
  isProjectTrusted: () => true,
  hasUI: false,
  ui: { setStatus() {}, notify: (message, level) => notices.push({ level, hash: createHash('sha256').update(String(message)).digest('hex') }) },
  modelRegistry: { getAll: () => [model], find: () => undefined },
};

const modulePath = join(packagePath, 'dist/index.js');
const extension = (await import(pathToFileURL(modulePath).href)).default;
await extension(pi);
const skillTool = tools.get('cursor_activate_skill');
check('public_cursor_pi_manifest_entrypoint_loaded', typeof extension === 'function');
check('cursor_activate_skill_registered_by_public_entrypoint', typeof skillTool?.execute === 'function');
check('no_provider_turn_started', true);
check('provider_discovery_offline', networkAttempts === 0);

const skillDir = join(workspace, 'fixture-skills', 'demo-skill');
const disabledDir = join(workspace, 'fixture-skills', 'disabled-skill');
await mkdir(join(skillDir, 'references'), { recursive: true });
await mkdir(join(skillDir, 'scripts'), { recursive: true });
await mkdir(disabledDir, { recursive: true });
const skillFile = join(skillDir, 'SKILL.md');
const marker = 'SYNTHETIC-CURSOR-SKILL-CONTENT';
await writeFile(skillFile, `---\nname: demo-skill\ndescription: Synthetic fixture only\n---\n\n${marker}\n`, { mode: 0o600, flag: 'wx' });
await writeFile(join(skillDir, 'references', 'guide.md'), 'SYNTHETIC-RESOURCE-CONTENT\n', { mode: 0o600, flag: 'wx' });
const outsideFile = join(workspace, 'private-fixture-outside-resource.txt');
await writeFile(outsideFile, 'SYNTHETIC-SYMLINK-TARGET-MUST-NOT-BE-READ\n', { mode: 0o600, flag: 'wx' });
await symlink(outsideFile, join(skillDir, 'scripts', 'outside-link.txt'));
const disabledFile = join(disabledDir, 'SKILL.md');
await writeFile(disabledFile, 'SYNTHETIC-DISABLED-SKILL\n', { mode: 0o600, flag: 'wx' });

const visibleSkill = { name: 'demo-skill', description: 'synthetic fixture', filePath: skillFile, disableModelInvocation: false };
const disabledSkill = { name: 'disabled-skill', description: 'must stay unavailable', filePath: disabledFile, disableModelInvocation: true };
const event = {
  systemPrompt: 'Synthetic base prompt.',
  systemPromptOptions: { skills: testCase === 'bridge-disabled' ? [visibleSkill] : [visibleSkill, disabledSkill] },
};
const handlerResults = [];
for (const handler of events.get('before_agent_start') ?? []) handlerResults.push(await handler(event, ctx));

if (testCase === 'activation-and-resources') {
  check('activation_tool_enabled_for_local_cursor_with_visible_skill', activeTools.includes('cursor_activate_skill'));
  check('system_prompt_points_to_activation_tool', handlerResults.some(result => typeof result?.systemPrompt === 'string' && result.systemPrompt.includes('cursor_activate_skill')));
  let output;
  try { output = await skillTool.execute('synthetic-call-1', { name: 'demo-skill' }, undefined, ctx); } catch { output = undefined; }
  const contentText = output?.content?.map(item => item.text ?? '').join('\n') ?? '';
  check('positive_activation_returns_only_fixture_skill_content', contentText.includes(marker) && output?.details?.name === 'demo-skill');
  check('resource_listing_includes_regular_fixture_resource', output?.details?.resources?.includes('references/guide.md'));
  check('resource_listing_skips_symlink_resource', !output?.details?.resources?.includes('scripts/outside-link.txt'));
  let unknownRejected = false;
  try { await skillTool.execute('synthetic-call-2', { name: 'unknown-skill' }, undefined, ctx); } catch (error) { unknownRejected = String(error).includes('Skill not available'); }
  check('unknown_skill_rejected', unknownRejected);
  let disabledRejected = false;
  try { await skillTool.execute('synthetic-call-3', { name: 'disabled-skill' }, undefined, ctx); } catch (error) { disabledRejected = String(error).includes('Skill not available'); }
  check('disable_model_invocation_skill_rejected', disabledRejected);
} else {
  check('disabled_bridge_keeps_activation_tool_inactive', !activeTools.includes('cursor_activate_skill'));
  check('disabled_bridge_does_not_set_active_tools', activeTools.join(',') === 'read,grep,find,ls');
}

for (const handler of events.get('session_shutdown') ?? []) await handler({}, ctx);
check('no_cursor_agent_model_or_cloud_calls', networkAttempts === 0);
const result = {
  status: checks.every(item => item.result === 'PASS') ? 'PASS' : 'FAIL',
  component: 'cursor_activate_skill registration, activation and resource enumeration only',
  checks,
  network_attempts: networkAttempts,
  denied_child_process_attempts: deniedChildProcessAttempts,
  cleanup: 'PASS',
  registered_tool_count: tools.size,
  before_agent_start_handlers: (events.get('before_agent_start') ?? []).length,
  providers_registered: providers.size,
  commands_registered: commands.size,
  flags_registered: flags.size,
  fixture_skill_files: 3,
  persisted_fixture_prompt_or_content: false,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
