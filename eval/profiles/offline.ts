import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPlan, roleViews } from "./catalog.js";
import { emptyResult } from "./runner.js";
import { comparison } from "./comparison.js";
import { VERSION } from "./schemas.js";
import { ownedTemporary, digest } from "./files.js";
const exec=promisify(execFile);
export const offlineFiles=[
  "test/profile-oracles.test.ts","test/profile-boundaries.test.ts","test/profile-evaluation.test.ts","test/profile-evaluation-stdio.test.ts","test/profile-oracle-process.test.ts",
  "test/mcp-contract.test.ts","test/mcp-stdio-e2e.test.ts","test/mcp-session-tools.test.ts",
  "test/sdk-pi-adapter.test.ts","test/sdk-contract.test.ts","test/sdk-failure-recovery.test.ts",
  "test/pi-skills.test.ts","test/pi-extensions.test.ts","test/sdk-extension-contract.test.ts",
  "test/process-stdin-eof.test.ts","test/lifecycle-hardening.test.ts","test/shutdown.test.ts",
];
export async function runOffline(root:string,output:string) {
  const temp=await ownedTemporary(),report=join(temp.root,"vitest.json"),start=Date.now();
  let exit=0;
  try{await exec(process.execPath,[join(root,"node_modules/vitest/vitest.mjs"),"run",...offlineFiles,"--reporter=json",`--outputFile=${report}`],{
    cwd:root,timeout:180000,maxBuffer:1024*1024,
    env:{PATH:process.env.PATH??"",PI_CODING_AGENT_DIR:join(temp.root,"agent"),NODE_OPTIONS:"--unhandled-rejections=strict"},
  });}catch{exit=1;}
  type Summary={numTotalTests:number;numPassedTests:number;numFailedTests:number;numPendingTests:number;success:boolean};
  let summary:Summary|null=null;
  try{const raw=JSON.parse(await readFile(report,"utf8")) as Summary; if(raw)summary={numTotalTests:raw.numTotalTests,numPassedTests:raw.numPassedTests,numFailedTests:raw.numFailedTests,numPendingTests:raw.numPendingTests,success:raw.success};}catch{exit=1;}
  if(!summary?.success)exit=1;
  const plan=await createPlan(root), records=await Promise.all(plan.runs.map(async(run)=>{
    const r=await emptyResult(root,plan,run);r.harness_status="BLOCKED";return r;
  }));
  const coverage=JSON.parse(await readFile(join(root,"test/fixtures/profile-evaluation/coverage.json"),"utf8")) as unknown;
  const evidence={schema_version:VERSION,kind:"provider-free-harness-tests",server_commit:plan.server_commit,source_digest:plan.source_digest,
    harness_status:exit===0?"PASS":"FAIL",exit_code:exit,summary,checks:offlineFiles.map(file=>({file})),
    duration_ms:Date.now()-start,model_starts:0,provider_calls:0,provider_call_scope:"external-paid-providers",scripted_loopback_endpoints:true,coverage,
    records,comparison:comparison(records),role_views:roleViews,limits:["No live quality ranking","No OS sandbox","Inner-method authorization absent","No observed controlled compaction","No live UI verification"]};
  await writeFile(join(output,"offline.json"),JSON.stringify(evidence,null,2)+"\n",{flag:"wx",mode:0o600});
  await writeFile(join(output,"manifest.json"),JSON.stringify(plan,null,2)+"\n",{flag:"wx",mode:0o600});
  await writeFile(join(output,"budget.proposed.json"),JSON.stringify({schema_version:VERSION,approved:false,manifest_digest:digest(plan),max_starts:8,max_retries:0,parallelism:1,run_timeout_ms:180000,total_timeout_ms:1440000,advisory_usd:5,provider_cap_usd:null,acknowledges_unmetered_cost:false},null,2)+"\n",{flag:"wx",mode:0o600});
  // No raw Vitest report is persisted: it contains local paths and full assertion text.
  await temp.remove();
  return evidence;
}
