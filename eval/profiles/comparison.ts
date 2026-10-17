import type { Result } from "./schemas.js";
import { digest } from "./files.js";
export function comparison(records:Result[]) {
  const groups=new Map<string,Result[]>();
  for(const r of records){
    const key=digest({stage:r.stage,profile_id:r.profile_id,view:r.view,route:r.requested_route,permission:r.permission_profile,skills:r.skills,extensions:r.extensions,task_id:r.task_id});
    groups.set(key,[...groups.get(key)??[],r]);
  }
  return [...groups.entries()].map(([combination,runs])=>{
    const first=runs[0]!,started=runs.filter(r=>r.started_at!==null),accepted=started.filter(r=>r.harness_status==="PASS"&&r.task_status==="PASS");
    const rejected=started.some(r=>r.task_status==="FAIL"||r.observed_diff_scope.some(p=>!r.expected_diff_scope.includes(p)));
    const twoRepetitions=new Set(accepted.map(r=>r.repetition)).size===2;
    const durations=started.map(r=>r.duration_ms).filter((n):n is number=>n!==null);
    return {combination,stage:first.stage,profile_id:first.profile_id,view:first.view,task_id:first.task_id,route:first.requested_route,
      skills:first.skills,extensions:first.extensions,planned:runs.length,started:started.length,accepted:accepted.length,blocked:runs.filter(r=>r.harness_status==="BLOCKED").length,
      two_repetitions_accepted:twoRepetitions,
      critical_scope_errors:started.filter(r=>r.blockers.includes("observed_scope_violation")).map(r=>r.run_id),
      duration_ms:durations.length?durations.reduce((a,b)=>a+b,0):null,
      controller_calls:started.length?started.reduce((a,r)=>a+r.controller_calls,0):null,
      tool_errors:null,manual_rework:null,cost_per_accepted_usd:null,cost_reason:"not-exposed-by-mcp",
      seed_detected:started.length?started.reduce((a,r)=>a+(r.metrics.seed_findings_detected??0),0):null,
      seed_total:started.length?started.reduce((a,r)=>a+(r.metrics.seed_findings_total??0),0):null,
      confirmed_findings:started.length?started.reduce((a,r)=>a+(r.metrics.confirmed_findings??0),0):null,
      all_findings:started.length?started.reduce((a,r)=>a+(r.metrics.all_findings??0),0):null,
      false_positives_on_clean_cases:started.length?started.reduce((a,r)=>a+(r.metrics.false_positives_on_clean_cases??0),0):null,
      decision:rejected?"rejected-for-scope":twoRepetitions?"restricted":"blocked-not-established"};
  });
}
