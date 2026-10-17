// Read-only live artifact validation; never starts an evaluation or provider.
import assert from 'node:assert/strict';
import {readFile,readdir,lstat,access,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sourceBinding,hash,digest,snapshot} from '../../../.profile-eval/eval/profiles/files.js';
import {manifestSchema,budgetSchema,resultSchema} from '../../../.profile-eval/eval/profiles/schemas.js';
import {comparison} from '../../../.profile-eval/eval/profiles/comparison.js';
const root=process.cwd();
const raw='eval/results/live-rescreen-0e7491cd-68b7-400d-b738-489f9b9b6d67';
const archive='docs/evaluation/live-rescreen-2026-10-17';
const manifest=manifestSchema.parse(JSON.parse(await readFile(join(archive,'approved-manifest.json'),'utf8')));
const budget=budgetSchema.parse(JSON.parse(await readFile(join(archive,'approved-budget.json'),'utf8')));
const source=await sourceBinding(root);
assert.equal(source.digest,manifest.source_digest);assert.equal(source.commit,manifest.server_commit);
assert.equal(budget.manifest_digest,digest(manifest));assert.equal(manifest.runs.length,6);
assert.equal(budget.max_starts,6);assert.equal(budget.parallelism,1);assert.equal(budget.max_retries,0);
const entries=await readdir(join(raw,'runs'));
const claims=entries.filter(n=>n.endsWith('.claim'));
assert.ok(claims.length<=6);
const results=[],artifacts=[],diagnostics=[];
for(const run of manifest.runs){
 const record=resultSchema.parse(JSON.parse(await readFile(join(raw,'runs',run.run_id+'.json'),'utf8')));
 assert.equal(record.run_id,run.run_id);assert.equal(record.task_id,run.task_id);assert.equal(record.task_hash,run.task_hash);
 assert.equal(record.stage,'screening');assert.equal(record.source_digest,manifest.source_digest);
 assert.equal(record.server_commit,manifest.server_commit);assert.equal(record.repetition,run.repetition);
 assert.equal(record.profile_id,run.profile_id);assert.equal(record.view,run.view);assert.equal(record.permission_profile,run.permission_profile);
 assert.deepEqual(record.expected_diff_scope,run.permission_profile==='read-only'?[]:manifest.tasks.find(t=>t.id===run.task_id).allowed_paths);
 assert.deepEqual(record.requested_route,run.route);assert.deepEqual(record.skills,[]);assert.deepEqual(record.extensions,[]);
 assert.ok(record.observed_diff_scope.every(p=>record.expected_diff_scope.includes(p)));
 assert.equal(record.profile_digest,digest({profile:run.profile_id,permission:run.permission_profile,route:run.route,skills:run.skills,extensions:run.extensions}));
 assert.equal(record.fixture_revision,manifest.tasks.find(t=>t.id===run.task_id).fixture_hash);
 assert.equal(record.cost_usd,null);assert.equal(record.usage,null);
 if(record.started_at!==null){
  assert.ok(claims.includes(run.run_id+'.claim'));
  assert.equal(await readFile(join(raw,'runs',run.run_id+'.claim'),'utf8'),digest({run_id:run.run_id,source:manifest.source_digest}));
  if(record.resolved_route!==null)assert.deepEqual(record.resolved_route,run.route);
  assert.ok(record.duration_ms<=budget.run_timeout_ms+15000);
  assert.equal(record.checks.find(c=>c.id==='observed-process-cleanup')?.status,'PASS');
 }
 if(record.harness_status==='PASS'){
  assert.equal(record.checks.find(c=>c.id==='session-cleanup')?.status,'PASS');
  assert.equal(record.checks.find(c=>c.id==='transport-route-binding')?.status,'PASS');
 }
 for(const artifact of record.artifacts){
  const target=join(raw,'runs',artifact.path),st=await lstat(target);assert.ok(!st.isSymbolicLink());
  const actual=st.isDirectory()?digest(await snapshot(target)):hash(await readFile(target));assert.equal(actual,artifact.hash);
  artifacts.push({run_id:run.run_id,...artifact});
 }
 let retained=false;
 if(record.started_at!==null){
  assert.ok(record.scope_id.startsWith('pi-profile-eval-'));
  try{await access(join(tmpdir(),record.scope_id));retained=true;}catch(e){assert.equal(e.code,'ENOENT');}
 }else assert.equal(record.scope_id,'not-created');
 if(record.task_status==='PASS'&&record.harness_status==='PASS')assert.equal(retained,false);
 diagnostics.push({run_id:run.run_id,scope_id:record.scope_id,temporary_fixture_retained:retained});
 results.push(record);
}
const started=results.filter(r=>r.started_at!==null),accepted=started.filter(r=>r.harness_status==='PASS'&&r.task_status==='PASS');
assert.equal(started.length,claims.length);
assert.equal(new Set(started.map(r=>r.scope_id)).size,started.length);
for(let i=1;i<started.length;i++)assert.ok(Date.parse(started[i].started_at)>=Date.parse(started[i-1].ended_at));
const first=started[0],last=started.at(-1);
const interval=first&&last?Date.parse(last.ended_at)-Date.parse(first.started_at):0;
assert.ok(interval<=budget.total_timeout_ms+15000);
assert.deepEqual(JSON.parse(await readFile(join(raw,'runs/comparison.json'),'utf8')),comparison(results));
const routes=[];
for(const run of manifest.runs){
 if(routes.some(r=>digest(r.route)===digest(run.route)))continue;
 const matching=results.filter(r=>digest(r.requested_route)===digest(run.route));
 const pass=matching.filter(r=>r.harness_status==='PASS'&&r.task_status==='PASS');
 const review=run.profile_id==='P3';
 const qualified=review?new Set(pass.filter(r=>r.task_id==='T5').map(r=>r.repetition)).size===2:['T1','T2'].every(t=>pass.some(r=>r.task_id===t));
 routes.push({route:run.route,screening_gate:qualified?'PASS':'FAIL',eligible_for_separately_approved_pilot:qualified,evidence_run_ids:pass.map(r=>r.run_id),limitations:['Screening eligibility is not two-repeat role qualification or production approval.','Coding profiles have no OS file-scope boundary.']});
}
const audit={kind:'six-start-live-rescreen-audit',status:'PASS',source_binding:source,approved_manifest_digest:digest(manifest),claims:claims.length,started:started.length,accepted:accepted.length,rejected:started.filter(r=>r.task_status==='FAIL').length,blocked:results.filter(r=>r.harness_status==='BLOCKED').length,harness_passed:started.filter(r=>r.harness_status==='PASS').length,sequential_intervals_verified:true,unique_scopes_verified:true,artifacts,diagnostics,route_screening:routes,measured_interval_ms:interval,cost_usd:null,usage:null,cost_reason:'not-exposed-by-mcp',scope_violations:results.filter(r=>r.blockers.includes('observed_scope_violation')).map(r=>r.run_id),model_starts_beyond_approved_matrix:0,live_starts_used_across_authorized_waves:8+started.length,planning_envelope_remaining_if_30_total:30-8-started.length,limitations:['No raw model receipt archived; exact rejected response content cannot be reconstructed.','Cleanup covers observed sessions and process identities, not OS containment.','SDK-internal provider retries and provider cost/quota are not metered.']};
await writeFile(join(archive,'audit.json'),JSON.stringify(audit,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:audit.status,started:audit.started,accepted:audit.accepted,harness_passed:audit.harness_passed,route_screening:routes.map(r=>({model:r.route.model,screening_gate:r.screening_gate}))}));
