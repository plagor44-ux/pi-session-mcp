// Provider-free proposal generation. This never writes an approved manifest.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createPlan} from '../../../.profile-eval/eval/profiles/catalog.js';
import {inventory} from '../../../.profile-eval/eval/profiles/inventory.js';
import {digest} from '../../../.profile-eval/eval/profiles/files.js';
import {manifestSchema} from '../../../.profile-eval/eval/profiles/schemas.js';
import {validateApproval} from '../../../.profile-eval/eval/profiles/runner.js';
const root=process.cwd(),output=resolve(process.argv[2]??'docs/evaluation/plan-continuation-2026-10-17');
const client=JSON.parse(await readFile(join(homedir(),'.claude.json'),'utf8'));
const config=client.mcpServers['pi-session-mcp'].env.PI_SESSION_MCP_CONFIG;
const metadata=await inventory(config),base=await createPlan(root);
const selected=base.runs.filter(r=>r.route.provider!=='deepseek');
const manifest=manifestSchema.parse({...base,approved:false,runs:selected.map((run,i)=>{
 const actual=metadata.profiles.find(p=>p.provider===run.route.provider&&p.model===run.route.model&&p.effort===run.route.effort);
 if(!actual?.provider_registered||!actual.model_registered||!actual.credential_metadata_present||actual.auth_type!=='oauth'||actual.billing_type!=='subscription')throw Error('route_metadata_prerequisite_missing');
 return {...run,run_id:`rescreen-${i+1}`,route:{...run.route,auth_type:'oauth',billing_type:'subscription'}};
})});
const budget={schema_version:'1.0.0',approved:false,manifest_digest:digest(manifest),max_starts:6,max_retries:0,parallelism:1,run_timeout_ms:180000,total_timeout_ms:1080000,advisory_usd:5,provider_cap_usd:null,acknowledges_unmetered_cost:true};
let blocked=false;
try{await validateApproval(root,manifest,{...budget,approved:true});}catch(e){blocked=e.message==='approval_binding_missing';}
if(!blocked)throw Error('unapproved_proposal_not_blocked');
// Check the complete structural/source binding with in-memory approval fixtures.
// These objects are discarded and cannot authorize any model execution.
const approvedFixture={...manifest,approved:true};
await validateApproval(root,approvedFixture,{...budget,approved:true,manifest_digest:digest(approvedFixture)});
await mkdir(output,{recursive:true});
for(const [name,value] of Object.entries({'manifest.proposed.json':manifest,'budget.proposed.json':budget,'inventory.json':metadata,'proposal-validation.json':{status:'PASS',manifest_approved:false,budget_approved:false,unapproved_live_gate:'BLOCKED',hypothetical_approved_structure_and_source:'PASS',model_starts:0,provider_calls:0,notes:['Approval fixture objects existed only in memory during validation.','Operator authorization must precede setting approved and recomputing the budget manifest digest.','No connectivity or authentication-validity probe was made.']}}))await writeFile(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:'PROPOSED_NOT_APPROVED',starts:manifest.runs.length,advisory_usd:5,source_digest:manifest.source_digest,provider_calls:0}));
