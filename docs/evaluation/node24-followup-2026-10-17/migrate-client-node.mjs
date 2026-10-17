// Operator-authorized interpreter-only migration, not a general setup replacement.
import { readFile, rename, lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
const home=homedir(), scope='node24-extension-followup-04470d85-3a99-47e3-b356-ce96e77de0dd';
const state=join(home,'.local/state/pi-node24-switch',scope);
const root=join(home,'.npm-global/lib/node_modules/pi-session-mcp');
const {immutableReleaseBinding,registrationFingerprint}=await import(join(root,'dist/setup.js'));
const {DurableOwnershipStore}=await import(join(root,'dist/setup-ownership.js'));
class MigrationError extends Error {}
const hash=b=>createHash('sha256').update(b).digest('hex');
const oldNode='/usr/bin/node', newNode=join(home,'.local/opt/node-v24.22.0/bin/node');
const entry=join(root,'dist/main.js');
const targets=[{client:'codex',scope:'user',alias:'pi-session-mcp'},{client:'claude-code',scope:'user',alias:'pi-session-mcp'}];
const paths=[join(home,'.codex/config.toml'),join(home,'.claude.json')];
// Preserve all bytes except the one command string. Refuse ambiguous syntax.
function registration(text,index,from,to){
 let start,end,obj,command;
 if(index===0){
  const headers=[...text.matchAll(/^\[mcp_servers\.pi-session-mcp\]\r?$/gm)];
  if(headers.length!==1)throw new MigrationError('codex_header_ambiguous');
  start=headers[0].index+headers[0][0].length;
  const next=/^\[/m.exec(text.slice(start));end=next?start+next.index:text.length;
  const block=text.slice(start,end);
  const commands=[...block.matchAll(/^command\s*=\s*("[^"\r\n]*")\s*\r?$/gm)];
  if(commands.length!==1)throw new MigrationError('codex_command_ambiguous');
  command=commands[0];
  const args=/^args\s*=\s*(\[[^\r\n]*\])\s*\r?$/m.exec(block);
  if(!args||JSON.stringify(JSON.parse(args[1]))!==JSON.stringify([entry]))throw new MigrationError('codex_args_mismatch');
  obj={command:JSON.parse(command[1])};
 }else{
  const parsed=JSON.parse(text);obj=parsed.mcpServers?.['pi-session-mcp'];
  if(!obj||JSON.stringify(obj.args)!==JSON.stringify([entry]))throw new MigrationError('claude_args_mismatch');
  const keys=[...text.matchAll(/"pi-session-mcp"\s*:\s*\{/g)];
  if(keys.length!==1)throw new MigrationError('claude_key_ambiguous');
  start=keys[0].index+keys[0][0].lastIndexOf('{');
  let depth=0,inString=false,escape=false;
  for(end=start;end<text.length;end++){
   const c=text[end];if(inString){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')inString=false;}
   else if(c==='"')inString=true;else if(c==='{')depth++;else if(c==='}'&&!--depth){end++;break;}
  }
  const block=text.slice(start,end);
  if(JSON.stringify(JSON.parse(block))!==JSON.stringify(obj))throw new MigrationError('claude_scope_mismatch');
  const commands=[...block.matchAll(/"command"\s*:\s*("(?:\\.|[^"\\])*")/g)];
  if(commands.length!==1)throw new MigrationError('claude_command_ambiguous');command=commands[0];
 }
 if(obj.command!==from)throw new MigrationError('interpreter_diverged');
 const block=text.slice(start,end), offset=start+command.index+command[0].indexOf(command[1]);
 return text.slice(0,offset)+JSON.stringify(to)+text.slice(offset+command[1].length);
}
async function checkedFile(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid())throw new MigrationError('config_owner_invalid');return {bytes:await readFile(path),mode:s.mode&0o777};}
async function syncDirectory(path){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
async function durableCreate(path,bytes,mode){const handle=await open(path,'wx',mode);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}await syncDirectory(dirname(path));}
async function replace(path,before,after,mode){
 if(hash(await readFile(path))!==hash(before))throw new MigrationError('config_concurrent_edit');
 const temp=path+'.'+scope;await durableCreate(temp,after,mode);
 const current=await checkedFile(path);
 if(hash(current.bytes)!==hash(before)||current.mode!==mode)throw new MigrationError('config_concurrent_edit');
 await rename(temp,path);await syncDirectory(dirname(path));
}

try{
 const operation=process.argv[2]??'--check';if(process.argv.length>3||!['--check','--apply','--restore-check','--restore'].includes(operation))throw new MigrationError('usage_invalid');
 if(await readFile(join(state,'.owner'),'utf8')!==scope)throw new MigrationError('scope_owner_invalid');
 const release=await immutableReleaseBinding(root);
 const claude=JSON.parse(await readFile(paths[1],'utf8')).mcpServers['pi-session-mcp'];
 const config=claude.env?.PI_SESSION_MCP_CONFIG;
 if(typeof config!=='string'||Object.keys(claude.env).length!==1)throw new MigrationError('config_env_mismatch');
 const fp=node=>registrationFingerprint({scope:'user',nodePath:node,entryPath:entry,configPath:config},release);
 const oldFingerprint=fp(oldNode),newFingerprint=fp(newNode);
 const store=new DurableOwnershipStore(join(home,'.local/state/pi-session-mcp/ownership.json'));
 const restoring=operation.startsWith('--restore'),applying=operation==='--apply'||operation==='--restore';
 const result=await store.transaction(async access=>{
  const files=await Promise.all(paths.map(checkedFile));
  const records=await Promise.all(targets.map(t=>access.get(t)));
  let meta;
  try{meta=JSON.parse(await readFile(join(state,'client-registration-migration.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(meta&&(meta.scope!==scope||meta.release!==release||meta.oldFingerprint!==oldFingerprint||meta.newFingerprint!==newFingerprint))throw new MigrationError('journal_binding_mismatch');
  if(restoring&&!meta)throw new MigrationError('restore_journal_missing');
  for(let i=0;i<2;i++){
   const r=records[i];
   if(!r||r.phase!=='owned'||![oldFingerprint,...(meta?[newFingerprint]:[])].includes(r.fingerprint))throw new MigrationError('owned_release_binding_mismatch');
   if(meta&&JSON.stringify({...r,fingerprint:oldFingerprint})!==JSON.stringify(meta.records[i]))throw new MigrationError('ownership_record_changed');
  }
  // Existing CLI adapters prove each complete registration, including env and scope.
  const {createProcessRunner}=await import(join(root,'dist/setup-process.js'));
  const {createCodexAdapter,createClaudeCodeAdapter}=await import(join(root,'dist/client-adapters/index.js'));
  const runner=createProcessRunner();
  const adapters=[createCodexAdapter({runner}),createClaudeCodeAdapter({runner})];
  const currentNodes=[];
  const destination=restoring?oldNode:newNode;
  const replacements=[];
  for(let i=0;i<2;i++){
   const text=files[i].bytes.toString('utf8');let current;
   for(const candidate of [oldNode,...(meta?[newNode]:[])]){
    try{registration(text,i,candidate,destination);current=candidate;break;}catch{}
   }
   if(!current)throw new MigrationError('registration_command_diverged');
   const inspected=await adapters[i].inspect('user',{scope:'user',nodePath:current,entryPath:entry,configPath:config});
   if(inspected.state!=='equivalent')throw new MigrationError('registration_not_equivalent');
   currentNodes.push(current);replacements.push(Buffer.from(registration(text,i,current,destination)));
  }
  if(meta)for(let i=0;i<2;i++)if(hash(await readFile(join(state,`client-${i}.original`)))!==meta.files[i].before)throw new MigrationError('original_backup_changed');
  if(!applying)return {status:'CHECK_PASS',operation,mutations:0,targets:2,owned_release_proved:true,recovery_journal_present:!!meta};
  const journal=async()=>{
   const stage=join(state,'client-registration-migration.next');
   await durableCreate(stage,JSON.stringify(meta,null,2)+'\n',0o600);
   await rename(stage,join(state,'client-registration-migration.json'));await syncDirectory(state);
  };
  if(!meta){
   for(let i=0;i<2;i++)await durableCreate(join(state,`client-${i}.original`),files[i].bytes,0o600);
   meta={scope,release,oldFingerprint,newFingerprint,files:files.map((f,i)=>({before:hash(f.bytes),after:hash(replacements[i]),mode:f.mode})),records,steps:[]};
   await journal(); // Durable recovery intent precedes every configuration/ownership mutation.
  }
  for(let i=0;i<2;i++){
   access.assertHealthy();
   if(currentNodes[i]!==destination)await replace(paths[i],files[i].bytes,replacements[i],files[i].mode);
   if(hash(await readFile(paths[i]))!==hash(replacements[i]))throw new MigrationError('postwrite_mismatch');
   meta.steps.push({operation,index:i,event:'config_verified'});await journal();
   const inspected=await adapters[i].inspect('user',{scope:'user',nodePath:destination,entryPath:entry,configPath:config});
   if(inspected.state!=='equivalent')throw new MigrationError('postwrite_registration_mismatch');
   await access.put({...records[i],fingerprint:restoring?oldFingerprint:newFingerprint});
   meta.steps.push({operation,index:i,event:'ownership_updated'});await journal();
  }
  return {status:restoring?'RESTORED':'APPLIED',operation,targets:2,owned_release_proved:true,only_command_tokens_changed:true,skills_changed:false,release};
 });
 console.log(JSON.stringify(result));
}catch(e){console.error(JSON.stringify({status:'REFUSED',code:e instanceof MigrationError?e.message:'migration_failed'}));process.exitCode=1;}
