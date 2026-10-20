import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedPaths, scoreImplementation, scoreReview } from "../eval/extensions/oracles.js";
import { taskSpecSchema, type ReviewOracle } from "../eval/extensions/schemas.js";

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
const node = (code: string): string[] => ["node", "-e", code];

const reviewOracle: ReviewOracle = {
  kind: "review",
  findings: [
    { id: "f1", critical: true, anchors: [{ file: "src/a.ts", terms: ["race", "lock"] }] },
    { id: "f2", critical: false, anchors: [{ file: "b.md", terms: ["typo"] }] },
  ],
  falseFindings: [{ id: "x1", anchors: [{ file: "src/a.ts", terms: ["sql injection"] }] }],
};

describe("scoreReview", () => {
  it("accepts a review that hits every critical finding in one block", () => {
    expect(scoreReview("- src/a.ts: race when the lock is released early", reviewOracle))
      .toMatchObject({ accepted: true, criticalHit: 1, criticalTotal: 1, recall: 0.5, falseFindings: [] });
    expect(scoreReview("src/a.ts has a race.\n\nThe lock is fine.", reviewOracle).accepted).toBe(false);
    expect(scoreReview("- src/a.ts: race, lock\n- src/a.ts: SQL injection", reviewOracle).falseFindings).toEqual(["x1"]);
  });

  it("rejects an otherwise complete review that hits a false finding", () => {
    const r = scoreReview("- src/a.ts: race, lock\n- b.md: typo\n- src/a.ts: SQL Injection", reviewOracle);
    expect(r).toMatchObject({ accepted: false, criticalHit: 1, recall: 1, falseFindings: ["x1"] });
  });

  it("matches the basename or the repo-relative path, case-insensitively", () => {
    expect(scoreReview("A.TS: RACE on LOCK", reviewOracle).criticalHit).toBe(1);
    expect(scoreReview("src/A.ts: Race on Lock", reviewOracle).criticalHit).toBe(1);
    expect(scoreReview("c.ts: race on lock", reviewOracle).criticalHit).toBe(0);
    expect(scoreReview("race on lock", reviewOracle).criticalHit).toBe(0);
  });

  it("requires path boundaries around the file name", () => {
    const hit = (text: string, file = "src/a.ts"): boolean => scoreReview(text, {
      kind: "review", findings: [{ id: "f", critical: true, anchors: [{ file, terms: ["race"] }] }], falseFindings: [],
    }).criticalHit === 1;
    expect(hit("data.ts: race", "a.ts")).toBe(false);
    expect(hit("src/a.tsx: race")).toBe(false);
    expect(hit("src/a.tsx: race", "a.ts")).toBe(false);
    expect(hit("xa.ts: race")).toBe(false);
    expect(hit("xsrc/a.ts: race")).toBe(true); // basename form may follow a slash
    expect(hit("src/a.ts.bak: race")).toBe(false);
    expect(hit("src/a.ts/b: race")).toBe(false);
    expect(hit("`src/a.ts:12` race")).toBe(true);
    expect(hit("(see src/a.ts#L3) race")).toBe(true);
    expect(hit("src/a.ts:12-15 race")).toBe(true);
    expect(hit("src/a.ts#L3-L9 race")).toBe(true);
    expect(hit("race in src/a.ts.")).toBe(true);
    expect(hit("race in lib/a.ts", "a.ts")).toBe(true);
    expect(hit("race in `a.ts`", "src/a.ts")).toBe(true); // basename form
    expect(hit("race in a.ts, twice; also data.ts", "a.ts")).toBe(true);
    expect(hit("data.ts and then a.ts: race", "a.ts")).toBe(true);
  });

  it("splits blocks on blank lines and list items but keeps continuation lines together", () => {
    expect(scoreReview("- src/a.ts: race\n  when the lock is released", reviewOracle).criticalHit).toBe(1);
    expect(scoreReview("1. src/a.ts: race\n2. the lock", reviewOracle).criticalHit).toBe(0);
    expect(scoreReview("* src/a.ts: race\n* src/a.ts: lock", reviewOracle).criticalHit).toBe(0);
    expect(scoreReview("src/a.ts: race\r\n\r\nlock", reviewOracle).criticalHit).toBe(0);
  });

  it("lets any anchor of a finding hit and requires every term in its anchor", () => {
    const o: ReviewOracle = { kind: "review", findings: [{ id: "f", critical: true, anchors: [{ file: "a.ts", terms: ["one", "two"] }, { file: "b.ts", terms: ["three"] }] }], falseFindings: [] };
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

describe("changedPaths", () => {
  it("lists modified, untracked and ignored paths minus scopeIgnore and .codegraph/", async () => {
    const repo = makeRepo({ "a.ts": "1\n", ".gitignore": "out/\n*.log\n" });
    writeFileSync(join(repo, "a.ts"), "2\n");
    mkdirSync(join(repo, ".pi-lens"));
    writeFileSync(join(repo, ".pi-lens", "cache.json"), "{}");
    mkdirSync(join(repo, ".codegraph"));
    writeFileSync(join(repo, ".codegraph", "db"), "x");
    mkdirSync(join(repo, "out"));
    writeFileSync(join(repo, "out", "x.js"), "x");
    writeFileSync(join(repo, "debug.log"), "x");
    writeFileSync(join(repo, "b.ts"), "x");
    expect(await changedPaths(repo, [".pi-lens/"])).toEqual(["a.ts", "b.ts", "debug.log", "out/"]);
    expect(await changedPaths(repo, [".pi-lens/", "out/"])).toEqual(["a.ts", "b.ts", "debug.log"]);
  });

  it("counts both paths of a rename and handles unusual file names", async () => {
    const repo = makeRepo({ "a.ts": "export const a = 'a long enough body for rename detection';\n", "dir/old name.ts": "unchanged\n" });
    git(repo, "mv", "a.ts", "c.ts");
    git(repo, "mv", "dir/old name.ts", "dir/new\nline.ts");
    expect(await changedPaths(repo, [])).toEqual(["a.ts", "c.ts", "dir/new\nline.ts", "dir/old name.ts"]);
  });

  it("matches scopeIgnore only on directory prefixes", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "dist"));
    writeFileSync(join(repo, "dist", "x.js"), "x");
    writeFileSync(join(repo, "distinct.ts"), "x");
    expect(await changedPaths(repo, ["dist/"])).toEqual(["distinct.ts"]);
  });

  it("returns an empty list for a clean clone", async () => {
    expect(await changedPaths(makeRepo(), [])).toEqual([]);
  });
});

describe("scoreImplementation", () => {
  it("computes scope before tests and honours scopeIgnore", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    mkdirSync(join(repo, ".pi-lens"));
    writeFileSync(join(repo, ".pi-lens", "cache.json"), "{}");
    writeFileSync(join(repo, "b.ts"), "x");
    const r = await scoreImplementation(repo, {
      allowedPaths: ["a.ts"], scopeIgnore: [".pi-lens/"],
      oracle: { kind: "implementation", command: node("require('fs').writeFileSync('late.ts','x')"), timeoutMs: 10_000 },
    });
    expect(r).toEqual({ accepted: false, testsPassed: true, outOfScope: ["b.ts"] });
  });

  it("accepts an in-scope change with a passing command, including files below an allowed directory", async () => {
    const repo = makeRepo({ "src/a.ts": "1\n" });
    writeFileSync(join(repo, "src", "a.ts"), "2\n");
    writeFileSync(join(repo, "src", "new.ts"), "x");
    const oracle = { kind: "implementation" as const, command: node("process.exit(0)"), timeoutMs: 10_000 };
    expect(await scoreImplementation(repo, { allowedPaths: ["src/a.ts", "src/new.ts"], scopeIgnore: [], oracle }))
      .toEqual({ accepted: true, testsPassed: true, outOfScope: [] });
    expect(await scoreImplementation(repo, { allowedPaths: ["src"], scopeIgnore: [], oracle }))
      .toEqual({ accepted: true, testsPassed: true, outOfScope: [] });
    expect((await scoreImplementation(repo, { allowedPaths: ["src/a.ts"], scopeIgnore: [], oracle })).outOfScope).toEqual(["src/new.ts"]);
  });

  it("fails on a non-zero or timed-out test command", async () => {
    const repo = makeRepo();
    const base = { allowedPaths: ["a.ts"], scopeIgnore: [] as string[] };
    const failing = await scoreImplementation(repo, { ...base, oracle: { kind: "implementation", command: node("process.exit(3)"), timeoutMs: 10_000 } });
    expect(failing).toEqual({ accepted: false, testsPassed: false, outOfScope: [] });
    const started = Date.now();
    const slow = await scoreImplementation(repo, { ...base, oracle: { kind: "implementation", command: node("setTimeout(()=>{}, 60000)"), timeoutMs: 500 } });
    expect(slow.testsPassed).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
    const missing = await scoreImplementation(repo, { ...base, oracle: { kind: "implementation", command: ["definitely-not-a-command-xyz"], timeoutMs: 1000 } });
    expect(missing.testsPassed).toBe(false);
  });

  it("kills the whole process group on timeout", async () => {
    const repo = makeRepo();
    const marker = join(tmp("oracle-marker-"), "marker");
    const code = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'x'),1500)`)}],{stdio:'ignore'});setTimeout(()=>{},60000)`;
    const r = await scoreImplementation(repo, { allowedPaths: [], scopeIgnore: [], oracle: { kind: "implementation", command: node(code), timeoutMs: 500 } });
    expect(r.testsPassed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(marker)).toBe(false);
  });

  it("runs setup commands first and skips the test when setup fails", async () => {
    const repo = makeRepo();
    const base = { allowedPaths: ["a.ts"], scopeIgnore: ["state/"] };
    const ok = await scoreImplementation(repo, {
      ...base, oracle: { kind: "implementation", setup: [node("require('fs').writeFileSync('setup.flag','1')")], command: node("process.exit(require('fs').existsSync('setup.flag')?0:1)"), timeoutMs: 10_000 },
    });
    expect(ok).toEqual({ accepted: true, testsPassed: true, outOfScope: [] });
    const bad = await scoreImplementation(repo, {
      ...base, oracle: { kind: "implementation", setup: [node("process.exit(1)")], command: node("require('fs').writeFileSync('ran.flag','1')"), timeoutMs: 10_000 },
    });
    expect(bad.testsPassed).toBe(false);
    expect(existsSync(join(repo, "ran.flag"))).toBe(false);
  });

  it("passes only PATH, HOME and CI=1, with HOME defaulting to the clone", async () => {
    const repo = makeRepo();
    const home = tmp("oracle-home-");
    const check = (expectedHome: string) => node(`const e=process.env;process.exit(Object.keys(e).sort().join()==='CI,HOME,PATH'&&e.CI==='1'&&e.HOME===${JSON.stringify(expectedHome)}?0:1)`);
    const base = { allowedPaths: [], scopeIgnore: [] as string[] };
    expect((await scoreImplementation(repo, { ...base, oracle: { kind: "implementation", command: check(repo), timeoutMs: 10_000 } })).testsPassed).toBe(true);
    expect((await scoreImplementation(repo, { ...base, oracle: { kind: "implementation", command: check(home), timeoutMs: 10_000 } }, { home })).testsPassed).toBe(true);
  });
});
