import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLedger, renderTaskMarkdown } from "./ledger.js";
import type { LedgerEvent } from "./ledger.js";
import { LedgerError, LedgerStore } from "./ledger-store.js";

export interface CliResult { code: number; stdout: string; stderr: string }
const OPTIONS: Record<string, string[]> = { apply: ["--dir"], init: ["--dir", "--run-id", "--controller"], render: ["--dir"] };

function parse(argv: string[]): { command: string; options: Record<string, string> } | undefined {
  const [command, ...rest] = argv;
  const allowed = command ? OPTIONS[command] : undefined;
  if (!command || !allowed || rest.length !== allowed.length * 2) return undefined;
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1];
    if (!allowed.includes(key) || value === undefined || value.startsWith("--") || key in options) return undefined;
    options[key] = value;
  }
  return { command, options };
}

/** Prints only IDs, outcomes and codes. Paths and event text never appear in the output. */
export async function runCli(argv: string[], readStdin: () => Promise<string>): Promise<CliResult> {
  const usage: CliResult = { code: 64, stdout: "", stderr: JSON.stringify({ error: "usage" }) + "\n" };
  const parsed = parse(argv);
  if (!parsed) return usage;
  const store = new LedgerStore(parsed.options["--dir"]!);
  try {
    if (parsed.command === "init") {
      await store.init(createLedger({ runId: parsed.options["--run-id"]!, controllerLabel: parsed.options["--controller"]!, at: new Date().toISOString() }));
      return { code: 0, stdout: JSON.stringify({ revision: 0, outcomes: [] }) + "\n", stderr: "" };
    }
    if (parsed.command === "render") return { code: 0, stdout: renderTaskMarkdown(await store.read()), stderr: "" };
    let input: unknown;
    try { input = JSON.parse(await readStdin()); } catch { return usage; }
    const events = (Array.isArray(input) ? input : [input]) as LedgerEvent[];
    const result = await store.apply(events);
    return { code: result.outcomes.some((o) => o.outcome === "rejected") ? 2 : 0, stdout: JSON.stringify(result) + "\n", stderr: "" };
  } catch (e) {
    if (e instanceof LedgerError) return { code: 2, stdout: "", stderr: JSON.stringify({ error: e.code }) + "\n" };
    return { code: 1, stdout: "", stderr: JSON.stringify({ error: "internal_error" }) + "\n" };
  }
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
function isEntryPoint(argvPath: string): boolean {
  try { return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (process.argv[1] && isEntryPoint(process.argv[1])) {
  const r = await runCli(process.argv.slice(2), readAll);
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
