import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/client";
import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";
import { serveRefusal } from "../src/refusal-server.js";
it("reports transport failure with one fixed stderr diagnostic", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await serveRefusal("writer_not_ready", { stdin, stdout });
    stdin.emit("error", new Error("secret /private/path"));
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledTimes(1));
    expect(stderr.mock.calls).toEqual([[JSON.stringify({ level: "error", event: "mcp_transport_error", stage: "transport", code: "mcp_transport_error" }) + "\n"]]);
  } finally { stdin.end(); stderr.mockRestore(); }
});
it("lists all eight tools and returns fixed structured refusals over frames only", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough(); const frames: unknown[] = [];
  const transport: Transport = {
    async start() { let buffer = ""; stdout.on("data", (chunk: Buffer) => { buffer += chunk.toString(); let end: number; while ((end = buffer.indexOf("\n")) >= 0) { const message = JSON.parse(buffer.slice(0, end)) as JSONRPCMessage; buffer = buffer.slice(end + 1); frames.push(message); transport.onmessage?.(message); } }); },
    async send(message) { stdin.write(JSON.stringify(message) + "\n"); },
    async close() { stdin.end(); },
  };
  await serveRefusal("container_runtime_unavailable", { stdin, stdout });
  const client = new Client({ name: "test", version: "1" }); await client.connect(transport);
  expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual(["pi_capabilities_get", "pi_session_abort", "pi_session_close", "pi_session_get", "pi_session_list", "pi_session_prompt", "pi_session_start", "pi_turn_get"]);
  const result = await client.callTool({ name: "pi_session_start", arguments: { arbitrary: true } });
  expect(result.isError).toBe(true); expect(result.structuredContent).toEqual({ ok: false, error: { code: "container_runtime_unavailable", message: "Rootless Podman is not usable on this machine; this writer refuses all work." } });
  expect(frames.length).toBeGreaterThan(0); await client.close();
});
