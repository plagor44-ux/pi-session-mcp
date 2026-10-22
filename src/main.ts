#!/usr/bin/env node
import { stdoutGuard } from "./stdout-guard-install.js";
import { isAbsolute } from "node:path";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { EventSpoolError, TurnEventSpool, type EventSpoolDiagnostic } from "./event-spool.js";
import { startupFailureDiagnostic, type StartupDiagnostic } from "./process-diagnostics.js";
import { createServer } from "./server.js";
import { SessionRegistry } from "./session-registry.js";
import { SdkPiSessionAdapter, type SdkPiAdapterDiagnostic } from "./sdk-pi-adapter.js";
import { shutdownAndTerminate } from "./shutdown.js";
import { EVENTS_DIR_ENV, eventsRoot } from "./turn-events.js";
import { createWriterGuard } from "./writer-guard.js";

type ProcessDiagnostic = SdkPiAdapterDiagnostic | StartupDiagnostic | EventSpoolDiagnostic | {
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

/** An explicit absolute directory wins; otherwise the runtime directory decides. Throws without either. */
function eventSpoolDirectory(env: NodeJS.ProcessEnv): string {
  const explicit = env[EVENTS_DIR_ENV];
  const dir = explicit !== undefined && explicit.length > 0 ? explicit : eventsRoot(env);
  if (dir === undefined || dir.includes("\0") || !isAbsolute(dir)) throw new EventSpoolError();
  return dir;
}

async function main(): Promise<void> {
  let registry: SessionRegistry | undefined;
  let spool: TurnEventSpool | undefined;
  let handle: ReturnType<typeof serveStdio> | undefined;
  try {
    const config = await loadConfig();
    const guardPath = process.env.PI_SESSION_MCP_WRITER_GUARD;
    if (config.eventDelivery === "spool") spool = TurnEventSpool.open(eventSpoolDirectory(process.env), { diagnostic: writeDiagnostic });
    const events = spool;
    registry = new SessionRegistry(new SdkPiSessionAdapter({ diagnosticSink: writeDiagnostic }), config.workspaces, {
      ...(guardPath === undefined ? {} : { writerGuard: createWriterGuard(guardPath, config.workspaces) }),
      ...(events === undefined ? {} : {
        onTurnTerminal: (event) => events.write({ kind: "turn_terminal", session: event.sessionId, turn: event.turnId, state: event.state, via: event.via }),
      }),
    });
    handle = serveStdio(
      () => createServer(registry!, config.workspaces, config.executionProfiles, config.defaultExecutionProfile, config.configuration, config.workspaceModes, config.eventDelivery),
      {
        transport: new StdioServerTransport(process.stdin, stdoutGuard.transportStdout),
        onerror: () => writeDiagnostic({ level: "error", event: "mcp_transport_error", stage: "transport", code: "mcp_transport_error" }),
      },
    );
  } catch (error) {
    spool?.close("shutdown");
    writeDiagnostic(startupFailureDiagnostic(error));
    process.exitCode = 1;
    return;
  }

  let stopping = false;
  // The spool closes only after the registry shutdown finished, so that the terminals which `close`
  // generates precede `instance_ended`. If the shutdown deadline wins, the spool still closes before exit.
  const shutdown = async (exitCode: number, reason: "eof" | "signal"): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const registryShutdown = async (): Promise<void> => {
      try { await registry!.shutdown(); } finally { spool?.close(reason); }
    };
    await shutdownAndTerminate(registryShutdown, () => handle!.close(), exitCode, {
      report: (outcome) => {
        if (outcome === "timed_out") spool?.close("shutdown");
        if (outcome !== "completed") writeDiagnostic({
          level: "error", event: "shutdown_failed", stage: "shutdown",
          code: outcome === "timed_out" ? "shutdown_timeout" : "shutdown_failed",
        });
      },
      terminate: (code) => { spool?.close(reason); process.exit(code); },
    });
  };
  process.once("SIGINT", () => { void shutdown(130, "signal"); });
  process.once("SIGTERM", () => { void shutdown(143, "signal"); });
  // On stdin EOF the SDK closes only its transport and server instance; sessions and
  // their MCP children need the same bounded shutdown as a signal. The first trigger wins.
  const endOfInput = (): void => { void shutdown(0, "eof"); };
  process.stdin.once("end", endOfInput);
  process.stdin.once("close", endOfInput);
  if (process.stdin.readableEnded || process.stdin.destroyed) endOfInput();
}

await main();
