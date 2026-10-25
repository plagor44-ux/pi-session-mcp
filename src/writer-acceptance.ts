import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { podmanInfo } from "./writer-boundary.js";
import type { WriterContext, WriterOutcome } from "./writer-lifecycle.js";
import { currentAcceptanceFingerprint, readWriterState, writerAcceptanceCurrent, writerPaths, writersRoot, writeWriterState, WriterStateError } from "./writer-state.js";

export function controlStatePath(home: string): string {
  return join(home, ".local", "state", "pi-session-mcp", "isolation-control.json");
}
const failed = (code: string): WriterOutcome => ({ code, status: "failed" });
type HarnessReport = Record<string, unknown>;
interface HarnessResult { exitCode: number; report: "present" | "absent" | "invalid"; data: HarnessReport }
async function harness(ctx: WriterContext, args: string[], env?: NodeJS.ProcessEnv): Promise<HarnessResult> {
  await mkdir(writersRoot(ctx.home), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(writersRoot(ctx.home), ".acceptance-"));
  try {
    const out = join(directory, "report.json");
    const result = await ctx.runner.run(ctx.nodePath, [join(ctx.releaseRoot, "scripts", "isolation-acceptance.mjs"), ...args, "--out", out], AbortSignal.timeout(300_000), env ? { env } : undefined);
    let text: string;
    try { text = await readFile(out, "utf8"); } catch (error) {
      // The harness writes no report when it exits on a usage or unexpected error.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { exitCode: result.exitCode, report: "absent", data: {} };
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { exitCode: result.exitCode, report: "invalid", data: {} };
      return { exitCode: result.exitCode, report: "present", data: parsed as HarnessReport };
    } catch { return { exitCode: result.exitCode, report: "invalid", data: {} }; }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const networkOf = (report: HarnessReport) => (report.network !== null && typeof report.network === "object" ? (report.network as { classification?: unknown }).classification : undefined);
const SAFE_TOKEN = /^[A-Za-z0-9_.:+-]{1,80}$/;
const safeToken = (value: unknown): string | null => (typeof value === "string" && SAFE_TOKEN.test(value) ? value : null);
const safeList = (value: unknown): string[] => (Array.isArray(value)
  ? value.map(safeToken).filter((entry): entry is string => entry !== null).slice(0, 64) : []);
/** The ids of the digest groups that changed during the probe (#131): group ids only, never digests or paths. */
function changedGroups(report: HarnessReport): string[] {
  const digests = report.digests;
  if (digests === null || typeof digests !== "object" || !Array.isArray((digests as { groups?: unknown }).groups)) return [];
  return safeList(((digests as { groups: unknown[] }).groups).filter((group): group is { id: unknown } =>
    group !== null && typeof group === "object" && (group as { unchanged?: unknown }).unchanged === false).map((group) => group.id));
}
/** Copies only allowlisted, token-shaped values: the record must stay path-free and secret-free. */
function harnessSummary(result: HarnessResult) {
  return { exitCode: result.exitCode, report: result.report, verdict: safeToken(result.data.verdict), network: safeToken(networkOf(result.data)),
    failedChecks: safeList(result.data.failed_checks), inconclusiveChecks: safeList(result.data.inconclusive_checks), changedDigestGroups: changedGroups(result.data) };
}
/** Best effort: a failure to write the record never changes the returned outcome. */
async function recordFailure(root: string, file: string, code: string, result?: HarnessResult): Promise<void> {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const body = { schemaVersion: 1, at: new Date().toISOString(), code, ...(result ? { harness: harnessSummary(result) } : {}) };
    // Never follow a link placed at the record's path, and keep 0600 on an existing file.
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await handle.chmod(0o600); await handle.writeFile(JSON.stringify(body, null, 2) + "\n"); } finally { await handle.close(); }
  } catch { /* Diagnostics only. */ }
}
export async function runIsolationControl(ctx: WriterContext): Promise<WriterOutcome> {
  const record = async (verdict: "fail" | "control_detected_escapes") => {
    await writeFile(controlStatePath(ctx.home), JSON.stringify({ schemaVersion: 1, verdict, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
  };
  try {
    await mkdir(writersRoot(ctx.home), { recursive: true, mode: 0o700 });
    await record("fail");
    const root = join(ctx.home, ".cache", "pi-session-mcp-isolation");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, "control-"));
    try {
      const clone = join(directory, "clone");
      const result = await ctx.runner.run("git", ["-c", "core.hooksPath=/dev/null", "clone", "--no-hardlinks", "--", ctx.checkout, clone], AbortSignal.timeout(300_000));
      if (result.exitCode !== 0) throw new Error("isolation_control_failed");
      const report = await harness(ctx, ["--mode", "uncontained-control", "--launch", "node", "--workspace", clone]);
      if (report.exitCode !== 0 || report.report !== "present" || report.data.verdict !== "control_detected_escapes") throw new Error("isolation_control_failed");
    } finally { await rm(directory, { recursive: true, force: true }); }
    await record("control_detected_escapes");
    return { status: "ok", code: "isolation_control_passed" };
  } catch {
    await record("fail").catch(() => {}); // Invalidate again even when an earlier step threw.
    return failed("isolation_control_failed");
  }
}
/**
 * Whether setup may keep the writer's acceptance. `stale` covers every doubtful state (not ready, unreadable state, a
 * changed binding, a missing image) and means accept again. `unknown` means Podman could not be asked or failed: acceptance
 * would downgrade a ready writer before it found that out, so setup leaves the writer as it is.
 */
export async function acceptanceCurrent(ctx: WriterContext, name: string): Promise<"current" | "stale" | "unknown"> {
  let state;
  try { state = await readWriterState(ctx.home, name); } catch { return "stale"; }
  if (state?.phase !== "ready" || !state.acceptance) return "stale";
  const info = await podmanInfo(ctx.runner);
  if (!info.usable || !info.version) return "unknown";
  let asked = true;
  const imageExists = async (id: string): Promise<boolean> => {
    const { exitCode } = await ctx.runner.run("podman", ["image", "exists", id], AbortSignal.timeout(10_000));
    if (exitCode !== 0 && exitCode !== 1) asked = false; // Only exit 1 means missing; anything else is a Podman error.
    return exitCode === 0;
  };
  try {
    const current = await writerAcceptanceCurrent(writerPaths(ctx.home, name).wrapper, state, { podmanVersion: info.version, imageExists });
    return current ? "current" : asked ? "stale" : "unknown";
  } catch { return "stale"; }
}
export async function acceptWriter(ctx: WriterContext, name: string): Promise<WriterOutcome> {
  let paths: ReturnType<typeof writerPaths> | undefined; // Set once the writer state is accepted; failures after it leave a record.
  let ran: HarnessResult | undefined;
  const fail = async (code: string): Promise<WriterOutcome> => {
    if (paths) await recordFailure(paths.root, paths.acceptanceFailure, code, ran);
    return failed(code);
  };
  try {
    try {
      const control = JSON.parse(await readFile(controlStatePath(ctx.home), "utf8")) as { schemaVersion?: unknown; verdict?: unknown };
      if (control.schemaVersion !== 1 || control.verdict !== "control_detected_escapes") return failed("isolation_control_required");
    } catch { return failed("isolation_control_required"); }
    const state = await readWriterState(ctx.home, name);
    if (!state || state.alias !== ctx.alias) return failed("writer_state_invalid");
    paths = writerPaths(ctx.home, name);
    const { acceptance: _old, ...retained } = state;
    await writeWriterState(ctx.home, name, { ...retained, phase: "not_ready" });
    const info = await podmanInfo(ctx.runner);
    if (!info.usable || !info.version) return await fail("podman_unavailable");
    const fingerprint = await currentAcceptanceFingerprint(paths.wrapper, state, info.version);
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    // Acceptance makes no provider request: a launch-time refresh of an expired host token would change
    // the host agent directory inside the harness's digest window (#131).
    ran = await harness(ctx, ["--mode", "contained", "--agent-dir-copy-writable", "--agent-dir-copy", paths.agent,
      "--launch", `${quote(paths.wrapper)} node`, "--workspace", paths.clone], { PI_WRITER_NO_CREDENTIAL_REFRESH: "1" });
    const network = networkOf(ran.data);
    if (ran.exitCode !== 0 || ran.report !== "present" || ran.data.verdict !== "pass" || (network !== "limited" && network !== "not_limited")) return await fail("acceptance_harness_failed");
    if (fingerprint !== await currentAcceptanceFingerprint(paths.wrapper, state, info.version)) return await fail("acceptance_fingerprint_changed");
    await writeWriterState(ctx.home, name, { ...retained, phase: "ready", acceptance: { fingerprint, verdict: "pass", network, at: new Date().toISOString() } });
    await rm(paths.acceptanceFailure, { force: true }).catch(() => {}); // A stale failure record would contradict the accepted state.
    return { status: "ok", code: "writer_accepted" };
  } catch (error) {
    if (error instanceof WriterStateError) return failed(error.code);
    return await fail("writer_acceptance_failed");
  }
}
