import { spawnSync } from "node:child_process";
import { closeSync, openSync, fstatSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

// The operator script is plain ESM without declarations; the tests use its exports untyped on purpose.
const scriptUrl = new URL("../scripts/isolation-acceptance.mjs", import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const h: Record<string, any> = await import(/* @vite-ignore */ scriptUrl.href);

afterAll(removeTemporaryRoots);

const write = (id: string, group: string, overrides: Record<string, unknown> = {}) => ({
  id, group, method: "node", skipped: false, host_observable: true, applicable: true, probe_blocked: true, host_changed: false, error_code: "ENOENT", ...overrides,
});

function containedReport(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    mode: "contained",
    launch_binding: { bound: true },
    controls: { bash_available: true, workspace_write_node: true, workspace_write_bash: true, marker_started: true },
    writes: [write("abs.node", "abs"), write("home.bash", "home"), write("agentdir.node", "agentdir"), write("home_inner.node", "home_inner", { host_observable: false, applicable: false })],
    credentials: { visible_count: 0, ssh_authenticated: false },
    persistence: { marker_survivors: 0, crontab_delta: 0, user_unit_delta: 0 },
    children: { secret_like_unallowed: 0, unexpected_names: 0, strict: false },
    network: { tcp_443: true },
    digests: { preexisting_unchanged_after_probe: true, preexisting_unchanged_after_cleanup: true },
    cleanup: { residual_canaries: 0, run_root_removed: true },
    ...overrides,
  };
}

function controlReport(overrides: Record<string, any> = {}): Record<string, any> {
  return containedReport({
    mode: "uncontained-control",
    launch_binding: { bound: false },
    writes: [write("abs.node", "abs", { probe_blocked: false, host_changed: true }), write("home.bash", "home", { probe_blocked: false, host_changed: true }), write("home_inner.node", "home_inner", { skipped: true })],
    persistence: { marker_survivors: 1, crontab_delta: 0, user_unit_delta: 0 },
    ...overrides,
  });
}

it("forwards the harness lease only to the wrapper as fd 3", async () => {
  const home = await temporaryRoot("iso-lease-");
  const workspace = join(home, "clone");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const observed = join(home, "observed.json"), wrapper = join(home, "wrapper.cjs");
  writeFileSync(wrapper, `const fs=require('node:fs');const s=fs.fstatSync(3);fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify([s.dev,s.ino,process.env.PI_WRITER_LEASE_FD]));process.stdin.resume();`);
  const fd = openSync(join(home, "lease"), "w+");
  try {
    const stat = fstatSync(fd);
    spawnSync(process.execPath, [scriptPath, "--launch", `${process.execPath} ${wrapper}`, "--workspace", workspace, "--mode", "contained", "--no-remote-checks"], {
      env: { ...process.env, HOME: home, PI_WRITER_LEASE_FD: "4" }, stdio: ["ignore", "pipe", "pipe", "ignore", fd], timeout: 30_000,
    });
    expect(JSON.parse(readFileSync(observed, "utf8"))).toEqual([stat.dev, stat.ino, "3"]);
  } finally { closeSync(fd); }
});

describe("argument validation", () => {
  const valid = ["--launch", "node", "--workspace", "/some/clone", "--mode", "contained"];

  it("accepts a complete command line and normalizes it", () => {
    const options = h.parseArguments([...valid, "--out", "report.json", "--env-allow", "OPENAI_API_KEY, FOO"]);
    expect(options).toMatchObject({ mode: "contained", launch: ["node"], workspace: "/some/clone", envAllow: ["OPENAI_API_KEY", "FOO"], skipRemote: false, agentDirCopyWritable: false });
    expect(options.out.endsWith("report.json")).toBe(true);
  });

  it("rejects missing or unknown values with a UsageError", () => {
    const bad = [
      ["--launch", "node", "--workspace", "/w"],
      ["--launch", "node", "--workspace", "/w", "--mode", "lenient"],
      ["--workspace", "/w", "--mode", "contained"],
      ["--launch", "   ", "--workspace", "/w", "--mode", "contained"],
      ["--launch", "node", "--mode", "contained"],
      ["--launch", "node", "--workspace", "/w", "--mode", "contained", "--cwd", "/x"],
      ["--launch", "node", "--workspace", "/w", "--mode", "contained", "extra"],
      ["--launch", "podman run 'x", "--workspace", "/w", "--mode", "contained"],
      ["--launch", "node", "--workspace", "/w", "--mode", "contained", "--env-allow", "A=B"],
      ["--launch", "node", "--workspace", "/w", "--mode", "uncontained-control", "--agent-dir-copy-writable"],
    ];
    for (const argv of bad) expect(() => h.parseArguments(argv), argv.join(" ")).toThrow(h.UsageError);
  });

  it("splits the launch prefix into words without a shell", () => {
    expect(h.tokenizeCommand("podman run -i --rm -v /a:/a:rw img node")).toEqual(["podman", "run", "-i", "--rm", "-v", "/a:/a:rw", "img", "node"]);
    expect(h.tokenizeCommand(`sh -c 'echo "a b"' "x y" z\\ w ''`)).toEqual(["sh", "-c", 'echo "a b"', "x y", "z w", ""]);
    expect(() => h.tokenizeCommand('node "unterminated')).toThrow(h.UsageError);
  });

  it("returns help without requiring other options", () => {
    expect(h.parseArguments(["--help"])).toEqual({ help: true });
  });
});

describe("verdict logic", () => {
  it("passes a contained run where every escape failed and nothing changed", () => {
    expect(h.evaluateVerdict(containedReport())).toMatchObject({ verdict: "pass", exit_code: 0, failed_checks: [] });
  });

  it("exempts writes to the boundary's own HOME only when it is a tmpfs", () => {
    const innerWrite = [write("home_inner.node", "home_inner", { host_observable: false, applicable: true, probe_blocked: false })];
    expect(h.evaluateVerdict(containedReport({ writes: innerWrite, boundary: { home_is_tmpfs: true } })).verdict).toBe("pass");
    expect(h.evaluateVerdict(containedReport({ writes: innerWrite, boundary: { home_is_tmpfs: false } })).failed_checks).toContain("writes.not_blocked.home_inner.node");
    expect(h.evaluateVerdict(containedReport({ writes: innerWrite })).failed_checks).toContain("writes.not_blocked.home_inner.node");
    const landed = [write("home_inner.node", "home_inner", { probe_blocked: false, host_changed: true })];
    expect(h.evaluateVerdict(containedReport({ writes: landed, boundary: { home_is_tmpfs: true } })).failed_checks).toContain("writes.host_changed.home_inner.node");
  });

  it("fails when a Git redirect file the run created is left in the writer's clone", () => {
    const left = containedReport({ git_metadata: { commondir_writable_inside: true, redirect_files_preexisting: 0, redirect_files_removed: 0, redirect_files_residual: 1 } });
    expect(h.evaluateVerdict(left).failed_checks).toContain("git_metadata.redirect_residual");
    const removed = containedReport({ git_metadata: { commondir_writable_inside: true, redirect_files_preexisting: 0, redirect_files_removed: 1, redirect_files_residual: 0 } });
    expect(h.evaluateVerdict(removed).verdict).toBe("pass");
  });

  it("fails when the boundary's own configuration is the host configuration", () => {
    const exposed = containedReport({ credentials: { visible_count: 0, ssh_authenticated: false, host_config_exposed: true } });
    expect(h.evaluateVerdict(exposed).failed_checks).toContain("credentials.host_config_exposed");
  });

  it("fails when an escape was not blocked or the host changed", () => {
    const leaked = containedReport({ writes: [write("abs.node", "abs", { probe_blocked: false })] });
    expect(h.evaluateVerdict(leaked)).toMatchObject({ verdict: "fail", exit_code: 1, failed_checks: ["writes.not_blocked.abs.node"] });
    const landed = containedReport({ writes: [write("abs.node", "abs", { host_changed: true })] });
    expect(h.evaluateVerdict(landed).failed_checks).toContain("writes.host_changed.abs.node");
  });

  it("fails on each other violated check", () => {
    const cases: [Record<string, any>, string][] = [
      [{ launch_binding: { bound: false } }, "launch_binding.not_bound"],
      [{ credentials: { visible_count: 1, ssh_authenticated: false } }, "credentials.visible"],
      [{ credentials: { visible_count: 0, ssh_authenticated: true } }, "credentials.ssh_authenticated"],
      [{ persistence: { marker_survivors: 1, crontab_delta: 0, user_unit_delta: 0 } }, "persistence.process_survived"],
      [{ persistence: { marker_survivors: 0, crontab_delta: 1, user_unit_delta: 0 } }, "persistence.crontab_changed"],
      [{ persistence: { marker_survivors: 0, crontab_delta: 0, user_unit_delta: -1 } }, "persistence.user_units_changed"],
      [{ children: { secret_like_unallowed: 2, unexpected_names: 0, strict: false } }, "children.secret_like_env"],
      [{ children: { secret_like_unallowed: 0, unexpected_names: 3, strict: true } }, "children.unexpected_env"],
      [{ digests: { preexisting_unchanged_after_probe: false, preexisting_unchanged_after_cleanup: true } }, "digests.preexisting_changed_after_probe"],
      [{ digests: { preexisting_unchanged_after_probe: true, preexisting_unchanged_after_cleanup: false } }, "digests.preexisting_changed"],
      [{ cleanup: { residual_canaries: 1, run_root_removed: true } }, "cleanup.residual_canaries"],
    ];
    for (const [overrides, id] of cases) {
      const result = h.evaluateVerdict(containedReport(overrides));
      expect(result.verdict, id).toBe("fail");
      expect(result.failed_checks, id).toContain(id);
    }
  });

  it("ignores unexpected env names unless an allowlist made the check strict", () => {
    expect(h.evaluateVerdict(containedReport({ children: { secret_like_unallowed: 0, unexpected_names: 9, strict: false } })).verdict).toBe("pass");
  });

  it("reports inconclusive instead of pass when the probe could not prove anything", () => {
    const cases: [Record<string, any>, string][] = [
      [{ controls: { bash_available: false, workspace_write_node: true, workspace_write_bash: true, marker_started: true } }, "controls.bash_unavailable"],
      [{ controls: { bash_available: true, workspace_write_node: false, workspace_write_bash: true, marker_started: true } }, "controls.workspace_not_writable"],
      [{ credentials: { visible_count: 0, ssh_authenticated: null } }, "credentials.ssh_not_checked"],
      [{ network: { tcp_443: null } }, "network.not_recorded"],
    ];
    for (const [overrides, id] of cases) {
      const result = h.evaluateVerdict(containedReport(overrides));
      expect(result, id).toMatchObject({ verdict: "inconclusive", exit_code: 2 });
      expect(result.inconclusive_checks, id).toContain(id);
    }
  });

  it("lets a fail outrank inconclusive, and accepts either network result", () => {
    const both = containedReport({ network: { tcp_443: null }, credentials: { visible_count: 1, ssh_authenticated: false } });
    expect(h.evaluateVerdict(both).verdict).toBe("fail");
    expect(h.evaluateVerdict(containedReport({ network: { tcp_443: false } })).verdict).toBe("pass");
  });

  it("exempts the declared writable Pi agent directory copy, but only for its groups and only the probe side", () => {
    const copy = containedReport({ writes: [write("agentdir.node", "agentdir", { probe_blocked: false }), write("extdir_inner.bash", "extdir_inner", { probe_blocked: false })] });
    expect(h.evaluateVerdict(copy).verdict).toBe("fail");
    expect(h.evaluateVerdict(copy, { agentDirCopyWritable: true }).verdict).toBe("pass");
    const home = containedReport({ writes: [write("home.node", "home", { probe_blocked: false })] });
    expect(h.evaluateVerdict(home, { agentDirCopyWritable: true }).verdict).toBe("fail");
    const hostLanding = containedReport({ writes: [write("agentdir.node", "agentdir", { probe_blocked: false, host_changed: true })] });
    expect(h.evaluateVerdict(hostLanding, { agentDirCopyWritable: true }).failed_checks).toEqual(["writes.host_changed.agentdir.node"]);
  });

  it("expects the uncontained control to detect every observable escape", () => {
    expect(h.evaluateVerdict(controlReport())).toMatchObject({ verdict: "control_detected_escapes", exit_code: 0, failed_checks: [] });
  });

  it("flags a control that missed an escape, a bound control and an undetected persistence marker", () => {
    const missed = controlReport({ writes: [write("abs.node", "abs", { probe_blocked: false, host_changed: false })] });
    expect(h.evaluateVerdict(missed)).toMatchObject({ verdict: "control_missed_escapes", exit_code: 1, failed_checks: ["control.missed.abs.node"] });
    expect(h.evaluateVerdict(controlReport({ launch_binding: { bound: true } })).failed_checks).toContain("control.launch_is_bound");
    expect(h.evaluateVerdict(controlReport({ persistence: { marker_survivors: 0, crontab_delta: 0, user_unit_delta: 0 } })).failed_checks).toContain("control.persistence_not_detected");
  });

  it("does not require detection where the host target does not exist", () => {
    const absent = controlReport({ writes: [write("abs.node", "abs", { probe_blocked: false, host_changed: true }), write("extdir.node", "extdir", { applicable: false, probe_blocked: true })] });
    expect(h.evaluateVerdict(absent).verdict).toBe("control_detected_escapes");
  });

  it("never reports a pass for the control mode or a contained verdict for it", () => {
    expect(h.evaluateVerdict(controlReport()).verdict).not.toBe("pass");
    expect(h.evaluateVerdict(controlReport({ controls: { bash_available: false, workspace_write_node: true, workspace_write_bash: true, marker_started: true } })).verdict).toBe("inconclusive");
  });
});

describe("classification and sanitization", () => {
  it("counts environment names without keeping them", () => {
    const result = h.classifyEnvNames(["PATH", "HOME", "LC_ALL", "OPENAI_API_KEY", "GH_TOKEN", "CUSTOM"], ["OPENAI_API_KEY"]);
    expect(result).toEqual({ env_names_total: 6, secret_like_unallowed: 1, unexpected_names: 2, strict: true });
    expect(h.classifyEnvNames(["PATH"], null)).toMatchObject({ strict: false, secret_like_unallowed: 0 });
  });

  it("classifies the network result", () => {
    expect(h.classifyNetwork(true).classification).toBe("not_limited");
    expect(h.classifyNetwork(false).classification).toBe("limited");
    expect(h.classifyNetwork(null).classification).toBe("not_recorded");
  });

  it("refuses any string that could carry a path, an environment pair or free text", () => {
    expect(() => h.assertSanitized({ ok: true, count: 3, nothing: null, id: "abs.node", list: ["a_b", "c-d"], at: "2026-10-18T10:00:00.000Z" })).not.toThrow();
    for (const bad of ["/home/user/.ssh", "../x", "TOKEN=abc", "two words", "x".repeat(200), "C:\\x"]) {
      expect(() => h.assertSanitized({ nested: { value: bad } }), bad).toThrow(h.UsageError);
      expect(() => h.assertSanitized({ [bad]: 1 }), bad).toThrow(h.UsageError);
    }
    expect(() => h.assertSanitized({ value: undefined })).toThrow(h.UsageError);
  });

  it("digests a target without its canaries and notices other changes", async () => {
    const dir = join(await temporaryRoot("iso-digest-"), "d");
    mkdirSync(dir);
    writeFileSync(join(dir, "keep"), "a");
    const before = h.digestTarget(dir, "content", "canary-1");
    writeFileSync(join(dir, "canary-1-x"), "new");
    expect(h.digestTarget(dir, "content", "canary-1")).toBe(before);
    writeFileSync(join(dir, "keep"), "b");
    expect(h.digestTarget(dir, "content", "canary-1")).not.toBe(before);
    expect(h.digestTarget(join(dir, "missing"), "names", "canary-1")).toBe(h.digestTarget(join(dir, "also-missing"), "names", "canary-1"));
  });

  it("builds an attempt list that covers every required escape through both methods", () => {
    const attempts = h.buildAttempts({
      prefix: "isolation-canary-abc", home: "/h", agentDir: "/h/.pi/agent", extDir: "/h/.pi/agent/npm/node_modules", userUnitDir: "/h/.config/systemd/user",
      workspace: "/w/clone", outside: "/r/outside", source: "/r/source", linkName: "isolation-canary-abc-link",
    });
    const groups = attempts.map((attempt: { group: string }) => attempt.group);
    for (const group of ["abs", "dotdot", "symlink", "home", "agentdir", "extdir", "githooks", "gitconfig", "userunit", "control"]) expect(groups).toContain(group);
    expect(attempts.find((attempt: { id: string }) => attempt.id === "dotdot").path).toContain("/../");
    for (const attempt of attempts) expect(JSON.stringify(attempt)).toContain(attempt.kind === "append" ? "/r/source/.git/config" : "isolation-canary-abc");
  });
});

// The whole harness against an owned temporary home: it really performs the escapes there, so nothing outside the owned root is touched.
describe.skipIf(process.platform !== "linux")("uncontained control run in an owned temporary home", () => {
  it("detects every escape, removes every canary, leaves pre-existing files alone and prints nothing sensitive", async () => {
    const home = await temporaryRoot("iso-home-");
    const files: Record<string, string> = {
      ".bashrc": "alias a=b\n",
      ".pi/agent/auth.json": '{"secret":"HOME-FILE-CONTENT-7731"}',
      ".pi/agent/npm/node_modules/.keep": "",
      ".config/systemd/user/.keep": "",
    };
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(home, name, ".."), { recursive: true });
      writeFileSync(join(home, name), content);
    }
    const workspace = join(home, "work", "clone");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    const out = join(home, "report.json");
    const listing = (dir: string): string[] => readdirSync(dir).sort();
    const before = { home: listing(home), agent: listing(join(home, ".pi/agent")), work: listing(join(home, "work")) };

    const run = spawnSync(process.execPath, [scriptPath, "--launch", process.execPath, "--workspace", workspace, "--mode", "uncontained-control", "--no-remote-checks", "--out", out], {
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: "", ISOLATION_TEST_SECRET: "env-value-8842" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("verdict=control_detected_escapes");

    const text = readFileSync(out, "utf8");
    const report = JSON.parse(text);
    expect(report.verdict).toBe("control_detected_escapes");
    const detected = report.writes.filter((entry: any) => !entry.skipped && entry.host_observable && entry.applicable);
    expect(detected.length).toBeGreaterThanOrEqual(16);
    expect(detected.every((entry: any) => entry.probe_blocked === false && entry.host_changed === true)).toBe(true);
    expect(report.persistence.marker_survivors).toBeGreaterThanOrEqual(1);
    expect(report.cleanup).toMatchObject({ residual_canaries: 0, run_root_removed: true });
    expect(report.cleanup.canaries_found).toBe(report.cleanup.canaries_removed);
    expect(report.digests.preexisting_unchanged_after_cleanup).toBe(true);

    // Sanitization: no path, home name, file content or environment value in anything the harness printed or wrote.
    for (const forbidden of [home, "HOME-FILE-CONTENT-7731", "env-value-8842", "/", "isolation-canary-"]) {
      expect(text.includes(forbidden), forbidden).toBe(false);
    }
    expect(run.stdout.includes(home) || run.stderr.includes(home)).toBe(false);

    // Host state: the pre-existing files are intact and only the report is new.
    for (const [name, content] of Object.entries(files)) expect(readFileSync(join(home, name), "utf8")).toBe(content);
    expect(listing(home)).toEqual([...before.home, ".cache", "report.json"].sort());
    expect(listing(join(home, ".pi/agent"))).toEqual(before.agent);
    expect(listing(join(home, "work"))).toEqual(before.work);
    expect(listing(workspace)).toEqual([".git"]);
    expect(existsSync(join(home, ".cache", "pi-session-mcp-isolation")) && readdirSync(join(home, ".cache", "pi-session-mcp-isolation")).length).toBe(0);
  }, 90_000);

  it("refuses an unusable workspace before doing anything", async () => {
    const home = await temporaryRoot("iso-refuse-");
    const gitfile = join(home, "wt");
    mkdirSync(gitfile);
    writeFileSync(join(gitfile, ".git"), "gitdir: /elsewhere\n");
    for (const workspace of [gitfile, home, join(home, "missing")]) {
      const run = spawnSync(process.execPath, [scriptPath, "--launch", process.execPath, "--workspace", workspace, "--mode", "uncontained-control", "--no-remote-checks"], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(run.status, workspace).toBe(2);
    }
    expect(readdirSync(home).sort()).toEqual([".cache", "wt"]);
  });
});
