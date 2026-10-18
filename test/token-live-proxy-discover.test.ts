import { describe, expect, test } from "vitest";
import { TokenFrameForwarder } from "../eval/profiles/token-live-proxy.js";

// The pinned @modelcontextprotocol/server 2.3.1 defines `server/discover` (protocol revision 2026-07-28, "servers MUST
// implement"); serveStdio answers it with a result for a valid _meta envelope. Claude Code 2.1.301 sends it first.
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const send = (forwarder: TokenFrameForwarder, value: unknown) => {
  const out: Buffer[] = [];
  forwarder.forward("request", line(value), bytes => out.push(Buffer.from(bytes)));
  return Buffer.concat(out);
};

describe("token-live proxy: server/discover", () => {
  test("forwards server/discover byte for byte and counts it without weakening later checks", () => {
    const forwarder = new TokenFrameForwarder();
    const bare = line({ jsonrpc: "2.0", id: 0, method: "server/discover" });
    const enveloped = line({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } });
    expect(send(forwarder, JSON.parse(bare.toString()))).toEqual(bare);
    expect(send(forwarder, JSON.parse(enveloped.toString()))).toEqual(enveloped);
    const response: Buffer[] = [];
    forwarder.forward("response", line({ jsonrpc: "2.0", id: 1, result: { supportedVersions: ["2026-07-28"] } }), bytes => response.push(Buffer.from(bytes)));
    expect(response).toHaveLength(1);
    expect(send(forwarder, { jsonrpc: "2.0", id: 2, method: "tools/list" }).length).toBeGreaterThan(0);
    expect(forwarder.finish()).toMatchObject({ discover_requests: 2, integrity_passed: true, fatal_request: false, written_bytes: bare.length + enveloped.length + line({ jsonrpc: "2.0", id: 2, method: "tools/list" }).length });
    // Another unlisted method is still fatal after a discover.
    expect(send(forwarder, { jsonrpc: "2.0", id: 3, method: "tasks/get", params: {} })).toEqual(Buffer.alloc(0));
    expect(forwarder.finish()).toMatchObject({ integrity_passed: false, fatal_request: true, discover_requests: 2 });
  });

  test.each([
    ["notification form without id", { jsonrpc: "2.0", method: "server/discover" }],
    ["array params", { jsonrpc: "2.0", id: 1, method: "server/discover", params: [] }],
    ["null params", { jsonrpc: "2.0", id: 1, method: "server/discover", params: null }],
    ["wrong jsonrpc version", { jsonrpc: "1.0", id: 1, method: "server/discover" }],
    ["method prefix", { jsonrpc: "2.0", id: 1, method: "server/discover/extra" }],
    ["sibling method", { jsonrpc: "2.0", id: 1, method: "server/other" }],
    ["wildcard-like method", { jsonrpc: "2.0", id: 1, method: "server/*" }],
    ["case variant", { jsonrpc: "2.0", id: 1, method: "Server/Discover" }],
  ])("keeps %s fatal and unforwarded", (_name, request) => {
    const forwarder = new TokenFrameForwarder();
    expect(send(forwarder, request)).toEqual(Buffer.alloc(0));
    expect(forwarder.finish()).toMatchObject({ integrity_passed: false, fatal_request: true, discover_requests: 0, written_bytes: 0 });
  });

  test("does not count a discover that the proxy refuses to forward", () => {
    const forwarder = new TokenFrameForwarder({ maxStarts: 1, maxPrompts: 1 });
    send(forwarder, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "synthetic_mutation", arguments: {} } });
    expect(send(forwarder, { jsonrpc: "2.0", id: 2, method: "server/discover" })).toEqual(Buffer.alloc(0));
    expect(forwarder.finish().discover_requests).toBe(0);
  });
});
