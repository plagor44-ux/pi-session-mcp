import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { mkdir, readFile, writeFile, readdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createPlan, taskCatalog } from "../eval/profiles/catalog.js";
import { digest, ownedTemporary, snapshot, changedPaths, copyFixture } from "../eval/profiles/files.js";
import * as oracleProcess from "../eval/profiles/oracle-process.js";
import { comparison } from "../eval/profiles/comparison.js";
import { emptyResult } from "../eval/profiles/runner.js";
import { budgetSchema, manifestSchema, resultSchema, type Budget } from "../eval/profiles/schemas.js";
import { validateApproval, receiptFromTurn, runOne, runLive, type Transport } from "../eval/profiles/runner.js";
const root=process.cwd();
beforeAll(async()=>{await promisify(execFile)(process.execPath,[join(root,"node_modules/typescript/bin/tsc"),"-p","tsconfig.eval.json"],{cwd:root,timeout:120000});},150000);
const sessionId=randomUUID(),turnId=randomUUID();
const temporary:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(temporary.splice(0).map(f=>f()));});
async function scratch(){const t=await ownedTemporary();temporary.push(t.remove);return t.root;}
function budget(manifest:unknown):Budget {return budgetSchema.parse({schema_version:"1.0.0",approved:true,manifest_digest:digest(manifest),max_starts:8,max_retries:0,parallelism:1,run_timeout_ms:10000,total_timeout_ms:100000,advisory_usd:5,provider_cap_usd:null,acknowledges_unmetered_cost:true});}
class ScriptedTransport implements Transport {
  calls=0; starts=0; closed=0; workspace="";
  constructor(readonly answer:unknown={state:"completed",turnId,assistantText:'{}',truncated:false},readonly behavior?: (workspace:string)=>Promise<void>){}
  async connect(_entry:string,config:string){const raw=JSON.parse(await readFile(config,"utf8"));this.workspace=raw.workspaces.fixture;expect(Object.keys(raw.workspaces)).toEqual(["fixture"]);}
  async call(name:string,args:Record<string,unknown>):Promise<Record<string,unknown>>{
    this.calls++;
    if(name==="pi_capabilities_get")return {executionProfiles:[]};
    if(name==="pi_session_start"){this.starts++;return {session:{id:sessionId,provider:"openai-codex",model:"gpt-6-luna",thinkingLevel:"low"}};}
    if(name==="pi_session_prompt"){await this.behavior?.(this.workspace);return {turn:this.answer};}
    if(name==="pi_session_list")return {sessions:[]};
    return {};
  }
  async close(){this.closed++;return true;}
}
describe("profile evaluation runner",()=>{
  it("runs the real plan CLI without creating repository files or sessions",async()=>{
    const before=(await readdir(root)).sort();
    const output=await promisify(execFile)(process.execPath,["scripts/profile-evaluation.mjs","--plan"],{cwd:root,timeout:120000,maxBuffer:1024*1024});
    const plan=JSON.parse(output.stdout) as {live_status:string;manifest:{approved:boolean}};
    expect(plan.live_status).toBe("BLOCKED");expect(plan.manifest.approved).toBe(false);expect((await readdir(root)).sort()).toEqual(before);
  },150000);
  it("builds a provider-free bound plan with eight unapproved screening slots",async()=>{
    const plan=await createPlan(root);expect(plan.approved).toBe(false);expect(plan.runs).toHaveLength(8);expect(plan.tasks).toHaveLength(9);
    expect(plan.runs.filter(r=>r.stage==="screening")).toHaveLength(8);
    expect(plan.runs.every(r=>r.variant==="A"&&r.skills.length===0&&r.extensions.length===0)).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(root);
    expect(await taskCatalog(root)).toEqual(plan.tasks);
  });
  it("blocks live starts until approval, exact source and budget binding all match",async()=>{
    const plan=await createPlan(root);await expect(validateApproval(root,plan,budget(plan))).rejects.toThrow("approval_binding_missing");
    const approved={...plan,approved:true,runs:plan.runs.map(r=>({...r,route:{...r.route,auth_type:"oauth",billing_type:"subscription"}}))};
    expect((await validateApproval(root,approved,budget(approved))).manifest.approved).toBe(true);
    const changed={...approved,source_digest:`sha256:${"f".repeat(64)}`};
    await expect(validateApproval(root,changed,budget(changed))).rejects.toThrow("source_binding_changed");
    await expect(validateApproval(root,approved,{...budget(approved),manifest_digest:plan.source_digest})).rejects.toThrow("approval_binding_missing");
    expect(()=>budgetSchema.parse({...budget(approved),parallelism:2})).toThrow();
    expect(()=>budgetSchema.parse({...budget(approved),max_retries:1})).toThrow();
  });
  it("rejects client-like selection widening, stage expansion and new variants",async()=>{
    const plan=await createPlan(root),run=plan.runs[0]!;
    expect(()=>manifestSchema.parse({...plan,runs:[{...run,permission_profile:"coding"}]})).toThrow();
    expect(()=>manifestSchema.parse({...plan,runs:[...plan.runs,{...run,run_id:"extra"}]})).toThrow();
    expect(()=>manifestSchema.parse({...plan,runs:[{...run,cwd:"/host"}]})).toThrow();
    expect(()=>manifestSchema.parse({...plan,runs:[{...plan.runs[1]!,view:"reviewer"}]})).toThrow();
    expect(()=>manifestSchema.parse({...plan,runs:[{...run,variant:"C"}]})).toThrow();
  });
  it.each([
    {state:"completed",turnId,assistantText:'{"ok":',truncated:false},
    {state:"completed",turnId,assistantText:'{}',truncated:true},
    {state:"completed",turnId,assistantText:'tests pass',truncated:false},
    {state:"completed",turnId,assistantText:'null',truncated:false},
    {state:"failed",turnId}, {state:"aborted",turnId},
  ])("does not accept malformed, truncated or failed terminal receipts %#",turn=>expect(()=>receiptFromTurn(turn)).toThrow());
  it.skipIf(process.platform!=="linux")("never retries a mutation on a lost or invalid acknowledgement and closes resources",async()=>{
    const plan=await createPlan(root),run=plan.runs[1]!,out=await scratch();
    const fake=new ScriptedTransport({state:"completed",turnId,assistantText:'{"partial":',truncated:false});
    const result=await runOne(root,plan,run,budget(plan),out,fake);
    expect(fake.starts).toBe(1);expect(fake.closed).toBe(1);expect(result.task_status).not.toBe("PASS");expect(result.harness_status).toBe("FAIL");
    expect(result.cost_usd).toBeNull();expect(result.usage).toBeNull();expect(resultSchema.parse(result)).toEqual(result);
    for(const artifact of result.artifacts)expect(digest(JSON.parse(await readFile(join(out,artifact.path),"utf8")))).toBe(artifact.hash);
  });
  it.skipIf(process.platform!=="linux")("does not accept completed and exit zero without an independent oracle",async()=>{
    const plan=await createPlan(root),run=plan.runs[1]!,out=await scratch(),fake=new ScriptedTransport();
    const result=await runOne(root,plan,run,budget(plan),out,fake);
    expect(result.harness_status).toBe("PASS");expect(result.task_status).toBe("FAIL");expect(result.boundary_status).toBe("FAIL");
  });
  it("rejects output collisions before any session starts",async()=>{
    const plan=await createPlan(root),run=plan.runs[0]!,out=await scratch(),fake=new ScriptedTransport();
    await writeFile(join(out,`${run.run_id}.json`),"existing");
    await expect(runOne(root,plan,run,budget(plan),out,fake)).rejects.toThrow("output_collision");expect(fake.starts).toBe(0);
  });
  it.skipIf(process.platform!=="linux")("keeps two concurrent run copies, results and writes independent",async()=>{
    const plan=await createPlan(root),out=await scratch(),run=plan.runs[1]!;
    const fix=async(workspace:string)=>{await writeFile(join(workspace,"contract.mjs"),"export function parseLimit(v){const n=Number(v);return Number.isFinite(n)&&n>=0?n:20;}\n");};
    const a=new ScriptedTransport(undefined,fix), b=new ScriptedTransport(undefined,fix);
    const records=await Promise.all([runOne(root,plan,{...run,run_id:"parallel-a"},budget(plan),out,a),runOne(root,plan,{...run,run_id:"parallel-b"},budget(plan),out,b)]);
    expect(a.workspace).not.toBe(b.workspace);expect(records.map(r=>r.task_status)).toEqual(["PASS","PASS"]);
    expect(records.every(r=>r.observed_diff_scope.join() === "contract.mjs")).toBe(true);
    expect((await readdir(out)).filter(p=>p.endsWith(".json")).sort()).toEqual([".owner","parallel-a.json","parallel-b.json"].filter(p=>p.endsWith(".json")));
  });
  it("observes changes beyond scope, including symlinks, without following them",async()=>{
    const temp=await scratch(),w=join(temp,"w");await mkdir(w);await writeFile(join(temp,"canary"),"unchanged");const before=await snapshot(w);
    await symlink(join(temp,"canary"),join(w,"link"));
    expect(changedPaths(before,await snapshot(w))).toEqual(["link"]);expect(await readFile(join(temp,"canary"),"utf8")).toBe("unchanged");
    await expect(copyFixture(w,join(temp,"copy"))).rejects.toThrow("fixture_symlink");
  });
  it.skipIf(process.platform!=="linux")("fails closed when the final diff becomes unreadable during cleanup",async()=>{
    const plan=await createPlan(root),run=plan.runs[1]!,out=await scratch();
    const fake=new ScriptedTransport(undefined,async w=>{await writeFile(join(w,"contract.mjs"),"export function parseLimit(v){const n=Number(v);return Number.isFinite(n)&&n>=0?n:20;}");});
    fake.close=async()=>{await rm(fake.workspace,{recursive:true});return true;};
    const r=await runOne(root,plan,run,budget(plan),out,fake);
    expect(r.harness_status).toBe("INCONCLUSIVE");expect(r.task_status).toBe("INCONCLUSIVE");expect(r.blockers).toContain("diff_unreadable");
  });
  it("stops every remaining combination when oracle cleanup is unverified",async()=>{
    const plan=await createPlan(root),approved={...plan,approved:true,runs:plan.runs.map(r=>({...r,route:{...r.route,auth_type:"oauth",billing_type:"subscription"}}))},out=await scratch();
    vi.spyOn(oracleProcess,"evaluateBounded").mockRejectedValue(Object.assign(new Error("oracle_cleanup_unverified"),{code:"oracle_cleanup_unverified"}));
    let starts=0;
    const results=await runLive(root,approved,budget(approved),out,undefined,()=>{starts++;return new ScriptedTransport();});
    expect(starts).toBe(1);expect(results[0]?.blockers).toContain("process_cleanup_unverified");
    expect(results.slice(1).every(r=>r.started_at===null&&r.harness_status==="BLOCKED")).toBe(true);
  });
  it("compares exact routes independently and requires two accepted repetitions",async()=>{
    const plan=await createPlan(root),base=await emptyResult(root,plan,plan.runs[0]!);
    const accepted={...base,started_at:new Date().toISOString(),harness_status:"PASS" as const,task_status:"PASS" as const};
    const failed={...accepted,run_id:"failed-sol",requested_route:{...base.requested_route,model:"gpt-6.1-sol"},task_status:"FAIL" as const};
    const rows=comparison([accepted,{...accepted,run_id:"repeat",repetition:2},failed]);
    expect(rows).toHaveLength(2);expect(rows.find(r=>r.route.model==="gpt-6-luna")?.decision).toBe("restricted");expect(rows.find(r=>r.route.model==="gpt-6.1-sol")?.decision).toBe("rejected-for-scope");
    expect(comparison([accepted])[0]?.decision).toBe("blocked-not-established");
  });
  it("interrupts an in-flight call on abort, with no retry and observed close",async()=>{
    const plan=await createPlan(root),run=plan.runs[0]!,out=await scratch(),controller=new AbortController();
    const fake=new ScriptedTransport();fake.call=vi.fn(async()=>{controller.abort();return new Promise<Record<string,unknown>>(()=>undefined);});
    const result=await runOne(root,plan,run,budget(plan),out,fake,controller.signal);
    expect(fake.closed).toBe(1);expect(result.task_status).not.toBe("PASS");expect(result.blockers).toContain("controller_abort");
  });
});
