import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedPaths, scoreImplementation, scoreReview } from "../eval/extensions/oracles.js";
import { anchorSchema, taskSpecSchema, type ImplementationOracle, type ReviewOracle } from "../eval/extensions/schemas.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: { PATH: process.env.PATH ?? "", HOME: cwd } });
}
function makeRepo(files: Record<string, string> = { "a.ts": "export const a = 1;\n" }): string {
  const repo = tmp("oracle-repo-");
  git(repo, "init");
  git(repo, "config", "user.name", "Oracle Test");
  git(repo, "config", "user.email", "oracle@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(repo, name, ".."), { recursive: true });
    writeFileSync(join(repo, name), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base");
  return repo;
}
function revParse(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: repo } }).trim();
}
/** A work clone plus a pristine bare clone of it taken before any worker change, as in production. */
function makeBase(files?: Record<string, string>): { repo: string; base: { gitDir: string; commit: string } } {
  const repo = makeRepo(files);
  const gitDir = join(tmp("oracle-bare-"), "base.git");
  execFileSync("git", ["clone", "--bare", "--quiet", repo, gitDir], { stdio: "ignore", env: { PATH: process.env.PATH ?? "", HOME: repo } });
  return { repo, base: { gitDir, commit: revParse(repo) } };
}
const node = (code: string): string[] => ["node", "-e", code];

/** Matches every text, so the anchor tests below are about the anchors alone; the verdict has its own tests. */
const ANY_VERDICT = { pattern: "[\\s\\S]*" };
const reviewOracle: ReviewOracle = {
  kind: "review", verdict: ANY_VERDICT,
  findings: [
    { id: "f1", critical: true, anchors: [{ file: "src/a.ts", terms: ["race", "lock"] }] },
    { id: "f2", critical: false, anchors: [{ file: "b.md", terms: ["typo"] }] },
  ],
  falseFindings: [{ id: "x1", anchors: [{ file: "src/a.ts", terms: ["sql injection"] }] }],
};

describe("scoreReview", () => {
  it.each([
    ["bold titles (P1)", "**Race on cache write**\nsrc/a.ts:42\nThe lock is released early.\n\n**SQL injection**\nsrc/db/query.ts:17\nInput is concatenated."],
    ["numbered titles (P3)", "1. Race on cache write\n`src/a.ts:42`\nThe lock is released early.\n\n2. SQL injection\n`src/db/query.ts:17`\nInput is concatenated."],
    ["prose followed by location (P6)", "Race: the lock is released early, in\nsrc/a.ts:42\n\nSQL injection via concatenation, in\nsrc/db/query.ts:17"],
  ])("keeps a path-only continuation with %s", (_name, text) => {
    const oracle: ReviewOracle = { ...reviewOracle, findings: [
      reviewOracle.findings[0]!,
      { id: "f2", critical: true, anchors: [{ file: "src/db/query.ts", terms: ["injection"] }] },
    ] };
    expect(scoreReview(text, oracle)).toMatchObject({ accepted: true, criticalHit: 2, falseFindings: [] });
  });

  it("accepts a review that hits every critical finding in one block", () => {
    expect(scoreReview("- src/a.ts: race when the lock is released early", reviewOracle))
      .toMatchObject({ accepted: true, criticalHit: 1, criticalTotal: 1, recall: 0.5, falseFindings: [] });
    expect(scoreReview("src/a.ts has a race.\n\nThe lock is fine.", reviewOracle).accepted).toBe(false);
    expect(scoreReview("- src/a.ts: race, lock\n- src/a.ts: SQL injection", reviewOracle).falseFindings).toEqual(["x1"]);
  });

  it("reports a false finding without letting it decide (R78)", () => {
    const r = scoreReview("- src/a.ts: race, lock\n- b.md: typo\n- src/a.ts: SQL Injection", reviewOracle);
    expect(r).toMatchObject({ accepted: true, criticalHit: 1, recall: 1, falseFindings: ["x1"], verdictMatched: true });
  });

  describe("the verdict (R78)", () => {
    const withVerdict: ReviewOracle = { ...reviewOracle, verdict: { pattern: "^verdict:\\s*(not ready|reject)" } };
    const findings = "- src/a.ts: race, lock\n";

    it("matches the pattern with flags i and m anywhere in the text", () => {
      expect(scoreReview(`${findings}\nVERDICT: Not Ready`, withVerdict).verdictMatched).toBe(true);
      expect(scoreReview(`Verdict: reject\n${findings}`, withVerdict).verdictMatched).toBe(true);
      expect(scoreReview(`${findings}the verdict: reject`, withVerdict).verdictMatched).toBe(false);
      expect(scoreReview(`${findings}Verdict: ready`, withVerdict).verdictMatched).toBe(false);
      expect(scoreReview("", withVerdict).verdictMatched).toBe(false);
    });

    it("does not accept a review that hits every critical finding but omits the verdict", () => {
      expect(scoreReview(`${findings}Verdict: ready`, withVerdict)).toMatchObject({ accepted: false, criticalHit: 1, criticalTotal: 1, verdictMatched: false });
    });

    it("does not accept a review with the verdict but a missed critical finding", () => {
      expect(scoreReview("Verdict: reject\n- b.md: typo", withVerdict)).toMatchObject({ accepted: false, criticalHit: 0, verdictMatched: true });
    });

    it("accepts the verdict with every critical finding, and a false-finding hit is only reported", () => {
      expect(scoreReview(`Verdict: reject\n${findings}- src/a.ts: SQL injection`, withVerdict))
        .toMatchObject({ accepted: true, criticalHit: 1, falseFindings: ["x1"], verdictMatched: true, recall: 0.5 });
    });
  });

  it("matches the basename or the repo-relative path, case-insensitively", () => {
    expect(scoreReview("A.TS: RACE on LOCK", reviewOracle).criticalHit).toBe(1);
    expect(scoreReview("src/A.ts: Race on Lock", reviewOracle).criticalHit).toBe(1);
    expect(scoreReview("c.ts: race on lock", reviewOracle).criticalHit).toBe(0);
    expect(scoreReview("race on lock", reviewOracle).criticalHit).toBe(0);
  });

  it("requires path boundaries around the file name", () => {
    const hit = (text: string, file = "src/a.ts"): boolean => scoreReview(text, {
      kind: "review", verdict: ANY_VERDICT, findings: [{ id: "f", critical: true, anchors: [{ file, terms: ["race"] }] }], falseFindings: [],
    }).criticalHit === 1;
    expect(hit("data.ts: race", "a.ts")).toBe(false);
    expect(hit("src/a.tsx: race")).toBe(false);
    expect(hit("src/a.tsx: race", "a.ts")).toBe(false);
    expect(hit("xa.ts: race")).toBe(false);
    expect(hit("xsrc/a.ts: race")).toBe(false);
    expect(hit("lib/a.ts: race")).toBe(false);
    expect(hit("a.ts: race")).toBe(true);
    expect(hit("/x/y/src/a.ts: race")).toBe(true);
    expect(hit("./src/a.ts: race")).toBe(true);
    expect(hit("src/a.ts.bak: race")).toBe(false);
    expect(hit("src/a.ts/b: race")).toBe(false);
    expect(hit("`src/a.ts:12` race")).toBe(true);
    expect(hit("(see src/a.ts#L3) race")).toBe(true);
    expect(hit("src/a.ts:12-15 race")).toBe(true);
    expect(hit("src/a.ts#L3-L9 race")).toBe(true);
    expect(hit("race in src/a.ts.")).toBe(true);
    expect(hit("race in lib/a.ts", "a.ts")).toBe(true);
    expect(hit("race in `a.ts`", "src/a.ts")).toBe(true); // a bare name agrees with any directory
    expect(hit("race in lib/a.ts", "src/a.ts")).toBe(false);
    expect(hit("race in a.ts, twice; also data.ts", "a.ts")).toBe(true);
    expect(hit("data.ts and then a.ts: race", "a.ts")).toBe(true);
  });

  it("splits blocks on blank lines and list items but keeps continuation lines together", () => {
    expect(scoreReview("- src/a.ts: race\n  when the lock is released", reviewOracle).criticalHit).toBe(1);
    expect(scoreReview("1. src/a.ts: race\n2. the lock", reviewOracle).criticalHit).toBe(0);
    expect(scoreReview("* src/a.ts: race\n* src/a.ts: lock", reviewOracle).criticalHit).toBe(0);
    expect(scoreReview("src/a.ts: race\r\n\r\nlock", reviewOracle).criticalHit).toBe(0);
  });

  it("keeps tables, headings, bold lines and nested lists apart as specified", () => {
    const accepted = (text: string): boolean => scoreReview(text, reviewOracle).criticalHit === 1;
    expect(accepted("| src/a.ts:10 | possible race |\n| src/b.ts:4 | lock is never released |")).toBe(false);
    expect(accepted("| src/a.ts:10 | possible race, lock |")).toBe(true);
    expect(accepted("### src/a.ts\nPossible race.\n### src/b.ts\nThe lock is never released.")).toBe(false);
    expect(accepted("**src/a.ts**: race.\n**src/b.ts**: lock never released.")).toBe(false);
    expect(accepted("### src/a.ts:12\n\nRace when the lock is released early.")).toBe(true);
    expect(accepted("### src/a.ts:12\n\nRace.\n\nThe lock is fine.")).toBe(false);
    expect(accepted("### src/a.ts race lock")).toBe(true);
    expect(accepted("- src/a.ts\n  - race when\n  - the lock is released")).toBe(true);
    expect(accepted("- src/a.ts: race\n- the lock")).toBe(false);
    expect(accepted("  - src/a.ts: race\n    - the lock")).toBe(true);
  });

  it("limits heading path tokens to blocks without a path of their own (R27b)", () => {
    const o: ReviewOracle = { ...reviewOracle, falseFindings: [{ id: "x1", anchors: [{ file: "src/a.ts", terms: ["sql injection"] }] }] };
    const accepted = (text: string): boolean => scoreReview(text, o).criticalHit === 1;
    expect(accepted("### src/a.ts\nLooks fine.\n\n- src/b.ts: race; the lock is never released")).toBe(false);
    expect(accepted("## Findings (src/a.ts, src/b.ts)\n\n- src/b.ts: race; the lock is never released")).toBe(false);
    expect(accepted("### src/a.ts\n| src/b.ts | race, lock |")).toBe(false);
    const mixed = scoreReview("### src/a.ts\n- race when the lock is released\n\n- src/b.ts: SQL injection in the parser", o);
    expect(mixed).toMatchObject({ criticalHit: 1, falseFindings: [] });
    expect(accepted("### src/a.ts:12\n\nRace when the lock is released early.")).toBe(true);
    expect(accepted("### Race and lock\n\n- src/a.ts: parser")).toBe(true);
    expect(accepted("## src/a.ts\n### Issue 1\n- race when the lock is released")).toBe(true);
    expect(accepted("## src/a.ts\n## src/b.ts\n- race; lock")).toBe(false);
    expect(accepted("## src/a.ts\n### src/b.ts\n- race; lock")).toBe(false);
    expect(accepted("## src/a.ts\n### Issue 1\n#### Detail\n- race when the lock is released")).toBe(true);
    expect(accepted("## src/a.ts\n### Issue 1\n## Other\n- race when the lock is released")).toBe(false);
  });

  it("starts a bold block only for unindented, non-list lines with a path, so field labels continue", () => {
    const accepted = (text: string): boolean => scoreReview(text, reviewOracle).criticalHit === 1;
    expect(accepted("**File:** src/a.ts:12\n**Issue:** race when the lock is released early")).toBe(true);
    expect(accepted("- **src/a.ts:12** - race in handler\n  **Impact:** the lock is released early")).toBe(true);
    expect(accepted("1. **Race in src/a.ts:12**\n   **Why:** the lock is released early")).toBe(true);
    expect(accepted("**src/a.ts**: race.\n**src/b.ts**: lock never released.")).toBe(false);
  });

  it("keeps fenced code inside its block and never reads headings from it", () => {
    expect(scoreReview("```python\n# src/a.ts\n```\n\nrace and lock in b.ts", reviewOracle).accepted).toBe(false);
    expect(scoreReview("src/a.ts: race\n```\n\n| x |\n**src/b.ts**\n```\nlock", reviewOracle).criticalHit).toBe(1);
  });

  it("does not mistake dotted identifiers, slash words or URLs for paths (R30)", () => {
    const accepted = (text: string): boolean => scoreReview(text, reviewOracle).criticalHit === 1;
    expect(accepted("## src/a.ts:42\nRace: `this.lock.release()` runs before the write completes.")).toBe(true);
    expect(accepted("### src/a.ts\n- race in the read/write lock path")).toBe(true);
    expect(accepted("### src/a.ts\n- race in Node.js handler; the lock is released early")).toBe(true);
    expect(accepted("**File:** src/a.ts:42\n**Issue:** race, `mutex.unlock()` releases the lock early")).toBe(true);
    expect(accepted("### src/a.ts\n- race (see https://example.com/x/y.html); the lock is released early")).toBe(true);
    const o: ReviewOracle = { ...reviewOracle, falseFindings: [{ id: "x1", anchors: [{ file: "src/a.ts", terms: ["sql injection"] }] }] };
    expect(scoreReview("### src/a.ts\n- SQL injection via `db.query()`", o).falseFindings).toEqual(["x1"]);
    expect(accepted("### src/a.ts\n- race in lib/util.ts; the lock is released early")).toBe(false);
  });

  it("gives the first pathless block of a section the full heading text (R27f)", () => {
    const two: ReviewOracle = { kind: "review", verdict: ANY_VERDICT, falseFindings: [], findings: [
      { id: "f1", critical: true, anchors: [{ file: "src/a.ts", terms: ["race", "lock"] }] },
      { id: "f2", critical: true, anchors: [{ file: "src/db/query.ts", terms: ["injection"] }] },
    ] };
    const r = scoreReview("### 1. Race condition in src/a.ts:42\nThe lock is released before `cache.set()` completes.\n\n### 2. SQL injection in src/db/query.ts:17\nUser input is concatenated.", two);
    expect(r).toMatchObject({ accepted: true, criticalHit: 2 });
    // later blocks only receive the path tokens, not the heading words
    expect(scoreReview("### Race in src/a.ts\nfirst.\n\nthe lock is released", reviewOracle).criticalHit).toBe(0);
  });

  it.each([
    ["file field (P4)", "### Race condition in cache write\n**File:** `src/a.ts:42`\n**Issue:** The lock is released early."],
    ["pseudo-heading (P5)", "### Race condition in cache write\n`src/a.ts:42`\nThe lock is released early."],
    ["location label (P10)", "### Race condition in cache write\nLocation: src/a.ts:42\nThe lock is released early."],
  ])("prefixes heading words to the first located body: %s (R27h)", (_name, text) => {
    expect(scoreReview(text, reviewOracle)).toMatchObject({ accepted: true, criticalHit: 1, falseFindings: [] });
  });

  it("never lends a heading's path or words to a first block naming another file (R27i)", () => {
    expect(scoreReview("### Race in src/a.ts\n- src/b.ts: the lock is released", reviewOracle).criticalHit).toBe(0);
    expect(scoreReview("### Race in src/a.ts\n- src/b.ts: the lock is released", {
      ...reviewOracle, findings: [{ id: "f", critical: true, anchors: [{ file: "src/b.ts", terms: ["race", "lock"] }] }],
    }).criticalHit).toBe(0);
    expect(scoreReview("### race.ts\n- src/a.ts: lock", reviewOracle).criticalHit).toBe(0);
  });

  it("does not lend SQL heading words to another file mentioned in the first block (B1)", () => {
    const oracle: ReviewOracle = { ...reviewOracle, findings: [
      reviewOracle.findings[0]!,
      { id: "f2", critical: true, anchors: [{ file: "src/db/query.ts", terms: ["injection"] }] },
    ] };
    const text = "### Race in src/a.ts\nThe lock is released early.\n\n### SQL injection in src/db/query.ts\nInput from src/a.ts reaches src/db/query.ts:17 unescaped (injection).";
    expect(scoreReview(text, oracle)).toMatchObject({ accepted: true, criticalHit: 2, criticalTotal: 2, falseFindings: [] });
  });

  it.each([
    ["a.ts", "src/a.ts", true],
    ["/workspace/src/a.ts", "a.ts", true],
    ["src/a.ts and src/b.ts", "src/a.ts and src/b.ts", true],
    ["src/a.ts", "src/a.ts and src/b.ts", false],
  ])("requires every body path to agree by segment suffix with heading %s (B1)", (heading, body, accepted) => {
    expect(scoreReview(`### Race in ${heading}\n- ${body}: the lock is released`, reviewOracle).accepted).toBe(accepted);
  });

  it("does not repeat heading words on later located or pseudo-heading blocks", () => {
    expect(scoreReview("### Race\n- src/a.ts: context\n- src/a.ts: lock", reviewOracle).criticalHit).toBe(0);
    expect(scoreReview("### Race\n**src/a.ts**\n- context\n- lock", reviewOracle).criticalHit).toBe(0);
  });

  it("removes URLs before inheriting heading words (B4)", () => {
    const text = "### Race (https://github.com/o/r/blob/main/src/a.ts)\n- src/b.ts: the lock is released";
    expect(scoreReview(text, reviewOracle)).toMatchObject({ accepted: false, criticalHit: 0, falseFindings: [] });
  });

  it("lends a pathless parent's words only to its first pseudo-heading (B2)", () => {
    const oracle: ReviewOracle = { ...reviewOracle, findings: [
      reviewOracle.findings[0]!,
      { id: "f2", critical: true, anchors: [{ file: "src/db/query.ts", terms: ["injection"] }] },
    ] };
    const text = "## Race and SQL injection\n**src/db/query.ts**\n- injection via concatenation\n**src/a.ts**\n- race: the lock is released early";
    expect(scoreReview(text, oracle)).toMatchObject({ accepted: true, criticalHit: 2, criticalTotal: 2, falseFindings: [] });
  });

  it("does not repeat parent heading words after a blank before another pseudo-heading (B2)", () => {
    const text = "### Race\n**src/b.ts**\n- context\n\n**src/a.ts**\n- the lock is released early";
    expect(scoreReview(text, reviewOracle)).toMatchObject({ accepted: false, criticalHit: 0, falseFindings: [] });
  });

  it("carries the inherited path into a bodyless heading", () => {
    const two: ReviewOracle = { kind: "review", verdict: ANY_VERDICT, falseFindings: [], findings: [
      { id: "f1", critical: true, anchors: [{ file: "src/a.ts", terms: ["race", "lock"] }] },
      { id: "f2", critical: true, anchors: [{ file: "src/db/query.ts", terms: ["injection"] }] },
    ] };
    expect(scoreReview("## src/a.ts\n### Race: the lock is released early\n## src/db/query.ts\n### SQL injection via concatenation", two))
      .toMatchObject({ accepted: true, criticalHit: 2 });
  });

  it.each(["```markdown", "```md", "```", "~~~text"])("unwraps a whole review fence opened by %s (P7)", (open) => {
    const close = open.startsWith("~") ? "~~~~" : "````";
    const oracle: ReviewOracle = { ...reviewOracle, findings: [
      reviewOracle.findings[0]!,
      { id: "f2", critical: true, anchors: [{ file: "src/db/query.ts", terms: ["injection"] }] },
    ] };
    const text = `  \n${open}\n## src/a.ts:42\nRace: the lock is released early.\n\n## src/db/query.ts:17\nSQL injection via concatenation.\n${close}\n  `;
    expect(scoreReview(text, oracle)).toMatchObject({ accepted: true, criticalHit: 2, falseFindings: [] });
  });

  it.each(["md", "markdown"])("reads an embedded %s fence as review text", (info) => {
    expect(scoreReview(`Review follows.\n\n\`\`\`${info}\n- src/a.ts: race and lock\n\`\`\`\n\nEnd.`, reviewOracle).accepted).toBe(true);
  });

  it("still drops quoted code inside an unwrapped review fence", () => {
    expect(scoreReview("````markdown\n- src/a.ts: race\n```ts\nlock\n```\n````", reviewOracle).criticalHit).toBe(0);
  });

  it("drops terminated fences and treats an unterminated opener as text (R27e)", () => {
    const accepted = (text: string): boolean => scoreReview(text, reviewOracle).criticalHit === 1;
    expect(accepted("- src/a.ts:42: race in handler\n```ts\nfoo();\n\n- src/b.ts: the lock is never released")).toBe(false);
    expect(accepted("- src/a.ts:42: race and lock in handler\n```ts\nfoo();\n\nbar();\n```\nmore")).toBe(true);
    expect(accepted("- race and lock in the handler\n```ts\n// src/a.ts\n```")).toBe(false);
    expect(accepted("- src/a.ts: race\n```\nlock\n```")).toBe(false);
    expect(accepted("- src/a.ts: race ```x``` and lock")).toBe(true);
    expect(accepted("- src/a.ts: race\n```ts\nx\n```ts\n\n- src/b.ts: lock")).toBe(false);
  });

  it("treats a path-only line as a pseudo-heading (R27g)", () => {
    const accepted = (text: string): boolean => scoreReview(text, reviewOracle).criticalHit === 1;
    expect(accepted("**src/a.ts**\n- race: the lock is released early")).toBe(true);
    expect(accepted("src/a.ts:\n- race; lock")).toBe(true);
    expect(accepted("`src/a.ts:12`\n- race; lock")).toBe(true);
    expect(accepted("**src/a.ts**\n- race when\n- the lock is released early")).toBe(false);
    expect(accepted("**src/b.ts**\n- race; lock")).toBe(false);
    expect(accepted("**src/a.ts**\n- race: the lock\n**src/b.ts**\n- other thing")).toBe(true);
    expect(accepted("src/a.ts:\n\nA paragraph.\n\n- race; lock")).toBe(false);
    expect(accepted("src/a.ts:\n\n- race; lock")).toBe(true);
  });

  it("starts a bold file pseudo-heading after introductory prose (B3)", () => {
    const oracle: ReviewOracle = { ...reviewOracle, findings: [
      reviewOracle.findings[0]!,
      { id: "f2", critical: true, anchors: [{ file: "src/db/query.ts", terms: ["injection"] }] },
    ] };
    const text = "Here are my findings:\n**src/a.ts**\n- race: the lock is released early\n\n**src/db/query.ts**\n- SQL injection";
    expect(scoreReview(text, oracle)).toMatchObject({ accepted: true, criticalHit: 2, criticalTotal: 2, falseFindings: [] });
  });

  it("requires terms to start at a word boundary but allows prefix stems", () => {
    expect(scoreReview("- src/a.ts: trace logging around the block", reviewOracle).accepted).toBe(false);
    expect(scoreReview("- src/a.ts: races while locking", reviewOracle).criticalHit).toBe(1);
    expect(scoreReview("- src/a.ts: race, (lock)", reviewOracle).criticalHit).toBe(1);
    expect(scoreReview("- src/a.ts: sql injection?", { ...reviewOracle, falseFindings: [{ id: "x", anchors: [{ file: "src/a.ts", terms: ["sql injection?"] }] }] }).falseFindings).toEqual(["x"]);
  });

  it("lets any anchor of a finding hit and requires every term in its anchor", () => {
    const o: ReviewOracle = { kind: "review", verdict: ANY_VERDICT, findings: [{ id: "f", critical: true, anchors: [{ file: "a.ts", terms: ["one", "two"] }, { file: "b.ts", terms: ["three"] }] }], falseFindings: [] };
    expect(scoreReview("b.ts: three", o).accepted).toBe(true);
    expect(scoreReview("a.ts: one", o).accepted).toBe(false);
    expect(scoreReview("a.ts: one and two", o).accepted).toBe(true);
  });
});

describe("scopeIgnore schema", () => {
  const spec = (scopeIgnore: string[]) => ({
    id: "t1", kind: "implementation", repo: "pi-session-mcp", baseCommit: "b".repeat(40),
    promptRef: "eval/results/extensions/prompts/t1.txt", promptHash: `sha256:${"a".repeat(64)}`, sourceSession: "s",
    allowedPaths: ["a.ts"], scopeIgnore, oracle: { kind: "implementation", command: ["node", "-v"], timeoutMs: 1000 },
  });
  it("accepts repo-relative directory prefixes", () => {
    expect(taskSpecSchema.safeParse(spec([".pi-lens/", "dist/", "a/b/"])).success).toBe(true);
    expect(taskSpecSchema.safeParse(spec([])).success).toBe(true);
  });
  it.each([
    ["missing trailing slash", "dist"],
    ["leading slash", "/dist/"],
    ["parent segment", "../dist/"],
    ["embedded parent segment", "a/../b/"],
    ["star", "dist*/"],
    ["question mark", "d?st/"],
    ["bracket", "d[i]st/"],
    ["closing bracket", "dist]/"],
    ["brace", "{dist,out}/"],
    ["empty", ""],
  ])("rejects %s", (_name, entry) => {
    expect(taskSpecSchema.safeParse(spec([entry])).success).toBe(false);
  });
});

describe("anchor file schema", () => {
  it.each(["mts", "cts", "proto", "graphql", "gql"])("accepts .%s anchors and inherits their heading path", (extension) => {
    const anchor = anchorSchema.parse({ file: `src/x.${extension}`, terms: ["race", "lock"] });
    const oracle: ReviewOracle = { kind: "review", verdict: ANY_VERDICT, findings: [{ id: "f", critical: true, anchors: [anchor] }], falseFindings: [] };
    // Use the second block, which receives only path tokens, never the title itself.
    expect(scoreReview(`### ${anchor.file}\n- context\n- race and lock`, oracle)).toMatchObject({ accepted: true, criticalHit: 1 });
  });

  it("rejects an anchor file that is not a recognized path token", () => {
    for (const file of ["Makefile", "node.js", "src/noextension", "src/a.unsupported"]) {
      expect(anchorSchema.safeParse({ file, terms: ["race"] }).success, file).toBe(false);
    }
  });

  it("rejects characters an anchor could never match as a path token", () => {
    expect(anchorSchema.safeParse({ file: "src/a-b_c.d.ts", terms: ["x"] }).success).toBe(true);
    for (const file of ["src/a.ts.", "src/a b.ts", "src/ä.ts", "src/a:1.ts", "src/a#1.ts", "src/(a).ts", "src/a,b.ts"]) {
      expect(anchorSchema.safeParse({ file, terms: ["x"] }).success, file).toBe(false);
    }
  });
});

describe("changedPaths", () => {
  it("lists modified, deleted, untracked and ignored paths minus scopeIgnore and .codegraph/", async () => {
    const { repo, base } = makeBase({ "a.ts": "1\n", "gone.ts": "x\n", ".gitignore": "out/\n*.log\n" });
    writeFileSync(join(repo, "a.ts"), "2\n");
    rmSync(join(repo, "gone.ts"));
    mkdirSync(join(repo, ".pi-lens"));
    writeFileSync(join(repo, ".pi-lens", "cache.json"), "{}");
    mkdirSync(join(repo, ".codegraph"));
    writeFileSync(join(repo, ".codegraph", "db"), "x");
    mkdirSync(join(repo, "out"));
    writeFileSync(join(repo, "out", "x.js"), "x");
    writeFileSync(join(repo, "debug.log"), "x");
    writeFileSync(join(repo, "b.ts"), "x");
    expect(await changedPaths(repo, base, [".pi-lens/"])).toEqual(["a.ts", "b.ts", "debug.log", "gone.ts", "out/x.js"]);
    expect(await changedPaths(repo, base, [".pi-lens/", "out/"])).toEqual(["a.ts", "b.ts", "debug.log", "gone.ts"]);
  });

  it("reports both sides of a rename and handles unusual file names", async () => {
    const { repo, base } = makeBase({ "a.ts": "export const a = 'a long enough body for rename detection';\n", "dir/old name.ts": "unchanged\n" });
    git(repo, "mv", "a.ts", "c.ts");
    git(repo, "mv", "dir/old name.ts", "dir/new\nline.ts");
    expect(await changedPaths(repo, base, [])).toEqual(["a.ts", "c.ts", "dir/new\nline.ts", "dir/old name.ts"]);
  });

  it("matches scopeIgnore only on directory prefixes", async () => {
    const { repo, base } = makeBase();
    mkdirSync(join(repo, "dist"));
    writeFileSync(join(repo, "dist", "x.js"), "x");
    writeFileSync(join(repo, "distinct.ts"), "x");
    expect(await changedPaths(repo, base, ["dist/"])).toEqual(["distinct.ts"]);
  });

  it("returns an empty list for a clean clone and never reports the clone's own .git", async () => {
    const { repo, base } = makeBase();
    expect(await changedPaths(repo, base, [])).toEqual([]);
  });

  it("reports changes the worker committed", async () => {
    const { repo, base } = makeBase();
    writeFileSync(join(repo, "out.ts"), "x");
    writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "worker");
    expect(await changedPaths(repo, base, [])).toEqual(["a.ts", "out.ts"]);
  });

  it.each(["--skip-worktree", "--assume-unchanged"])("reports an edit hidden with %s", async (flag) => {
    const { repo, base } = makeBase();
    git(repo, "update-index", flag, "a.ts");
    writeFileSync(join(repo, "a.ts"), "export const a = 4;\n");
    expect(await changedPaths(repo, base, [])).toEqual(["a.ts"]);
  });

  it("neither runs nor trusts a core.fsmonitor command from the clone's config", async () => {
    const { repo, base } = makeBase();
    const marker = join(tmp("oracle-fsm-"), "marker");
    const hook = join(tmp("oracle-hook-"), "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(hook, 0o755);
    git(repo, "config", "core.fsmonitor", hook);
    writeFileSync(join(repo, "a.ts"), "export const a = 5;\n");
    expect(await changedPaths(repo, base, [])).toEqual(["a.ts"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed on an unreadable directory", async () => {
    const { repo, base } = makeBase();
    const hid = join(repo, "hid");
    mkdirSync(hid);
    writeFileSync(join(hid, "x.ts"), "x");
    chmodSync(hid, 0o111);
    try {
      await expect(changedPaths(repo, base, [])).rejects.toThrow("scope_unreadable");
    } finally { chmodSync(hid, 0o755); }
  });

  it("fails closed when git exits non-zero", async () => {
    const { repo, base } = makeBase();
    await expect(changedPaths(repo, { ...base, commit: "0".repeat(40) }, [])).rejects.toThrow("scope_unreadable");
  });

  it("reports a nested .git entry that git itself would never list", async () => {
    const { repo, base } = makeBase({ "src/a.ts": "1\n" });
    mkdirSync(join(repo, "src", ".git"));
    writeFileSync(join(repo, "src", ".git", "payload.js"), "x");
    mkdirSync(join(repo, "lib"));
    writeFileSync(join(repo, "lib", ".git"), "gitdir: elsewhere");
    expect(await changedPaths(repo, base, [])).toEqual(["lib/.git", "src/.git"]);
    expect(await changedPaths(repo, base, ["src/"])).toEqual(["lib/.git"]);
  });

  it("rejects a pristine base containing any gitlink (R31)", async () => {
    const repo = makeRepo();
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${revParse(repo)},sub`);
    git(repo, "commit", "-m", "gitlink");
    const gitDir = join(tmp("oracle-bare-"), "base.git");
    execFileSync("git", ["clone", "--bare", "--quiet", repo, gitDir], { stdio: "ignore", env: { PATH: process.env.PATH ?? "", HOME: repo } });
    const base = { gitDir, commit: revParse(repo) };
    mkdirSync(join(repo, "sub"));
    git(join(repo, "sub"), "init");
    mkdirSync(join(repo, "other"));
    writeFileSync(join(repo, "other", ".git"), "gitdir: x");
    await expect(changedPaths(repo, base, [])).rejects.toThrow("base_has_submodules");
    // The pristine base decides this, even when the worker deletes the submodule.
    rmSync(join(repo, "sub"), { recursive: true });
    await expect(changedPaths(repo, base, ["sub/"])).rejects.toThrow("base_has_submodules");
  });

  it("rejects a malformed base commit", async () => {
    const { repo, base } = makeBase();
    await expect(changedPaths(repo, { ...base, commit: "--help" }, [])).rejects.toThrow("base_commit_invalid");
  });
});

describe("scoreImplementation", () => {
  const task = (over: Partial<{ allowedPaths: string[]; scopeIgnore: string[] }>, base: { commit: string }, oracle: ImplementationOracle) =>
    ({ allowedPaths: [], scopeIgnore: [] as string[], ...over, baseCommit: base.commit, oracle });
  const pass = (timeoutMs = 10_000): ImplementationOracle => ({ kind: "implementation", command: node("process.exit(0)"), timeoutMs });

  it("computes scope before tests and honours scopeIgnore", async () => {
    const { repo, base } = makeBase();
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    mkdirSync(join(repo, ".pi-lens"));
    writeFileSync(join(repo, ".pi-lens", "cache.json"), "{}");
    writeFileSync(join(repo, "b.ts"), "x");
    const r = await scoreImplementation(repo, task({ allowedPaths: ["a.ts"], scopeIgnore: [".pi-lens/"] }, base,
      { kind: "implementation", command: node("require('fs').writeFileSync('late.ts','x')"), timeoutMs: 10_000 }), { gitDir: base.gitDir });
    expect(r).toEqual({ accepted: false, testsPassed: true, outOfScope: ["b.ts"] });
  });

  it("matches allowedPaths exactly unless an entry ends with a slash", async () => {
    const { repo, base } = makeBase({ "src/a.ts": "1\n" });
    writeFileSync(join(repo, "src", "a.ts"), "2\n");
    writeFileSync(join(repo, "src", "new.ts"), "x");
    const run = (allowedPaths: string[]) => scoreImplementation(repo, task({ allowedPaths }, base, pass()), { gitDir: base.gitDir });
    expect(await run(["src/a.ts", "src/new.ts"])).toEqual({ accepted: true, testsPassed: true, outOfScope: [] });
    expect(await run(["src/"])).toEqual({ accepted: true, testsPassed: true, outOfScope: [] });
    expect((await run(["src/a.ts"])).outOfScope).toEqual(["src/new.ts"]);
    expect((await run(["src"])).outOfScope).toEqual(["src/a.ts", "src/new.ts"]);
    expect((await run(["src/a.t", "sr/"])).outOfScope).toEqual(["src/a.ts", "src/new.ts"]);
  });

  it("scores a worker commit and a hidden edit as out of scope", async () => {
    const { repo, base } = makeBase({ "a.ts": "1\n", "b.ts": "1\n" });
    git(repo, "update-index", "--skip-worktree", "b.ts");
    writeFileSync(join(repo, "b.ts"), "2\n");
    writeFileSync(join(repo, "out.ts"), "x");
    git(repo, "add", "out.ts");
    git(repo, "commit", "-m", "worker");
    const r = await scoreImplementation(repo, task({ allowedPaths: ["a.ts"] }, base, pass()), { gitDir: base.gitDir });
    expect(r).toEqual({ accepted: false, testsPassed: true, outOfScope: ["b.ts", "out.ts"] });
  });

  it("fails on a non-zero or timed-out test command", async () => {
    const { repo, base } = makeBase();
    const run = (command: string[], timeoutMs: number) => scoreImplementation(repo, task({ allowedPaths: ["a.ts"] }, base, { kind: "implementation", command, timeoutMs }), { gitDir: base.gitDir });
    expect(await run(node("process.exit(3)"), 10_000)).toEqual({ accepted: false, testsPassed: false, outOfScope: [] });
    const started = Date.now();
    expect((await run(node("setTimeout(()=>{}, 60000)"), 500)).testsPassed).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await run(["definitely-not-a-command-xyz"], 1000)).testsPassed).toBe(false);
  });

  it("kills the whole process group on timeout", async () => {
    const { repo, base } = makeBase();
    const marker = join(tmp("oracle-marker-"), "marker");
    const code = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'x'),1500)`)}],{stdio:'ignore'});setTimeout(()=>{},60000)`;
    const r = await scoreImplementation(repo, task({}, base, { kind: "implementation", command: node(code), timeoutMs: 500 }), { gitDir: base.gitDir });
    expect(r.testsPassed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(marker)).toBe(false);
  });

  it("kills a background grandchild after a normal exit", async () => {
    const { repo, base } = makeBase();
    const marker = join(tmp("oracle-marker-"), "marker");
    const code = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'x'),1500)`)}],{stdio:'ignore'}).unref();`;
    const r = await scoreImplementation(repo, task({}, base, { kind: "implementation", command: node(code), timeoutMs: 10_000 }), { gitDir: base.gitDir });
    expect(r.testsPassed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(marker)).toBe(false);
  });

  it("gives oracle commands a TMPDIR inside the oracle HOME, or the one passed in (R33)", async () => {
    const { repo, base } = makeBase();
    const home = tmp("oracle-home-");
    const probe = (expected: string) => node(`const p=process.env.TMPDIR;process.exit(p===${JSON.stringify(expected)}&&require('fs').statSync(p).isDirectory()?0:1)`);
    const own = await scoreImplementation(repo, task({}, base, { kind: "implementation", command: probe(join(home, "tmp")), timeoutMs: 10_000 }), { gitDir: base.gitDir, home });
    expect(own.testsPassed).toBe(true);
    const custom = join(home, "custom-tmp");
    const passed = await scoreImplementation(repo, task({}, base, { kind: "implementation", command: probe(custom), timeoutMs: 10_000 }), { gitDir: base.gitDir, home, tmpdir: custom });
    expect(passed.testsPassed).toBe(true);
    const fresh = await scoreImplementation(repo, task({}, base, {
      kind: "implementation", command: node("const p=process.env.TMPDIR;process.exit(p&&p.startsWith(process.env.HOME+'/')&&require('fs').statSync(p).isDirectory()?0:1)"), timeoutMs: 10_000,
    }), { gitDir: base.gitDir });
    expect(fresh.testsPassed).toBe(true);
  });

  it("shares one deadline between setup and the decisive command", async () => {
    const { repo, base } = makeBase();
    const sleep = node("setTimeout(()=>{}, 700)");
    const run = (timeoutMs: number) => scoreImplementation(repo, task({}, base, { kind: "implementation", setup: [sleep], command: sleep, timeoutMs }), { gitDir: base.gitDir });
    expect((await run(1100)).testsPassed).toBe(false);
    expect((await run(5000)).testsPassed).toBe(true);
  });

  it("runs setup commands first and skips the test when setup fails", async () => {
    const { repo, base } = makeBase();
    const ok = await scoreImplementation(repo, task({ allowedPaths: ["setup.flag"] }, base, {
      kind: "implementation", setup: [node("require('fs').writeFileSync('setup.flag','1')")], command: node("process.exit(require('fs').existsSync('setup.flag')?0:1)"), timeoutMs: 10_000,
    }), { gitDir: base.gitDir });
    expect(ok).toEqual({ accepted: true, testsPassed: true, outOfScope: [] });
    const bad = await scoreImplementation(repo, task({}, base, {
      kind: "implementation", setup: [node("process.exit(1)")], command: node("require('fs').writeFileSync('ran.flag','1')"), timeoutMs: 10_000,
    }), { gitDir: base.gitDir });
    expect(bad.testsPassed).toBe(false);
    expect(existsSync(join(repo, "ran.flag"))).toBe(false);
  });

  it("deletes scopeIgnore directories and .codegraph/ after scoring scope and before setup runs", async () => {
    const { repo, base } = makeBase();
    for (const dir of [".pi-lens", ".codegraph"]) { mkdirSync(join(repo, dir)); writeFileSync(join(repo, dir, "state.json"), "{}"); }
    const gone = node("const fs=require('fs');process.exit(fs.existsSync('.pi-lens')||fs.existsSync('.codegraph')?1:0)");
    const r = await scoreImplementation(repo, task({ scopeIgnore: [".pi-lens/"] }, base, { kind: "implementation", setup: [gone], command: gone, timeoutMs: 10_000 }), { gitDir: base.gitDir });
    expect(r).toEqual({ accepted: true, testsPassed: true, outOfScope: [] });
  });

  it("does not delete through a symlinked parent directory", async () => {
    const { repo, base } = makeBase();
    const outside = tmp("oracle-outside-");
    mkdirSync(join(outside, "keep"));
    writeFileSync(join(outside, "keep", "file"), "x");
    symlinkSync(outside, join(repo, "link"));
    await scoreImplementation(repo, task({ allowedPaths: ["link"], scopeIgnore: ["link/keep/", "../x/"] }, base, pass()), { gitDir: base.gitDir });
    expect(existsSync(join(outside, "keep", "file"))).toBe(true);
  });

  it("applies wrap to every setup and test argv", async () => {
    const { repo, base } = makeBase();
    const log = join(tmp("oracle-wrap-"), "log");
    const wrap = (argv: readonly string[]): string[] => node(`require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(1).join(' ')+'\\n')`).concat(argv);
    const r = await scoreImplementation(repo, task({}, base, { kind: "implementation", setup: [["setup-one", "x"]], command: ["the-command", "y"], timeoutMs: 10_000 }), { gitDir: base.gitDir, wrap });
    expect(r.testsPassed).toBe(true);
    expect(readFileSync(log, "utf8")).toBe("setup-one x\nthe-command y\n");
  });

  it("replaces the clone's .git so its hooks and config never run, while git keeps working", async () => {
    const { repo, base } = makeBase();
    const markers = tmp("oracle-markers-");
    const hook = join(markers, "fsmonitor.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(join(markers, "fsmonitor"))}\nexit 0\n`);
    chmodSync(hook, 0o755);
    git(repo, "config", "core.fsmonitor", hook);
    const preCommit = join(repo, ".git", "hooks", "pre-commit");
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(preCommit, `#!/bin/sh\ntouch ${JSON.stringify(join(markers, "pre-commit"))}\nexit 0\n`);
    chmodSync(preCommit, 0o755);
    writeFileSync(join(repo, "a.ts"), "export const a = 6;\n");
    const useGit = node(`const {execFileSync}=require('child_process');
      const out=execFileSync('git',['status','--porcelain'],{encoding:'utf8'});
      if(out!==' M a.ts\\n') process.exit(2);
      execFileSync('git',['-c','user.name=a','-c','user.email=a@b.invalid','commit','--allow-empty','-q','-m','x'],{stdio:'ignore'});`);
    const r = await scoreImplementation(repo, task({ allowedPaths: ["a.ts"] }, base, { kind: "implementation", setup: [useGit], command: useGit, timeoutMs: 20_000 }), { gitDir: base.gitDir });
    expect(r).toEqual({ accepted: true, testsPassed: true, outOfScope: [] });
    expect(existsSync(join(markers, "fsmonitor"))).toBe(false);
    expect(existsSync(join(markers, "pre-commit"))).toBe(false);
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("export const a = 6;\n");
  });

  it("passes only PATH, HOME, TMPDIR (inside HOME, R33) and CI=1; HOME defaults to a fresh directory outside the clone", async () => {
    const { repo, base } = makeBase();
    const home = tmp("oracle-home-");
    const homeLog = join(tmp("oracle-homelog-"), "home");
    // macOS (CoreFoundation) adds __CF_USER_TEXT_ENCODING to every process environment by itself; it is the only key ignored.
    const check = (expectedHome: string) => node(`const e=process.env;process.exit(Object.keys(e).filter((k)=>k!=='__CF_USER_TEXT_ENCODING').sort().join()==='CI,HOME,PATH,TMPDIR'&&e.CI==='1'&&e.HOME===${JSON.stringify(expectedHome)}&&e.TMPDIR===${JSON.stringify(expectedHome)}+'/tmp'?0:1)`);
    const run = (command: string[], options: { home?: string } = {}) => scoreImplementation(repo, task({}, base, { kind: "implementation", command, timeoutMs: 10_000 }), { gitDir: base.gitDir, ...options });
    expect((await run(check(home), { home })).testsPassed).toBe(true);
    expect((await run(node(`require('fs').writeFileSync(${JSON.stringify(homeLog)}, process.env.HOME)`))).testsPassed).toBe(true);
    const used = readFileSync(homeLog, "utf8");
    expect(used).not.toBe(repo);
    expect(used.startsWith(repo)).toBe(false);
    expect(existsSync(used)).toBe(false);
  });
});
