#!/usr/bin/env node
import { isEntryPoint } from "./entry-point.js";
import { runRoutingCli } from "./routing/cli.js";

async function main(): Promise<void> {
  process.stdout.on("error", () => process.exit(0));
  process.exitCode = await runRoutingCli(process.argv.slice(2), {
    stdout: text => { process.stdout.write(text); },
    stderr: text => { process.stderr.write(text); },
  });
}
if (isEntryPoint(import.meta.url, process.argv[1])) void main().catch(() => { process.stderr.write("routing_unavailable\n"); process.exitCode = 1; });
