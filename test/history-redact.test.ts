import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { HISTORY_ENTRY_CAP_BYTES, PATH_RULE_MARKER } from "../src/history/constants.js";
import { compilePathRule, DEFAULT_REDACT_PATHS } from "../src/history/path-rule.js";
import { capJson, knownValuesFromEnv, Redactor, type ToolCallIndex } from "../src/history/redact.js";
import type { McpServers } from "../src/mcp-config.js";
import { connectSessionMcpTools, type McpConnection } from "../src/mcp-session-tools.js";
import { SECRET_PARTS, SENTINELS, alnum, b64url } from "./history-sentinels.js";

const env = { MY_API_KEY: SENTINELS.known, TOKEN: "abc", PATH: "/usr/bin:/bin", HOME: "/home/someone" };

function redactor(extraGlobs: readonly string[] = []): Redactor {
  return new Redactor({ knownValues: knownValuesFromEnv(env), pathRule: compilePathRule(extraGlobs) });
}

let ids = 0;
function base(type: string) { ids += 1; return { type, id: `e${ids}`, parentId: null, timestamp: "2026-11-04T10:00:00.000Z" }; }
function assistantText(text: string) { return { ...base("message"), message: { role: "assistant", content: [{ type: "text", text }] } }; }
function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { ...base("message"), message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } };
}
function toolResult(id: string, name: string, text: string, details?: unknown) {
  return { ...base("message"), message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, ...(details === undefined ? {} : { details }) } };
}

function run(r: Redactor, entries: unknown[]) {
  const calls: ToolCallIndex = new Map();
  return entries.map((entry) => r.entry(entry, calls));
}

describe("history redaction", () => {
  it("replaces every sentinel kind with its marker and counts it", () => {
    const text = Object.values(SENTINELS).join("\n and \n");
    const [out] = run(redactor(), [assistantText(text)]);
    for (const secret of SECRET_PARTS) expect(out!.json).not.toContain(secret);
    for (const kind of ["known_value", "github_token", "api_key", "aws_access_key", "slack_token", "jwt", "private_key", "url_credentials", "assignment"] as const) {
      expect(out!.redactions[kind], kind).toBeGreaterThanOrEqual(1);
      expect(out!.json).toContain(`[REDACTED:${kind}]`);
    }
    expect(out!.role).toBe("assistant");
  });

  it("redacts strings in tool arguments, thinking and custom entries", () => {
    const thinking = { ...base("message"), message: { role: "assistant", content: [{ type: "thinking", thinking: `use ${SENTINELS.github_token}` }] } };
    const custom = { ...base("custom"), customType: "x", data: { nested: [SENTINELS.aws] } };
    const call = toolCall("c1", "bash", { command: `curl -H 'Authorization: Bearer ${SENTINELS.openai}'` });
    for (const out of run(redactor(), [thinking, custom, call])) {
      for (const secret of SECRET_PARTS) expect(out.json).not.toContain(secret);
    }
  });

  it("skips short known values", () => {
    expect(knownValuesFromEnv(env)).toEqual([SENTINELS.known]);
    const [out] = run(redactor(), [assistantText("abc def")]);
    expect(out!.json).toContain("abc def");
  });

  it("drops read results for each default glob and a configured glob", () => {
    const paths = [".env", ".env.local", "deploy/app.sops.yaml", "secrets/db/creds.txt", "certs/server.pem", "tls.key", "/home/x/.ssh/id_rsa.pub", "id_ed25519", "kubeconfig-prod", "config/prod/app.yaml"];
    expect(DEFAULT_REDACT_PATHS).toEqual([".env", ".env.*", "*.sops.*", "secrets/**", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "kubeconfig*"]);
    const r = redactor(["config/prod/*.yaml"]);
    for (const [index, path] of paths.entries()) {
      const id = `read${index}`;
      const [call, result] = run(r, [toolCall(id, "read", { path }), toolResult(id, "read", `CONTENT_${index}_ZZZ plain`)]);
      expect(call!.droppedByPath, path).toBe(false);
      expect(call!.json).toContain(path);
      expect(result!.droppedByPath, path).toBe(true);
      expect(result!.json).not.toContain(`CONTENT_${index}_ZZZ`);
      expect(result!.json).toContain(PATH_RULE_MARKER);
      expect(result!.toolName).toBe("read");
    }
  });

  it("keeps read results for ordinary paths", () => {
    const [, result] = run(redactor(), [toolCall("r", "read", { path: "src/env.ts" }), toolResult("r", "read", "export const x = 1;")]);
    expect(result!.droppedByPath).toBe(false);
    expect(result!.json).toContain("export const x = 1;");
  });

  it("drops grep lines from matching files only", () => {
    const output = [
      ".env:3: DB_URL=postgres-local-ONLYENV",
      ".env-4- context-ONLYENV",
      "src/a.ts:10: const env = load();",
      "src/a.ts-11- // keep me",
      "secrets/x.txt:1: SECRETFILEONLY",
    ].join("\n");
    const [, result] = run(redactor(), [toolCall("g", "grep", { pattern: "env", path: "." }), toolResult("g", "grep", output)]);
    expect(result!.json).not.toContain("ONLYENV");
    expect(result!.json).not.toContain("SECRETFILEONLY");
    expect(result!.json).toContain("src/a.ts:10: const env = load();");
    expect(result!.json).toContain("src/a.ts-11- // keep me");
    expect(result!.droppedByPath).toBe(true);
  });

  it("drops grep results whose search root matches and resolves printed paths against the root", () => {
    // Pi prints paths relative to the search directory, or the basename for a single file.
    const [, inside] = run(redactor(), [toolCall("g1", "grep", { pattern: "x", path: "secrets" }), toolResult("g1", "grep", "db/creds.txt:1: ROOTSECRET1\nother.txt:2: ROOTSECRET2")]);
    expect(inside!.droppedByPath).toBe(true);
    expect(inside!.json).not.toContain("ROOTSECRET");
    const [, file] = run(redactor(), [toolCall("g2", "grep", { pattern: "x", path: "deploy/.env.prod" }), toolResult("g2", "grep", ".env.prod:1: FILESECRET")]);
    expect(file!.json).not.toContain("FILESECRET");
    const [, joined] = run(redactor(["config/prod/*.yaml"]), [toolCall("g3", "grep", { pattern: "x", path: "config/prod" }), toolResult("g3", "grep", "app.yaml:4: JOINEDSECRET\nREADME.md:1: keep-readme")]);
    expect(joined!.json).not.toContain("JOINEDSECRET");
    expect(joined!.json).toContain("keep-readme");
    const [, nospace] = run(redactor(), [toolCall("g4", "grep", { pattern: "x" }), toolResult("g4", "grep", ".env:3:NOSPACESECRET")]);
    expect(nospace!.json).not.toContain("NOSPACESECRET");
  });

  it("matches the path rule case-insensitively", () => {
    const rule = compilePathRule([]);
    for (const path of [".ENV", "Secrets/x", "server.PEM", "ID_RSA", "KubeConfig"]) expect(rule(path), path).toBe(true);
    const [, result] = run(redactor(), [toolCall("c", "read", { path: ".Env" }), toolResult("c", "read", "CASESECRET")]);
    expect(result!.json).not.toContain("CASESECRET");
  });

  it("redacts the whole userinfo of a URL whose password contains @", () => {
    const [out] = run(redactor(), [assistantText("clone https://user:p@ssw0rd@example.org/repo and http://a:b@h/")]);
    expect(out!.json).not.toContain("ssw0rd");
    expect(out!.json).toContain("[REDACTED:url_credentials]@example.org/repo");
    expect(out!.json).toContain("[REDACTED:url_credentials]@h/");
  });

  it("drops edit and write arguments and results on matching paths", () => {
    const [call, result] = run(redactor(), [
      toolCall("w", "write", { path: ".env", content: "TOKEN=plainvaluewritten" }),
      toolResult("w", "write", "Successfully wrote 26 bytes to .env"),
    ]);
    expect(call!.droppedByPath).toBe(true);
    expect(call!.json).not.toContain("plainvaluewritten");
    expect(call!.json).toContain(".env");
    expect(call!.json).toContain(PATH_RULE_MARKER);
    expect(result!.droppedByPath).toBe(true);
    const [editCall, editResult] = run(redactor(), [
      toolCall("e", "edit", { path: "secrets/app.env", edits: [{ oldText: "OLDPLAIN", newText: "NEWPLAIN" }] }),
      toolResult("e", "edit", "Edited", { diff: "-OLDPLAIN\n+NEWPLAIN" }),
    ]);
    for (const out of [editCall!, editResult!]) {
      expect(out.json).not.toContain("OLDPLAIN");
      expect(out.json).not.toContain("NEWPLAIN");
    }
  });

  it("bash output gets patterns only", () => {
    const output = `$ cat .env\nGITHUB=${SENTINELS.github_token}\nDB_PASS_RANDOM=Zq8assignedValue77\nWv3bareValue99x\n`;
    const [call, result] = run(redactor(), [toolCall("b", "bash", { command: "cat .env" }), toolResult("b", "bash", output)]);
    expect(call!.droppedByPath).toBe(false);
    expect(result!.droppedByPath).toBe(false);
    expect(result!.json).not.toContain(SENTINELS.github_token);
    expect(result!.json).not.toContain("Zq8assignedValue77");
    // Documented limit: an unrecognizable secret on its own line passes.
    expect(result!.json).toContain("Wv3bareValue99x");
  });

  it("redacts quoted multi-word assignment values to the closing quote", () => {
    const output = [
      `DB_PASSWORD="correct horse battery staple"`,
      `secret = "my multi word secret"`,
      `api_token: 'two words'`,
      `"client_secret": "Kq9 tail words here"`,
      `PASSWORD="unterminated Zr5tailvalue`,
    ].join("\n");
    const [, result] = run(redactor(), [toolCall("q", "bash", { command: "cat config" }), toolResult("q", "bash", output)]);
    for (const leaked of ["horse", "battery", "staple", "multi word", "two words", "tail words", "Zr5tailvalue"]) expect(result!.json).not.toContain(leaked);
    expect(result!.json).toContain(`DB_PASSWORD=\\"[REDACTED:assignment]\\"`);
    expect(result!.json).toContain(`api_token: '[REDACTED:assignment]'`);
  });

  it("PEM block in write to a non-matching path is removed", () => {
    const [call, result] = run(redactor(), [
      toolCall("p", "write", { path: "notes.txt", content: `keep this\n${SENTINELS.pem}\nand this` }),
      toolResult("p", "write", `wrote ${SENTINELS.pem}`),
    ]);
    for (const out of [call!, result!]) {
      expect(out.droppedByPath).toBe(false);
      expect(out.json).not.toContain("SENTINELPEMBODYLINE2");
      expect(out.json).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ");
      expect(out.json).toContain("[REDACTED:private_key]");
    }
    expect(call!.json).toContain("keep this");
    expect(call!.json).toContain("and this");
  });

  it("removes an unterminated PEM block to the end of the string", () => {
    const [out] = run(redactor(), [assistantText("-----BEGIN RSA PRIVATE KEY-----\nTRUNCATEDKEYBODY")]);
    expect(out!.json).not.toContain("TRUNCATEDKEYBODY");
  });

  it("replaces images and thinking signatures with size markers", () => {
    const image = "iVBORw0KGgo" + "A".repeat(5000);
    const entry = {
      ...base("message"),
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hm", thinkingSignature: "SIG".repeat(100) }, { type: "text", text: "x", textSignature: "TSIG".repeat(10) }] },
    };
    const user = { ...base("message"), message: { role: "user", content: [{ type: "image", data: image, mimeType: "image/png" }] } };
    const [a, u] = run(redactor(), [entry, user]);
    expect(a!.json).not.toContain("SIGSIG");
    expect(a!.json).toContain('"omitted":"signature"');
    expect(u!.json).not.toContain("AAAAAAAA");
    expect(JSON.parse(u!.json).message.content[0].data).toEqual({ omitted: "image", bytes: image.length });
  });

  it("truncates an entry above 1 MiB and flags it", () => {
    const big = "x".repeat(10 * 1024 * 1024);
    const [, result] = run(redactor(), [toolCall("t", "bash", { command: "yes" }), toolResult("t", "bash", big)]);
    expect(result!.truncated).toBe(true);
    expect(Buffer.byteLength(result!.json)).toBeLessThanOrEqual(HISTORY_ENTRY_CAP_BYTES);
    expect(result!.json).toContain(`[TRUNCATED:${big.length}]`);
    expect(() => JSON.parse(result!.json)).not.toThrow();
  });

  it("drops the content past the cap, not only its size", () => {
    const big = `HEAD_KEPT_ZZZ ${"x".repeat(5 * 1024 * 1024)} TAIL_DROPPED_ZZZ`;
    const [, result] = run(redactor(), [toolCall("t", "bash", { command: "cat big" }), toolResult("t", "bash", big)]);
    expect(result!.truncated).toBe(true);
    expect(result!.json).toContain("HEAD_KEPT_ZZZ");
    expect(result!.json).not.toContain("TAIL_DROPPED_ZZZ");
  });

  it("replaces an entry of many small strings with its envelope when cutting cannot fit it", () => {
    const value = { type: "message", id: "many", parentId: "root", timestamp: "2026-11-04T10:00:00.000Z", blob: Array.from({ length: 50 }, (_, index) => `MANY_DROPPED_${index}`) };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const capped = capJson(value, 200);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.json)).toBeLessThanOrEqual(200);
    expect(capped.json).not.toContain("MANY_DROPPED_");
    expect(JSON.parse(capped.json)).toEqual({ type: "message", id: "many", parentId: "root", timestamp: "2026-11-04T10:00:00.000Z", omitted: "oversized", bytes });
  });

  it("redacts recognized secrets in object keys at any depth and keeps every value", () => {
    const otherToken = `ghp_${alnum(36, "Wv4")}`;
    const data = {
      [SENTINELS.known]: "value under a known key",
      list: [{ [`Bearer ${SENTINELS.openai}`]: { [`x-${SENTINELS.aws}-y`]: "deep value" } }],
      [SENTINELS.github_token]: "first colliding value",
      [otherToken]: "second colliding value",
      "[REDACTED:github_token]#2": "literal key value",
      control: `string value ${SENTINELS.known}`,
    };
    const [out] = run(redactor(), [{ ...base("custom"), customType: "x", data }]);
    for (const secret of [...SECRET_PARTS, otherToken]) expect(out!.json).not.toContain(secret);
    const stored = JSON.parse(out!.json).data as Record<string, unknown>;
    expect(stored["[REDACTED:known_value]"]).toBe("value under a known key");
    expect(stored.list).toEqual([{ "Bearer [REDACTED:api_key]": { "x-[REDACTED:aws_access_key]-y": "deep value" } }]);
    // Keys that redact to the same text get a numbered suffix instead of overwriting each other.
    expect(stored["[REDACTED:github_token]"]).toBe("first colliding value");
    expect(stored["[REDACTED:github_token]#2"]).toBe("second colliding value");
    expect(stored["[REDACTED:github_token]#2#2"]).toBe("literal key value");
    expect(Object.keys(stored)).toHaveLength(6);
    // Control: the same secret as a string value is redacted as before.
    expect(stored.control).toBe("string value [REDACTED:known_value]");
    expect(out!.redactions).toEqual({ known_value: 2, api_key: 1, aws_access_key: 1, github_token: 2 });
  });

  it("numbers many keys that redact to the same text in linear time", () => {
    // Each new colliding key must not search the suffixes from #2 again, or n such keys cost n²/2 lookups.
    const count = 2000;
    const data: Record<string, string> = { "[REDACTED:github_token]#5": "literal" };
    for (let index = 0; index < count; index += 1) data[`ghp_${String(index).padStart(36, "0")}`] = `value ${index}`;
    const r = redactor();
    const hasOwn = vi.spyOn(Object, "hasOwn");
    let lookups: number;
    let out;
    try {
      [out] = run(r, [{ ...base("custom"), customType: "x", data }]);
      lookups = hasOwn.mock.calls.length;
    } finally { hasOwn.mockRestore(); }
    expect(lookups).toBeLessThan(3 * count);
    const stored = JSON.parse(out!.json).data as Record<string, string>;
    expect(Object.keys(stored)).toHaveLength(count + 1);
    expect(new Set(Object.values(stored))).toEqual(new Set(Object.values(data)));
    expect(stored["[REDACTED:github_token]#5"]).toBe("literal");
    expect(stored["[REDACTED:github_token]"]).toBe("value 0");
    expect(stored["[REDACTED:github_token]#4"]).toBe("value 3");
    expect(stored["[REDACTED:github_token]#6"]).toBe("value 4");
    expect(stored[`[REDACTED:github_token]#${count + 1}`]).toBe(`value ${count - 1}`);
    expect(out!.redactions).toEqual({ github_token: count });
  });

  it("keeps a __proto__ key as data and redacts below it", () => {
    const entry = JSON.parse(`{"type":"custom","id":"proto","parentId":null,"timestamp":"2026-11-04T10:00:00.000Z","data":{"__proto__":{"inner":"${SENTINELS.known}"},"list":[{"__proto__":"${SENTINELS.github_token}"}]}}`) as unknown;
    const [out] = run(redactor(), [entry]);
    expect(out!.json).not.toContain(SENTINELS.known);
    expect(out!.json).not.toContain(SENTINELS.github_token);
    expect(out!.json).toContain(`"__proto__":{"inner":"[REDACTED:known_value]"}`);
    expect(out!.json).toContain(`"__proto__":"[REDACTED:github_token]"`);
  });

  it("redacts keys of the structured content an external MCP tool returns", async () => {
    const structuredContent = { [SENTINELS.github_token]: { [SENTINELS.known]: "nested value" }, list: [{ [SENTINELS.openai]: 1 }] };
    const connection: McpConnection = {
      async connect() {},
      async listTools() { return { tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] }; },
      async callTool() { return { content: [], structuredContent }; },
      async close() {},
    };
    const servers: McpServers = { knowledge: { command: "/usr/bin/node", tools: { lookup: { name: "lookup", readOnly: true } } } };
    const session = await connectSessionMcpTools(servers, "read-only", "/workspace", () => connection);
    try {
      const tool = session.tools[0]!;
      const result = await tool.execute("mcp-1", { query: "q" }, undefined, undefined, {} as Parameters<ToolDefinition["execute"]>[4]);
      const recorded = { ...base("message"), message: { role: "toolResult", toolCallId: "mcp-1", toolName: tool.name, content: result.content, details: result.details, isError: false } };
      const [, out] = run(redactor(), [toolCall("mcp-1", tool.name, { query: "q" }), recorded]);
      for (const secret of SECRET_PARTS) expect(out!.json).not.toContain(secret);
      const stored = JSON.parse(out!.json).message.details.structuredContent;
      expect(stored).toEqual({ "[REDACTED:github_token]": { "[REDACTED:known_value]": "nested value" }, list: [{ "[REDACTED:api_key]": 1 }] });
    } finally { await session.close(); }
  });

  it("checks metadata strings separately from the entry JSON", () => {
    const r = redactor();
    for (const value of [SENTINELS.known, `id-${SENTINELS.github_token}`]) expect(r.isClean(value), value).toBe(false);
    expect(r.isClean("e1-plain-id")).toBe(true);
  });

  it("keeps entries below the cap untouched apart from redaction", () => {
    const [out] = run(redactor(), [assistantText("hello world")]);
    expect(out!.truncated).toBe(false);
    expect(JSON.parse(out!.json).message.content[0].text).toBe("hello world");
  });

  it("compilePathRule matches basenames, nested paths and absolute paths", () => {
    const rule = compilePathRule([]);
    for (const path of [".env", "./.env", "/repo/.env", "a/b/.env.prod", "/repo/secrets/a/b", "secrets/x", "@.env", "~/.kube/kubeconfig"]) expect(rule(path), path).toBe(true);
    for (const path of ["env", "src/env.ts", "secretsx/a", "a.pem.txt", "notes.txt", ""]) expect(rule(path), path).toBe(false);
  });

  it("compilePathRule matches equivalent spellings with . and .. segments", () => {
    const rule = compilePathRule(["config/prod/*.yaml"]);
    for (const path of ["config/prod/./app.yaml", "config/./prod/app.yaml", "config/staging/../prod/app.yaml", "src/../config/prod/app.yaml", "/repo/config//prod/app.yaml", "secrets/./db", "a/../secrets/x", ".\\secrets\\.\\x"]) expect(rule(path), path).toBe(true);
    for (const path of ["config/prod/../app.yaml", "secrets/../notes.txt", "config/prod/sub/../../app.yaml"]) expect(rule(path), path).toBe(false);
    const [call, result] = run(redactor(["config/prod/*.yaml"]), [toolCall("n", "read", { path: "config/prod/./app.yaml" }), toolResult("n", "read", "NORMALIZED_SECRET_ZZZ")]);
    expect(call!.droppedByPath).toBe(false);
    expect(result!.droppedByPath).toBe(true);
    expect(result!.json).not.toContain("NORMALIZED_SECRET_ZZZ");
  });
});
