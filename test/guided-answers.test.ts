import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGuidedAnswers, type AnswersIssue } from "../src/guided/answers.js";
import { runGuidedMain } from "../src/setup-guided-main.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const valid = () => ({
  schemaVersion: 1, approveProbes: false, allowConfigChange: false,
  profiles: [{ alias: "review-medium", provider: "p", model: "m", role: "review", thinkingLevel: "high", tier: "medium", family: "fam" }],
  defaultProfile: "review-medium",
  workspaces: [{ alias: "project", path: "/abs/repo", mode: "read-only" }],
  history: { enabled: false }, routing: { mode: "manual" }, clients: { claudeCode: true, codex: false },
});
const issues = (input: unknown): AnswersIssue[] => {
  try { parseGuidedAnswers(input); } catch (error) { return (error as { issues: AnswersIssue[] }).issues; }
  throw new Error("expected the answers to be refused");
};
type Edit = (answers: ReturnType<typeof valid>) => unknown;
const edit = (change: (answers: Record<string, any>) => void): Edit => (answers) => { const copy = structuredClone(answers) as Record<string, any>; change(copy); return copy; };

describe("answers issues", () => {
  it.each<[string, Edit, AnswersIssue]>([
    ["a missing field", edit((a) => { delete a.approveProbes; }), { path: "approveProbes", rule: "missing_field" }],
    ["a wrong type", edit((a) => { a.approveProbes = "yes"; }), { path: "approveProbes", rule: "wrong_type" }],
    ["a missing nested field", edit((a) => { delete a.profiles[0].model; }), { path: "profiles.0.model", rule: "missing_field" }],
    ["an empty string", edit((a) => { a.profiles[0].model = ""; }), { path: "profiles.0.model", rule: "too_small" }],
    ["an unknown enum value", edit((a) => { a.profiles[0].role = "reviewer"; }), { path: "profiles.0.role", rule: "invalid_value" }],
    ["a wrong schema version", edit((a) => { a.schemaVersion = 2; }), { path: "schemaVersion", rule: "invalid_value" }],
    ["a malformed alias", edit((a) => { a.profiles[0].alias = "Not An Alias"; }), { path: "profiles.0.alias", rule: "invalid_format" }],
    ["a malformed family", edit((a) => { a.profiles[0].family = "Bad Family"; }), { path: "profiles.0.family", rule: "invalid_format" }],
    ["a tier without a family", edit((a) => { a.profiles[0].family = null; }), { path: "profiles.0.family", rule: "required_with_tier" }],
    ["a relative workspace path", edit((a) => { a.workspaces[0].path = "relative/repo"; }), { path: "workspaces.0.path", rule: "not_absolute_path" }],
    ["too many writers", edit((a) => { a.workspaces[0] = { ...a.workspaces[0], mode: "container", container: { writers: 17 } }; }), { path: "workspaces.0.container.writers", rule: "too_large" }],
    ["an unknown field", edit((a) => { a.apiKey = "SECRET-VALUE"; }), { path: "document", rule: "unknown_field" }],
    ["an unknown nested field", edit((a) => { a.profiles[0].apiKey = "SECRET-VALUE"; }), { path: "profiles.0", rule: "unknown_field" }],
    ["a code profile as the default", edit((a) => { a.profiles[0].role = "code"; }), { path: "defaultProfile", rule: "default_profile_is_code" }],
    ["a duplicate profile alias", edit((a) => { a.profiles.push({ ...a.profiles[0] }); }), { path: "profiles", rule: "duplicate_profile_alias" }],
    ["a duplicate workspace alias", edit((a) => { a.workspaces.push({ ...a.workspaces[0] }); }), { path: "workspaces", rule: "duplicate_workspace_alias" }],
  ])("names the field and rule for %s", (_name, change, expected) => {
    expect(issues(change(valid()))).toContainEqual(expected);
  });
  it.each([[null], ["text"], [[]], [7]])("reports a document that is not an object (%j)", (input) => {
    expect(issues(input)).toEqual([{ path: "document", rule: "wrong_type" }]);
  });
  it("echoes no value and no unknown field name", () => {
    const found = issues(edit((a) => { a.apiKey = "SECRET-VALUE"; a["SECRET-FIELD-NAME"] = 1; a.profiles[0].model = 12345; a.workspaces[0].path = "/SECRET/relative"; a.workspaces[0].mode = "SECRET-MODE"; })(valid()));
    const text = JSON.stringify(found);
    for (const secret of ["SECRET", "12345"]) expect(text).not.toContain(secret);
  });
  it("reports every violation up to a cap and in a stable order", () => {
    const found = issues(edit((a) => { for (let index = 0; index < 40; index++) a[`extra${index}`] = index; a.approveProbes = 1; a.allowConfigChange = 1; })(valid()));
    expect(found.length).toBeLessThanOrEqual(20);
    expect(found).toEqual([{ path: "approveProbes", rule: "wrong_type" }, { path: "allowConfigChange", rule: "wrong_type" }, { path: "document", rule: "unknown_field" }]);
  });
  it("still accepts valid answers", () => {
    expect(parseGuidedAnswers(valid()).defaultProfile).toBe("review-medium");
  });
});

describe("guided answers file", () => {
  async function run(content: string | undefined, apply = false): Promise<{ exitCode: number; report: { status: string; findings: { target: { client: string; scope: string; alias: string }; status: string; code: string }[] }; text: string; directory: string }> {
    const directory = await mkdtemp(join(tmpdir(), "guided-answers-"));
    directories.push(directory);
    const path = join(directory, "answers.json");
    if (content !== undefined) await writeFile(path, content);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runGuidedMain({ apply, answersPath: path }, true, new AbortController().signal, {});
      expect(output).toHaveBeenCalledTimes(1);
      const text = String(output.mock.calls[0]![0]);
      return { exitCode, report: JSON.parse(text), text, directory };
    } finally { output.mockRestore(); }
  }
  it("reports a missing file as answers_unreadable with exit 64 and no path", async () => {
    const { exitCode, report, text, directory } = await run(undefined);
    expect(exitCode).toBe(64);
    expect(report.findings.map((finding) => finding.code)).toEqual(["answers_unreadable"]);
    expect(text).not.toContain(directory);
  });
  it("reports a directory as answers_unreadable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "guided-answers-"));
    directories.push(directory);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await runGuidedMain({ apply: false, answersPath: directory }, true, new AbortController().signal, {})).toBe(64);
      expect(JSON.parse(String(output.mock.calls[0]![0])).findings[0].code).toBe("answers_unreadable");
    } finally { output.mockRestore(); }
  });
  it("reports text that is not JSON as answers_invalid with the rule not_json", async () => {
    const { exitCode, report, text } = await run("{ not json SECRET-TEXT");
    expect(exitCode).toBe(64);
    expect(report.findings.map((finding) => [finding.target.scope, finding.target.alias, finding.status, finding.code])).toEqual([["plan", "installation", "failed", "answers_invalid"], ["answers", "document", "failed", "not_json"]]);
    expect(text).not.toContain("SECRET-TEXT");
  });
  it("reports each schema violation as a finding with its field path and rule, and exits 64", async () => {
    const answers = { ...valid(), approveProbes: "yes", apiKey: "SECRET-VALUE" };
    const { exitCode, report, text } = await run(JSON.stringify(answers), true);
    expect(exitCode).toBe(64);
    expect(report.status).toBe("failed");
    expect(report.findings.map((finding) => [finding.target.client, finding.target.scope, finding.target.alias, finding.code])).toEqual([
      ["guided", "plan", "installation", "answers_invalid"], ["guided", "answers", "approveProbes", "wrong_type"], ["guided", "answers", "document", "unknown_field"],
    ]);
    expect(text).not.toContain("SECRET");
  });
});
