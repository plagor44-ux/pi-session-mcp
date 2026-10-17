import {spawn} from 'node:child_process';
import {mkdir,readFile,readdir,writeFile,rm,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const base=dirname(fileURLToPath(import.meta.url)),repo=resolve(base,'../../../..'),node=process.execPath;
if(process.versions.node!=='24.22.0')throw Error('run_with_node_24_22_0');
const npmRoot=process.env.PI_FUNCTION_NPM_ROOT??join(repo,'eval/results/node24-extension-followup-04470d85-3a99-47e3-b356-ce96e77de0dd/extension-agent/npm/node_modules');
const owner=randomUUID(),scope=join(repo,'eval/results/extension-functions-cache-'+owner),attemptDir=join(scope,'attempts');
await mkdir(scope,{mode:0o700});await writeFile(join(scope,'.owner'),owner,{flag:'wx',mode:0o600});await mkdir(attemptDir);
const results=[],harness=[];
for(const name of ['runner.mjs','probe.mjs'])harness.push({path:name,sha256:createHash('sha256').update(await readFile(join(base,name))).digest('hex')});
async function groupEmpty(pgid){for(const pid of await readdir('/proc')){if(!/^\d+$/.test(pid))continue;try{const line=await readFile('/proc/'+pid+'/stat','utf8'),f=line.slice(line.lastIndexOf(')')+2).trim().split(/\s+/);if(Number(f[2])===pgid&&!['Z','X'].includes(f[0]))return false;}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))return false;}}return true;}
for(const name of ['payload-openai','payload-codex-bypass','warming-disabled-zero','warming-disabled-unknown','commands-headless','stats-synthetic']){
 const id=randomUUID(),home=join(scope,'home-'+id),agent=join(home,'.pi/agent'),workspace=join(home,'workspace');
 await mkdir(agent,{recursive:true});await mkdir(workspace);await writeFile(join(home,'.owner'),owner,{flag:'wx'});
 const child=spawn(node,[join(base,'probe.mjs'),name,npmRoot,agent,workspace],{cwd:workspace,env:{PATH:dirname(node)+':/usr/bin:/bin',HOME:home,PI_CODING_AGENT_DIR:agent,PI_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING:'1',PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE:'1',PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY:'0',PI_CACHE_OPTIMIZER_FOOTER_MODE:'process',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe'],detached:true});
 let stdout='',stderr='',stderrBytes=0,timedOut=false,overflow=false,escalation;
 const signal=s=>{try{process.kill(-child.pid,s);}catch(e){if(e.code!=='ESRCH')throw e;}};
 child.stdout.on('data',b=>{if(Buffer.byteLength(stdout)+b.length>65536){overflow=true;signal('SIGKILL');}else stdout+=b;});
 child.stderr.on('data',b=>{stderrBytes+=b.length;if(Buffer.byteLength(stderr)<4096)stderr+=b.toString().slice(0,4096-stderr.length);});
 const timer=setTimeout(()=>{timedOut=true;signal('SIGTERM');escalation=setTimeout(()=>signal('SIGKILL'),2000);},15000);
 const terminal=await new Promise(r=>{child.once('error',()=>r({code:null,signal:null,spawn_error:true}));child.once('close',(code,signal)=>r({code,signal}));});
 clearTimeout(timer);if(escalation)clearTimeout(escalation);
 let gone=await groupEmpty(child.pid);if(!gone){signal('SIGTERM');await new Promise(r=>setTimeout(r,100));signal('SIGKILL');await new Promise(r=>setTimeout(r,100));gone=await groupEmpty(child.pid);}
 let removed=false;if(gone&&await readFile(join(scope,'.owner'),'utf8')===owner&&await readFile(join(home,'.owner'),'utf8')===owner){await rm(home,{recursive:true});try{await stat(home);}catch(e){removed=e.code==='ENOENT';}}
 let probe;try{probe=JSON.parse(stdout.trim());}catch{probe={status:'HARNESS_ERROR'};}
 const result={schema:'pi-cache-optimizer-function-attempt.v1',attempt_id:id,package:'pi-cache-optimizer@2.9.3',case:name,node:process.versions.node,outcome:timedOut?'TIMEOUT':overflow?'RECEIPT_LIMIT':terminal.code===0?probe.status:'HARNESS_ERROR',exit_code:terminal.code,cleanup:gone&&removed?'PASS':'FAIL',process_group_empty:gone,owned_home_removed:removed,timed_out:timedOut,output_overflow:overflow,checks:probe.checks??[],network_attempts:probe.network_attempts??null,child_process_attempts:probe.child_process_attempts??null,changed_files:probe.changed_files??[],stdout_sha256:createHash('sha256').update(stdout).digest('hex'),stderr_prefix_sha256:createHash('sha256').update(stderr).digest('hex'),stderr_bytes:stderrBytes};
 if(!gone||!removed)result.outcome='FAIL';
 const receiptPath=join(attemptDir,name+'-'+id+'.json'),body=JSON.stringify(result,null,2)+'\n';await writeFile(receiptPath,body,{flag:'wx',mode:0o600});results.push({...result,receipt:relative(repo,receiptPath),receipt_sha256:createHash('sha256').update(body).digest('hex')});
}
const status=results.every(r=>r.outcome==='PASS'&&r.cleanup==='PASS')?'PASS':'FAIL';
const manifest={schema:'pi-cache-optimizer-function-evidence.v1',package:'pi-cache-optimizer@2.9.3',source:'isolated package prefix; real published index.ts entrypoint; public SDK package root',scope_id:relative(repo,scope),created_at:new Date().toISOString(),scope:'provider-free functional checks; no model/provider requests',status,harness,attempts:results};
const body=JSON.stringify(manifest,null,2)+'\n',name='cache-function-evidence-'+new Date().toISOString().replaceAll(':','-').replaceAll('.','-')+'-'+randomUUID()+'.json';await writeFile(join(base,name),body,{flag:'wx'});
console.log(JSON.stringify({status,manifest:name,manifest_sha256:createHash('sha256').update(body).digest('hex'),attempts:results.map(r=>({case:r.case,outcome:r.outcome,cleanup:r.cleanup,process_group_empty:r.process_group_empty}))}));
if(status!=='PASS')process.exitCode=1;
