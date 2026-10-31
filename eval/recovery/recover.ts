import { rm } from "node:fs/promises";
import { join } from "node:path";
import { BOUNDARY_GIT, IMAGE_PULL_TIMEOUT_MS, NODE_IMAGE_REF, isSafeRefName, throwawayArgs, verifyCloneLayout } from "../../src/writer-boundary.js";
import { acquireWriterLease, WriterLeaseError } from "../../src/writer-lease.js";
import type { WriterContext } from "../../src/writer-lifecycle.js";
import { SETUP_LEASE_WAIT_MS } from "../../src/setup-writers-common.js";
import { writerPaths } from "../../src/writer-state.js";

export const RECOVERY_REF_ROOT = "refs/recovery";
export type RecoverCode = "writer_recover_planned" | "writer_recovered" | "nothing_to_recover" | "writer_recover_unsupported" | "writer_recover_failed" | "writer_recover_incomplete" | "writer_busy";
type Result = { code: RecoverCode; status: "ok" | "planned" | "unchanged" | "failed"; slot?: number };

// All Git operations on the clone run here, with the original index copied and objects written to scratch.
const script = `set -eu
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=pi-writer GIT_AUTHOR_EMAIL=pi-writer@example.invalid
export GIT_COMMITTER_NAME=pi-writer GIT_COMMITTER_EMAIL=pi-writer@example.invalid
mkdir -p /tmp/objects
export GIT_OBJECT_DIRECTORY=/tmp/objects GIT_ALTERNATE_OBJECT_DIRECTORIES="$1/.git/objects"
cp "$1/.git/index" /tmp/orig
GIT_INDEX_FILE=/tmp/orig ${BOUNDARY_GIT} -C "$1" ls-files -u -z > /tmp/unmerged
[ -s /tmp/unmerged ] || { echo nothing_to_recover; exit 0; }
# Node processes NUL-delimited paths as bytes, never shell words or newline-separated records.
node - "$1" <<'NODE'
const fs = require('fs');
const cp = require('child_process');
const root = process.argv[2];
const base = ['-c','safe.directory=*','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.useReplaceRefs=false','-C',root];
const run = (args, input, index) => cp.execFileSync('git', [...base,...args], {input, env:{...process.env,...(index ? {GIT_INDEX_FILE:index} : {})}, stdio:['pipe','pipe','pipe']}).toString().trim();
const data = fs.readFileSync('/tmp/unmerged');
const entries = []; let start = 0;
for (let i=0;i<data.length;i++) if (data[i]===0) { const record=data.subarray(start,i); start=i+1; const tab=record.indexOf(9); const match=/^(\\d+) ([0-9a-f]+) ([123])$/.exec(record.subarray(0,tab).toString()); if (!match) throw Error('invalid index'); entries.push({mode:match[1], oid:match[2], stage:Number(match[3]), path:record.subarray(tab+1)}); }
if (entries.some(e=>e.mode==='160000')) { console.log('writer_recover_unsupported'); process.exit(0); }
for (const e of entries) run(['cat-file','-e',e.oid+'^{blob}']);
const head=run(['rev-parse','HEAD']);
run(['init','--bare','/tmp/scratch']);
function save(name, tree) { const commit=run(['commit-tree',tree,'-p',head,'-m','recovery '+name]); run(['--git-dir=/tmp/scratch','update-ref','refs/heads/recovery/'+name,commit]); }
for (const stage of [1,2,3]) {
  const selected=entries.filter(e=>e.stage===stage); if (!selected.length) continue;
  const index='/tmp/s'+stage; run(['read-tree',head],undefined,index);
  const seen=new Set(); const records=[];
  for (const e of entries) { const key=e.path.toString('hex'); if (!seen.has(key)) { seen.add(key); records.push(Buffer.concat([Buffer.from('0 '+ '0'.repeat(e.oid.length)+'\\t'),e.path,Buffer.from([0])])); } }
  for (const e of selected) records.push(Buffer.concat([Buffer.from(e.mode+' '+e.oid+'\\t'),e.path,Buffer.from([0])]));
  run(['update-index','-z','--index-info'],Buffer.concat(records),index);
  save('stage'+stage,run(['write-tree'],undefined,index));
}
run(['read-tree',head],undefined,'/tmp/wt'); run(['add','-A'],undefined,'/tmp/wt'); save('worktree',run(['write-tree'],undefined,'/tmp/wt'));
const manifest=cp.execFileSync('git',[...base,'ls-files','-u'],{env:{...process.env,GIT_INDEX_FILE:'/tmp/orig'}});
const blob=run(['hash-object','-w','--stdin'],manifest);
run(['read-tree','--empty'],undefined,'/tmp/manifest');
run(['update-index','--add','--cacheinfo','100644,'+blob+',unmerged-index.txt'],undefined,'/tmp/manifest');
save('manifest',run(['write-tree'],undefined,'/tmp/manifest'));
run(['--git-dir=/tmp/scratch','bundle','create','/bundles/recover.bundle','--all']);
console.log('recovered');
NODE`;

export async function recoverWriter(ctx: WriterContext, name: string, options: { apply: boolean }): Promise<Result> {
  if (!options.apply) return { code: "writer_recover_planned", status: "planned" };
  let lease;
  try { lease = await acquireWriterLease(ctx.home, name, { waitMs: SETUP_LEASE_WAIT_MS }); }
  catch (error) { return { code: error instanceof WriterLeaseError && error.code === "writer_busy" ? "writer_busy" : "writer_recover_failed", status: "failed" }; }
  try {
    const paths = writerPaths(ctx.home, name), bundle = join(paths.bundles, "recover.bundle");
    const run = (command: string, args: readonly string[]) => ctx.runner.run(command, args, AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS), { inheritFds: [lease.fd] });
    const git = async (...args: string[]) => { const result = await run("git", ["-c", "core.hooksPath=/dev/null", "-C", ctx.checkout, ...args]); if (result.exitCode !== 0) throw Error("git failed"); return result.stdout; };
    try {
      await verifyCloneLayout(paths.clone);
      await rm(bundle, { force: true });
      const result = await run("podman", throwawayArgs(name, paths, NODE_IMAGE_REF, { clone: "ro", bundles: true }, script, [paths.clone]));
      if (result.exitCode !== 0) throw Error("container failed");
      if (result.stdout.trim() === "nothing_to_recover") return { code: "nothing_to_recover", status: "unchanged" };
      if (result.stdout.trim() === "writer_recover_unsupported") return { code: "writer_recover_unsupported", status: "failed" };
      if (result.stdout.trim() !== "recovered") throw Error("invalid container result");
      await git("bundle", "verify", bundle);
      const heads = (await git("bundle", "list-heads", bundle)).trim().split("\n").map(line => {
        const m = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/heads\/recovery\/(worktree|stage1|stage2|stage3|manifest))$/.exec(line);
        if (!m || !isSafeRefName(m[2]!)) throw Error("invalid head"); return { oid: m[1]!, source: m[2]!, part: m[3]! };
      });
      if (new Set(heads.map(h => h.part)).size !== heads.length || !heads.some(h => h.part === "manifest") || !heads.some(h => h.part === "worktree")) throw Error("invalid heads");
      const root = `${RECOVERY_REF_ROOT}/writer-${name}`;
      if (!isSafeRefName(root)) throw Error("invalid root");
      const existing = await git("for-each-ref", "--format=%(refname)", `${root}/`);
      let slot = 1; for (const line of existing.split("\n")) { const suffix = line.slice(root.length + 1); const m = /^(\d+)\//.exec(suffix); if (line.startsWith(root + "/") && m) { const n = Number(m[1]); if (!Number.isSafeInteger(n)) throw Error("invalid slot"); slot = Math.max(slot, n + 1); } }
      if (!Number.isSafeInteger(slot)) throw Error("invalid slot");
      const imported: typeof heads = [];
      try {
        for (const head of heads) { const dest = `${root}/${slot}/${head.part}`; if (!isSafeRefName(dest)) throw Error("invalid destination"); imported.push(head); await git("fetch", "--no-tags", "--end-of-options", bundle, `+${head.source}:${dest}`); }
      } catch {
        for (const h of imported) { try { await git("update-ref", "-d", `${root}/${slot}/${h.part}`, h.oid); } catch { /* report incomplete even if rollback is indeterminate */ } }
        return { code: "writer_recover_incomplete", status: "failed" };
      }
      return { code: "writer_recovered", status: "ok", slot };
    } finally { await rm(bundle, { force: true }); }
  } catch { return { code: "writer_recover_failed", status: "failed" }; }
  finally { await lease.release(); }
}
