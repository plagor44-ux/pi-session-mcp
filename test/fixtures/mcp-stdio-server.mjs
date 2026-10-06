/**
 * Controlled local stdio MCP test server.
 *
 * Uses the real `@modelcontextprotocol/server` SDK over a real stdio transport.
 * Every payload is synthetic. The server never reads host files beyond the
 * harness-provided release path of the `hold_note` barrier, never uses
 * credentials, and writes only MCP frames to stdout (diagnostics go to stderr).
 *
 * Configuration is by environment variable only so the server can be launched
 * by an absolute `node` executable plus an absolute script path:
 *
 *   MCP_FIXTURE_LOG        append one JSON line per tools/call (synthetic data)
 *   MCP_FIXTURE_DELAY_INIT_MS  delay the `initialize` response
 *   MCP_FIXTURE_IGNORE_EOF     stay alive after stdin EOF
 *   MCP_FIXTURE_IGNORE_SIGTERM ignore SIGTERM (forces SIGKILL escalation)
 *   MCP_FIXTURE_PAGE_SIZE      tools returned per tools/list page
 *   MCP_FIXTURE_HOLD_RELEASE_FILE  path whose creation releases a held `hold_note` call
 *   MCP_FIXTURE_HOLD_BUDGET_MS     upper bound on how long `hold_note` stays held
 *   MCP_FIXTURE_SOURCE_ERROR      synthetic tools/call error-result JSON for `source_excerpt`
 *                                (the existing hold barrier also holds its error reply)
 *   MCP_FIXTURE_SOURCE_LARGE_RESULT  generate an oversized UTF-8 `success` or `error` reply
 */
import { appendFileSync, existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const logPath = process.env.MCP_FIXTURE_LOG;
const delayInitMs = Number(process.env.MCP_FIXTURE_DELAY_INIT_MS ?? "0");
const pageSize = Number(process.env.MCP_FIXTURE_PAGE_SIZE ?? "4");
const ignoreEof = process.env.MCP_FIXTURE_IGNORE_EOF === "1";
const ignoreSigterm = process.env.MCP_FIXTURE_IGNORE_SIGTERM === "1";
const emptyCatalog = process.env.MCP_FIXTURE_EMPTY_TOOLS === "1";
const loopCursor = process.env.MCP_FIXTURE_CURSOR_LOOP === "1";
const advertiseTools = process.env.MCP_FIXTURE_NO_TOOLS_CAPABILITY !== "1";
const invalidStructuredOutput = process.env.MCP_FIXTURE_INVALID_STRUCTURED_OUTPUT === "1";
// Barrier knob for `hold_note`: when a release path is configured, the call stays in flight
// until the harness creates that file, so a test can observe state between the assistant's
// tool request and the tool's completion. The budget keeps a broken test from holding the
// child open forever; with no path configured the tool returns immediately.
const holdReleaseFile = process.env.MCP_FIXTURE_HOLD_RELEASE_FILE ?? "";
const holdBudgetMs = Number(process.env.MCP_FIXTURE_HOLD_BUDGET_MS ?? "20000");
const sourceError = JSON.parse(process.env.MCP_FIXTURE_SOURCE_ERROR ?? JSON.stringify({
  content: [{ type: "text", text: JSON.stringify({ code: "SOURCE_TOO_LARGE", message: "Increase maxBytes." }) }],
  isError: true,
}));
const largeSourceResult = process.env.MCP_FIXTURE_SOURCE_LARGE_RESULT;
const largeMarker = "MCP_LARGE_RESULT_LEAK_MARKER";
// Generate in the child: oversized payloads cannot be passed in one Linux env value.
const sourceReply = largeSourceResult === "success"
  ? { isError: false, content: [{ type: "text", text: `${largeMarker}${"😀".repeat(65536)}` }] }
  : largeSourceResult === "error"
    ? { isError: true, content: [{ type: "text", text: `${JSON.stringify({ code: "SOURCE_TOO_LARGE", message: largeMarker })}${" ".repeat(262144)}` }] }
    : sourceError;

const noteSchema = {
  type: "object",
  properties: { note: { type: "string", minLength: 1, maxLength: 200 } },
  required: ["note"],
  additionalProperties: false,
};

/** Nested schema: exercises required fields, wrong types and additionalProperties:false. */
const inspectSchema = {
  type: "object",
  properties: {
    artifact: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
      additionalProperties: false,
    },
    options: {
      type: "object",
      properties: { deep: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  required: ["artifact"],
  additionalProperties: false,
};
const inspectOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    tool: { type: "string" },
    id: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    deep: { type: "boolean" },
  },
  required: ["ok", "tool", "id", "tags", "deep"],
  additionalProperties: false,
};

// `secret_admin` is deliberately NOT granted by the tested configuration.
const catalog = [
  { name: "echo_note", description: "Echo a synthetic note.", inputSchema: noteSchema },
  { name: "artifact_inspect", description: "Inspect a synthetic artifact.", inputSchema: inspectSchema, outputSchema: inspectOutputSchema },
  { name: "fail_note", description: "Always fails with MCP isError.", inputSchema: noteSchema },
  { name: "secret_admin", description: "Must never be reachable without a grant.", inputSchema: noteSchema },
  { name: "slow_note", description: "Resolves only if not cancelled.", inputSchema: noteSchema },
  { name: "error_note", description: "Fails with a JSON-RPC error.", inputSchema: noteSchema },
  { name: "crash_note", description: "Exits the process mid-call.", inputSchema: noteSchema },
  // Page 2 of the catalog holds one granted tool behind a cursor.
  { name: "paged_note", description: "Granted tool beyond the first catalog page.", inputSchema: noteSchema },
  // Appended last so the existing catalog pages keep their contents. Stays in flight until the
  // harness creates the configured release file, which lets a test observe the exact window
  // between a completed assistant tool request and the tool's own completion.
  { name: "hold_note", description: "Stays in flight until the harness releases it.", inputSchema: noteSchema },
  { name: "source_excerpt", description: "Reads a synthetic source with a response byte limit.", inputSchema: {
    type: "object", properties: { maxBytes: { type: "integer", minimum: 1, maximum: 4096 } },
    required: ["maxBytes"], additionalProperties: false,
  } },
];

/** Synthetic marker used to prove child diagnostics never reach controller output. */
const STDERR_MARKER = "MCP_FIXTURE_STDERR_MARKER";

function record(entry) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Recording is best-effort diagnostics for the test harness.
  }
}

function ok(payload) {
  return { content: [{ type: "text", text: payload }] };
}

const server = new Server(
  { name: "pi-session-mcp-mcp-fixture", version: "1.0.0" },
  { capabilities: advertiseTools ? { tools: {} } : {} },
);

server.setRequestHandler("initialize", async (request) => {
  if (delayInitMs > 0) await new Promise((resolve) => setTimeout(resolve, delayInitMs));
  record({ event: "initialize", requestedVersion: request?.params?.protocolVersion ?? null, pid: process.pid });
  return {
    protocolVersion: request?.params?.protocolVersion ?? "2025-06-18",
    capabilities: advertiseTools ? { tools: {} } : {},
    serverInfo: { name: "pi-session-mcp-mcp-fixture", version: "1.0.0" },
  };
});

if (advertiseTools) server.setRequestHandler("tools/list", async (request) => {
  const cursor = request?.params?.cursor;
  if (emptyCatalog) {
    record({ event: "tools/list", offset: 0, returned: [] });
    return { tools: [] };
  }
  if (loopCursor) {
    const tool = cursor === undefined ? catalog[0] : catalog.at(-1);
    record({ event: "tools/list", offset: -1, returned: [tool.name] });
    return { tools: [tool], nextCursor: "loop" };
  }
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(offset) || offset < 0 || offset > catalog.length) {
    throw new Error("invalid cursor");
  }
  const page = catalog.slice(offset, offset + pageSize);
  const next = offset + pageSize;
  record({ event: "tools/list", offset, returned: page.map((tool) => tool.name) });
  return next < catalog.length
    ? { tools: page, nextCursor: String(next) }
    : { tools: page };
});

if (advertiseTools) server.setRequestHandler("tools/call", async (request) => {
  const name = request?.params?.name;
  const args = request?.params?.arguments ?? {};
  record({ event: "tools/call", name, args });
  record({ event: "stderr_marker", where: "tools/call", bytes: process.stderr.write(`${STDERR_MARKER} handling ${String(name)}\n`) });

  if (name === "echo_note") {
    return {
      content: [{ type: "text", text: `note:${args.note}` }],
      structuredContent: { ok: true, tool: "echo_note", note: args.note },
    };
  }
  if (name === "artifact_inspect") {
    const artifact = args.artifact ?? {};
    return {
      content: [{ type: "text", text: `artifact:${artifact.id}` }],
      structuredContent: { ok: true, tool: "artifact_inspect", id: invalidStructuredOutput ? 7 : artifact.id, tags: artifact.tags ?? [], deep: args.options?.deep === true },
    };
  }
  if (name === "paged_note") {
    return { content: [{ type: "text", text: `paged:${args.note}` }], structuredContent: { ok: true, tool: "paged_note" } };
  }
  if (name === "fail_note") {
    return { content: [{ type: "text", text: "synthetic failure" }], isError: true };
  }
  if (name === "source_excerpt") {
    if (args.maxBytes >= 128 && (largeSourceResult === undefined || args.maxBytes === 128)) {
      record({ event: "source-result", kind: "success" });
      return { content: [{ type: "text", text: "synthetic-source-oracle" }], structuredContent: { ok: true, maxBytes: args.maxBytes } };
    }
    if (holdReleaseFile) {
      const startedAt = Date.now();
      record({ event: "source-held" });
      while (!existsSync(holdReleaseFile) && Date.now() - startedAt < holdBudgetMs) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      record({ event: "source-released", released: existsSync(holdReleaseFile) });
    }
    // Synthetic foreign text also reaches the child's real fd 2, so the controller
    // subprocess probe can catch accidental stderr inheritance or forwarding.
    const diagnostic = `${JSON.stringify(sourceReply)}\n`;
    process.stderr.write(diagnostic);
    record({ event: "source-result", kind: largeSourceResult === "success" ? "success" : "error", result: sourceReply, stderrBytes: Buffer.byteLength(diagnostic, "utf8") });
    return sourceReply;
  }
  if (name === "slow_note") {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return ok(`slow:${args.note}`);
  }
  if (name === "hold_note") {
    const barrierConfigured = holdReleaseFile !== "";
    const startedAt = Date.now();
    record({ event: "hold-start", name, configured: barrierConfigured });
    let released = !barrierConfigured;
    while (!released && Date.now() - startedAt < holdBudgetMs) {
      released = existsSync(holdReleaseFile);
      if (!released) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    record({ event: "hold-end", name, configured: barrierConfigured, released, waitedMs: Date.now() - startedAt });
    return ok(`held:${args.note}`);
  }
  if (name === "error_note") {
    // Server-side failure: must surface as a JSON-RPC error, never as a result.
    throw new Error("SYNTHETIC_SERVER_ERROR_MARKER");
  }
  if (name === "crash_note") {
    record({ event: "crash", name });
    process.exit(7);
  }
  return { content: [{ type: "text", text: "ungranted tool executed" }], isError: true };
});

if (ignoreSigterm) process.on("SIGTERM", () => record({ event: "sigterm-ignored" }));
if (ignoreEof) {
  // Must stay ref'd: an unref'd timer would not hold the event loop open, so the
  // child would exit on stdin EOF and SIGKILL escalation would never be exercised.
  setInterval(() => {}, 1_000);
  process.stdin.on("close", () => record({ event: "eof-ignored" }));
}

await server.connect(new StdioServerTransport());
record({ event: "connected", pid: process.pid });
record({ event: "stderr_marker", where: "connected", bytes: process.stderr.write(`${STDERR_MARKER} connected\n`) });
// Proves real child termination: SIGKILL leaves no record, so the harness also
// polls the recorded pid for ESRCH.
process.on("exit", (code) => record({ event: "exit", pid: process.pid, code }));
