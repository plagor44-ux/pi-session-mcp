#!/usr/bin/env node
import { isEntryPoint } from "./entry-point.js";
import { runProviderCli } from "./provider-cli.js";

async function main(): Promise<void> {
  process.stdout.on("error", () => process.exit(0));
  process.exitCode = await runProviderCli(process.argv.slice(2), {
    stdout: text => { process.stdout.write(text); },
    stderr: text => { process.stderr.write(text); },
  });
}
if (isEntryPoint(import.meta.url, process.argv[1])) void main().catch(() => { process.stderr.write("provider_store_unavailable\n"); process.exitCode = 1; });
