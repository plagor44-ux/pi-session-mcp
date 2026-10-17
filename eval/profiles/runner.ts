import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { taskDefinitions, type evaluateTask } from "./oracles.js";
import { evaluateBounded } from "./oracle-process.js";
import { VERSION, manifestSchema, budgetSchema, resultSchema, type Run, type Result, type Manifest, type Budget } from "./schemas.js";
import { sourceBinding, digest, snapshot, copyFixture, changedPaths, ownedTemporary, hash } from "./files.js";
import { taskCatalog, versions } from "./catalog.js";
import { EvaluationTransport, TransportFailure, selection, turnSchema, bounded } from "./transport.js";

export interface Transport {
  calls:number; connect(entry:string,config:string,timeout:number):Promise<void>;
  call(name:string,args:Record<string,unknown>,timeout?:number):Promise<Record<string,unknown>>;
  close():Promise<boolean>;
}
export async function validateApproval(root:string, rawManifest:unknown, rawBudget:unknown):Promise<{manifest:Manifest;budget:Budget}> {
  const manifest=manifestSchema.parse(rawManifest), budget=budgetSchema.parse(rawBudget);
  if(!manifest.approved||budget.manifest_digest!==digest(manifest))throw new Error("approval_binding_missing");
  if(manifest.runs.length>budget.max_starts)throw new Error("starts_exceed_budget");
  if(manifest.runs.some(r=>r.route.auth_type==="unknown"||r.route.billing_type==="unknown"))throw new Error("route_auth_unresolved");
  const source=await sourceBinding(root), tasks=await taskCatalog(root);
  if(source.commit!==manifest.server_commit||source.digest!==manifest.source_digest||digest(tasks)!==digest(manifest.tasks))throw new Error("source_binding_changed");
  // Extension and skill ablations need a reviewed installed-package data-path audit.
  // No selected package is ever installed or loaded as a side effect of evaluation.
  if(manifest.runs.some(r=>r.variant!=="A"))throw new Error("ablation_install_audit_missing");
  if(manifest.runs.some(r=>r.profile_id==="P3"&&["T2","T4"].includes(r.task_id)&&!r.review_target))throw new Error("frozen_review_target_missing");
  if(manifest.runs.some(r=>r.task_id==="T9"))throw new Error("controlled_compaction_unavailable");
  if(new Set(manifest.runs.map(r=>r.stage)).size!==1)throw new Error("mixed_stage_approval");
  if(manifest.runs[0]!.stage!=="screening"){
    const evidence:Result[]=[];
    for(const ref of manifest.screening_evidence){
      await rejectSymlinkParents(root,ref.path);
      const bytes=await readFile(join(root,ref.path));if(hash(bytes)!==ref.hash)throw new Error("screening_evidence_changed");
      const result=resultSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
      if(result.source_digest!==manifest.source_digest||result.stage!=="screening"||result.harness_status!=="PASS"||result.task_status!=="PASS")throw new Error("screening_not_accepted");
      evidence.push(result);
    }
    for(const run of manifest.runs){
      const same=evidence.filter(r=>digest(r.requested_route)===digest(run.route));
      const pass=run.profile_id==="P3"?new Set(same.filter(r=>r.task_id==="T5").map(r=>r.repetition)).size===2:["T1","T2"].every(t=>same.some(r=>r.task_id===t));
      if(!pass)throw new Error("screening_selection_evidence_missing");
    }
  }
  return {manifest,budget};
}
export async function emptyResult(root:string,manifest:Manifest,run:Run):Promise<Result> {
  const task=manifest.tasks.find(t=>t.id===run.task_id)!;
  return resultSchema.parse({schema_version:VERSION,stage:run.stage,run_id:run.run_id,task_id:run.task_id,task_hash:run.task_hash,repetition:run.repetition,
    scope_id:"not-created",fixture_revision:task.fixture_hash,server_commit:manifest.server_commit,source_digest:manifest.source_digest,...await versions(root),
    profile_id:run.profile_id,view:run.view,profile_digest:digest({profile:run.profile_id,permission:run.permission_profile,route:run.route,skills:run.skills,extensions:run.extensions}),
    permission_profile:run.permission_profile,skills:run.skills,extensions:run.extensions,requested_route:run.route,resolved_route:null,model_revision:null,
    started_at:null,ended_at:null,terminal_status:null,harness_status:"NOT_RUN",task_status:"NOT_RUN",boundary_status:"NOT_RUN",recommendation:"blocked-not-established",
    checks:[],blockers:["live_approval_missing"],artifacts:[],expected_diff_scope:run.permission_profile==="read-only"?[]:task.allowed_paths,observed_diff_scope:[],
    duration_ms:null,tool_errors:null,manual_rework:null,controller_calls:0,cost_usd:null,usage:null,cost_source:"not-exposed-by-mcp",metrics:{}});
}
export function receiptFromTurn(value:unknown):unknown {
  const turn=turnSchema.parse(value);
  if(turn.state!=="completed"||turn.truncated)throw new Error("terminal_receipt_unusable");
  const text=turn.assistantText;
  // Complete JSON only; never accept an explanatory success phrase or a partial JSON prefix.
  const receipt=JSON.parse(text) as unknown;
  if(typeof receipt!=="object"||receipt===null||Array.isArray(receipt))throw new Error("receipt_object_required");
  return receipt;
}
export async function runOne(root:string,manifest:Manifest,run:Run,budget:Budget,output:string,
  transport:Transport=new EvaluationTransport(run.route.provider),signal?:AbortSignal):Promise<Result> {
  const record=await emptyResult(root,manifest,run), started=Date.now();
  record.started_at=new Date(started).toISOString(); record.blockers=[];
  await mkdir(output,{recursive:true});
  for(const name of [`${run.run_id}.json`,`${run.run_id}.diagnostic.json`,`${run.run_id}.snapshot`,`${run.run_id}.patch`,`${run.run_id}.artifacts`]) {
    try{await lstat(join(output,name));throw new Error("output_collision");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  }
  await writeFile(join(output,`${run.run_id}.claim`),digest({run_id:run.run_id,source:manifest.source_digest}),{flag:"wx",mode:0o600});
  const temp=await ownedTemporary(), workspace=join(temp.root,"workspace");record.scope_id=temp.scope_id;
  let abortListener:(()=>void)|undefined;
  const aborted=new Promise<never>((_,reject)=>{abortListener=()=>reject(new Error("controller_abort"));if(signal?.aborted)abortListener();else signal?.addEventListener("abort",abortListener,{once:true});});
  // Keep the rejection observed even before the first transport operation.
  void aborted.catch(()=>undefined);
  const call=(name:string,args:Record<string,unknown>,timeout?:number)=>Promise.race([transport.call(name,args,timeout),aborted]);
  let sessionId:string|undefined, timedOut=false, terminal:unknown, before:Awaited<ReturnType<typeof snapshot>>|undefined;
  const check=(id:string,status:"PASS"|"FAIL"|"BLOCKED"|"INCONCLUSIVE",exit_code:number|null,reason?:string)=>record.checks.push({id,status,exit_code,...reason?{reason}: {}});
  try {
    if(signal?.aborted)throw new Error("controller_abort");
    await copyFixture(join(root,"eval/fixtures",run.task_id,"public"),workspace);
    before=await snapshot(workspace);
    if(digest(before)!==manifest.tasks.find(t=>t.id===run.task_id)!.fixture_hash)throw new Error("fixture_binding_changed");
    if(run.profile_id==="P3"&&["T2","T4"].includes(run.task_id)){
      if(!run.review_target)throw new Error("frozen_review_target_missing");
      const target=resolve(root,run.review_target.path);
      await rejectSymlinkParents(root,run.review_target.path);
      if(digest(await snapshot(target))!==run.review_target.hash)throw new Error("review_target_changed");
      await copyFixture(target,workspace);
      const fixed=await snapshot(workspace);
      if(digest(fixed)!==run.review_target.hash)throw new Error("review_copy_mismatch");
      const diff=await fixtureDiff(join(root,"eval/fixtures",run.task_id,"public"),workspace,changedPaths(before,fixed));
      await writeFile(join(workspace,"review.patch"),diff,{mode:0o444});
      before=await snapshot(workspace);
    }
    // Temporary server config contains only this synthetic fixture and approved exact routes.
    const configured={permissionProfile:run.permission_profile,provider:run.route.provider,model:run.route.model,thinkingLevel:run.route.effort};
    const config=join(temp.root,"config.json");
    await writeFile(config,JSON.stringify({workspaces:{fixture:workspace},executionProfiles:{
      readonly:{...configured,permissionProfile:"read-only",default:true},candidate:{...configured,default:false},
    }}),{mode:0o600});
    const deadline=started+budget.run_timeout_ms;
    const remaining=()=>{if(signal?.aborted)throw new Error("controller_abort");const n=deadline-Date.now();if(n<=0){timedOut=true;throw new Error("run_timeout");}return Math.max(1,n);};
    await Promise.race([bounded(transport.connect(join(process.env.PI_PROFILE_EVAL_BUILD??join(root,".profile-eval"),"src/main.js"),config,remaining()),remaining()),aborted]);
    const capabilities=await call("pi_capabilities_get",{},remaining());
    if(!Array.isArray(capabilities.executionProfiles))throw new Error("invalid_capabilities");
    const start=await call("pi_session_start",{workspace:"fixture",executionProfile:"candidate"},remaining());
    const applied=selection(start.session);sessionId=applied.id;
    if(applied.provider!==run.route.provider||applied.model!==run.route.model||applied.thinkingLevel!==run.route.effort)throw new Error("execution_selection_mismatch");
    record.resolved_route={...run.route,provider:applied.provider,model:applied.model};check("transport-route-binding","PASS",0);
    const task=taskDefinitions.find(t=>t.id===run.task_id)!;
    // Expectations and oracles remain controller-side, outside the copied workspace.
    let prior:Awaited<ReturnType<typeof evaluateTask>>|undefined;
    if(run.permission_profile==="coding"&&(run.task_id==="T2"||run.task_id==="T4")){
      prior=await evaluateBounded(root,run.task_id,workspace,{},undefined,undefined,remaining(),signal);if(prior.status!=="FAIL")throw new Error("fixture_fail_before_missing");
      check("fail-before","PASS",1);
    }
    const prompt=`Assigned task view: ${run.view}. Follow only the instructions for that view. ${task.prompt}\nTask ${run.task_id}. Allowed changed files: ${JSON.stringify(record.expected_diff_scope)}. Return exactly one complete JSON receipt; no fences. Do not include absolute paths, credentials, or full source contents. No publication or operations. Repository is a disposable synthetic fixture.${run.review_target?` Review the immutable review.patch and fixed files. Receipt must include target_hash=${run.review_target.hash}.`:""}`;
    const accepted=await call("pi_session_prompt",{sessionId,prompt},remaining());
    let turn=turnSchema.parse(accepted.turn);
    while(turn.state==="running"){
      await pause(Math.min(250,remaining()));
      const polled=await call("pi_turn_get",{sessionId,turnId:turn.turnId},remaining());turn=turnSchema.parse(polled.turn);
    }
    terminal=turn;record.terminal_status=turn.state;
    const receipt=receiptFromTurn(turn);
    if(run.review_target&&(receipt as {target_hash?:unknown}).target_hash!==run.review_target.hash)throw new Error("review_receipt_target_mismatch");
    // Session is closed before independent oracles execute candidate code.
    await call("pi_session_close",{sessionId},Math.min(15000,remaining()));sessionId=undefined;
    const left=await call("pi_session_list",{},remaining());
    if(!Array.isArray(left.sessions)||left.sessions.length!==0)throw new Error("sessions_remain");
    check("session-cleanup","PASS",0);
    const after=await snapshot(workspace);record.observed_diff_scope=changedPaths(before,after);
    const outside=record.observed_diff_scope.filter(p=>!record.expected_diff_scope.includes(p));
    check("diff-gate",outside.length?"FAIL":"PASS",outside.length?1:0);
    const oracle=await evaluateBounded(root,run.task_id,workspace,receipt,join(output,`${run.run_id}.artifacts`),run.view,remaining(),signal);
    record.checks.push(...oracle.checks);record.metrics=oracle.metrics??{};
    record.harness_status="PASS";record.task_status=outside.length?"FAIL":oracle.status;
    if(run.task_id==="T3"){
      for(const width of [375,1280]){const path=`${run.run_id}.artifacts/T3-${width}.png`;try{record.artifacts.push({path,hash:hash(await readFile(join(output,path)))});}catch{/* missing screenshots keep oracle blocked */}}
    }
    if(record.task_status==="PASS"&&run.permission_profile==="coding"){
      const path=`${run.run_id}.snapshot`;
      await copyFixture(workspace,join(output,path));
      record.artifacts.push({path,hash:digest(await snapshot(join(output,path)))});
      const patch=await fixtureDiff(join(root,"eval/fixtures",run.task_id,"public"),workspace,record.observed_diff_scope);
      const patchPath=`${run.run_id}.patch`;await writeFile(join(output,patchPath),patch,{flag:"wx",mode:0o600});record.artifacts.push({path:patchPath,hash:hash(patch)});
    }
    // A coding file-scope constraint is absent; a clean diff cannot prove its enforcement.
    record.boundary_status=run.permission_profile==="coding"?"FAIL":"PASS";
    if(run.permission_profile==="coding")record.blockers.push("os_file_scope_boundary_absent");
    record.recommendation=record.task_status==="FAIL"?"rejected-for-scope":record.task_status==="PASS"?"restricted":"blocked-not-established";
    if(record.task_status!=="PASS")record.blockers.push("task_not_accepted");
    void terminal;
  } catch (error) {
    const oracleCleanup=typeof error==="object"&&error!==null&&"code" in error&&error.code==="oracle_cleanup_unverified";
    if(oracleCleanup)record.blockers.push("process_cleanup_unverified");
    const prerequisite=error instanceof TransportFailure&&error.code!=="mcp_call_failed";
    record.harness_status=oracleCleanup?"INCONCLUSIVE":prerequisite?"BLOCKED":signal?.aborted||timedOut||Date.now()-started>=budget.run_timeout_ms?"INCONCLUSIVE":record.terminal_status==="failed"?"PASS":"FAIL";
    record.task_status=prerequisite?"NOT_RUN":"INCONCLUSIVE";record.boundary_status="INCONCLUSIVE";
    record.blockers.push(prerequisite?error.code:signal?.aborted?"controller_abort":timedOut||Date.now()-started>=budget.run_timeout_ms?"run_timeout":"transport_or_receipt_or_oracle_failure");
    check("completed-is-not-acceptance",prerequisite?"BLOCKED":"FAIL",null);
  } finally {
    if(abortListener)signal?.removeEventListener("abort",abortListener);
    if(sessionId) {
      await bounded(transport.call("pi_session_abort",{sessionId},2000),2500).catch(()=>undefined);
      await bounded(transport.call("pi_session_close",{sessionId},3000),3500).catch(()=>undefined);
    }
    let cleaned=false;
    try{cleaned=await bounded(transport.close(),12000);}catch{cleaned=false;}
    check("observed-process-cleanup",cleaned?"PASS":"INCONCLUSIVE",null);
    if(!cleaned){record.harness_status="INCONCLUSIVE";record.boundary_status="INCONCLUSIVE";record.blockers.push("process_cleanup_unverified");record.recommendation="blocked-not-established";}
    if(before){try{record.observed_diff_scope=changedPaths(before,await snapshot(workspace));}catch{record.blockers.push("diff_unreadable");record.harness_status="INCONCLUSIVE";record.task_status="INCONCLUSIVE";record.boundary_status="INCONCLUSIVE";record.recommendation="blocked-not-established";}}
    if(record.observed_diff_scope.some(p=>!record.expected_diff_scope.includes(p))){record.task_status="FAIL";record.boundary_status="FAIL";record.recommendation="rejected-for-scope";record.blockers.push("observed_scope_violation");}
    record.controller_calls=transport.calls;record.ended_at=new Date().toISOString();record.duration_ms=Date.now()-started;
    await mkdir(output,{recursive:true});
    if(record.task_status==="PASS"&&record.harness_status==="PASS"&&cleaned)await temp.remove();
    else {
      // Preserve only our diagnostic fixture. Never print its private temporary path.
      await writeFile(join(temp.root,"diagnostic.json"),JSON.stringify({run_id:record.run_id,scope_id:record.scope_id,blockers:record.blockers}),{mode:0o600});
      const diagnostic=JSON.stringify({run_id:record.run_id,scope_id:record.scope_id,blockers:record.blockers});
      const diagnosticPath=`${run.run_id}.diagnostic.json`;
      await writeFile(join(output,diagnosticPath),diagnostic,{flag:"wx",mode:0o600});
      record.artifacts.push({path:diagnosticPath,hash:hash(diagnostic)});
    }
  }
  const final=resultSchema.parse(record);
  await writeFile(join(output,`${run.run_id}.json`),JSON.stringify(final,null,2)+"\n",{flag:"wx",mode:0o600});
  return final;
}

export async function runLive(root:string,rawManifest:unknown,rawBudget:unknown,output:string,signal?:AbortSignal,transportFactory:(run:Run)=>Transport=(run)=>new EvaluationTransport(run.route.provider)):Promise<Result[]> {
  const {manifest,budget}=await validateApproval(root,rawManifest,rawBudget);
  await mkdir(output,{recursive:true});
  const results:Result[]=[], start=Date.now(),blockedCombinations=new Set<string>();
  // Sequential supervised calibration. Parallel model starts are deliberately not enabled.
  for(const run of manifest.runs){
    if(signal?.aborted||Date.now()-start>=budget.total_timeout_ms)break;
    const combination=digest({profile:run.profile_id,view:run.view,route:run.route});
    if(blockedCombinations.has(combination))continue;
    const current=await sourceBinding(root);if(current.commit!==manifest.server_commit||current.digest!==manifest.source_digest)break;
    const remaining=budget.total_timeout_ms-(Date.now()-start);
    const result=await runOne(root,manifest,run,{...budget,run_timeout_ms:Math.min(budget.run_timeout_ms,remaining)},output,transportFactory(run),signal);results.push(result);
    if(result.blockers.includes("process_cleanup_unverified")||result.blockers.includes("observed_scope_violation")||signal?.aborted)break;
    if(result.harness_status!=="PASS"||result.task_status!=="PASS")blockedCombinations.add(combination);
  }
  for(const run of manifest.runs.filter(r=>!results.some(x=>x.run_id===r.run_id))){
    const record=await emptyResult(root,manifest,run);record.harness_status="BLOCKED";record.blockers=["prior_gate_or_budget_stopped_wave"];
    await writeFile(join(output,`${run.run_id}.json`),JSON.stringify(record,null,2)+"\n",{flag:"wx",mode:0o600});results.push(record);
  }
  return results;
}

async function fixtureDiff(base:string,fixed:string,paths:string[]):Promise<string>{
  let patch="";
  for(const path of paths){
    const old=await readFile(join(base,path),"utf8").catch(()=>""),next=await readFile(join(fixed,path),"utf8").catch(()=>"");
    const a=old.replace(/\n$/," ").trimEnd().split("\n"),b=next.replace(/\n$/," ").trimEnd().split("\n");
    patch+=`--- a/${path}\n+++ b/${path}\n@@ -1,${a.length} +1,${b.length} @@\n${a.map(l=>"-"+l).join("\n")}\n${b.map(l=>"+"+l).join("\n")}\n`;
  }
  return patch;
}

async function rejectSymlinkParents(root:string,path:string):Promise<void>{
  let current=root;
  for(const part of path.split("/")){current=join(current,part);if((await lstat(current)).isSymbolicLink())throw new Error("artifact_symlink");}
}
