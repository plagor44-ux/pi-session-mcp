import { describe, expect, it } from "vitest";
import { HISTORY_ENTRY_CAP_BYTES, PATH_RULE_MARKER } from "../src/history/constants.js";
import { compilePathRule, DEFAULT_REDACT_PATHS } from "../src/history/path-rule.js";
import { knownValuesFromEnv, Redactor, type ToolCallIndex } from "../src/history/redact.js";

const alnum = (n: number, seed = "aB3"): string => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const b64url = (value: string): string => Buffer.from(value).toString("base64url");

export const SENTINELS = {
  github_token: `ghp_${alnum(36, "Qx7")}`,
  github_pat: `github_pat_${alnum(82, "K9_z")}`,
  anthropic: `sk-ant-api03-${alnum(40, "Rt5")}`,
  openai: `sk-${alnum(48, "Mn2")}`,
  aws: `AKIA${"JX4Q".repeat(4)}`,
  slack: "xoxb-1-2-abc",
  jwt: `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"sentinel-subject"}')}.${alnum(43, "sIg")}`,
  pem: `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nSENTINELPEMBODYLINE2\n-----END OPENSSH PRIVATE KEY-----`,
  url: "https://u:p4ssw0rd@host/x",
  assignment: "PASSWORD=hunter2hunter2",
  known: "KNOWN_9f2c_long_value",
} as const;

/** The secret part of each sentinel, which must never survive. */
const SECRET_PARTS = [
  SENTINELS.github_token, SENTINELS.github_pat, SENTINELS.anthropic, SENTINELS.openai, SENTINELS.aws,
  SENTINELS.slack, SENTINELS.jwt, "SENTINELPEMBODYLINE2", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
  "p4ssw0rd", "hunter2hunter2", SENTINELS.known,
];

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
});
