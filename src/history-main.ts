#!/usr/bin/env node
import { isEntryPoint } from "./entry-point.js";
import { runHistoryCli } from "./history/cli.js";

/**
 * `pi-session-mcp-history`: reads and maintains the opt-in session history (ADR 0019). It is a
 * separate binary, so its stdout carries reports; the MCP server's stdout stays reserved for frames.
 */
async function main(): Promise<void> {
  // A closed pipe (`| head`) ends the report quietly.
  process.stdout.on("error", () => process.exit(0));
  process.exitCode = await runHistoryCli(process.argv.slice(2), {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}

if (isEntryPoint(import.meta.url, process.argv[1])) void main().catch(() => { process.stderr.write("History command failed\n"); process.exitCode = 1; });
