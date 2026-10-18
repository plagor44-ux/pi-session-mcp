import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { podmanInfo } from "./writer-boundary.js";
import type { WriterContext, WriterOutcome } from "./writer-lifecycle.js";
import { currentAcceptanceFingerprint, readWriterState, writerPaths, writersRoot, writeWriterState } from "./writer-state.js";

export function controlStatePath(home: string): string {
  return join(home, ".local", "state", "pi-session-mcp", "isolation-control.json");
}
const failed = (code: string): WriterOutcome => ({ code, status: "failed" });
async function harness(ctx: WriterContext, args: string[]) {
  await mkdir(writersRoot(ctx.home), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(writersRoot(ctx.home), ".acceptance-"));
  try {
    await chmod(directory, 0o700);
    const out = join(directory, "report.json");
    const result = await ctx.runner.run(ctx.nodePath, [join(ctx.releaseRoot, "scripts", "isolation-acceptance.mjs"), ...args, "--out", out], AbortSignal.timeout(300_000));
    const report = JSON.parse(await readFile(out, "utf8")) as { verdict?: unknown; network?: { classification?: unknown } };
    return { exitCode: result.exitCode, verdict: report.verdict, network: report.network?.classification };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function runIsolationControl(ctx: WriterContext): Promise<WriterOutcome> {
  let directory: string | undefined;
  try {
    await mkdir(writersRoot(ctx.home), { recursive: true, mode: 0o700 });
    await writeFile(controlStatePath(ctx.home), JSON.stringify({ schemaVersion: 1, verdict: "fail", at: new Date().toISOString() }) + "\n", { mode: 0o600 });
    const root = join(ctx.home, ".cache", "pi-session-mcp-isolation");
    await mkdir(root, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(root, "control-"));
    const clone = join(directory, "clone");
    const result = await ctx.runner.run("git", ["-c", "core.hooksPath=/dev/null", "clone", "--no-hardlinks", "--", ctx.checkout, clone], AbortSignal.timeout(300_000));
    if (result.exitCode !== 0) return failed("isolation_control_failed");
    const report = await harness(ctx, ["--mode", "uncontained-control", "--launch", "node", "--workspace", clone]);
    const pass = report.exitCode === 0 && report.verdict === "control_detected_escapes";
    await writeFile(controlStatePath(ctx.home), JSON.stringify({ schemaVersion: 1, verdict: pass ? "control_detected_escapes" : "fail", at: new Date().toISOString() }) + "\n", { mode: 0o600 });
    return pass ? { status: "ok", code: "isolation_control_passed" } : failed("isolation_control_failed");
  } catch { return failed("isolation_control_failed"); }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
export async function acceptWriter(ctx: WriterContext, name: string): Promise<WriterOutcome> {
  try {
    try {
      const control = JSON.parse(await readFile(controlStatePath(ctx.home), "utf8")) as { schemaVersion?: unknown; verdict?: unknown };
      if (control.schemaVersion !== 1 || control.verdict !== "control_detected_escapes") return failed("isolation_control_required");
    } catch { return failed("isolation_control_required"); }
    const state = await readWriterState(ctx.home, name);
    if (!state || state.alias !== ctx.alias) return failed("writer_acceptance_failed");
    const { acceptance: _old, ...retained } = state;
    await writeWriterState(ctx.home, name, { ...retained, phase: "not_ready" });
    const info = await podmanInfo(ctx.runner);
    if (!info.usable || !info.version) return failed("writer_acceptance_failed");
    const paths = writerPaths(ctx.home, name);
    const fingerprint = await currentAcceptanceFingerprint(paths.wrapper, state, info.version);
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    const report = await harness(ctx, ["--mode", "contained", "--agent-dir-copy-writable", "--agent-dir-copy", paths.agent,
      "--launch", `${quote(paths.wrapper)} node`, "--workspace", paths.clone]);
    if (report.exitCode !== 0 || report.verdict !== "pass" || (report.network !== "limited" && report.network !== "not_limited")) return failed("writer_acceptance_failed");
    if (fingerprint !== await currentAcceptanceFingerprint(paths.wrapper, state, info.version)) return failed("writer_acceptance_failed");
    await writeWriterState(ctx.home, name, { ...retained, phase: "ready", acceptance: { fingerprint, verdict: "pass", network: report.network, at: new Date().toISOString() } });
    return { status: "ok", code: "writer_accepted" };
  } catch { return failed("writer_acceptance_failed"); }
}
