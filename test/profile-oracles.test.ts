import { describe, expect, it } from 'vitest';
import { mkdtemp, cp, writeFile, rm, access, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, sourceBinding, digest, hash } from "../eval/profiles/files.js";
import { evaluateTask, taskDefinitions } from '../eval/profiles/oracles.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (id:string) => path.join(repo,'eval','fixtures',id);
describe('profile task oracle contract', () => {
  it('defines T1-T9 with bounded scopes and prompt-facing evidence fields', () => {
    expect(taskDefinitions.map(t=>t.id)).toEqual(['T1','T2','T3','T4','T5','T6','T7','T8','T9']);
    expect(taskDefinitions.every(t=>t.allowed_paths.every(p=>!path.isAbsolute(p)))).toBe(true);
    expect(taskDefinitions.find(t=>t.id==='T1')?.allowed_paths).toEqual([]);
    expect(taskDefinitions.find(t=>t.id==='T2')?.allowed_paths).toEqual(['contract.mjs']);
    expect(taskDefinitions.find(t=>t.id==='T4')?.allowed_paths).toEqual(['src/tax.mjs']);
    expect(taskDefinitions.find(t=>t.id==='T3')?.allowed_paths).toEqual(['src/App.jsx','src/style.css']);
  });
  it('rejects keyword-only T1 answers and accepts cited source contradictions', async () => {
    const root=await mkdtemp(path.join(tmpdir(),'profile-t1-'));
    try {
      await cp(path.join(fixture('T1'),'public'),root,{recursive:true});
      expect((await evaluateTask('T1',root,{})).status).toBe('FAIL');
      const receipt={claims:[{id:'api-data-flow',paths:['src/api/records.ts','src/services/records.ts','src/data/record-store.ts'],symbols:['handle','getRecord','recordStore.findById'],text:'flow'},{id:'stale-doc',paths:['README.md','src/api/records.ts'],document_status:200,source_status:404,text:'README claims HTTP 200; route returns HTTP 404'}]};
      expect((await evaluateTask('T1',root,receipt)).status).toBe('PASS');
      expect((await evaluateTask('T1',root,{claims:[receipt.claims[0],{...receipt.claims[1],document_status:404,source_status:200}]})).status).toBe('FAIL');
      expect((await evaluateTask('T1',root,{claims:[...receipt.claims,{id:'imaginary-helper',paths:[],symbols:['inventedFunction'],text:'inventedFunction exists'}]})).status).toBe('FAIL');
      const containerOnly={...receipt.claims[0],symbols:['handle','getRecord','recordStore']};
      expect((await evaluateTask('T1',root,{claims:[containerOnly,receipt.claims[1]]})).checks.find(c=>c.id==='api-data-flow')?.status).toBe('FAIL');
      const reversedFlow={...receipt.claims[0],paths:[...receipt.claims[0]!.paths].reverse()};
      expect((await evaluateTask('T1',root,{claims:[reversedFlow,receipt.claims[1]]})).checks.find(c=>c.id==='api-data-flow')?.status).toBe('FAIL');
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it('independent T2 test fails before and passes after reference behavior is applied', async () => {
    const root=await mkdtemp(path.join(tmpdir(),'profile-t2-'));
    try {
      await cp(path.join(fixture('T2'),'public'),root,{recursive:true});
      expect((await evaluateTask('T2',root,{})).status).toBe('FAIL');
      const file=path.join(root,'contract.mjs');
      await writeFile(file,"process.exit(0);\n");
      const premature=await evaluateTask('T2',root,{});
      expect(premature.status).toBe('FAIL');
      expect(premature.checks[0]?.reason).toMatch(/without completing all assertions/);
      await writeFile(file,"export function parseLimit(value) { const parsed=Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20; }\n");
      expect((await evaluateTask('T2',root,{})).status).toBe('PASS');
      const reviewer={reviewed_files:['contract.mjs'],target_hash:'a'.repeat(64),findings:[]};
      expect((await evaluateTask('T2',root,reviewer,undefined,'reviewer')).status).toBe('PASS');
      expect((await evaluateTask('T2',root,{...reviewer,findings:[{path:'contract.mjs',line:1,summary:'broken',preconditions:'bad value',impact:'bad'}]},undefined,'reviewer')).status).toBe('FAIL');
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it('independent T4 test fails before and passes after root cause correction', async () => {
    const root=await mkdtemp(path.join(tmpdir(),'profile-t4-'));
    try {
      await cp(path.join(fixture('T4'),'public'),root,{recursive:true});
      expect((await evaluateTask('T4',root,{})).status).toBe('FAIL');
      const symptom=path.join(root,'src/checkout.mjs');
      await writeFile(symptom,"import { subtotal } from './price.mjs';\nexport function charge(items, taxRate) { return subtotal(items) * (1 + taxRate); }\n");
      expect((await evaluateTask('T4',root,{})).status).toBe('FAIL');
      const file=path.join(root,'src/tax.mjs');
      await writeFile(file,"process.exit(0);\n");
      const premature=await evaluateTask('T4',root,{});
      expect(premature.status).toBe('FAIL');
      expect(premature.checks[0]?.reason).toMatch(/without completing all assertions/);
      await writeFile(file,"export function addTax(subtotal, taxRate) { return subtotal === 0 ? 0 : subtotal * (1 + taxRate); }\n");
      expect((await evaluateTask('T4',root,{})).status).toBe('PASS');
      const reviewer={reviewed_files:['src/tax.mjs'],target_hash:'b'.repeat(64),findings:[]};
      expect((await evaluateTask('T4',root,reviewer,undefined,'reviewer')).status).toBe('PASS');
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it('rejects weak T5 matches, requires both defects, and counts clean-case false positives', async () => {
    const root=await mkdtemp(path.join(tmpdir(),'profile-t5-'));
    try {
      await cp(path.join(fixture('T5'),'public'),root,{recursive:true});
      const receipt={findings:[{path:'handler.ts',line:2,summary:'tenant scope missing',preconditions:'attacker supplies another tenant id',impact:'cross-tenant disclosure'},{path:'token.ts',line:2,summary:'wildcard permission accepted',preconditions:'token includes * claim',impact:'authorization bypass'}],clean_cases:[{path:'clean.ts',status:'no finding'}]};
      expect((await evaluateTask('T5',root,{findings:[]})).status).toBe('FAIL');
      expect((await evaluateTask('T5',root,{findings:[{path:'handler.ts',line:99,summary:'tenant',preconditions:'x',impact:'x'}],clean_cases:[]})).status).toBe('FAIL');
      const evaluated=await evaluateTask('T5',root,receipt);
      expect(evaluated.status).toBe('PASS');
      expect(evaluated.metrics?.false_positives_on_clean_cases).toBe(0);
      expect(evaluated.metrics?.precision_numerator).toBe(2);
      expect(evaluated.metrics?.precision_denominator).toBe(2);
      const falsePositive=await evaluateTask('T5',root,{...receipt,findings:[...receipt.findings,{path:'clean.ts',line:1,summary:'made-up defect'}]});
      expect(falsePositive.status).toBe('FAIL');
      expect(falsePositive.metrics?.false_positives_on_clean_cases).toBe(1);
      expect(falsePositive.metrics?.false_positives).toBe(1);
      const unspecifiedStatus=await evaluateTask('T5',root,{...receipt,clean_cases:[{path:'clean.ts',status:'clean'}]});
      expect(unspecifiedStatus.checks.find(c=>c.id==='clean-counterexample')?.status).toBe('FAIL');
      const duplicateClean=await evaluateTask('T5',root,{...receipt,clean_cases:[...receipt.clean_cases,...receipt.clean_cases]});
      expect(duplicateClean.checks.find(c=>c.id==='clean-counterexample')?.status).toBe('FAIL');
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it('runs independent boundary probes for tester view and rejects gaps-by-keyword alone', async () => {
    const root=await mkdtemp(path.join(tmpdir(),'profile-t6-'));
    try {
      await cp(path.join(fixture('T6'),'public'),root,{recursive:true});
      expect((await evaluateTask('T6',root,{coverage_gaps:[]})).status).toBe('FAIL');
      const receipt={coverage_gaps:[{case:'zero',test:'formatPage(0)'},{case:'negative',test:'formatPage(-1)'},{case:'non-integer',test:'formatPage(1.5)'},{case:'maximum',test:'formatPage(100)'}]};
      expect((await evaluateTask('T6',root,receipt)).status).toBe('PASS');
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it('requires source-linked T7/T8 claims and keeps compaction blocked', async () => {
    const root=await mkdtemp(path.join(tmpdir(),'profile-read-'));
    try {
      await cp(path.join(fixture('T7'),'public'),root,{recursive:true});
      const good={findings:[{path:'compose.yaml',line:4,claim:'relative mount config path may be missing'},{path:'start.sh',line:3,claim:'echo masks the server failure exit status'}],summary:'Static analysis only; no claim about live host state.'};
      expect((await evaluateTask('T7',root,good)).status).toBe('PASS');
      expect((await evaluateTask('T7',root,{findings:[{path:'compose.yaml',line:99,claim:'host is compromised'}]})).status).toBe('FAIL');
      expect((await evaluateTask('T7',root,{...good,summary:'The current host is compromised.'})).status).toBe('FAIL');
    } finally { await rm(root,{recursive:true,force:true}); }
    const docRoot=await mkdtemp(path.join(tmpdir(),'profile-t8-'));
    try {
      await cp(path.join(fixture('T8'),'public'),docRoot,{recursive:true});
      const good={claims:[{source:'adr.md',revision:2,date:'2026-10-10',text:'Proposed append-only'},{source:'runbook.md',revision:1,date:'2026-10-12',text:'in-place replacement'}],summary:'The 2026-10-12 runbook is newer than the 2026-10-10 ADR; the sources conflict, and the runbook does not update the ADR Proposed status.'};
      expect((await evaluateTask('T8',docRoot,good)).status).toBe('PASS');
      expect((await evaluateTask('T8',docRoot,{...good,summary:'The sources agree.'})).status).toBe('FAIL');
      expect((await evaluateTask('T8',docRoot,{...good,claims:[{...good.claims[0],date:'2026-10-11'},good.claims[1]]})).status).toBe('FAIL');
    } finally { await rm(docRoot,{recursive:true,force:true}); }
    expect((await evaluateTask('T9','.',{})).status).toBe('BLOCKED');
    expect(await access(path.join(fixture('T9'),'public/README.md')).then(()=>true,()=>false)).toBe(true);
  });
  it('uses a real browser when local T3 tooling is installed; otherwise preserves BLOCKED', async () => {
    const source=path.join(fixture('T3'),'public');
    const baseline=await mkdtemp(path.join(tmpdir(),'profile-t3-before-'));
    await mkdir(path.join(repo,'eval/results'),{recursive:true});
    const artifacts=await mkdtemp(path.join(repo,'eval/results/ui-oracle-calibration-'));
    try {
      await cp(source,baseline,{recursive:true});
      const invariant=await snapshot(baseline);
      const before=await evaluateTask('T3',baseline,{},artifacts);
      expect(await snapshot(baseline)).toEqual(invariant);
      if (before.status==='BLOCKED') {
        expect(before.checks.some(c=>c.id==='browser-runtime'&&c.status==='BLOCKED')).toBe(true);
        return;
      }
      expect(before.status).toBe('FAIL');
      await writeFile(path.join(baseline,'src/style.css'),'main{box-sizing:border-box;width:min(900px,calc(100% - 32px));margin:24px auto}button:focus-visible{outline:3px solid #2457d6;outline-offset:3px}section{white-space:normal;overflow-wrap:anywhere}\n');
      const after=await evaluateTask('T3',baseline,{},artifacts);
      expect(after.status,JSON.stringify(after)).toBe('PASS');
      const screenshots=[];
      for (const file of ['T3-375.png','T3-1280.png']) {
        const contents=await readFile(path.join(artifacts,file));
        expect(contents.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
        screenshots.push({path:file,sha256:createHash('sha256').update(contents).digest('hex')});
      }
      const binding=await sourceBinding(repo);
      const evidence={server_commit:binding.commit,source_digest:binding.digest,fixture_hash:digest(await snapshot(source)),reference_css_hash:hash(await readFile(path.join(baseline,'src/style.css'))),kind:'provider_free_reference_calibration_not_model_run',task_id:'T3',observed_at:new Date().toISOString(),fixture_revision:'synthetic-T3',before:{status:before.status,checks:before.checks},after:{status:after.status,checks:after.checks},tooling:{vite:'6.4.4',react:'18.3.1',react_dom:'18.3.1',playwright:'1.60.0-alpha-1775584683000',browser_channel:process.env.PI_PROFILE_EVAL_CHROMIUM_EXECUTABLE?'explicit-executable':'playwright-chromium'},screenshots};
      await writeFile(path.join(artifacts,'result.json'),`${JSON.stringify(evidence,null,2)}\n`,{flag:'wx'});
      const ui=path.join(baseline,'src/App.jsx');await writeFile(ui,(await readFile(ui,'utf8')).replace("'Synthetic record '.repeat(24)","'Synthetic record'"));
      const shortened=await evaluateTask('T3',baseline,{},path.join(artifacts,'rejected-short-content'));
      expect(shortened.status).toBe('FAIL');expect(shortened.checks.some(c=>c.id.endsWith('long-content-preserved')&&c.status==='FAIL')).toBe(true);
    } finally { await rm(baseline,{recursive:true,force:true}); }
  },30000);
});
