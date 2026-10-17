import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp,mkdir,readFile,readdir,writeFile,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import http from 'node:http';
const repo=process.cwd(),scope=process.env.EXT_FUNCTION_SCOPE,mode=process.argv[2];
const workspace=join(scope,'workspace'),agent=join(scope,'agent'),installed=process.env.EXT_FUNCTION_INSTALLED_AGENT;
const packageName=mode==='web'?'pi-web-access':mode==='openwiki'?'openwiki':'pi-cursor-sdk';
const root=join(installed,'npm/node_modules',packageName);
const metadata=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
assert.equal(metadata.version,mode==='web'?'0.41.0':'0.7.2');
const packageFiles=[];for(const path of ['package.json',...(mode==='web'?['dist/mcp-cli.js']:['dist/integrations/pi/openwiki.js','dist/cli/cli.js'])])packageFiles.push({path,sha256:createHash('sha256').update(await readFile(join(root,path))).digest('hex')});
const cases=[],diagnostics=[];
let activeCase='setup',handle,client,transport,webServer,session,guard;
const record=(id,details={})=>cases.push({id,status:'PASS',...details});
let receipt={kind:'actual-extension-functional-probe',package:packageName+'@'+metadata.version,package_files:packageFiles,node:process.versions.node,cases,model_prompts_submitted:0,provider_calls:0};
try{
 await mkdir(workspace,{recursive:true});await mkdir(agent);
 for(const d of ['config','cache','data'])await mkdir(join(scope,d));
 process.env.HOME=scope;process.env.PI_CODING_AGENT_DIR=agent;
 process.env.XDG_CONFIG_HOME=join(scope,'config');process.env.XDG_CACHE_HOME=join(scope,'cache');process.env.XDG_DATA_HOME=join(scope,'data');
 process.env.DO_NOT_TRACK='1';process.env.OPENWIKI_TELEMETRY_DISABLED='1';
 const source='export function fixtureCatalog() { return "FIXTURE_CATALOG_CANARY_71"; }\n';
 await mkdir(join(workspace,'src'));await writeFile(join(workspace,'src/catalog.js'),source);
 await writeFile(join(workspace,'README.md'),'Synthetic fixture catalog. No external systems.\n');
 const git=promisify(execFile),gitEnv={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:'/dev/null'};
 for(const args of [['init','-q'],['add','README.md','src/catalog.js'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','synthetic-fixture']])await git('/usr/bin/git',args,{cwd:workspace,env:gitEnv,timeout:3000});
 process.chdir(workspace);
 process.env.EXT_FUNCTION_CHILD_ENTRY=mode==='web'?join(root,'dist/mcp-cli.js'):join(root,'dist/cli/cli.js');
 process.env.EXT_FUNCTION_ALLOW_CHILD='1';
 if(mode==='web'){
  await mkdir(join(scope,'.pi'),{recursive:true});await writeFile(join(scope,'.pi/web-search.json'),JSON.stringify({ssrf:{allowRanges:['127.0.0.1/32']}}));
  const text='Synthetic page title\nWEB_FETCH_CANARY_429\n'+('The quick brown fixture fox.\n'.repeat(20));
  webServer=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/plain; charset=utf-8'});res.end(text);});
  await new Promise(r=>webServer.listen(0,'127.0.0.1',r));
  process.env.EXT_FUNCTION_HTTP_PORT=String(webServer.address().port);
 }
 await import('./guard.mjs');
 const {installStdoutGuard}=await import(pathToFileURL(join(repo,'.profile-eval/src/stdout-guard.js')));
 guard=installStdoutGuard({report:()=>{}});
 const {resolvePiExtension}=await import(pathToFileURL(join(repo,'.profile-eval/src/pi-extensions.js')));
 const {parseExtensionSpec}=await import(pathToFileURL(join(repo,'.profile-eval/src/extension-spec.js')));
 if(mode==='web'){
  activeCase='pi-extension-resolver-gate';
  let code;
  try{await resolvePiExtension(parseExtensionSpec('npm:pi-web-access@0.41.0'),{agentDir:installed});}catch(e){code=e.code;}
  assert.equal(code,'extension_load_failed');record(activeCase,{expected_blocker:'directory_manifest_entry',pi_profile_status:'BLOCKED'});
  const {Client}=await import('@modelcontextprotocol/client');const {StdioClientTransport}=await import('@modelcontextprotocol/client/stdio');
  client=new Client({name:'extension-function-fixture',version:'1.0.0'});
  transport=new StdioClientTransport({command:process.execPath,args:[process.env.EXT_FUNCTION_CHILD_ENTRY],stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  await client.connect(transport,{timeout:15000});
  const tools=(await client.listTools()).tools.map(t=>t.name);assert.ok(tools.includes('fetch_content')&&tools.includes('get_search_content'));record('standalone-mcp-tool-discovery',{tools});
  const call=(name,args)=>client.callTool({name,arguments:args},{timeout:15000});
  const value=r=>(r.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
  activeCase='standalone-raw-fetch-owned-http';
  const url='http://127.0.0.1:'+process.env.EXT_FUNCTION_HTTP_PORT+'/fixture.txt';
  const fetched=await call('fetch_content',{url,mode:'raw'});assert.ok(!fetched.isError);assert.ok(value(fetched).includes('WEB_FETCH_CANARY_429'));
  const match=value(fetched).match(/(?:responseId|Response ID|ResponseId)["\s:]+([a-zA-Z0-9_-]+)/i);assert.ok(match,'response_id_not_found');record(activeCase,{canary_preserved:true});
  activeCase='standalone-stored-content-search';
  const stored=await call('get_search_content',{responseId:match[1],urlIndex:0,findText:'WEB_FETCH_CANARY_429'});assert.ok(!stored.isError);assert.ok(value(stored).includes('WEB_FETCH_CANARY_429'));record(activeCase,{original_content_retrieved:true});
  activeCase='standalone-invalid-fetch-rejected';const invalid=await call('fetch_content',{mode:'raw'});assert.equal(invalid.isError,true);record(activeCase);
  activeCase='standalone-model-answer-mode-rejected';const answer=await call('fetch_content',{url,mode:'answer'});assert.equal(answer.isError,true);record(activeCase);
  receipt.integration='Standalone MCP functional path; production Pi extension loading remains BLOCKED.';
 }else if(mode==='openwiki'){
  await cp(join(repo,'test/fixtures/pi-extension-fixture'),join(agent,'npm/node_modules/pi-extension-fixture'),{recursive:true,errorOnExist:true});
  const {SdkPiSessionAdapter}=await import(pathToFileURL(join(repo,'.profile-eval/src/sdk-pi-adapter.js')));
  const {ModelRuntime,createAgentSessionServices,createAgentSessionFromServices,createAgentSessionRuntime}=await import('@earendil-works/pi-coding-agent');
  const adapter=new SdkPiSessionAdapter({modelRuntimeFactory:()=>ModelRuntime.create({refreshOnCreate:false,allowModelNetwork:false,modelsPath:null,authPath:join(scope,'absent-auth.json'),modelsStorePath:join(scope,'absent-models.json')}),resolveExtension:s=>resolvePiExtension(s,{agentDir:s.name==='pi-extension-fixture'?agent:installed}),extensionSdk:{createServices:createAgentSessionServices,createSessionFromServices:createAgentSessionFromServices,createRuntime:async(factory,options)=>{const runtime=await createAgentSessionRuntime(factory,options);session=runtime.session;return runtime;}},diagnosticSink:x=>diagnostics.push({code:x.code,stage:x.stage})});
  activeCase='pi-sdk-openwiki-bind';
  handle=await adapter.create({cwd:workspace,executionProfile:{alias:'function-openwiki',permissionProfile:'coding',provider:'fixture-ext',model:'fixture-ext-model',thinkingLevel:'off',extensions:[parseExtensionSpec('npm:pi-extension-fixture@1.0.0'),parseExtensionSpec('npm:openwiki@0.7.2')],skills:[]}});record(activeCase);
  async function call(name,args){const tool=session.getToolDefinition(name);assert.ok(tool);const id='synthetic-'+name;const result=await tool.execute(id,args,AbortSignal.timeout(15000),undefined,session.extensionRunner.createToolContext(id,undefined));const text=result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');try{return JSON.parse(text);}catch{return result.details;}}
  activeCase='relative-root-rejected';await assert.rejects(()=>call('openwiki_begin',{root:'relative',mode:'init',language:'en'}));record(activeCase);
  activeCase='begin-owned-repository';const begin=await call('openwiki_begin',{root:workspace,mode:'init',language:'en'});assert.equal(begin.status,'active');assert.equal(begin.phase,'planning');assert.ok(begin.runId);record(activeCase);
  const plan={runId:begin.runId,pages:[{path:'openwiki/quickstart.md',title:'Quickstart',purpose:'Explain the synthetic catalog behavior',seedPaths:['src/catalog.js']}]};
  activeCase='accept-and-repeat-canonical-plan';const planned=await call('openwiki_submit_plan',plan);assert.equal(planned.status,'accepted');assert.equal(planned.totalPages,1);assert.equal((await call('openwiki_submit_plan',plan)).status,'accepted');record(activeCase);
  activeCase='different-plan-rejected';await assert.rejects(()=>call('openwiki_submit_plan',{...plan,pages:[{...plan.pages[0],title:'Changed'}]}));record(activeCase);
  activeCase='next-page-queued';const next=await call('openwiki_next_page',{runId:begin.runId});assert.equal(next.status,'pending');assert.equal(next.job.path,'/openwiki/quickstart.md');record(activeCase);
  activeCase='inspect-pending-claims';const inspected=await call('openwiki_inspect_page_claims',{runId:begin.runId,jobId:next.job.id});assert.equal(inspected.page,'/openwiki/quickstart.md');assert.deepEqual(inspected.claims,[]);record(activeCase);
  activeCase='premature-finish-rejected';await assert.rejects(()=>call('openwiki_finish',{runId:begin.runId}));record(activeCase);
  activeCase='missing-page-submission-rejected';await assert.rejects(()=>call('openwiki_submit_page',{runId:begin.runId,jobId:next.job.id,claims:[]}));record(activeCase);
  activeCase='submit-grounded-written-page';await mkdir(join(workspace,'openwiki'),{recursive:true});await writeFile(join(workspace,'openwiki/quickstart.md'),'# Quickstart\n\nThe catalog returns FIXTURE_CATALOG_CANARY_71.\n');
  const submitted=await call('openwiki_submit_page',{runId:begin.runId,jobId:next.job.id,claims:[{statement:'The catalog returns FIXTURE_CATALOG_CANARY_71.',evidence:[{resource:'repo://src/catalog.js#L1'}]}]});assert.equal(submitted.status,'complete');record(activeCase);
  activeCase='queue-completion';assert.equal((await call('openwiki_next_page',{runId:begin.runId})).status,'complete');record(activeCase);
  activeCase='finish-written-wiki';const finished=await call('openwiki_finish',{runId:begin.runId});assert.equal(finished.status,'complete');assert.notEqual(finished.sourceChanged,true);assert.ok((await readFile(join(workspace,'openwiki/quickstart.md'),'utf8')).includes('FIXTURE_CATALOG_CANARY_71'));record(activeCase);
  activeCase='finished-run-rejected';await assert.rejects(()=>call('openwiki_next_page',{runId:begin.runId}));record(activeCase);
  assert.equal(await readFile(join(workspace,'src/catalog.js'),'utf8'),source);record('original-source-preserved');
  receipt.integration='Actual registered Pi tool definitions -> real OpenWiki stdio MCP child -> synthetic repository writer lifecycle.';
 }else throw Error('cursor_probe_not_configured');
 receipt.status='PASS';
}catch(e){receipt.status='FAIL';receipt.failure={case:activeCase,code:typeof e.code==='string'?e.code:e.name??'probe_failed',message:String(e.message).replaceAll(scope,'<owned-scope>').replaceAll(repo,'<eval-repo>').replaceAll(installed,'<installed-agent>').replace(/\/home\/[^\s\"')]+/g,'<host-path>').slice(0,1200)};}
finally{
 try{if(client)await client.close();if(transport)await transport.close();if(handle)await handle.dispose();if(webServer)await new Promise(r=>webServer.close(r));receipt.cleanup='PASS';}catch{receipt.cleanup='FAIL';receipt.status='FAIL';}
 const counters=[];for(const f of await readdir(scope))if(/^guard-\d+\.json$/.test(f))counters.push(JSON.parse(await readFile(join(scope,f),'utf8')));
 receipt.guards=counters.reduce((a,b)=>Object.fromEntries(Object.keys(b).map(k=>[k,(a[k]??0)+b[k]])),{});
 receipt.diagnostics=diagnostics;receipt.limits=['No model prompt or paid provider request.','JavaScript network/child guards are instrumentation, not OS containment.','Only named synthetic function cases are qualified; model quality and production use remain unproven.'];
 if(guard)guard.transportStdout.write(JSON.stringify(receipt)+'\n');else process.stdout.write(JSON.stringify(receipt)+'\n');
 if(receipt.status==='FAIL')process.exitCode=1;
}
