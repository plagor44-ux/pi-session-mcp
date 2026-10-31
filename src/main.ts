#!/usr/bin/env node
import { stdoutGuard } from "./stdout-guard-install.js";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { RoutingPiSessionAdapter, WriterRelayAdapter } from "./writer-relay.js";
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
import { createSnapshotGuard } from "./snapshot-guard.js";
import { trustedGit } from "./review-snapshot.js";

type ProcessDiagnostic = SdkPiAdapterDiagnostic | StartupDiagnostic | EventSpoolDiagnostic | {
  readonly level: "warn";
  readonly event: "event_delivery_inactive";
  readonly stage: "startup";
  readonly code: "event_runtime_dir_missing";
} | {
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

/**
 * An explicit directory wins and must be absolute; otherwise the runtime directory decides.
 * `undefined` when neither is set: a launcher such as Codex passes no `XDG_RUNTIME_DIR`, and no
 * controller there could be woken, so delivery stays inactive instead of failing startup (#113).
 */
function eventSpoolDirectory(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env[EVENTS_DIR_ENV];
  if (explicit === undefined || explicit.length === 0) return eventsRoot(env);
  if (explicit.includes("\0") || !isAbsolute(explicit)) throw new EventSpoolError();
  return explicit;
}

async function main(): Promise<void> {
  let registry: SessionRegistry | undefined;
  let spool: TurnEventSpool | undefined;
  let handle: ReturnType<typeof serveStdio> | undefined;
  try {
    const config = await loadConfig();
    const guardPath = process.env.PI_SESSION_MCP_WRITER_GUARD;
    let delivery = config.eventDelivery;
    if (delivery === "spool") {
      const directory = eventSpoolDirectory(process.env);
      if (directory === undefined) {
        delivery = "off";
        writeDiagnostic({ level: "warn", event: "event_delivery_inactive", stage: "startup", code: "event_runtime_dir_missing" });
      } else spool = TurnEventSpool.open(directory, { diagnostic: writeDiagnostic });
    }
    const events = spool;
    // The configuration directory must never become readable through a skill directory: the directory
    // named by the variable and, for a symlinked configuration file, the directory of its target.
    // loadConfig has read the file, so the variable is set and the path exists.
    const configFile = resolve(process.env.PI_SESSION_MCP_CONFIG!);
    const hostAdapter = new SdkPiSessionAdapter({
      diagnosticSink: writeDiagnostic,
      protectedReadPaths: [dirname(configFile), dirname(await realpath(configFile))],
    });
    const relay = guardPath === undefined;
    const adapter = relay ? new RoutingPiSessionAdapter(hostAdapter, new WriterRelayAdapter({
      home: homedir(), workspaceModes: config.workspaceModes, executionProfiles: config.executionProfiles,
    }), config.workspaceModes) : hostAdapter;
    registry = new SessionRegistry(adapter, config.workspaces, {
      snapshotGuard: createSnapshotGuard({ home: homedir(), workspaceModes: config.workspaceModes, git: trustedGit() }),
      ...(guardPath === undefined ? {} : { writerGuard: createWriterGuard(guardPath, config.workspaces) }),
      ...(events === undefined ? {} : {
        onTurnTerminal: (event) => events.write({ kind: "turn_terminal", session: event.sessionId, turn: event.turnId, state: event.state, via: event.via }),
      }),
    });
    handle = serveStdio(
      () => createServer(registry!, config.workspaces, config.executionProfiles, config.defaultExecutionProfile, config.configuration, config.workspaceModes, delivery, relay),
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
