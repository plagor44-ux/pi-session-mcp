import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createPlan, roleViews } from "./catalog.js";
import { runOffline } from "./offline.js";
import { inventory } from "./inventory.js";
import { comparison } from "./comparison.js";
import { runLive } from "./runner.js";

export function parseArgs(args:string[]) {
  const mode=args.filter(x=>["--plan","--offline","--live"].includes(x));
  if(mode.length>1)throw new Error("choose_one_mode");
  const options:Record<string,string>={};
  for(let i=0;i<args.length;i++){
    const a=args[i]!;if(["--plan","--offline","--live"].includes(a))continue;
    if(!["--manifest","--budget","--output","--inventory"].includes(a)||!args[i+1]||args[i+1]!.startsWith("--")||options[a])throw new Error("invalid_argument");
    options[a]=args[++i]!;
  }
  if(options["--inventory"]&&mode[0]&&mode[0]!=="--plan")throw new Error("inventory_plan_only");
  if(mode[0]!=="--live"&&(options["--manifest"]||options["--budget"]))throw new Error("live_only_argument");
  if(mode[0]==="--live"&&(!options["--manifest"]||!options["--budget"]))throw new Error("live_approval_required");
  return {mode:mode[0]??"--plan",options};
}
async function main() {
  const {mode,options}=parseArgs(process.argv.slice(2)),root=process.cwd();
  if(mode==="--plan"){
    const manifest=await createPlan(root);
    process.stdout.write(JSON.stringify({manifest,role_views:roleViews,...options["--inventory"]?{inventory:await inventory(options["--inventory"])}:{},live_status:"BLOCKED",reason:"matrix_routes_and_budget_not_approved"},null,2)+"\n");return;
  }
  const output=options["--output"]?resolve(options["--output"]):join(root,"eval/results",randomUUID());
  // Exclusive fresh output directory: never overwrite an earlier attempt.
  await mkdir(output,{recursive:false,mode:0o700}).catch(async(e:unknown)=>{
    if((e as NodeJS.ErrnoException).code==="ENOENT"&&!options["--output"]){await mkdir(join(root,"eval/results"),{recursive:true});await mkdir(output,{mode:0o700});return;}throw e;
  });
  if(mode==="--offline"){
    const evidence=await runOffline(root,output);process.stdout.write(JSON.stringify({harness_status:evidence.harness_status,summary:evidence.summary,model_starts:0,artifact_scope:output.startsWith(root+"/")?output.slice(root.length+1):"operator-selected-output"})+"\n");
    if(evidence.harness_status!=="PASS")process.exitCode=1;return;
  }
  const manifest=JSON.parse(await readFile(options["--manifest"]!,"utf8")) as unknown;
  const budget=JSON.parse(await readFile(options["--budget"]!,"utf8")) as unknown;
  const controller=new AbortController(),stop=()=>controller.abort();
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
  try{
    const results=await runLive(root,manifest,budget,output,controller.signal);
    await writeFile(join(output,"comparison.json"),JSON.stringify(comparison(results),null,2)+"\n",{flag:"wx",mode:0o600});
    process.stdout.write(JSON.stringify({runs:results.length,accepted:results.filter(r=>r.task_status==="PASS"&&r.harness_status==="PASS").length})+"\n");
    if(results.some(r=>r.task_status!=="PASS"||r.harness_status!=="PASS"))process.exitCode=1;
  }finally{process.off("SIGINT",stop);process.off("SIGTERM",stop);}
}
await main().catch(()=>{process.stderr.write(JSON.stringify({event:"profile_evaluation_stopped",code:"invalid_input_or_failed_gate"})+"\n");process.exitCode=1;});
