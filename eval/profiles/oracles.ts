import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ownedTemporary } from "./files.js";
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export type CheckStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN' | 'INCONCLUSIVE';
export interface TaskDefinition {
  id: string; title: string; family: string; profiles: string[]; views: string[];
  allowed_paths: string[]; prompt: string; oracle_kind: string;
}
export const taskDefinitions: TaskDefinition[] = [
  {id:'T1',title:'Codebase explanation',family:'code-understanding',profiles:['P1'],views:['scout','docs-writer'],allowed_paths:[],prompt:'Return one JSON object with a claims array containing exactly two claims: {id:"api-data-flow",paths:[...],symbols:[...],text} and {id:"stale-doc",paths:[...],document_status:number,source_status:number,text}. For api-data-flow, paths must contain exactly three source paths in execution order: API handler file, service file, data-store file. symbols must contain exactly three entries: the API handler function name, the service function name, and the data-store lookup in Object.method notation. Omit container objects, imported aliases, Map methods and other local helpers. Derive the names and paths from source. For stale-doc, cite README.md and src/api/records.ts and use numeric HTTP status values. Do not modify files.',oracle_kind:'source-and-receipt'},
  {id:'T2',title:'Backend contract fix',family:'backend-fix',profiles:['P2','P3'],views:['implementer','reviewer'],allowed_paths:['contract.mjs'],prompt:'Implementer: fix parseLimit so negative values use the default and preserve valid values, then answer with exactly one JSON object {changed_files:[...],summary} and no other text. Reviewer: inspect the supplied immutable fixed diff and return {reviewed_files:[...],target_hash,findings:[{path,line,summary,preconditions,impact}]}; include the exact changed path and supplied target hash, with an empty findings array when no defect remains. No edits in reviewer view.',oracle_kind:'external-test-and-review'},
  {id:'T3',title:'Responsive accessible UI',family:'ui',profiles:['P4'],views:['ui-writer'],allowed_paths:['src/App.jsx','src/style.css'],prompt:'Fix narrow viewport overflow and visible keyboard focus. Verify 375px and 1280px viewports, keyboard focus, and the visible error alert before and after activating Refresh. Save screenshots for both viewports.',oracle_kind:'browser-execution'},
  {id:'T4',title:'Multi-module debugging',family:'debugging',profiles:['P2','P3'],views:['implementer','reviewer'],allowed_paths:['src/tax.mjs'],prompt:'Implementer: fix checkout tax calculation at its cause in src/tax.mjs; include the empty-cart counterexample. Reviewer: inspect the supplied immutable fixed diff and return {reviewed_files:[...],target_hash,findings:[{path,line,summary,preconditions,impact}]}; include the exact changed path and supplied target hash, with an empty findings array when no defect remains. No edits in reviewer view.',oracle_kind:'external-test-and-review'},
  {id:'T5',title:'Independent security review',family:'review',profiles:['P3'],views:['reviewer'],allowed_paths:[],prompt:'Return one JSON object with findings [{path,line,summary,preconditions,impact}] and clean_cases [{path,status}]. Provide one finding per defect, with a source line, preconditions and impact. Assess clean.ts exactly once in clean_cases. For a file with no finding, use exactly status:"no finding"; do not also report a finding on a file assessed as clean. Review sources read-only.',oracle_kind:'structured-findings'},
  {id:'T6',title:'Regression test gap',family:'testing',profiles:['P4'],views:['tester'],allowed_paths:[],prompt:'Return coverage_gaps [{case,test}] for zero, negative, non-integer and maximum input values. Give each executable call, report product_code_changed:false, and do not change product code.',oracle_kind:'test-execution-and-coverage'},
  {id:'T7',title:'Infrastructure source review',family:'infrastructure-review',profiles:['P1'],views:['scout'],allowed_paths:[],prompt:'Return findings [{path,line,claim,impact}]. Identify the relative config mount and shell failure-propagation risks using source citations. Do not assert current host, production or live state; perform no operations.',oracle_kind:'source-and-receipt'},
  {id:'T8',title:'Evidence-based documentation draft',family:'documentation',profiles:['P1'],views:['docs-writer'],allowed_paths:[],prompt:'Return claims [{source,revision,date,text}] and summary. Cite ADR revision 2 dated 2026-10-10 and runbook revision 1 dated 2026-10-12 in chronological order, preserve Proposed status, explain their conflict and uncertainty, and state the newer runbook does not change ADR status. Do not publish.',oracle_kind:'source-and-receipt'},
  {id:'T9',title:'Observed compaction continuation',family:'context-continuation',profiles:['P1','P2'],views:['scout','implementer'],allowed_paths:[],prompt:'Use README.md as the read-only handoff context. Only evaluate after the harness observes and records an actual compaction event; retain objective, ownership, prohibitions and pending checks without repeating a completed mutation.',oracle_kind:'observed-compaction-event'},
];
const result = (status: CheckStatus, checks: Array<{id:string;status:CheckStatus;exit_code:number|null;reason?:string}>) => ({status, checks});
const pass = (id:string) => ({id,status:'PASS' as const,exit_code:0});
const fail = (id:string,reason:string) => ({id,status:'FAIL' as const,exit_code:1,reason});
const bounded = <T>(promise:Promise<T>, milliseconds:number, label:string):Promise<T> => new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error(`${label} timed out`)),milliseconds);
  promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});

export async function evaluateTask(taskId: string, workspace: string, receipt: unknown, artifactsRoot?: string, view?: string): Promise<{status:CheckStatus;checks:Array<{id:string;status:CheckStatus;exit_code:number|null;reason?:string}>;metrics?:Record<string,number|null>}> {
  const task = taskDefinitions.find(item => item.id === taskId);
  if (!task) return result('NOT_RUN',[{id:'known-task',status:'NOT_RUN',exit_code:null,reason:'Unknown task id'}]);
  if (taskId === 'T9') return result('BLOCKED',[{id:'compaction-event',status:'BLOCKED',exit_code:null,reason:'No observable controlled compaction event was supplied.'}]);
  const r = receipt && typeof receipt === 'object' ? receipt as Record<string,unknown> : {};
  if (taskId === 'T3') {
    type BrowserPage = {goto:(url:string,options?:{timeout?:number})=>Promise<unknown>;evaluate:<T>(fn:()=>T)=>Promise<T>;keyboard:{press:(key:string)=>Promise<void>};locator:(s:string)=>{isVisible:()=>Promise<boolean>;evaluate:<T>(fn:(el:HTMLElement)=>T)=>Promise<T>;click:(options?:{timeout?:number})=>Promise<void>;textContent:()=>Promise<string|null>};screenshot:(o:{path:string;fullPage:boolean})=>Promise<void>;close:()=>Promise<void>};
    type LocalBrowser = {newPage:(options:Record<string,unknown>)=>Promise<BrowserPage>;close:()=>Promise<void>};
    type LocalServer = {listen:()=>Promise<void>;close:()=>Promise<void>;httpServer:{address:()=>{port:number}|string|null}};
    let server: LocalServer | undefined;
    let browser: LocalBrowser | undefined;
    const cache=await ownedTemporary();
    let phase='resolve local browser tooling';
    const checks: Array<{id:string;status:CheckStatus;exit_code:number|null;reason?:string}> = [];
    try {
      const tooling = path.resolve(process.cwd(),'eval/fixtures/T3/tooling/node_modules');
      const runtime=await import(pathToFileURL(path.resolve(tooling,'../runtime.mjs')).href) as {createServer:(options:Record<string,unknown>)=>Promise<LocalServer>;chromium:{launch:(options?:{channel?:string;executablePath?:string})=>Promise<LocalBrowser>}};
      const vite=runtime,playwright=runtime;
      const aliases=[{find:/^react\/(.+)$/,replacement:`${path.resolve(tooling,'react')}/$1`},{find:'react',replacement:path.resolve(tooling,'react')},{find:/^react-dom\/(.+)$/,replacement:`${path.resolve(tooling,'react-dom')}/$1`},{find:'react-dom',replacement:path.resolve(tooling,'react-dom')}];
      phase='start local Vite';
      server=await vite.createServer({root:workspace,configFile:false,cacheDir:path.join(cache.root,"vite-cache"),logLevel:"silent",resolve:{alias:aliases},optimizeDeps:{include:['react','react-dom/client']},server:{host:'127.0.0.1',port:0}}); await server.listen();
      const address=server.httpServer.address(); if (!address || typeof address==='string') throw new Error('Vite did not bind a TCP port');
      phase='launch Chromium';
      const executable=process.env.PI_PROFILE_EVAL_CHROMIUM_EXECUTABLE;
      browser=await playwright.chromium.launch(executable?{executablePath:executable}:{channel:'chromium'});
      phase='responsive browser assertions';
      for (const width of [375,1280]) {
        const page=await bounded(browser.newPage({viewport:{width,height:800}}),4000,'new page');
        try {
          phase=`viewport ${width} navigation`;
          await bounded(page.goto(`http://127.0.0.1:${address.port}`,{timeout:4000}),5000,'navigation');
          phase=`viewport ${width} application render`;
          const rendered=await bounded(page.evaluate(()=>Boolean(document.querySelector('#root')?.textContent?.trim())),3000,'render assertion');
          if (!rendered) {
            checks.push(fail(`viewport-${width}-app-render`,'Application root rendered no visible content.'));
            if (artifactsRoot) { await mkdir(artifactsRoot,{recursive:true}); phase=`viewport ${width} screenshot`; await bounded(page.screenshot({path:path.join(artifactsRoot,`T3-${width}.png`),fullPage:true}),5000,'screenshot'); }
            continue;
          }
          phase=`viewport ${width} layout`;
          const noOverflow=await bounded(page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),3000,'layout assertion');
          const longContent=await bounded(page.evaluate(()=>(document.querySelector('section')?.textContent?.split('Synthetic record').length??0)-1===24),3000,'long content assertion');
          checks.push(longContent?pass(`viewport-${width}-long-content-preserved`):fail(`viewport-${width}-long-content-preserved`,'The long synthetic fixture content was removed or shortened.'));
          phase=`viewport ${width} initial error visibility`;
          const alertBefore=await bounded(page.locator('[role="alert"]').isVisible(),3000,'error visibility');
          phase=`viewport ${width} initial error text`;
          const initialError=await bounded(page.locator('[role="alert"]').textContent(),3000,'error text');
          phase=`viewport ${width} keyboard focus`;
          await bounded(page.keyboard.press('Tab'),3000,'keyboard input');
          const focusVisible=await bounded(page.locator('button').evaluate(el=>{const s=getComputedStyle(el);return document.activeElement===el&&s.outlineStyle!=='none'&&Number.parseFloat(s.outlineWidth)>0;}),3000,'focus assertion');
          phase=`viewport ${width} refresh interaction`;
          await bounded(page.locator('button').click({timeout:2500}),3000,'button click');
          const alertAfter=await bounded(page.locator('[role="alert"]').isVisible(),3000,'post-refresh error visibility');
          const afterError=await bounded(page.locator('[role="alert"]').textContent(),3000,'post-refresh error text');
          checks.push(noOverflow?pass(`viewport-${width}-no-overflow`):fail(`viewport-${width}-no-overflow`,'Document overflows viewport.'),alertBefore&&/could not load records/i.test(initialError ?? '')?pass(`viewport-${width}-initial-error-visible`):fail(`viewport-${width}-initial-error-visible`,'Initial error alert is not visible.'),focusVisible?pass(`viewport-${width}-keyboard-focus`):fail(`viewport-${width}-keyboard-focus`,'Keyboard focus is not on the button or has no visible outline.'),alertAfter&&/retry failed/i.test(afterError ?? '')?pass(`viewport-${width}-error-after-refresh`):fail(`viewport-${width}-error-after-refresh`,'Refresh did not leave a visible retry-failed error.'));
          if (artifactsRoot) { await mkdir(artifactsRoot,{recursive:true}); phase=`viewport ${width} screenshot`; await bounded(page.screenshot({path:path.join(artifactsRoot,`T3-${width}.png`),fullPage:true}),5000,'screenshot'); }
        } finally { await bounded(page.close(),3000,'page close'); }
      }
      if (!artifactsRoot) checks.push({id:'screenshots',status:'BLOCKED',exit_code:null,reason:'Pass artifactsRoot to preserve viewport screenshots.'});
    } catch (error) { const assertionFailure=phase.startsWith('viewport '); checks.push({id:assertionFailure?'browser-assertions':'browser-runtime',status:assertionFailure?'FAIL':'BLOCKED',exit_code:assertionFailure?1:null,reason:`${phase} ${assertionFailure?'failed':'unavailable'} (${error instanceof Error ? error.name : 'unknown error'}).`}); }
    finally {
      if (browser) { try { await bounded(browser.close(),5000,'browser close'); } catch { checks.push({id:'browser-cleanup',status:'FAIL',exit_code:1,reason:'Browser close failed.'}); } }
      if (server) { try { await bounded(server.close(),5000,'Vite close'); } catch { checks.push({id:'vite-cleanup',status:'FAIL',exit_code:1,reason:'Vite server close failed.'}); } }
      await cache.remove();
    }
    const finalStatus=checks.some(c=>c.status==='FAIL')?'FAIL':checks.some(c=>c.status==='BLOCKED')?'BLOCKED':'PASS';
    return result(finalStatus,checks);
  }
  if (taskId === 'T2' || taskId === 'T4') {
    try {
      const { spawnSync } = await import('node:child_process');
      const candidate = taskId === 'T2' ? path.resolve(workspace,'contract.mjs') : path.resolve(workspace,'src/tax.mjs');
      const token=randomUUID();
      const assertions = taskId === 'T2'
        ? `const {parseLimit}=await import(${JSON.stringify(pathToFileURL(candidate).href)}); assert.equal(parseLimit(undefined),20); assert.equal(parseLimit('7'),7); assert.equal(parseLimit('invalid'),20); assert.equal(parseLimit('-2'),20);`
        : `const {charge}=await import(${JSON.stringify(pathToFileURL(path.resolve(workspace,'src/checkout.mjs')).href)}); const {addTax}=await import(${JSON.stringify(pathToFileURL(candidate).href)}); assert.equal(addTax(15,0.1),16.5); assert.equal(charge([{price:10},{price:5}],0.1),16.5); assert.equal(charge([],0.2),0);`;
      const expression = `import assert from 'node:assert/strict'; ${assertions} const {writeSync}=await import('node:fs'); writeSync(3,${JSON.stringify(token)});`;
      const test = spawnSync(process.execPath,['--input-type=module','-e',expression],{cwd:workspace,encoding:'utf8',timeout:10000,maxBuffer:64*1024,stdio:['ignore','pipe','pipe','pipe'],env:{PATH:process.env.PATH ?? '',TZ:'UTC'}});
      const completionOutput=test.output?.[3];
      const completed=completionOutput===token;
      if (test.status !== 0 || !completed) return result('FAIL',[fail('independent-regression-test',test.status !== 0 ? `External regression test exited ${String(test.status)}.` : 'External regression test exited zero without completing all assertions.')]);
      if (view==='reviewer') {
        const findings=Array.isArray(r.findings)?r.findings:undefined;
        const files=Array.isArray(r.reviewed_files)?r.reviewed_files.map(String):[];
        const target=taskId==='T2'?'contract.mjs':'src/tax.mjs';
        const fixedReceipt=findings?.length===0 && files.length===1 && files[0]===target && typeof r.target_hash==='string' && r.target_hash.length>=16;
        return result(fixedReceipt?'PASS':'FAIL',[pass('fixed-behavior-regression-test'),fixedReceipt?pass('reviewed-fixed-diff-scope'):fail('reviewed-fixed-diff-scope','Reviewer receipt must enumerate the changed file and report no findings on the fixed diff.')]);
      }
      return result('PASS',[pass('independent-regression-test')]);
    } catch { return result('INCONCLUSIVE',[{id:'independent-regression-test',status:'INCONCLUSIVE',exit_code:null,reason:'Could not run independent test.'}]); }
  }
  if (taskId === 'T5') {
    const sourceHandler=String(await readFile(path.resolve(workspace,'handler.ts'),'utf8')).split('\n');
    const sourceToken=String(await readFile(path.resolve(workspace,'token.ts'),'utf8')).split('\n');
    const handlerDefect=sourceHandler[1]?.includes('findUnique')===true && sourceHandler[1]?.includes('tenantId')!==true;
    const tokenDefect=sourceToken[1]?.includes("includes('*')")===true;
    const findings = Array.isArray(r.findings) ? r.findings as Array<Record<string,unknown>> : [];
    const matchesTenant=(f:Record<string,unknown>)=>f.path==='handler.ts'&&f.line===2&&/tenant/i.test(String(f.summary))&&/tenant/i.test(String(f.preconditions))&&/disclos|access/i.test(String(f.impact));
    const matchesWildcard=(f:Record<string,unknown>)=>f.path==='token.ts'&&f.line===2&&/wildcard|\*/i.test(String(f.summary))&&/wildcard|\*/i.test(String(f.preconditions))&&/authoriz|permission/i.test(String(f.impact));
    const tenant = handlerDefect && findings.some(matchesTenant);
    const wildcard = tokenDefect && findings.some(matchesWildcard);
    const checks = [tenant ? pass('seed-tenant-scope') : fail('seed-tenant-scope','Missing structured handler finding with line, preconditions and impact.'), wildcard ? pass('seed-wildcard-claim') : fail('seed-wildcard-claim','Missing structured token finding with line, preconditions and impact.')];
    const cleanCases = Array.isArray(r.clean_cases) ? r.clean_cases as Array<Record<string,unknown>> : [];
    const cleanEntries = cleanCases.filter(f => f.path==='clean.ts');
    const cleanFalsePositiveCount=findings.filter(f=>f.path==='clean.ts').length;
    const confirmed=Math.min(1,Number(tenant))+Math.min(1,Number(wildcard));
    const falsePositiveCount=findings.length-confirmed;
    const unexpected = falsePositiveCount>0;
    const claimsCleanDefect=cleanFalsePositiveCount>0;
    checks.push(cleanEntries.length===1 && cleanEntries[0]?.status==='no finding' && !claimsCleanDefect ? pass('clean-counterexample') : fail('clean-counterexample','clean.ts must be explicitly assessed exactly once as no finding.'));
    checks.push(!unexpected ? pass('no-extra-findings') : fail('no-extra-findings','Unexpected additional finding path counted as a potential false positive.'));
    const status = checks.some(c=>c.status==='FAIL') ? 'FAIL' : 'PASS';
    return {...result(status,checks),metrics:{all_findings:findings.length,confirmed_findings:confirmed,precision_numerator:confirmed,precision_denominator:findings.length||null,false_positives:falsePositiveCount,seed_findings_detected:checks.slice(0,2).filter(c=>c.status==='PASS').length,seed_findings_total:2,false_positives_on_clean_cases:cleanEntries.length ? cleanFalsePositiveCount : null}};
  }
  if (taskId==='T1') {
    const route=String(await readFile(path.resolve(workspace,'src/api/records.ts'),'utf8'));
    const service=String(await readFile(path.resolve(workspace,'src/services/records.ts'),'utf8'));
    const data=String(await readFile(path.resolve(workspace,'src/data/record-store.ts'),'utf8'));
    const readme=String(await readFile(path.resolve(workspace,'README.md'),'utf8'));
    const sourceTruth=route.includes('getRecord') && route.includes('status:404') && service.includes('recordStore.findById') && data.includes('rows.get(id)') && /HTTP 200/.test(readme);
    const claims=Array.isArray(r.claims)?r.claims as Array<Record<string,unknown>>:[];
    const flow=claims.find(c=>c.id==='api-data-flow'); const stale=claims.find(c=>c.id==='stale-doc');
    const flowPaths=Array.isArray(flow?.paths)?flow.paths.map(String):[];
    const symbols=Array.isArray(flow?.symbols)?flow.symbols.map(String):[];
    const allowedSymbols=['handle','getRecord','recordStore.findById'];
    const expectedIds=['api-data-flow','stale-doc'];
    const ids=claims.map(c=>String(c.id)).sort();
    const checks=[sourceTruth && flowPaths.join('|')==='src/api/records.ts|src/services/records.ts|src/data/record-store.ts' && symbols.sort().join('|')===allowedSymbols.sort().join('|') && ids.join('|')===expectedIds.join('|')?pass('api-data-flow'):fail('api-data-flow','Receipt must cite the actual ordered route/service/data path and only defined symbols.')];
    const cited=Array.isArray(stale?.paths)?stale.paths.map(String):[];
    checks.push(sourceTruth && cited.includes('README.md') && cited.includes('src/api/records.ts') && stale?.document_status===200 && stale?.source_status===404 ? pass('stale-doc-contradiction'):fail('stale-doc-contradiction','Must cite README and route source and state document_status 200 and source_status 404.'));
    return result(checks.every(c=>c.status==='PASS')?'PASS':'FAIL',checks);
  }
  if (taskId==='T6') {
    const checks: Array<{id:string;status:CheckStatus;exit_code:number|null;reason?:string}> = [];
    if (r.product_code_changed===true) checks.push(fail('read-only-mode','Tester mode reports product code edits.'));
    const coverage=Array.isArray(r.coverage_gaps)?r.coverage_gaps as Array<Record<string,unknown>>:[];
    const required: Array<{name:string;casePattern:RegExp;testPattern:RegExp}>=[
      {name:'zero',casePattern:/^zero$/,testPattern:/formatPage\s*\(\s*0\s*\)/},
      {name:'negative',casePattern:/^negative$/,testPattern:/formatPage\s*\(\s*-\d+\s*\)/},
      {name:'non-integer',casePattern:/^non[- ]integer$/,testPattern:/formatPage\s*\(\s*\d+\.\d+\s*\)/},
      {name:'maximum',casePattern:/^maximum$/,testPattern:/formatPage\s*\(\s*100\s*\)/},
    ];
    const named=required.map(item=>coverage.some(c=>item.casePattern.test(String(c.case).toLowerCase())&&item.testPattern.test(String(c.test)))?pass(`gap-${item.name}`):fail(`gap-${item.name}`,`Missing concrete ${item.name} case and executable input.`)); checks.push(...named);
    try {
      const {spawnSync}=await import('node:child_process');
    const weak=spawnSync(process.execPath,[path.resolve(workspace,'page-check.mjs')],{cwd:workspace,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH ?? '',TZ:'UTC'}});
      checks.push(weak.status===0?pass('existing-weak-test-runs'):fail('existing-weak-test-runs','Existing weak test did not run successfully.'));
      const candidate=pathToFileURL(path.resolve(workspace,'page.mjs')).href;
      const probe=`import assert from 'node:assert/strict';const {formatPage}=await import(${JSON.stringify(candidate)});assert.equal(formatPage(0),'Page 0');assert.equal(formatPage(-1),'Page -1');assert.equal(formatPage(1.5),'Page 1.5');assert.equal(formatPage(100),'Page 100');`;
      const edge=spawnSync(process.execPath,['--input-type=module','-e',probe],{cwd:workspace,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH ?? '',TZ:'UTC'}});
      checks.push(edge.status===0?pass('independent-boundary-probes'):fail('independent-boundary-probes','Controller edge probes failed.'));
    } catch { checks.push({id:'tester-checks',status:'INCONCLUSIVE',exit_code:null,reason:'Could not execute fixture checks.'}); }
    return result(checks.every(c=>c.status==='PASS')?'PASS':'FAIL',checks);
  }
  if (taskId==='T7') {
    const findings=Array.isArray(r.findings)?r.findings as Array<Record<string,unknown>>:[];
    const lines=String(await readFile(path.resolve(workspace,'compose.yaml'),'utf8')).split('\n');
    const script=String(await readFile(path.resolve(workspace,'start.sh'),'utf8')).split('\n');
    const mountLine=lines.findIndex(line=>line.includes('./config:/app/config'))+1;
    const failureLine=script.findIndex(line=>line.includes('echo "ready"'))+1;
    const masksFailure=script.some(line=>line.startsWith('./server '))&&!script.some(line=>/^set -e/.test(line))&&failureLine>1;
    const matched=findings.some(f=>String(f.path).endsWith('compose.yaml')&&f.line===mountLine&&/relative.*mount|config.*path/i.test(String(f.claim)))&&findings.some(f=>String(f.path).endsWith('start.sh')&&f.line===failureLine&&masksFailure&&/mask|swallow|exit.*status|failure/i.test(String(f.claim)));
    const claims=[...findings.map(f=>String(f.claim)),String(r.summary ?? '')].join(' ').toLowerCase();
    const unsupportedLiveClaim=/\b(?:the|this|current|production|live)\s+(?:host|server|deployment)\s+(?:is|has|runs|uses|contains|mounts)\s+(?!(?:not|unknown|unverified|uninspected|unclear)\b)|\bhost\s+is\s+(?!(?:not|unknown|unverified|uninspected|unclear)\b)(?:compromised|exposed|misconfigured)\b/i.test(claims);
    const checks=[matched?pass('static-source-findings'):fail('static-source-findings','Findings must cite the relative mount and the echo that masks a failed server exit.'),unsupportedLiveClaim?fail('no-live-host-claims','Receipt asserts an unsupported current-host or deployment fact.'):pass('no-live-host-claims')];
    return result(checks.every(c=>c.status==='PASS')?'PASS':'FAIL',checks);
  }
  if (taskId==='T8') {
    const adrSource=String(await readFile(path.resolve(workspace,'adr.md'),'utf8'));
    const runbookSource=String(await readFile(path.resolve(workspace,'runbook.md'),'utf8'));
    const claims=Array.isArray(r.claims)?r.claims as Array<Record<string,unknown>>:[];
    const adr=claims.find(c=>String(c.source).endsWith('adr.md')); const runbook=claims.find(c=>String(c.source).endsWith('runbook.md'));
    const checks=[adrSource.includes('revision 2')&&adrSource.includes('2026-10-10')&&adrSource.includes('append-only')&&adr?.revision===2&&adr?.date==='2026-10-10'&&/proposed/i.test(String(adr.text))&&/append-only/i.test(String(adr.text))?pass('adr-source-revision'):fail('adr-source-revision','ADR revision 2 dated 2026-10-10, Proposed status and append-only claim must be retained.'),runbookSource.includes('revision 1')&&runbookSource.includes('2026-10-12')&&runbookSource.includes('in-place replacement')&&runbook?.revision===1&&runbook?.date==='2026-10-12'&&/in-place replacement/i.test(String(runbook.text))?pass('runbook-source-revision'):fail('runbook-source-revision','Runbook revision 1 dated 2026-10-12 must retain its replacement claim.')];
    const summary=String(r.summary); const chronology=/2026-10-12/.test(summary)&&/2026-10-10/.test(summary)&&/newer/i.test(summary); const uncertainty=/conflict|disagree|uncertain/i.test(summary) && /does not (?:update|change|alter)|doesn't (?:update|change|alter)|not (?:update|change|alter)|proposed/i.test(summary); checks.push(chronology&&uncertainty?pass('conflict-chronology-and-status'):fail('conflict-chronology-and-status','Draft must identify both dates, state the runbook is newer, and preserve unresolved Proposed ADR status.'));
    return result(checks.every(c=>c.status==='PASS')?'PASS':'FAIL',checks);
  }
  return result('NOT_RUN',[{id:'task-oracle',status:'NOT_RUN',exit_code:null,reason:'No oracle implemented for task.'}]);
}
