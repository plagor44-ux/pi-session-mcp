import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

const { transportStdout, serve, transport } = vi.hoisted(() => ({
  transportStdout: {}, serve: vi.fn(), transport: vi.fn(),
}));
vi.mock("../src/stdout-guard-install.js", () => ({ stdoutGuard: { transportStdout } }));
vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: serve,
  StdioServerTransport: class { constructor(...args: unknown[]) { transport(...args); } },
}));
import { serveRefusal } from "../src/refusal-server.js";

it("uses protected stdout by default and preserves explicit stream injection", async () => {
  await serveRefusal("writer_not_ready");
  expect(transport).toHaveBeenLastCalledWith(process.stdin, transportStdout);
  const stdin = new PassThrough(), stdout = new PassThrough();
  await serveRefusal("writer_not_ready", { stdin, stdout });
  expect(transport).toHaveBeenLastCalledWith(stdin, stdout);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const options = serve.mock.calls[0]![1] as { onerror: (error: Error) => void };
    options.onerror(new Error("secret /private/path"));
    expect(stderr.mock.calls).toEqual([[JSON.stringify({ level: "error", event: "mcp_transport_error", stage: "transport", code: "mcp_transport_error" }) + "\n"]]);
  } finally { stderr.mockRestore(); }
});
