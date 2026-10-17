import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const mode=process.argv[2];
if(!['web','openwiki'].includes(mode))throw Error('mode_required');
const repo=process.cwd(),here=dirname(fileURLToPath(import.meta.url));
const {sourceBinding}=await import(new URL('../../../..'+'/.profile-eval/eval/profiles/files.js',import.meta.url));
const source=await sourceBinding(repo),startedAt=new Date().toISOString();
if(source.digest!=='sha256:a4524626851448908b8d21ecbd7248c9956ce830406e81c45fda46c8eb6fffc5')throw Error('source_binding_changed');
const harness=[];for(const name of ['run.mjs','worker.mjs','guard.mjs'])harness.push({path:name,sha256:createHash('sha256').update(await readFile(join(here,name))).digest('hex')});
const id='extension-functions-bridges-'+randomUUID(),out=join(repo,'eval/results',id);
await mkdir(out,{mode:0o700});await writeFile(join(out,'.owner'),id,{flag:'wx',mode:0o600});
const scope=await mkdtemp('/tmp/pi-functions-');await writeFile(join(scope,'.owner'),id,{mode:0o600});
const child=spawn(process.execPath,[join(here,'worker.mjs'),mode],{cwd:repo,detached:true,stdio:['ignore','pipe','pipe'],env:{HOME:scope,PATH:dirname(process.execPath)+':/usr/bin:/bin',EXT_FUNCTION_SCOPE:scope,EXT_FUNCTION_OWNER:id,EXT_FUNCTION_INSTALLED_AGENT:join(homedir(),'.pi/agent'),EXT_FUNCTION_KIND:mode,DO_NOT_TRACK:'1',OPENWIKI_TELEMETRY_DISABLED:'1'}});
let stdout='',stderrDebug='',stderrBytes=0,overflow=false,timedOut=false,escalation;
const signal=s=>{try{process.kill(-child.pid,s);}catch(e){if(e.code!=='ESRCH')throw e;}};
const timer=setTimeout(()=>{timedOut=true;signal('SIGTERM');escalation=setTimeout(()=>signal('SIGKILL'),1000);},60000);
child.stdout.on('data',b=>{if(Buffer.byteLength(stdout)+b.length>65536){overflow=true;signal('SIGKILL');}else if(!overflow)stdout+=b;});
child.stderr.on('data',b=>{stderrBytes+=b.length;if(stderrDebug.length<4096)stderrDebug+=b.toString();});
const terminal=await new Promise(r=>{child.once('error',()=>r({code:null,signal:null,spawn_error:true}));child.once('close',(code,signal)=>r({code,signal}));});
clearTimeout(timer);if(escalation)clearTimeout(escalation);
async function groupEmpty(){for(const pid of await readdir('/proc')){if(!/^\d+$/.test(pid))continue;try{const stat=await readFile('/proc/'+pid+'/stat','utf8'),f=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);if(Number(f[2])===child.pid&&!['Z','X'].includes(f[0]))return false;}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')return false;}}return true;}
let gone=await groupEmpty();if(!gone){signal('SIGTERM');await new Promise(r=>setTimeout(r,100));signal('SIGKILL');await new Promise(r=>setTimeout(r,100));gone=await groupEmpty();}
let receipt;try{receipt=JSON.parse(stdout.trim());}catch{receipt={status:'FAIL',code:'missing_sanitized_receipt'};}
let removed=false;if(gone&&await readFile(join(scope,'.owner'),'utf8')===id){await rm(scope,{recursive:true});removed=true;}
const supervisor={worker_exit_code:terminal.code,worker_signal:terminal.signal,timed_out:timedOut,output_overflow:overflow,stderr_bytes_discarded:stderrBytes,process_group_empty:gone,owned_scope_removed:removed};
if(terminal.code!==0||timedOut||overflow||!gone||!removed)receipt.status='FAIL';
if(receipt.status==='FAIL')receipt.sanitized_stderr=stderrDebug.replaceAll(scope,'<owned-scope>').replaceAll(repo,'<eval-repo>').replace(/\/home\/[^\s\"')]+/g,'<host-path>').replace(/file:\/\/[^\s)]+/g,'<module>').slice(0,4096);
receipt.source_binding=source;receipt.started_at=startedAt;receipt.ended_at=new Date().toISOString();receipt.harness=harness;
receipt.supervisor=supervisor;receipt.scope_id=id;
await writeFile(join(out,'result.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify({mode,status:receipt.status,scope_id:id,cases:receipt.cases,supervisor})+'\n');
if(receipt.status==='FAIL')process.exitCode=1;
