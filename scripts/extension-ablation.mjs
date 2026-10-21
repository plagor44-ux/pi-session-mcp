// Compile into an owned disposable build: even --plan leaves repository files unchanged.
// Mirrors profile-evaluation.mjs; the extension ablation additionally needs the skills directory in the build.
import {mkdtemp,symlink,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';

const root=process.cwd(),temporary=await mkdtemp(join(tmpdir(),'pi-extension-ablation-build-')),token=randomUUID();
await writeFile(join(temporary,'.owner'),token,{mode:0o600});
let child,stopped=false;
const controller=new AbortController();
const stop=signal=>{stopped=true;controller.abort();child?.kill(signal);};
// Once the CLI runs, a terminal Ctrl-C reaches it directly (same foreground process group). The wrapper must not forward it or die from it:
// a second SIGINT after a consumed handler would kill the wrapper's child path while a detached worker still runs. Only SIGTERM is forwarded.
const interrupt=()=>{if(!child)stop('SIGINT');},terminate=()=>stop('SIGTERM');
process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
try{
  const build=join(temporary,'build');
  await promisify(execFile)(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p',join(root,'tsconfig.eval.json'),'--outDir',build],{cwd:root,timeout:120000,maxBuffer:1024*1024,signal:controller.signal});
  if(stopped)throw new Error("aborted");
  await symlink(join(root,'node_modules'),join(build,'node_modules'),'dir');
  // `builtin:` skill aliases resolve against the skills directory next to the built sources.
  await symlink(join(root,'skills'),join(build,'skills'),'dir');
  child=spawn(process.execPath,[join(build,'eval/extensions/cli.js'),...process.argv.slice(2)],{cwd:root,env:process.env,stdio:'inherit'});
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  process.exitCode=exit.code??(exit.signal==='SIGINT'?130:143);
}catch{
  process.stderr.write(JSON.stringify({event:'extension_ablation_stopped',code:'build_or_launch_failed'})+'\n');process.exitCode=1;
}finally{
  process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
  if(await readFile(join(temporary,'.owner'),'utf8')===token)await rm(temporary,{recursive:true});
}
