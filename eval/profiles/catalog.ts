import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { taskDefinitions } from "./oracles.js";
import { VERSION, taskSchema, manifestSchema, type Manifest } from "./schemas.js";
import { hash, digest, snapshot, sourceBinding } from "./files.js";

export const roleViews = {
  scout:{profile:"P1",state:"planned"}, "docs-writer":{profile:"P1",state:"draft-only"},
  implementer:{profile:"P2",state:"planned"}, reviewer:{profile:"P3",state:"screening-required"},
  tester:{profile:"P4",state:"read-only-checks-only"}, researcher:{profile:null,state:"deferred-external-data-path"},
  "ui-writer":{profile:"P4",state:"planned"}, "docs-writer-write":{profile:null,state:"separate-candidate"},
} as const;
export async function taskCatalog(root: string) {
  return Promise.all(taskDefinitions.map(async(t)=>{
    const fixture_hash=digest(await snapshot(join(root,"eval/fixtures",t.id,"public")));
    const prompt_hash=hash(t.prompt);
    const body={schema_version:VERSION,id:t.id,title:t.title,family:t.family,profiles:t.profiles,views:t.views,
      allowed_paths:t.allowed_paths,prompt_hash,fixture_hash,oracle_kind:t.oracle_kind};
    return taskSchema.parse({...body,task_hash:digest(body)});
  }));
}
/** Only eight screening slots. Unavailable alternatives replace slots; never expand them. */
export async function createPlan(root: string): Promise<Manifest> {
  const tasks=await taskCatalog(root), source=await sourceBinding(root);
  const candidates=[
    {provider:"openai-codex",model:"gpt-6-luna",effort:"low" as const,profile:"P1" as const,task:"T1",view:"scout"},
    {provider:"openai-codex",model:"gpt-6-luna",effort:"low" as const,profile:"P2" as const,task:"T2",view:"implementer"},
    {provider:"openai-codex",model:"gpt-6.1-sol",effort:"medium" as const,profile:"P1" as const,task:"T1",view:"scout"},
    {provider:"openai-codex",model:"gpt-6.1-sol",effort:"medium" as const,profile:"P2" as const,task:"T2",view:"implementer"},
    {provider:"deepseek",model:"deepseek-flash",effort:"high" as const,profile:"P1" as const,task:"T1",view:"scout"},
    {provider:"deepseek",model:"deepseek-flash",effort:"high" as const,profile:"P2" as const,task:"T2",view:"implementer"},
    {provider:"xai",model:"grok-4.7",effort:"high" as const,profile:"P3" as const,task:"T5",view:"reviewer"},
    {provider:"xai",model:"grok-4.7",effort:"high" as const,profile:"P3" as const,task:"T5",view:"reviewer"},
  ];
  return manifestSchema.parse({schema_version:VERSION,approved:false,server_commit:source.commit,source_digest:source.digest,tasks,
    prerequisites:{baseline_passed:false,screening_passed:false,bottleneck:null},
    runs:candidates.map((c,i)=>({run_id:`screen-${i+1}`,task_id:c.task,task_hash:tasks.find(t=>t.id===c.task)!.task_hash,
      profile_id:c.profile,view:c.view,repetition:i===7?2:1,stage:"screening",permission_profile:c.profile==="P2"?"coding":"read-only",
      variant:"A",skills:[],extensions:[],route:{provider:c.provider,model:c.model,effort:c.effort,auth_type:"unknown",billing_type:"unknown",data_path:"synthetic-fixture-to-selected-provider"}}))});
}
export async function versions(root:string) {
  const p=JSON.parse(await readFile(join(root,"package.json"),"utf8")) as {version:string;dependencies:Record<string,string>};
  return {package_version:p.version,sdk_version:p.dependencies["@earendil-works/pi-coding-agent"]!,client_version:`profile-evaluation/${VERSION}`};
}
