import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import assert from 'node:assert/strict';
import { ModelRuntime, createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime } from '@earendil-works/pi-coding-agent';
const root=process.cwd(),home=process.env.HOME;
const {SdkPiSessionAdapter,PROFILE_TOOLS}=await import(pathToFileURL(join(root,'.profile-eval/src/sdk-pi-adapter.js')).href);
const {parseExtensionSpec}=await import(pathToFileURL(join(root,'.profile-eval/src/extension-spec.js')).href);
const {resolvePiExtension}=await import(pathToFileURL(join(root,'.profile-eval/src/pi-extensions.js')).href);
const {installStdoutGuard}=await import(pathToFileURL(join(root,'.profile-eval/src/stdout-guard.js')).href);
const suppressed=[];const guard=installStdoutGuard({report:line=>suppressed.push(JSON.parse(line))});
process.stderr.write=()=>true;
let networkAttempts=0,childAttempts=0;
const denyNetwork=()=>{networkAttempts++;throw new Error('offline_network_denied');};
const denyChild=()=>{childAttempts++;throw new Error('offline_child_denied');};
globalThis.fetch=denyNetwork;
net.Socket.prototype.connect=denyNetwork;net.connect=denyNetwork;net.createConnection=denyNetwork;
tls.connect=denyNetwork;http.request=denyNetwork;http.get=denyNetwork;https.request=denyNetwork;https.get=denyNetwork;
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[key]=denyChild;
syncBuiltinESMExports();
const rows=[],diagnostics=[];
let activeHandle;
try{
 const fixtureAgent=join(home,'fixture-agent');
 await mkdir(join(fixtureAgent,'npm/node_modules'),{recursive:true});
 await cp(join(root,'test/fixtures/pi-extension-fixture'),join(fixtureAgent,'npm/node_modules/pi-extension-fixture'),{recursive:true,errorOnExist:true});
 for(const permissionProfile of ['read-only','coding']){
  globalThis.__piExtensionFixtureEvents??=[];globalThis.__piExtensionFixtureEvents.length=0;
  const cwd=join(home,'workspace-'+permissionProfile);await mkdir(cwd);await writeFile(join(cwd,'README.md'),'Synthetic offline OpenWiki registration test.\n');
  let session;
  const adapter=new SdkPiSessionAdapter({
   modelRuntimeFactory:()=>ModelRuntime.create({refreshOnCreate:false,allowModelNetwork:false,modelsPath:null,authPath:join(home,'absent-auth.json'),modelsStorePath:join(home,'absent-models.json')}),
   resolveExtension:spec=>resolvePiExtension(spec,{agentDir:spec.name==='pi-extension-fixture'?fixtureAgent:process.env.PI_AUDIT_AGENT_DIR}),
   extensionSdk:{createServices:createAgentSessionServices,createSessionFromServices:async options=>{const result=await createAgentSessionFromServices(options);session=result.session;return result;},createRuntime:createAgentSessionRuntime},
   diagnosticSink:d=>diagnostics.push({stage:d.stage,code:d.code,extension:d.extension??null}),
  });
  activeHandle=await adapter.create({cwd,executionProfile:{alias:'offline-openwiki',permissionProfile,provider:'fixture-ext',model:'fixture-ext-model',thinkingLevel:'off',extensions:[parseExtensionSpec('npm:pi-extension-fixture@1.0.0'),parseExtensionSpec('npm:openwiki@0.7.2')],skills:[]}});
  const expected=['openwiki_begin','openwiki_submit_plan','openwiki_next_page','openwiki_inspect_page_claims','openwiki_submit_page','openwiki_finish'].sort();
  const loaded=session.resourceLoader.getExtensions();
  assert.equal(loaded.errors.length,0);assert.equal(loaded.extensions.length,2);
  const registered=loaded.extensions.flatMap(e=>[...e.tools.keys()]).filter(n=>n.startsWith('openwiki_')).sort();assert.deepEqual(registered,expected);
  assert.deepEqual(session.resourceLoader.getSkills().skills,[]);
  assert.deepEqual(session.resourceLoader.getPrompts().prompts,[]);
  const before=session.getActiveToolNames().sort();
  const allowed=[...PROFILE_TOOLS[permissionProfile],...(permissionProfile==='coding'?['fixture_tool',...expected]:[])].sort();assert.deepEqual(before,allowed);
  let accepted=false;const turn=await activeHandle.prompt('Offline fixture provider registration probe only; do not execute extension tools.',a=>{accepted=a;});
  assert.equal(accepted,true);assert.equal(turn.status,'completed');assert.equal(turn.assistantText,'FIXTURE-PONG');
  assert.deepEqual(session.getActiveToolNames().sort(),allowed);
  const events=globalThis.__piExtensionFixtureEvents;
  assert.ok(events.includes('session_start'));assert.ok(events.includes('stream'));assert.ok(!events.includes('tool'));
  await activeHandle.dispose();activeHandle=undefined;assert.ok(events.includes('session_shutdown'));
  rows.push({permission_profile:permissionProfile,status:'PASS',sdk_model:'fixture-ext/fixture-ext-model',candidate:'openwiki@0.7.2',support_fixture:'pi-extension-fixture@1.0.0',registered_tools:registered,active_tools:before,skills_selected:0,prompts_loaded:0,local_scripted_turn:'completed',candidate_tools_invoked:0,shutdown:'PASS'});
 }
 assert.equal(networkAttempts,0);assert.equal(childAttempts,0);
 guard.flush();
 guard.transportStdout.write(JSON.stringify({kind:'offline-headless-adapter-component-test',status:'PASS',node:process.versions.node,rows,network_attempts:networkAttempts,child_process_attempts:childAttempts,external_provider_calls:0,paid_candidate_runs:0,diagnostics,foreign_stdout_suppressed:suppressed.reduce((n,x)=>n+x.writes,0),limitation:'Registration, tool selection and shutdown only. No OpenWiki lifecycle tool, MCP child, writer mutation, retrieval or quality ablation was executed.'})+'\n');
}catch(e){if(activeHandle)await activeHandle.dispose().catch(()=>undefined);guard.flush();guard.transportStdout.write(JSON.stringify({kind:'offline-headless-adapter-component-test',status:'FAIL',rows,code:e?.code??e?.name??'probe_failed',diagnostics,network_attempts:networkAttempts,child_process_attempts:childAttempts,external_provider_calls:0,paid_candidate_runs:0})+'\n');process.exitCode=1;}
