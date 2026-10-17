import { readFile, writeFile, rename, symlink, unlink, readlink, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const scope='node24-extension-followup-04470d85-3a99-47e3-b356-ce96e77de0dd';
const base=join(homedir(),'.local/state/pi-node24-switch',scope);
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
try{
 const args=process.argv.slice(2);if(args.length>1||args.some(a=>!['--check','--apply'].includes(a)))throw new Error('invalid_arguments');
 const metadata=JSON.parse(await readFile(join(base,'restore-metadata.json'),'utf8'));
 if((await readFile(join(base,'.owner'),'utf8'))!==scope||metadata.scope!==scope)throw new Error('ownership_mismatch');
 if(metadata.pi.entry!=='.pi/agent/bin/pi'||metadata.mcp.entry!=='.npm-global/bin/pi-session-mcp'||metadata.selector!=='.local/share/pi-node/current'||metadata.runtime_target!=='.local/opt/node-v24.22.0'||metadata.mcp.original_target!=='../lib/node_modules/pi-session-mcp/dist/main.js')throw new Error('metadata_target_mismatch');
 const pi=join(homedir(),metadata.pi.entry),mcp=join(homedir(),metadata.mcp.entry),selector=join(homedir(),metadata.selector);
 const original=await readFile(join(base,'pi-launcher.original'));if(hash(original)!==metadata.pi.original_hash)throw new Error('original_backup_changed');
 const stat=await lstat(mcp),currentPi=await readFile(pi);
 if(hash(currentPi)===metadata.pi.original_hash&&stat.isSymbolicLink()&&await readlink(mcp)===metadata.mcp.original_target){console.log(JSON.stringify({status:'ALREADY_RESTORED',scope}));process.exit(0);}
 if(hash(currentPi)!==metadata.pi.new_hash||stat.isSymbolicLink()||hash(await readFile(mcp))!==metadata.mcp.new_hash)throw new Error('launcher_changed_since_switch');
 if(resolve(await readlink(selector))!==join(homedir(),metadata.runtime_target))throw new Error('selector_changed_since_switch');
 if(args[0]!=='--apply'){console.log(JSON.stringify({status:'CHECK_PASS',scope,restorable:true,mutations:0}));process.exit(0);}
 const piStage=pi+'.node24-restore',mcpStage=mcp+'.node24-restore';
 await writeFile(piStage,original,{flag:'wx',mode:metadata.pi.original_mode});
 await symlink(metadata.mcp.original_target,mcpStage);
 await rename(piStage,pi);await rename(mcpStage,mcp);await unlink(selector);
 const result={status:'RESTORED',scope,restored_at:new Date().toISOString(),node_install_retained:true,system_node_changed:false};
 await writeFile(join(base,'restoration-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
}catch(e){process.stderr.write(JSON.stringify({status:'REFUSED',code:e.message??'restore_failed'})+'\n');process.exitCode=1;}
