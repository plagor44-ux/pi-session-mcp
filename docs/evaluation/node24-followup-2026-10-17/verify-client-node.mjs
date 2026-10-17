// Offline Doctor + exact registration inspection + bounded MCP metadata handshake.
import {readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),home=homedir();
const root=join(home,'.npm-global/lib/node_modules/pi-session-mcp');
const node=join(home,'.local/opt/node-v24.22.0/bin/node');
const output=process.argv[2];
if(!output)throw Error('output_required');
const registration=JSON.parse(await readFile(join(home,'.claude.json'),'utf8')).mcpServers['pi-session-mcp'];
const config=registration.env.PI_SESSION_MCP_CONFIG;
const env={...process.env,PI_SESSION_MCP_CONFIG:config};
async function command(entry,args){
 try{const r=await exec(node,[entry,...args],{env,timeout:45000,maxBuffer:262144});return {exit_code:0,result:JSON.parse(r.stdout)};}
 catch(e){let result;try{result=JSON.parse(e.stdout);}catch{}return {exit_code:typeof e.code==='number'?e.code:1,...(result?{result}:{}),diagnostics_discarded:true};}
}
const doctor=await command(join(root,'scripts/doctor.mjs'),['--json']);
const verify=[];
for(const target of ['codex:user:pi-session-mcp','claude-code:user:pi-session-mcp'])verify.push({target,...await command(join(root,'dist/setup-main.js'),['--verify','--target',target,'--json'])});
const {createProcessRunner,createMcpStdioLauncher}=await import(join(root,'dist/setup-process.js'));
const {createCodexAdapter,createClaudeCodeAdapter}=await import(join(root,'dist/client-adapters/index.js'));
const {verifyMcpCapabilities}=await import(join(root,'dist/client-adapters/mcp-verifier.js'));
const runner=createProcessRunner(),intent={scope:'user',nodePath:node,entryPath:join(root,'dist/main.js'),configPath:config};
const inspections=[];
for(const adapter of [createCodexAdapter({runner}),createClaudeCodeAdapter({runner})])inspections.push(await adapter.inspect('user',intent));
const direct=await verifyMcpCapabilities({launch:createMcpStdioLauncher({nodePath:registration.command,entryPath:registration.args[0],configPath:config})});
const runtime=(await exec(registration.command,['--version'],{timeout:5000})).stdout.trim();
const result={kind:'node24-actual-client-registration-verification',verified_at:new Date().toISOString(),runtime,
 direct_command_matches_expected:registration.command===node,doctor,setup_verify:verify,registration_inspections:inspections,
 direct_registration_handshake:direct,session_starts:0,provider_calls:0,
 limits:'The direct Node executable is bound to 24.22.0. It does not prepend PATH; child commands selected by PATH retain the client environment. Existing client stdio connections were not restarted.'};
result.status=doctor.exit_code===0&&verify.every(v=>v.exit_code===0)&&inspections.every(i=>i.state==='equivalent')&&direct.status==='verified'&&runtime==='v24.22.0'?'PASS':'CHECK_FINDINGS';
await writeFile(resolve(output),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:result.status,doctor_exit:doctor.exit_code,setup_verify:verify.map(v=>({target:v.target,exit_code:v.exit_code})),direct_handshake:direct.status,session_starts:0,provider_calls:0}));
