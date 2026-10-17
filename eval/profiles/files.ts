import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile, copyFile, chmod } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export function hash(value: string | Uint8Array): `sha256:${string}` { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
export function digest(value: unknown): `sha256:${string}` { return hash(JSON.stringify(value)); }
export type Snapshot = Record<string, string>;
/** Never follows symlinks, including worker-created links to host paths. */
export async function snapshot(root: string): Promise<Snapshot> {
  const result: Snapshot = {};
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), key = relative(root, path).split("\\").join("/");
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) result[key] = digest(["symlink", await readlink(path)]);
      else if (stat.isDirectory()) { result[key] = digest(["directory",stat.mode & 0o777]); await walk(path); }
      else if (stat.isFile()) result[key] = digest([stat.mode & 0o777, hash(await readFile(path))]);
      else result[key] = "unsupported-file-type";
    }
  }
  await walk(root); return result;
}
export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]).sort();
}
export async function copyFixture(from: string, to: string): Promise<void> {
  await mkdir(to, {recursive:true});
  for (const name of await readdir(from)) {
    if ([".git", ".env", "node_modules", ".pi"].includes(name)) throw new Error("unsafe_fixture_entry");
    const src = join(from, name), dest = join(to, name), stat = await lstat(src);
    if (stat.isSymbolicLink()) throw new Error("fixture_symlink");
    if (stat.isDirectory()) await copyFixture(src,dest);
    else if (stat.isFile()) { await copyFile(src,dest); await chmod(dest, stat.mode & 0o777); }
    else throw new Error("unsafe_fixture_type");
  }
}
export async function ownedTemporary(): Promise<{ root:string; scope_id:string; remove:()=>Promise<void> }> {
  const root=await mkdtemp(join(tmpdir(),"pi-profile-eval-")), token=randomUUID();
  await writeFile(join(root,".owner"),token,{mode:0o600});
  return {root,scope_id:basename(root),remove:async()=>{if(await readFile(join(root,".owner"),"utf8")!==token)throw new Error("ownership_lost");await rm(root,{recursive:true});}};
}
export async function sourceBinding(root: string): Promise<{commit:string; digest:`sha256:${string}`}> {
  const commit=(await exec("git",["rev-parse","HEAD"],{cwd:root})).stdout.trim();
  const paths=(await exec("git",["ls-files","-z","--cached","--others","--exclude-standard"],{cwd:root})).stdout.split("\0").filter((p)=> /^(src\/|eval\/(profiles|fixtures)\/|test\/|scripts\/|package(-lock)?\.json$|tsconfig.*\.json$)/.test(p)).sort();
  const records=[];
  for(const path of paths) records.push([path,hash(await readFile(join(root,path)))]);
  return {commit,digest:digest(records)};
}
