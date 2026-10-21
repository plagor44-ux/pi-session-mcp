import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe, SCENARIOS } from "./claude-probe.js";

// `node cli.js probe --out <dir> [--client-version <v>] [--only S1,S2,X6]`
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

async function main(argv: string[]): Promise<number> {
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
