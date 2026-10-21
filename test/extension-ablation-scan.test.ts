import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, scanCommand } from "../eval/extensions/cli.js";
import { scanTranscripts, writeScan } from "../eval/extensions/scan.js";
import { hash } from "../eval/profiles/files.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

const FIXTURES = fileURLToPath(new URL("./fixtures/extension-ablation/", import.meta.url));
const line = (value: unknown): string => JSON.stringify(value);
const use = (id: string, name: string, input: Record<string, unknown>, timestamp = "2026-10-02T09:00:00Z") =>
  line({ type: "assistant", timestamp, message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: unknown, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
  line({ type: "user", ...top, message: { content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } });
const session = (id: string, executionProfile: string) => ({ id, workspace: "repo", executionProfile });
const turn = (turnId: string, state: string) => ({ turnId, state });

/** Runs `body` and returns what it wrote to stdout. */
async function captureStdout(body: () => Promise<void>): Promise<string> {
  let shown = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { shown += String(chunk); return true; }) as typeof process.stdout.write);
  try { await body(); } finally { spy.mockRestore(); }
  return shown;
}

async function scanLines(lines: string[]) {
  const dir = await temporaryRoot("ablation-scan-");
  await writeFile(join(dir, "t.jsonl"), `${lines.join("\n")}\n`);
  return scanTranscripts(dir);
}

describe("transcript scanner", () => {
  it("finds one candidate per prompted session, with profiles, follow-ups and terminal states, and returns no prompt text", async () => {
    const dir = await temporaryRoot("ablation-scan-fixture-");
    await writeFile(join(dir, "transcript.jsonl"), await readFile(join(FIXTURES, "transcript.jsonl")));
    await writeFile(join(dir, "notes.txt"), "ignored: not a jsonl file");
    const scan = await scanTranscripts(dir);
    expect(scan.candidates.map((c) => c.followUps)).toEqual([0, 1]);
    expect(scan.candidates.map((c) => c.executionProfile)).toEqual(["review-grok", "code"]);
    expect(scan.candidates.map((c) => c.firstTerminal)).toEqual(["completed", "failed"]);
    expect(scan.candidates.map((c) => c.sessionId)).toEqual(["sess-review", "sess-code"]);
    expect(scan.candidates[0]).toMatchObject({
      transcript: "transcript.jsonl", server: "pi-session-mcp", workspace: "synthetic-repo", firstPromptHash: hash("SYNTHETIC-PROMPT-REVIEW: look at the synthetic module"),
    });
    expect(scan.candidates[0]!.firstPromptAt).toMatch(/^2026-10-01T10:/);
    expect(scan.skippedLines).toBe(1);
    const serialized = JSON.stringify(scan);
    expect(serialized).not.toContain("SYNTHETIC-PROMPT");
    expect(serialized).not.toContain("SYNTHETIC-ASSISTANT-TEXT");
    expect(serialized).not.toContain(dir);
  });

  it("accepts any pi- server, structured results and text-part results, and takes a terminal state from the prompt result", async () => {
    const scan = await scanLines([
      use("a", "mcp__pi-coding-psm-alpha__pi_session_start", { workspace: "repo", executionProfile: "code" }),
      result("a", [{ type: "text", text: JSON.stringify({ ok: true, session: session("alpha-1", "code") }) }]),
      use("b", "mcp__pi-coding-psm-alpha__pi_session_prompt", { sessionId: "alpha-1", prompt: "first" }),
      result("b", "unused text", {}, { toolUseResult: { ok: true, turn: turn("t1", "completed") } }),
      use("c", "mcp__pi-session-mcp__pi_session_start", { workspace: "repo", executionProfile: "review" }),
      result("c", "not json", {}, { toolUseResult: { structuredContent: { ok: true, session: session("beta-1", "review") } } }),
      use("d", "mcp__pi-session-mcp__pi_session_prompt", { sessionId: "beta-1", prompt: "second" }),
      result("d", JSON.stringify({ ok: true, turn: turn("t2", "running") })),
    ]);
    expect(scan.candidates).toMatchObject([
      { server: "pi-coding-psm-alpha", sessionId: "alpha-1", firstTerminal: "completed", followUps: 0 },
      { server: "pi-session-mcp", sessionId: "beta-1", firstTerminal: "unknown", followUps: 0 },
    ]);
  });

  it("matches turns by id: only the first prompt's turn decides, and a turn_get of a later turn does not", async () => {
    const scan = await scanLines([
      use("a", "mcp__pi-session-mcp__pi_session_start", { workspace: "repo", executionProfile: "code" }),
      result("a", JSON.stringify({ ok: true, session: session("s", "code") })),
      use("b", "mcp__pi-session-mcp__pi_session_prompt", { sessionId: "s", prompt: "one" }),
      result("b", JSON.stringify({ ok: true, turn: turn("t1", "running") })),
      use("c", "mcp__pi-session-mcp__pi_session_prompt", { sessionId: "s", prompt: "two" }),
      result("c", JSON.stringify({ ok: true, turn: turn("t2", "running") })),
      use("d", "mcp__pi-session-mcp__pi_turn_get", { sessionId: "s", turnId: "t2" }),
      result("d", JSON.stringify({ ok: true, turn: turn("t2", "aborted") })),
    ]);
    expect(scan.candidates).toMatchObject([{ sessionId: "s", followUps: 1, firstTerminal: "unknown" }]);
  });

  it("skips sessions whose start failed, prompts for unknown sessions, error results and non-pi servers", async () => {
    const scan = await scanLines([
      use("a", "mcp__pi-session-mcp__pi_session_start", { workspace: "repo", executionProfile: "code" }),
      result("a", JSON.stringify({ ok: true, session: session("s", "code") }), { is_error: true }),
      use("b", "mcp__pi-session-mcp__pi_session_prompt", { sessionId: "s", prompt: "never started" }),
      result("b", JSON.stringify({ ok: true, turn: turn("t1", "completed") })),
      use("c", "mcp__elsewhere__pi_session_start", { workspace: "repo", executionProfile: "code" }),
      result("c", JSON.stringify({ ok: true, session: session("e", "code") })),
      use("d", "mcp__elsewhere__pi_session_prompt", { sessionId: "e", prompt: "x" }),
      "[]",
      line(null),
    ]);
    expect(scan.candidates).toEqual([]);
    expect(scan.skippedLines).toBe(2);
  });

  it("reads transcripts in subdirectories too (subagents), in path order, and never follows links", async () => {
    const dir = await temporaryRoot("ablation-scan-order-");
    const body = (id: string) => [
      use("a", "mcp__pi-session-mcp__pi_session_start", { workspace: "repo", executionProfile: "review" }),
      result("a", JSON.stringify({ ok: true, session: session(id, "review") })),
      use("b", "mcp__pi-session-mcp__pi_session_prompt", { sessionId: id, prompt: id }),
      result("b", JSON.stringify({ ok: true, turn: turn("t", "completed") })),
    ].join("\n");
    await writeFile(join(dir, "b.jsonl"), body("second"));
    await writeFile(join(dir, "a.jsonl"), body("first"));
    await mkdir(join(dir, "nested", "deeper"), { recursive: true });
    await writeFile(join(dir, "nested", "c.jsonl"), body("nested"));
    await writeFile(join(dir, "nested", "deeper", "d.jsonl"), body("deeper"));
    // Links to a file or a directory outside are skipped.
    const outside = await temporaryRoot("ablation-scan-outside-");
    await writeFile(join(outside, "e.jsonl"), body("linked"));
    await symlink(join(outside, "e.jsonl"), join(dir, "link.jsonl"));
    await symlink(outside, join(dir, "linked-dir"));
    const scan = await scanTranscripts(dir);
    expect(scan.candidates.map((c) => [c.transcript, c.sessionId])).toEqual([["a.jsonl", "first"], ["b.jsonl", "second"], ["nested/c.jsonl", "nested"], ["nested/deeper/d.jsonl", "deeper"]]);
    expect(JSON.stringify(scan)).not.toContain(dir);
  });
});

describe("scan output", () => {
  it("writes below the results root, refuses other places and existing files, and refuses a link that leaves the root", async () => {
    const base = await temporaryRoot("ablation-scan-out-");
    const results = join(base, "eval", "results");
    const scan = { candidates: [], skippedLines: 0 };
    await writeScan(scan, join(results, "scan", "candidates.json"), results);
    expect(JSON.parse(await readFile(join(results, "scan", "candidates.json"), "utf8"))).toEqual(scan);
    await expect(writeScan(scan, join(results, "scan", "candidates.json"), results)).rejects.toThrow("output_exists");
    await expect(writeScan(scan, join(base, "elsewhere.json"), results)).rejects.toThrow("scan_out_outside_results");
    await expect(writeScan(scan, `${results}-sibling/x.json`, results)).rejects.toThrow("scan_out_outside_results");
    await expect(writeScan(scan, join(results, "..", "x.json"), results)).rejects.toThrow("scan_out_outside_results");
    const outside = join(base, "outside");
    await mkdir(outside);
    await symlink(outside, join(results, "link"));
    await expect(writeScan(scan, join(results, "link", "x.json"), results)).rejects.toThrow("scan_out_outside_results");
    // A directory that does not exist yet below a link: nothing is created outside before the refusal.
    await expect(writeScan(scan, join(results, "link", "sub", "deeper", "x.json"), results)).rejects.toThrow("scan_out_outside_results");
    expect(existsSync(join(outside, "sub"))).toBe(false);
    // A dangling link is refused as well.
    await symlink(join(base, "nowhere"), join(results, "dangling"));
    await expect(writeScan(scan, join(results, "dangling", "sub", "x.json"), results)).rejects.toThrow("scan_out_outside_results");
    expect(existsSync(join(base, "nowhere"))).toBe(false);
  });

  it("wires --scan to the results root and prints counts only", async () => {
    const base = await temporaryRoot("ablation-scan-cli-");
    const results = join(base, "eval", "results");
    const transcripts = join(base, "transcripts");
    await mkdir(transcripts);
    await writeFile(join(transcripts, "t.jsonl"), await readFile(join(FIXTURES, "transcript.jsonl")));
    const out = join(results, "scan", "candidates.json");
    const shown = await captureStdout(() => scanCommand(parseArgs(["--scan", "--transcripts", transcripts, "--out", out]), results));
    expect(JSON.parse(shown)).toEqual({ candidates: 2, skippedLines: 1 });
    expect(shown).not.toContain(base);
    expect((JSON.parse(await readFile(out, "utf8")) as { candidates: unknown[] }).candidates).toHaveLength(2);
    await expect(scanCommand(parseArgs(["--scan", "--transcripts", transcripts, "--out", out]), results)).rejects.toThrow("output_exists");
    await expect(scanCommand(parseArgs(["--scan", "--transcripts", transcripts, "--out", join(base, "elsewhere.json")]), results)).rejects.toThrow("scan_out_outside_results");
    expect(existsSync(join(base, "elsewhere.json"))).toBe(false);
  });

  it("parses --scan with its two required options only", () => {
    expect(parseArgs(["--scan", "--transcripts", "/t", "--out", "eval/results/c.json"])).toMatchObject({ mode: "--scan", options: { "--transcripts": "/t", "--out": "eval/results/c.json" } });
    expect(() => parseArgs(["--scan", "--out", "eval/results/c.json"])).toThrow("transcripts_required");
    expect(() => parseArgs(["--scan", "--transcripts", "/t"])).toThrow("out_required");
    expect(() => parseArgs(["--scan", "--transcripts", "/t", "--out", "o", "--tasks", "t.json"])).toThrow("invalid_argument");
    expect(() => parseArgs(["--plan", "--tasks", "t.json", "--transcripts", "/t"])).toThrow("invalid_argument");
  });
});
