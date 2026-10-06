#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DOCTOR_ENTRY = new URL("../.pi-session-mcp-cli/doctor-cli.js", import.meta.url);

function safeProcessWriter(stream) {
  // A closed consumer reports EPIPE asynchronously on the stream. Install a
  // bounded sink before writing so the bootstrap never turns that transport
  // condition into an uncaught Node stack trace on stderr.
  stream.on("error", () => {});
  return (value) => {
    try {
      stream.write(value);
    } catch {
      // The report cannot be delivered; the caller's intended exit status is
      // still returned and remains the only observable result available.
    }
  };
}

function unavailableResult() {
  return {
    schemaVersion: 1,
    ok: false,
    checks: [{
      id: "doctor_cli_unavailable",
      severity: "error",
      subject: "Doctor CLI",
      remediation: "run the independent Doctor build",
    }],
    exitCode: 2,
  };
}

/**
 * Load the already-built offline Doctor without compiling in the report path.
 * Dependencies are injectable so failure sanitization can be proven without
 * exposing an arbitrary runtime entry-point option.
 */
export async function runDoctorBootstrap(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? safeProcessWriter(process.stdout);
  const stderr = dependencies.stderr ?? safeProcessWriter(process.stderr);
  const load = dependencies.load ?? (() => import(DOCTOR_ENTRY.href));
  const json = argv.length === 1 && argv[0] === "--json";

  if (!(argv.length === 0 || json)) {
    stderr("Usage: doctor [--json]\n");
    return 64;
  }

  try {
    await load();
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch {
    const result = unavailableResult();
    stdout(json
      ? `${JSON.stringify(result)}\n`
      : "ERROR doctor_cli_unavailable [Doctor CLI]: run the independent Doctor build\n");
    return result.exitCode;
  }
}

// npm installs bin entries as symlinks, so compare real paths.
function isEntryPoint(argv1) {
  if (!argv1) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1); } catch { return false; }
}

if (isEntryPoint(process.argv[1])) {
  process.exitCode = await runDoctorBootstrap(process.argv.slice(2));
}
