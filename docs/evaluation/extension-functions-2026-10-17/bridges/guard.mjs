// Synthetic-fixture instrumentation. This is not an operating-system sandbox.
import cp from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import {syncBuiltinESMExports} from 'node:module';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
const scope=process.env.EXT_FUNCTION_SCOPE;
if(!scope)throw Error('scope_required');
const workspace=join(scope,'workspace');
const port=Number(process.env.EXT_FUNCTION_HTTP_PORT??0);
const ledger={network_allowed:0,network_denied:0,git_allowed:0,children_allowed:0,children_denied:0};
const persist=()=>writeFileSync(join(scope,`guard-${process.pid}.json`),JSON.stringify(ledger),{mode:0o600});
persist();
function deny(kind){ledger[kind]++;persist();throw Object.assign(Error('fixture_guard_denied'),{code:'FIXTURE_GUARD_DENIED'});}
function local(host,p){return port>0&&Number(p)===port&&['127.0.0.1','localhost','::1'].includes(host??'localhost');}
const nativeConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const first=Array.isArray(args[0])?args[0][0]:args[0];
 const host=typeof first==='object'?first.host:typeof args[1]==='string'?args[1]:'localhost';
 const p=typeof first==='object'?first.port:first;
 if(!local(host,p))return deny('network_denied');
 ledger.network_allowed++;persist();return nativeConnect.apply(this,args);
};
tls.connect=()=>deny('network_denied');
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,options)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(url.protocol!=='http:'||!local(url.hostname,url.port))return deny('network_denied');
 return originalFetch(input,options);
};
for(const key of ['lookup','resolve','resolve4','resolve6']){
 dns[key]=()=>deny('network_denied');
 if(dns.promises?.[key])dns.promises[key]=()=>deny('network_denied');
}
dgram.createSocket=()=>deny('network_denied');
if('WebSocket' in globalThis)globalThis.WebSocket=class{constructor(){deny('network_denied');}};
const nativeSpawn=cp.spawn,nativeExecFile=cp.execFile,nativeSync=cp.execFileSync;
const readGit=new Set(['rev-parse','status','ls-files','show','diff','log','check-ignore','ls-tree','rev-list','symbolic-ref','check-attr']);
function gitArgs(command,args,options){
 if(!['git','/usr/bin/git'].includes(command)||!Array.isArray(args))return false;
 args=args.filter(a=>a!=='--no-pager');
 const index=args.indexOf('-C');
 const directory=index>=0?resolve(args[index+1]):resolve(options?.cwd??process.cwd());
 if(directory!==workspace&&!directory.startsWith(workspace+'/'))return false;
 const action=index>=0?args[index+2]:args[0];
 return readGit.has(action);
}
function safeGitOptions(options={}){return {...options,timeout:Math.min(options.timeout??3000,3000),env:{...process.env,...options.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:'/dev/null'}};}
cp.execFile=function(command,args,options,callback){
 if(typeof options==='function'){callback=options;options={};}
 if(!gitArgs(command,args,options))return deny('children_denied');
 ledger.git_allowed++;persist();return nativeExecFile('/usr/bin/git',args,safeGitOptions(options),callback);
};
cp.execFile[promisify.custom]=(...args)=>new Promise((resolvePromise,reject)=>cp.execFile(...args,(e,stdout,stderr)=>e?reject(e):resolvePromise({stdout,stderr})));
cp.execFileSync=function(command,args,options){
 if(!gitArgs(command,args,options))return deny('children_denied');
 ledger.git_allowed++;persist();return nativeSync('/usr/bin/git',args,safeGitOptions(options));
};
cp.spawn=function(command,args,options={}){
 const expected=process.env.EXT_FUNCTION_CHILD_ENTRY;
 const kind=process.env.EXT_FUNCTION_KIND;
 const valid=process.env.EXT_FUNCTION_ALLOW_CHILD==='1'&&command===process.execPath&&args[0]===expected
  &&(kind==='web'?args.length===1:args.length===4&&args.slice(1).join('|')==='mcp|--host|pi');
 if(!valid)return deny('children_denied');
 ledger.children_allowed++;persist();
 const env={...options.env,...Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('EXT_FUNCTION_'))),HOME:scope,PATH:process.env.PATH,XDG_CONFIG_HOME:join(scope,'config'),XDG_CACHE_HOME:join(scope,'cache'),XDG_DATA_HOME:join(scope,'data'),DO_NOT_TRACK:'1',OPENWIKI_TELEMETRY_DISABLED:'1',EXT_FUNCTION_ALLOW_CHILD:'0'};
 return nativeSpawn(command,['--import',new URL(import.meta.url).pathname,...args],{...options,cwd:workspace,env});
};
for(const key of ['spawnSync','exec','execSync','fork'])cp[key]=()=>deny('children_denied');
syncBuiltinESMExports();
