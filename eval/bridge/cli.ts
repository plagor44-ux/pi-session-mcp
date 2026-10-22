import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe, SCENARIOS } from "./claude-probe.js";
import { runLive, RefusedError } from "./live/runner.js";
import { runProductProbe, SCENARIOS as PRODUCT_SCENARIOS } from "./product-probe.js";

// `node cli.js probe --out <dir> [--client-version <v>] [--only S1,S2,X6]`
// `node cli.js live --arm A|C --out <dir> (--approval <file> | --dry-run [--client-version <v>])`
// The probe re-executes itself inside `unshare -rn` (new user and network namespace, loopback only) and refuses to run elsewhere.
const USAGE = "usage: cli.js probe --out <absolute dir> [--client-version <version>] [--only S1,S2,...,X6]";
interface Parsed { out: string; clientVersion?: string; only?: string[]; inside: boolean }
function parse(argv: string[]): Parsed | undefined {
  const [command, ...rest] = argv;
  if (command !== "probe") return undefined;
  let out: string | undefined, clientVersion: string | undefined, only: string[] | undefined, inside = false;
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (key === "--inside") inside = true;
    else if (key === "--out" || key === "--client-version" || key === "--only") {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) return undefined;
      if (key === "--out") out = value; else if (key === "--client-version") clientVersion = value; else only = value.split(",").filter(Boolean);
    } else return undefined;
  }
  if (!out || !isAbsolute(out)) return undefined;
  const known = new Set([...SCENARIOS.map((s) => s.id), "X6"]);
  if (only?.some((id) => !known.has(id))) return undefined;
  return { out, inside, ...(clientVersion ? { clientVersion } : {}), ...(only ? { only } : {}) };
}

function reexecInsideNamespace(parsed: Parsed): number {
  if (process.platform !== "linux") { process.stderr.write("refused: the probe needs Linux (user and network namespaces)\n"); return 3; }
  const check = spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" });
  if (check.error || check.status !== 0) { process.stderr.write("refused: unshare -rn is unavailable here\n"); return 3; }
  const self = fileURLToPath(import.meta.url);
  const args = ["probe", "--out", parsed.out, ...(parsed.clientVersion ? ["--client-version", parsed.clientVersion] : []), ...(parsed.only ? ["--only", parsed.only.join(",")] : []), "--inside"];
  const run = spawnSync("unshare", ["-rn", "sh", "-c", 'ip link set lo up && exec "$@"', "sh", process.execPath, self, ...args], { stdio: "inherit" });
  return run.status ?? 1;
}

// ---------------------------------------------------------------- live (one approved L1 run, or its provider-free dry run)
const LIVE_USAGE = "usage: cli.js live --arm A|C --out <dir> --approval <file>   |   cli.js live --arm A|C --out <dir> --dry-run [--client-version <version>]";
interface LiveParsed { arm: "A" | "C"; out: string; approval?: string; dryRun: boolean; clientVersion?: string; inside: boolean }
function parseLive(rest: string[]): LiveParsed | undefined {
  let arm: string | undefined, out: string | undefined, approval: string | undefined, clientVersion: string | undefined, dryRun = false, inside = false;
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (key === "--dry-run") dryRun = true;
    else if (key === "--inside") inside = true;
    else if (key === "--arm" || key === "--out" || key === "--approval" || key === "--client-version") {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) return undefined;
      if (key === "--arm") arm = value; else if (key === "--out") out = value; else if (key === "--approval") approval = value; else clientVersion = value;
    } else return undefined;
  }
  if ((arm !== "A" && arm !== "C") || !out) return undefined;
  if (dryRun ? approval !== undefined : (approval === undefined || clientVersion !== undefined || inside)) return undefined;
  return { arm, out: resolve(out), dryRun, inside, ...(approval ? { approval: resolve(approval) } : {}), ...(clientVersion ? { clientVersion } : {}) };
}
function reexecLiveInsideNamespace(parsed: LiveParsed): number {
  if (process.platform !== "linux") { process.stderr.write("refused: the dry run needs Linux (user and network namespaces)\n"); return 3; }
  const check = spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" });
  if (check.error || check.status !== 0) { process.stderr.write("refused: unshare -rn is unavailable here\n"); return 3; }
  const args = ["live", "--arm", parsed.arm, "--out", parsed.out, "--dry-run", ...(parsed.clientVersion ? ["--client-version", parsed.clientVersion] : []), "--inside"];
  const run = spawnSync("unshare", ["-rn", "sh", "-c", 'ip link set lo up && exec "$@"', "sh", process.execPath, fileURLToPath(import.meta.url), ...args], { stdio: "inherit" });
  return run.status ?? 1;
}
async function mainLive(rest: string[]): Promise<number> {
  const parsed = parseLive(rest);
  if (!parsed) { process.stderr.write(`${LIVE_USAGE}\n`); return 64; }
  if (parsed.dryRun && !parsed.inside) return reexecLiveInsideNamespace(parsed);
  try {
    const summary = await runLive({ arm: parsed.arm, out: parsed.out, dryRun: parsed.dryRun, ...(parsed.approval ? { approvalPath: parsed.approval } : {}), ...(parsed.clientVersion ? { clientVersion: parsed.clientVersion } : {}) });
    const r = summary.result, stream = (r.stream ?? {}) as Record<string, any>, server = (r.server ?? {}) as Record<string, any>, checks = (r.checks ?? {}) as Record<string, boolean>;
    process.stdout.write(`${summary.dryRun ? "dry-" : ""}${String(summary.seq).padStart(2, "0")}-L1-${summary.arm} outcome=${summary.outcome} requests=${String(stream.model_requests)} wakes=${String(stream.wakes?.started)} polls=${String(server.polls_running)} oracle=${String((r.oracle as Record<string, unknown> | undefined)?.status)} clean=${String(Object.values(checks).every(Boolean))}\n`);
    return summary.outcome === "completed" && Object.values(checks).every(Boolean) ? 0 : 1;
  } catch (error) {
    if (error instanceof RefusedError) { process.stderr.write(`refused: ${error.reason}\n`); return 3; }
    process.stderr.write("live run failed\n");
    return 2;
  }
}

// ---------------------------------------------------------------- product-probe (provider-free acceptance of the product's turn events and wake hook, ADR 0011)
const PRODUCT_USAGE = "usage: cli.js product-probe --out <absolute dir> [--only P1,P2,P3,P4,P6]";
interface ProductParsed { out: string; only?: string[]; inside: boolean }
function parseProduct(rest: string[]): ProductParsed | undefined {
  let out: string | undefined, only: string[] | undefined, inside = false;
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (key === "--inside") inside = true;
    else if (key === "--out" || key === "--only") {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) return undefined;
      if (key === "--out") out = value; else only = value.split(",").filter(Boolean);
    } else return undefined;
  }
  if (!out || !isAbsolute(out) || only?.some((id) => !PRODUCT_SCENARIOS.some((s) => s.id === id))) return undefined;
  return { out, inside, ...(only ? { only } : {}) };
}
async function mainProduct(rest: string[]): Promise<number> {
  const parsed = parseProduct(rest);
  if (!parsed) { process.stderr.write(`${PRODUCT_USAGE}\n`); return 64; }
  if (!parsed.inside) {
    if (process.platform !== "linux") { process.stderr.write("refused: the probe needs Linux (user and network namespaces)\n"); return 3; }
    const check = spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" });
    if (check.error || check.status !== 0) { process.stderr.write("refused: unshare -rn is unavailable here\n"); return 3; }
    const args = ["product-probe", "--out", parsed.out, ...(parsed.only ? ["--only", parsed.only.join(",")] : []), "--inside"];
    return spawnSync("unshare", ["-rn", "sh", "-c", 'ip link set lo up && exec "$@"', "sh", process.execPath, fileURLToPath(import.meta.url), ...args], { stdio: "inherit" }).status ?? 1;
  }
  try {
    const summary = await runProductProbe({ out: parsed.out, ...(parsed.only ? { only: parsed.only } : {}) });
    for (const row of summary.scenarios as Array<Record<string, unknown>>) process.stdout.write(`${String(row.scenario).padEnd(3)} expectation=${row.passed_expectation === true ? "met" : "NOT met"} requests=${String(row.requests)} wakes=${String(row.wakes)} leftover=${String(row.leftover_after_grace)}\n`);
    return summary.all_passed === true ? 0 : 1;
  } catch (error) {
    process.stderr.write(`product probe refused or failed: ${error instanceof Error ? error.message : "unknown"}\n`);
    return 2;
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "live") return mainLive(argv.slice(1));
  if (argv[0] === "product-probe") return mainProduct(argv.slice(1));
  const parsed = parse(argv);
  if (!parsed) { process.stderr.write(`${USAGE}\n`); return 64; }
  if (!parsed.inside) return reexecInsideNamespace(parsed);
  try {
    const summary = await runProbe({ out: parsed.out, ...(parsed.clientVersion ? { clientVersion: parsed.clientVersion } : {}), ...(parsed.only ? { only: parsed.only } : {}) });
    const rows = summary.scenarios as Array<Record<string, unknown>>;
    for (const row of rows) process.stdout.write(`${String(row.scenario).padEnd(3)} expectation=${row.passed_expectation === true ? "met" : "NOT met"} requests=${String(row.requests)} wakes=${String(row.wakes)} leftover=${String(row.leftover_after_grace)}\n`);
    return rows.every((row) => row.passed_expectation === true) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`probe refused or failed: ${error instanceof Error ? error.message : "unknown"}\n`);
    return 2;
  }
}
function isEntryPoint(argvPath: string): boolean {
  try { return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (process.argv[1] && isEntryPoint(process.argv[1])) { const code = await main(process.argv.slice(2)); process.stdout.write("", () => process.exit(code)); }
