import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, cp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, it } from "vitest";
import { evaluateBounded } from "../eval/profiles/oracle-process.js";

const exec = promisify(execFile);
const roots: string[] = [];
beforeAll(async () => {
  await exec(process.execPath, [join(process.cwd(), "node_modules/typescript/bin/tsc"), "-p", "tsconfig.eval.json"], { cwd: process.cwd(), timeout: 120_000 });
}, 150_000);
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
async function fixture(source: string): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "profile-oracle-worker-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  await writeFile(join(workspace, "contract.mjs"), source);
  return { root: process.cwd(), workspace };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

async function pidIsGoneOrZombie(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return tail[0] === "Z";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

describe.skipIf(process.platform!=="linux")("bounded oracle worker process", () => {
  it("kills an oracle stuck in a candidate assertion when its wall bound expires", async () => {
    const { root, workspace } = await fixture("export function parseLimit(){ while (true) {} }\n");
    const started = Date.now();
    await assert.rejects(evaluateBounded(root, "T2", workspace, {}, undefined, "implementer", 250), (error) => errorCode(error) === "oracle_timeout");
    assert.ok(Date.now() - started < 3_000, "timeout must include the independent test subprocess");
  }, 10_000);

  it("terminates and observes an ordinary candidate child after a successful oracle", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "profile-oracle-worker-"));
    roots.push(rootDir);
    const workspace = join(rootDir, "workspace");
    await (await import("node:fs/promises")).mkdir(workspace);
    const pidPath = join(workspace, "child.pid");
    const childCode = `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(() => {}, 1000);`;
    await writeFile(join(workspace, "contract.mjs"), [
      "import { spawn } from 'node:child_process';",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });`,
      "child.unref();",
      // Wait for the child's PID file so the oracle never finishes before the child has started.
      `const { existsSync } = await import('node:fs'); while (!existsSync(${JSON.stringify(pidPath)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
      "export function parseLimit(value) { const n=Number(value); return Number.isFinite(n)&&n>=0?n:20; }",
    ].join("\n"));
    const result = await evaluateBounded(process.cwd(), "T2", workspace, {}, undefined, "implementer", 10_000);
    assert.equal(result.status, "PASS");
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    const deadline = Date.now() + 1_500;
    while (!(await pidIsGoneOrZombie(pid)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(await pidIsGoneOrZombie(pid), "candidate child must not remain live after the oracle returns");
  }, 15_000);

  it("honors the explicitly configured Chromium executable in the isolated worker",async()=>{
    try{await access(join(process.cwd(),"eval/fixtures/T3/tooling/node_modules/playwright/index.mjs"));}catch{return;}
    const directory=await mkdtemp(join(tmpdir(),"profile-browser-config-"));roots.push(directory);
    const workspace=join(directory,"workspace");await cp(join(process.cwd(),"eval/fixtures/T3/public"),workspace,{recursive:true});
    const previous=process.env.PI_PROFILE_EVAL_CHROMIUM_EXECUTABLE;
    process.env.PI_PROFILE_EVAL_CHROMIUM_EXECUTABLE="/synthetic/nonexistent-browser";
    try{
      const result=await evaluateBounded(process.cwd(),"T3",workspace,{},join(directory,"artifacts"),"ui-writer",10000);
      assert.equal(result.status,"BLOCKED");assert.ok(result.checks.some(c=>c.id==="browser-runtime"&&c.reason?.includes("launch Chromium")));
    }finally{if(previous===undefined)delete process.env.PI_PROFILE_EVAL_CHROMIUM_EXECUTABLE;else process.env.PI_PROFILE_EVAL_CHROMIUM_EXECUTABLE=previous;}
  },15000);
  it("kills the worker and its process group promptly when aborted", async () => {
    const { root, workspace } = await fixture("export function parseLimit(){ while (true) {} }\n");
    const controller = new AbortController();
    const pending = evaluateBounded(root, "T2", workspace, {}, undefined, "implementer", 10_000, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, (error) => errorCode(error) === "oracle_aborted");
  }, 10_000);
});
