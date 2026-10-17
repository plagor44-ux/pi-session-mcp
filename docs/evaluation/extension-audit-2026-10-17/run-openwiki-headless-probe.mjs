// Run from the repository root after: ./node_modules/.bin/tsc -p tsconfig.eval.json
// Provider-free component check only. Never invokes an OpenWiki tool.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
const root=process.cwd();
const {ownedTemporary,sourceBinding,hash}=await import(pathToFileURL(join(root,'.profile-eval/eval/profiles/files.js')).href);
const source=await sourceBinding(root),scope=await ownedTemporary();
const output=join(root,'eval/results','openwiki-headless-'+randomUUID());
await mkdir(output,{mode:0o700});
const script=join(dirname(fileURLToPath(import.meta.url)),'openwiki-headless-probe.mjs');
const started=Date.now();
const child=spawn(process.execPath,[script],{cwd:root,env:{PATH:process.env.PATH,HOME:scope.root,XDG_CONFIG_HOME:join(scope.root,'config'),XDG_CACHE_HOME:join(scope.root,'cache'),XDG_DATA_HOME:join(scope.root,'data'),PI_CODING_AGENT_DIR:join(scope.root,'agent'),PI_AUDIT_AGENT_DIR:getAgentDir(),OPENWIKI_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1',NODE_OPTIONS:'--unhandled-rejections=strict'},stdio:['ignore','pipe','pipe']});
let outputText='',stderrBytes=0,killer;
child.stdout.on('data',b=>{outputText+=b;if(outputText.length>65536)child.kill('SIGKILL');});
child.stderr.on('data',b=>{stderrBytes+=b.length;});
const timer=setTimeout(()=>{child.kill('SIGTERM');killer=setTimeout(()=>child.kill('SIGKILL'),1000);},45000);
const terminal=await new Promise(resolve=>{child.once('error',()=>resolve({code:null,signal:null,spawn_error:true}));child.once('exit',(code,signal)=>resolve({code,signal,spawn_error:false}));});
clearTimeout(timer);if(killer)clearTimeout(killer);
let receipt;try{receipt=JSON.parse(outputText);}catch{receipt={status:'INCONCLUSIVE',reason:'missing_sanitized_receipt'};}
const after=await sourceBinding(root);
const result={...receipt,source_binding:source,source_unchanged:source.commit===after.commit&&source.digest===after.digest,scope_id:scope.scope_id,process_exit:terminal,duration_ms:Date.now()-started,stderr_bytes_discarded:stderrBytes,child_exit_observed:!terminal.spawn_error,additional_paid_candidate_runs:0};
if(result.status==='PASS'&&terminal.code===0&&result.source_unchanged)await scope.remove();
else{result.status='INCONCLUSIVE';process.exitCode=1;}
await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({artifact_scope:output.slice(root.length+1),status:result.status,rows:result.rows?.length??0,network_attempts:result.network_attempts??null,child_process_attempts:result.child_process_attempts??null,external_provider_calls:result.external_provider_calls??null,source_unchanged:result.source_unchanged,result_hash:hash(JSON.stringify(result,null,2)+'\n')}));
