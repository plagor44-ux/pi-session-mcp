// Compile into an owned disposable build: even --plan leaves repository files unchanged.
import {mkdtemp,symlink,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';

const root=process.cwd(),temporary=await mkdtemp(join(tmpdir(),'pi-profile-build-')),token=randomUUID();
await writeFile(join(temporary,'.owner'),token,{mode:0o600});
let child,stopped=false;
const controller=new AbortController();
const stop=signal=>{stopped=true;controller.abort();child?.kill(signal);};
const interrupt=()=>stop('SIGINT'),terminate=()=>stop('SIGTERM');
process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
try{
  const build=join(temporary,'build');
  await promisify(execFile)(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p',join(root,'tsconfig.eval.json'),'--outDir',build],{cwd:root,timeout:120000,maxBuffer:1024*1024,signal:controller.signal});
  if(stopped)throw new Error("aborted");
  await symlink(join(root,'node_modules'),join(build,'node_modules'),'dir');
  child=spawn(process.execPath,[join(build,'eval/profiles/cli.js'),...process.argv.slice(2)],{cwd:root,env:{...process.env,PI_PROFILE_EVAL_BUILD:build},stdio:'inherit'});
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  process.exitCode=exit.code??(exit.signal==='SIGINT'?130:143);
}catch{
  process.stderr.write(JSON.stringify({event:'profile_evaluation_stopped',code:'build_or_launch_failed'})+'\n');process.exitCode=1;
}finally{
  process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
  if(await readFile(join(temporary,'.owner'),'utf8')===token)await rm(temporary,{recursive:true});
}
