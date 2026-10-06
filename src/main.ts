#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { startupFailureDiagnostic, type StartupDiagnostic } from "./process-diagnostics.js";
import { createServer } from "./server.js";
import { SessionRegistry } from "./session-registry.js";
import { SdkPiSessionAdapter, type SdkPiAdapterDiagnostic } from "./sdk-pi-adapter.js";
import { shutdownAndTerminate } from "./shutdown.js";

type ProcessDiagnostic = SdkPiAdapterDiagnostic | StartupDiagnostic | {
  readonly level: "error";
  readonly event: "mcp_transport_error";
  readonly stage: "transport";
  readonly code: "mcp_transport_error";
} | {
  readonly level: "error";
  readonly event: "shutdown_failed";
  readonly stage: "shutdown";
  readonly code: "shutdown_failed" | "shutdown_timeout";
};

function writeDiagnostic(diagnostic: ProcessDiagnostic): void {
  process.stderr.write(JSON.stringify(diagnostic) + "\n");
}

async function main(): Promise<void> {
  let registry: SessionRegistry | undefined;
  let handle: ReturnType<typeof serveStdio> | undefined;
  try {
    const config = await loadConfig();
    registry = new SessionRegistry(new SdkPiSessionAdapter({ diagnosticSink: writeDiagnostic }), config.workspaces);
    handle = serveStdio(
      () => createServer(registry!, config.workspaces, config.executionProfiles, config.defaultExecutionProfile, config.configuration),
      { onerror: () => writeDiagnostic({ level: "error", event: "mcp_transport_error", stage: "transport", code: "mcp_transport_error" }) },
    );
  } catch (error) {
    writeDiagnostic(startupFailureDiagnostic(error));
    process.exitCode = 1;
    return;
  }

  let stopping = false;
  const shutdown = async (exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await shutdownAndTerminate(() => registry!.shutdown(), () => handle!.close(), exitCode, {
      report: (outcome) => {
        if (outcome !== "completed") writeDiagnostic({
          level: "error", event: "shutdown_failed", stage: "shutdown",
          code: outcome === "timed_out" ? "shutdown_timeout" : "shutdown_failed",
        });
      },
      terminate: (code) => process.exit(code),
    });
  };
  process.once("SIGINT", () => { void shutdown(130); });
  process.once("SIGTERM", () => { void shutdown(143); });
}

await main();
