import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";

export class TransportFailure extends Error {constructor(readonly code:string){super(code);}}
const startupCodes=new Set(["unknown_execution_profile","unknown_workspace","unknown_provider","unknown_model","local_authentication_missing","local_authentication_unavailable","model_unavailable","thinking_level_unavailable","execution_selection_mismatch","extension_not_installed","extension_version_mismatch","extension_load_failed","extension_tool_conflict","extension_tool_missing","skill_load_failed","sandbox_unavailable","external_mcp_unavailable","external_mcp_no_tools","external_mcp_grant_tool_missing","external_mcp_activation_mismatch","server_stopping"]);
interface Identity {pid:number;start:string;ppid:number;state:string}
async function identity(pid:number):Promise<Identity|null> {
  try { const s=await readFile(`/proc/${pid}/stat`,"utf8"), fields=s.slice(s.lastIndexOf(")")+2).split(" ");
    return {pid,ppid:Number(fields[1]),state:fields[0]!,start:fields[19]!};
  } catch {return null;}
}
export async function bounded<T>(promise:Promise<T>,timeout:number):Promise<T> {
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("deadline")),timeout);})]);}
  finally{clearTimeout(timer);}
}
/** Public MCP stdio, unmodified production entry point; only process metadata is observed. */
export class EvaluationTransport {
  readonly client = new Client({name:"profile-evaluation",version:"1.0.0"});
  private transport:StdioClientTransport|undefined;
  private timer:NodeJS.Timeout|undefined;
  private scanning:Promise<void>|undefined;
  private owned=new Map<number,Identity>();
  private scanFailed=false;
  calls=0;
  constructor(private readonly provider="") {}
  async connect(entry:string,config:string,timeout:number):Promise<void> {
    this.transport=new StdioClientTransport({command:process.execPath,args:[entry],
      env:this.environment(config),stderr:"pipe"});
    this.transport.stderr?.on("data",()=>undefined);
    this.client.onerror=()=>undefined;
    // Only live approval reaches here. Existing Pi auth is never copied or printed.
    const connected=this.client.connect(this.transport,{timeout});
    this.timer=setInterval(()=>{if(!this.scanning)this.scanning=this.scan().finally(()=>{this.scanning=undefined;});},50);
    await connected;await this.scan();
  }
  private environment(config:string):Record<string,string> {
    const providerKey:Record<string,string>={"openai":"OPENAI_API_KEY","deepseek":"DEEPSEEK_API_KEY","xai":"XAI_API_KEY","mistral":"MISTRAL_API_KEY"};
    const keys=["PATH","HOME","PI_CODING_AGENT_DIR","XDG_CONFIG_HOME","XDG_CACHE_HOME","XDG_DATA_HOME","HTTPS_PROXY","HTTP_PROXY","NO_PROXY","NODE_EXTRA_CA_CERTS",providerKey[this.provider]??""];
    return {...Object.fromEntries(keys.flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]!]])),PI_SESSION_MCP_CONFIG:config};
  }
  private async scan():Promise<void> {
    if(process.platform!=="linux"){this.scanFailed=true;return;}
    const pid=this.transport?.pid;
    if(pid&&!this.owned.has(pid)){const root=await identity(pid);if(root)this.owned.set(pid,root);}
    try {
      const all=(await Promise.all((await readdir("/proc")).filter(n=>/^\d+$/.test(n)).map(n=>identity(Number(n))))).filter((x):x is Identity=>x!==null);
      for(let changed=true;changed;){changed=false;for(const child of all){if(!this.owned.has(child.pid)&&all.some(p=>p.pid===child.ppid&&p.start===this.owned.get(child.ppid)?.start)){this.owned.set(child.pid,child);changed=true;}}}
    } catch {this.scanFailed=true;}
  }
  async call(name:string,args:Record<string,unknown>,timeout=15000):Promise<Record<string,unknown>> {
    this.calls++;
    const result=await this.client.callTool({name,arguments:args},{timeout,maxTotalTimeout:timeout,resetTimeoutOnProgress:false});
    const content=result.structuredContent as Record<string,unknown>|undefined;
    if(result.isError||content?.ok===false){
      const code=(content?.error as {code?:unknown}|undefined)?.code;
      throw new TransportFailure(typeof code==="string"&&startupCodes.has(code)?code:"mcp_call_failed");
    }
    if(typeof content!=="object"||content===null||content.ok!==true)throw new Error("invalid_mcp_result");
    return content;
  }
  async close():Promise<boolean> {
    clearInterval(this.timer);await this.scanning;await this.scan();
    await bounded(this.client.close(),3000).catch(()=>undefined);
    await bounded(this.transport?.close()??Promise.resolve(),3000).catch(()=>undefined);
    // Signal only identities observed below this server, never a reused PID.
    for(const signal of ["SIGTERM","SIGKILL"] as const){
      for(const original of this.owned.values()){
        const now=await identity(original.pid);
        if(now&&now.start===original.start&&now.state!=="Z")try{process.kill(now.pid,signal);}catch{ /* gone */ }
      }
      await pause(100);
    }
    for(const original of this.owned.values()){
      const now=await identity(original.pid);
      if(now&&now.start===original.start&&now.state!=="Z")return false;
    }
    return !this.scanFailed;
  }
}
const session=z.object({id:z.string().uuid(),provider:z.string(),model:z.string(),thinkingLevel:z.string()});
export function selection(value:unknown){return session.parse(value);}
export const turnSchema=z.discriminatedUnion("state",[
  z.object({state:z.literal("running"),turnId:z.string().uuid()}),
  z.object({state:z.literal("completed"),turnId:z.string().uuid(),assistantText:z.string().max(65536),truncated:z.boolean()}),
  z.object({state:z.enum(["failed","aborted"]),turnId:z.string().uuid()}),
]);
