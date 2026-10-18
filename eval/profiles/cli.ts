import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createPlan, roleViews } from "./catalog.js";
import { runOffline } from "./offline.js";
import { inventory } from "./inventory.js";
import { comparison } from "./comparison.js";
import { runLive } from "./runner.js";
import { measureFootprint } from "./token-footprint.js";
import { footprintPlan } from "./token-footprint-plan.js";
import { measureClientProjection } from "./token-client-projection.js";
import { measureClaudeProjection } from "./token-claude-projection.js";

export function parseArgs(args:string[]) {
  const modes=["--plan","--offline","--live","--footprint-offline","--footprint-plan","--footprint-live","--footprint-client-offline","--footprint-claude-offline","--footprint-claude-nonbare-offline"];
  const mode=args.filter(x=>modes.includes(x));
  if(mode.length>1)throw new Error("choose_one_mode");
  const options:Record<string,string>={};
  for(let i=0;i<args.length;i++){
    const a=args[i]!;if(modes.includes(a))continue;
    if(!["--manifest","--budget","--decision","--output","--inventory","--controller-version","--worker-skills","--worker-provider"].includes(a)||!args[i+1]||args[i+1]!.startsWith("--")||options[a])throw new Error("invalid_argument");
    options[a]=args[++i]!;
  }
  if(options["--inventory"]&&mode[0]&&!["--plan","--footprint-plan"].includes(mode[0]))throw new Error("inventory_plan_only");
  if(!["--live","--footprint-live"].includes(mode[0]??"")&&(options["--manifest"]||options["--budget"]))throw new Error("live_only_argument");
  if(["--live","--footprint-live"].includes(mode[0]??"")&&(!options["--manifest"]||!options["--budget"]))throw new Error("live_approval_required");
  if(options["--decision"]&&mode[0]!=="--footprint-live")throw new Error("footprint_decision_only");
  if((options["--controller-version"]||options["--worker-skills"]||options["--worker-provider"])&&mode[0]!=="--footprint-plan")throw new Error("footprint_plan_only");
  if(options["--controller-version"]&&!/^\d+\.\d+\.\d+$/.test(options["--controller-version"]))throw new Error("invalid_controller_version");
  if(options["--worker-skills"]&&!["none","selected"].includes(options["--worker-skills"]))throw new Error("invalid_worker_skills");
  if(options["--worker-provider"]&&!["openai-codex","openai"].includes(options["--worker-provider"]))throw new Error("invalid_worker_provider");
  if(mode[0]==="--footprint-live"&&!options["--decision"])throw new Error("footprint_decision_required");
  return {mode:mode[0]??"--plan",options};
}
async function main() {
  const {mode,options}=parseArgs(process.argv.slice(2)),root=process.cwd();
  if(mode==="--footprint-plan"){
    const {prepareTokenLive}=await import("./token-live.js");
    const build=process.env.PI_PROFILE_EVAL_BUILD??join(root,".profile-eval");
    // Selected worker skills are bound to the tree digests of this source; the version names the installed controller client.
    const {readSkillTree}=await import("../../src/skill-library.js");
    const workerSkills=options["--worker-skills"]==="selected"?await Promise.all(["pi-session-implementation","pi-session-review"].map(async name=>({name,tree_digest:(await readSkillTree(join(root,"skills",name))).fingerprint}))):[];
    const planOptions={controllerVersion:options["--controller-version"],workerSkills,workerProvider:options["--worker-provider"] as "openai-codex"|"openai"|undefined};
    process.stdout.write(JSON.stringify({proposal:await footprintPlan(root,planOptions),execution_templates:await prepareTokenLive(root,build,planOptions),...options["--inventory"]?{inventory:await inventory(options["--inventory"])}:{}},null,2)+"\n");return;
  }
  if(mode==="--plan"){
    const manifest=await createPlan(root);
    process.stdout.write(JSON.stringify({manifest,role_views:roleViews,...options["--inventory"]?{inventory:await inventory(options["--inventory"])}:{},live_status:"BLOCKED",reason:"matrix_routes_and_budget_not_approved"},null,2)+"\n");return;
  }
  const output=options["--output"]?resolve(options["--output"]):join(root,"eval/results",randomUUID());
  // Exclusive fresh output directory: never overwrite an earlier attempt.
  await mkdir(output,{recursive:false,mode:0o700}).catch(async(e:unknown)=>{
    if((e as NodeJS.ErrnoException).code==="ENOENT"&&!options["--output"]){await mkdir(join(root,"eval/results"),{recursive:true});await mkdir(output,{mode:0o700});return;}throw e;
  });
  if(mode==="--footprint-client-offline"){
    const result=await measureClientProjection(root,process.env.PI_PROFILE_EVAL_BUILD??join(root,".profile-eval"),output);
    process.stdout.write(JSON.stringify({harness_status:result.harness_status,client_attempts:result.rows.length,external_provider_requests_forwarded:0})+"\n");
    if(result.harness_status!=="PASS")process.exitCode=1;return;
  }
  if(mode==="--footprint-claude-offline"||mode==="--footprint-claude-nonbare-offline"){
    const result=await measureClaudeProjection(root,process.env.PI_PROFILE_EVAL_BUILD??join(root,".profile-eval"),output,{mode:mode==="--footprint-claude-nonbare-offline"?"non-bare":"bare"});
    process.stdout.write(JSON.stringify({harness_status:result.harness_status,client_attempts:result.rows.length,external_provider_requests_forwarded:0})+"\n");
    if(result.harness_status!=="PASS")process.exitCode=1;return;
  }
  if(mode==="--footprint-live"){
    const {runTokenLive}=await import("./token-live.js");
    const profileManifest=JSON.parse(await readFile(options["--manifest"]!,"utf8")) as unknown;
    const budget=JSON.parse(await readFile(options["--budget"]!,"utf8")) as unknown;
    const decision=JSON.parse(await readFile(options["--decision"]!,"utf8")) as unknown;
    const controller=new AbortController(),stop=()=>controller.abort();
    process.once("SIGINT",stop);process.once("SIGTERM",stop);
    try{
      const result=await runTokenLive(root,process.env.PI_PROFILE_EVAL_BUILD??join(root,".profile-eval"),{profileManifest,budget,decision},output,{signal:controller.signal});
      process.stdout.write(JSON.stringify({harness_status:result.harness_status})+"\n");
      if(result.harness_status!=="PASS")process.exitCode=1;
    }finally{process.off("SIGINT",stop);process.off("SIGTERM",stop);}
    return;
  }
  if(mode==="--footprint-offline"){
    const evidence=await measureFootprint(root,output);
    const passed=evidence.source_unchanged&&evidence.build_unchanged&&evidence.rows.every(r=>r.calibration_passed)&&evidence.filters.every(r=>r.independentlyPassed)&&evidence.report_controls.every(r=>r.preserved&&!r.incorrectly_accepted);
    process.stdout.write(JSON.stringify({harness_status:passed?"PASS":"FAIL",cases:evidence.rows.length,filter_cases:evidence.filters.length,provider_requests:0})+"\n");
    if(!passed)process.exitCode=1;return;
  }
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
// Run only as the entry point, so tests can import parseArgs without starting a mode.
// Compare real paths: on macOS the temporary directory is reached through a symlink (/var -> /private/var).
function isEntryPoint(argvPath:string):boolean{
  try{return realpathSync(argvPath)===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}
}
if(process.argv[1]&&isEntryPoint(process.argv[1]))await main().catch(()=>{process.stderr.write(JSON.stringify({event:"profile_evaluation_stopped",code:"invalid_input_or_failed_gate"})+"\n");process.exitCode=1;});
