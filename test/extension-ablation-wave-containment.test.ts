import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { buildMatrix, PAIRINGS } from "../eval/extensions/matrix.js";
import { runHelper } from "../eval/extensions/helpers.js";
import { WaveDirGuard } from "../eval/extensions/evidence.js";
import { ABSENT_PATHS, containmentSelfTest } from "../eval/extensions/containment.js";
import { ETC_ENTRIES, EMPTY_PLAN, bwrapArgs, planSandbox, sandboxed, type PlanHost, type SandboxPlan } from "../eval/extensions/sandbox.js";
import { assertWaveDirOutsideSources } from "../eval/extensions/tools.js";
import { BUILD_ROOT, CORE_LIMIT } from "../eval/extensions/supervise.js";
import { runPreflight } from "../eval/extensions/preflight.js";
import { runWave } from "../eval/extensions/wave.js";
import { scopeRoot, type RunScope } from "../eval/extensions/workspace.js";
import { realHostWith } from "./real-host.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { exec, productionConfig, benignTrace, fake, reviewTask, approvalFor, seedLedger, seams, waveSetup, TOOLS, baseDeps, text } from "./extension-ablation-wave-fixtures.js";

afterAll(removeTemporaryRoots);

describe("Unix socket stop and preflight charge", () => {
  it("stops a wave on a connect to the user bus", async () => {
    const s = await waveSetup(2);
    const trace = `${benignTrace()}4242 connect(3<socket:[1]>, {sa_family=AF_UNIX, sun_path="/run/user/1000/bus"}, 21) = 0\n`;
    const r = await runWave(s.input, s.deps([text({ trace })]).deps);
    expect(r.stopReason).toBe("unresolved_egress");
    expect(r.records[0]!.trace).toMatchObject({ unresolvedEgress: 1 });
  });

  it("charges the estimate when the preflight throws after the spawn", async () => {
    const root = await temporaryRoot("ablation-preflight-throw-");
    const tasks = [await reviewTask(root, "P1")];
    const approval = approvalFor(tasks, buildMatrix(tasks, PAIRINGS.filter((p) => p.id === "pl-review")));
    const { spawnRun } = fake([text()], root);
    const ledgerPath = join(root, "ledger.json");
    await seedLedger(ledgerPath);
    const r = await runPreflight({ approval, waveDir: join(root, "w"), ledgerPath, productionConfig, hostAuth: { openai: { type: "api_key", key: "k" } } }, {
      ...seams(), spawnRun: (scope, input) => spawnRun(scope, input, join(scope.root, "x.log")), residualCheck: async () => { throw new Error("residual exploded"); },
    });
    expect(r.routes).toMatchObject([{ ok: false, failure: "preflight_step_failed" }]);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { entries: { runId: string; costUsd: number; estimated?: boolean }[] };
    expect(ledger.entries).toMatchObject([{ runId: "preflight-review", costUsd: 1, estimated: true, kind: "preflight" }]);
    expect(existsSync(scopeRoot(join(root, "w"), "preflight-review"))).toBe(false);
  });
});

describe("bubblewrap containment (R46)", () => {
  // The real-host test below needs bwrap, strace, prlimit and codegraph on the PATH and skips when any is missing.
  const onPath = (name: string): string => (process.env.PATH ?? "").split(":").filter((dir) => dir.startsWith("/")).map((dir) => join(dir, name)).find((path) => existsSync(path)) ?? "";
  // Linux with a bubblewrap that can create a user namespace; the self-test's DNS lookup also needs the network, so it is a real-host test.
  const hasBwrap = realHostWith("strace", "prlimit");
  const codegraphPath = onPath("codegraph");
  const hasCodegraph = codegraphPath !== "";

  const HOME = "/home/op";
  const plan: SandboxPlan = {
    rootLinks: [{ path: "/bin", target: "usr/bin" }, { path: "/lib", target: "usr/lib" }], rootReadOnly: ["/opt"],
    etcReadOnly: ["/etc/hosts", "/etc/ssl"], runReadOnly: ["/run/systemd/resolve"], home: HOME,
    homeReadOnly: [`${HOME}/repo/node_modules`, `${HOME}/.codegraph/v1/bin`], homeLinks: [{ path: `${HOME}/.local/bin/codegraph`, target: `${HOME}/.codegraph/v1/bin/codegraph` }],
    extraReadOnly: ["/tmp/build"],
  };

  it("builds the sandbox from an allowlist root: no bind of /, /run and the home hidden, needs bound back read-only, scope bind after the tmpfs mounts", () => {
    const args = bwrapArgs("/tmp/x/scope", plan, ["/tmp/x/oracle-home"]);
    const at = (flag: string, value: string) => args.findIndex((arg, i) => arg === flag && args[i + 1] === value);
    const bind = (flag: string, path: string) => args.findIndex((arg, i) => arg === flag && args[i + 1] === path && args[i + 2] === path);
    const link = (target: string, path: string) => args.findIndex((arg, i) => arg === "--symlink" && args[i + 1] === target && args[i + 2] === path);
    // R51: the host's root is never bound; the allowlist comes first, in order.
    expect(bind("--ro-bind", "/")).toBe(-1);
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/usr", "/usr"]);
    expect(link("usr/bin", "/bin")).toBeGreaterThan(bind("--ro-bind", "/usr"));
    expect(link("usr/lib", "/lib")).toBeGreaterThan(-1);
    expect(bind("--ro-bind", "/opt")).toBeGreaterThan(-1);
    const etc = at("--dir", "/etc");
    expect(etc).toBeGreaterThan(-1);
    expect(bind("--ro-bind", "/etc/hosts")).toBeGreaterThan(etc);
    expect(bind("--ro-bind", "/etc/ssl")).toBeGreaterThan(etc);
    expect(bind("--ro-bind", "/etc/hosts")).toBeLessThan(at("--tmpfs", "/tmp"));
    expect(at("--tmpfs", "/tmp")).toBeGreaterThan(-1);
    // /var holds nothing but an empty tmpfs /var/tmp, made inside a plain /var.
    expect(at("--dir", "/var")).toBeGreaterThan(-1);
    expect(at("--tmpfs", "/var/tmp")).toBeGreaterThan(at("--dir", "/var"));
    expect(args.some((arg, i) => arg === "--tmpfs" && args[i + 1] === "/var")).toBe(false);
    const bindScope = bind("--bind", "/tmp/x/scope");
    expect(bindScope).toBeGreaterThan(at("--tmpfs", "/tmp"));
    expect(bind("--bind", "/tmp/x/oracle-home")).toBeGreaterThan(bindScope);
    // R48: all of /run is a tmpfs; no dedicated /run/user or /run/dbus entry is left to forget a sibling socket.
    expect(at("--tmpfs", "/run")).toBeGreaterThan(-1);
    expect(args.some((arg, i) => arg === "--tmpfs" && (args[i + 1] === "/run/user" || args[i + 1] === "/run/dbus"))).toBe(false);
    expect(bind("--ro-bind", "/run/systemd/resolve")).toBeGreaterThan(at("--tmpfs", "/run"));
    // R49: the home is a tmpfs, the needs are bound back after it, the writable binds come next, then the home and the root are remounted read-only.
    const home = at("--tmpfs", HOME);
    expect(home).toBeGreaterThan(at("--tmpfs", "/run"));
    expect(bind("--ro-bind", `${HOME}/repo/node_modules`)).toBeGreaterThan(home);
    expect(bind("--ro-bind", `${HOME}/.codegraph/v1/bin`)).toBeGreaterThan(home);
    expect(link(`${HOME}/.codegraph/v1/bin/codegraph`, `${HOME}/.local/bin/codegraph`)).toBeGreaterThan(home);
    expect(bindScope).toBeGreaterThan(link(`${HOME}/.codegraph/v1/bin/codegraph`, `${HOME}/.local/bin/codegraph`));
    expect(bind("--ro-bind", "/tmp/build")).toBeGreaterThan(at("--tmpfs", "/tmp"));
    expect(at("--remount-ro", HOME)).toBeGreaterThan(bind("--bind", "/tmp/x/oracle-home"));
    expect(at("--remount-ro", "/")).toBeGreaterThan(at("--remount-ro", HOME));
    expect(args.filter((arg) => arg === "--bind")).toHaveLength(2);
    for (const flag of ["--dev", "--proc", "--die-with-parent", "--new-session", "--unshare-ipc", "--unshare-pid"]) expect(args).toContain(flag);
    expect(args).not.toContain("--share-net");
    expect(args).not.toContain("--unshare-net");
    expect(args.at(-1)).toBe("--");
    expect(sandboxed(TOOLS, plan, "/s", ["echo", "x"]).slice(0, 1)).toEqual([TOOLS.bwrap]);
    expect(sandboxed(TOOLS, plan, "/s", ["echo", "x"]).slice(-2)).toEqual(["echo", "x"]);
    // Without a home there is no home tmpfs and no home remount, but the root is still read-only; /var/run does not exist at all.
    const bare = bwrapArgs("/s", { ...EMPTY_PLAN });
    expect(bare).not.toContain("/var/run");
    expect(bare.filter((arg) => arg === "--remount-ro")).toHaveLength(1);
    expect(bare.slice(0, 3)).toEqual(["--ro-bind", "/usr", "/usr"]);
  });

  /** A host with a merged-usr root, a resolv.conf that is a plain file, and a user bundle of codegraph below the home. */
  const fakeHost = (over: Partial<PlanHost> & { present?: readonly string[]; realMap?: Record<string, string>; kinds?: Record<string, "link" | "dir" | "file"> } = {}): Partial<PlanHost> => {
    const present = new Set(over.present ?? ["/opt", ...ETC_ENTRIES.map((entry) => `/etc/${entry}`)]);
    const kinds = { "/bin": "link", "/lib": "link", "/lib64": "link", "/sbin": "link", "/etc/resolv.conf": "file", ...over.kinds };
    return {
      exists: async (path) => present.has(path),
      lstat: async (path) => {
        const kind = (kinds as Record<string, string | undefined>)[path];
        return kind === undefined ? null : { isSymbolicLink: () => kind === "link", isDirectory: () => kind === "dir" };
      },
      real: async (path) => over.realMap?.[path] ?? path,
      trackedSkills: async () => ["skills/a/SKILL.md", "skills/a/references/r.md", "skills/b/SKILL.md", "skills/loose.md"],
      ...(over.exists === undefined ? {} : { exists: over.exists }),
      ...(over.trackedSkills === undefined ? {} : { trackedSkills: over.trackedSkills }),
    };
  };
  const planOf = (input: Partial<Parameters<typeof planSandbox>[0]>, host: Partial<PlanHost>) =>
    planSandbox({ tools: { codegraph: "/usr/bin/codegraph" }, repoRoot: `${HOME}/repo`, buildRoot: "/tmp/build", home: HOME, nodePath: "/usr/bin/node", ...input }, host);

  it("plans the allowlist root: merged-usr links by lstat, /opt only when present, and the /etc entries that exist", async () => {
    const full = await planOf({}, fakeHost());
    expect(full.rootLinks).toEqual([{ path: "/bin", target: "usr/bin" }, { path: "/lib", target: "usr/lib" }, { path: "/lib64", target: "usr/lib" }, { path: "/sbin", target: "usr/bin" }]);
    expect(full.rootReadOnly).toEqual(["/opt"]);
    expect(full.etcReadOnly).toEqual(ETC_ENTRIES.map((entry) => `/etc/${entry}`));
    // The brief's list, once, in one place.
    expect([...ETC_ENTRIES]).toEqual([
      "resolv.conf", "hosts", "nsswitch.conf", "passwd", "group", "localtime", "ld.so.cache", "ld.so.conf", "ld.so.conf.d",
      "ssl", "ca-certificates", "pki", "os-release", "gitconfig", "mime.types", "protocols", "services",
    ]);
    // No /opt, no gitconfig/pki, a missing /lib64, and a real directory at /sbin (bound instead of linked).
    const sparse = await planOf({}, fakeHost({
      present: ["/etc/hosts", "/etc/resolv.conf", "/etc/ssl"], kinds: { "/lib64": undefined as never, "/sbin": "dir" },
    }));
    expect(sparse.etcReadOnly).toEqual(["/etc/resolv.conf", "/etc/hosts", "/etc/ssl"]);
    expect(sparse.rootReadOnly).toEqual(["/sbin"]);
    expect(sparse.rootLinks.map((link) => link.path)).toEqual(["/bin", "/lib"]);
  });

  it("brings a resolv.conf link's directory back only below /run, without repeating the systemd one", async () => {
    const link = { kinds: { "/etc/resolv.conf": "link" as const } };
    const nm = await planOf({}, fakeHost({ ...link, present: ["/run/systemd/resolve"], realMap: { "/etc/resolv.conf": "/run/NetworkManager/resolv.conf" } }));
    expect(nm.runReadOnly).toEqual(["/run/systemd/resolve", "/run/NetworkManager"]);
    const systemd = await planOf({}, fakeHost({ ...link, present: ["/run/systemd/resolve"], realMap: { "/etc/resolv.conf": "/run/systemd/resolve/stub-resolv.conf" } }));
    expect(systemd.runReadOnly).toEqual(["/run/systemd/resolve"]);
    const elsewhere = await planOf({}, fakeHost({ ...link, present: [], realMap: { "/etc/resolv.conf": "/var/lib/dns/resolv.conf" } }));
    expect(elsewhere.runReadOnly).toEqual([]);
  });

  it("binds back only what a run needs below the home: node_modules, tracked skills, codegraph's file and a bundle's bin, node and lib", async () => {
    const bundle = `${HOME}/.codegraph/versions/v1`;
    const planned = await planOf(
      { tools: { codegraph: `${HOME}/.local/bin/codegraph` } },
      fakeHost({ present: [`${bundle}/bin`, `${bundle}/node`, `${bundle}/lib`], realMap: { [`${HOME}/.local/bin/codegraph`]: `${bundle}/bin/codegraph` } }),
    );
    expect(planned.homeReadOnly).toEqual([
      `${HOME}/repo/node_modules`, `${HOME}/repo/skills/a`, `${HOME}/repo/skills/b`, `${HOME}/repo/skills/loose.md`, `${bundle}/bin`, `${bundle}/node`, `${bundle}/lib`,
    ]);
    // The link is recreated, so the launcher finds its bundle through it; neither ~/.local/bin nor the bundle root nor ~/.codegraph is bound.
    expect(planned.homeLinks).toEqual([{ path: `${HOME}/.local/bin/codegraph`, target: `${bundle}/bin/codegraph` }]);
    for (const wide of [`${HOME}/.local`, `${HOME}/.local/bin`, bundle, `${HOME}/.codegraph`, `${HOME}/repo`, `${HOME}/repo/skills`, HOME]) expect(planned.homeReadOnly).not.toContain(wide);
    expect(planned.extraReadOnly).toEqual(["/tmp/build"]);
    // A plain binary file directly below the home is bound as that file alone, never its directory.
    const plain = await planOf({ tools: { codegraph: `${HOME}/bin/codegraph` } }, fakeHost());
    expect(plain.homeReadOnly).toEqual([`${HOME}/repo/node_modules`, `${HOME}/repo/skills/a`, `${HOME}/repo/skills/b`, `${HOME}/repo/skills/loose.md`, `${HOME}/bin/codegraph`]);
    expect(plain.homeLinks).toEqual([]);
    // codegraph below /usr needs nothing.
    expect((await planOf({}, fakeHost())).homeReadOnly.some((path) => path.includes("codegraph"))).toBe(false);
  });

  it("binds the node binary's directory only when it is outside /usr and /opt", async () => {
    expect((await planOf({ nodePath: "/usr/bin/node" }, fakeHost())).extraReadOnly).toEqual(["/tmp/build"]);
    expect((await planOf({ nodePath: "/opt/node/bin/node" }, fakeHost())).extraReadOnly).toEqual(["/tmp/build"]);
    expect((await planOf({ nodePath: "/data/node/bin/node" }, fakeHost())).extraReadOnly).toEqual(["/tmp/build", "/data/node/bin"]);
    const inHome = await planOf({ nodePath: `${HOME}/.local/bin/node` }, fakeHost());
    expect(inHome.homeReadOnly).toContain(`${HOME}/.local/bin`);
    expect(inHome.extraReadOnly).toEqual(["/tmp/build"]);
  });

  it("lists the tracked skill directories through git, so an untracked session buffer stays hidden", async () => {
    const repo = await temporaryRoot("ablation-skills-");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("init", "-q");
    await mkdir(join(repo, "skills", "tracked", "references"), { recursive: true });
    await mkdir(join(repo, "skills", ".remember"), { recursive: true });
    await mkdir(join(repo, "node_modules"));
    await writeFile(join(repo, "skills", "tracked", "SKILL.md"), "x");
    await writeFile(join(repo, "skills", "tracked", "references", "r.md"), "x");
    await writeFile(join(repo, "skills", ".remember", "buffer.md"), "secret");
    git("add", "skills/tracked");
    const planned = await planSandbox({ tools: { codegraph: "/usr/bin/codegraph" }, repoRoot: repo, buildRoot: "/tmp/build", home: repo, nodePath: "/usr/bin/node" });
    const real = await (await import("node:fs/promises")).realpath(repo);
    expect(planned.homeReadOnly).toEqual([join(real, "node_modules"), join(real, "skills", "tracked")]);
    await expect(planSandbox({ tools: { codegraph: "/usr/bin/codegraph" }, repoRoot: join(repo, "missing"), buildRoot: "/tmp/build", home: repo })).rejects.toThrow("skills_listing_failed");
  });

  it("plans the real file system: the home with its needs, a bundle's bin and a link to the codegraph file", async () => {
    const root = await temporaryRoot("ablation-plan-");
    const home = join(root, "home");
    const repo = join(home, "repo");
    await mkdir(join(repo, "node_modules"), { recursive: true });
    await mkdir(join(repo, "skills", "a"), { recursive: true });
    const bundle = join(home, ".tools", "cg", "v1");
    await mkdir(join(bundle, "bin"), { recursive: true });
    await writeFile(join(bundle, "bin", "codegraph"), "#!/bin/sh\n");
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(join(bundle, "bin", "codegraph"), join(home, ".local", "bin", "codegraph"));
    await writeFile(join(home, ".local", "bin", "node"), "x");
    const planned = await planSandbox(
      { tools: { codegraph: join(home, ".local", "bin", "codegraph") }, repoRoot: repo, buildRoot: "/tmp/build", home, nodePath: join(home, ".local", "bin", "node") },
      { trackedSkills: async () => ["skills/a/SKILL.md"] },
    );
    const fsReal = (await import("node:fs/promises")).realpath;
    expect(planned.home).toBe(await fsReal(home));
    expect([...planned.homeReadOnly].sort()).toEqual([join(repo, "node_modules"), join(repo, "skills", "a"), join(home, ".local", "bin"), join(bundle, "bin")].sort());
    expect(planned.homeLinks).toEqual([{ path: join(home, ".local", "bin", "codegraph"), target: join(bundle, "bin", "codegraph") }]);
    expect(planned.homeReadOnly).not.toContain(join(home, ".local"));
    expect(planned.extraReadOnly).toEqual(["/tmp/build"]);
  });

  const SOCKETS = ["/run/user/1000/bus", "/run/dbus/system_bus_socket", "/run/systemd/private", "/run/systemd/journal/socket", "/run/docker.sock"];
  const good = {
    home: "EROFS", ssh: "ENOENT", entry: null, absent: Object.fromEntries(ABSENT_PATHS.map((p) => [p, "ENOENT"])), scope: true, oracleHome: true, tmp: true, dns: true, codegraph: true,
    sockets: Object.fromEntries(SOCKETS.map((p) => [p, "ENOENT"])),
  };
  /** A fake sandbox run: writes the strace log of a clean probe where `-o` says, then prints `result`. */
  const probe = (result: unknown, logText: (root: number) => string = () => `${benignTrace()}`) => async (_file: string, args: readonly string[]) => {
    const log = args[args.indexOf("-o") + 1]!;
    await writeFile(log, logText(4240));
    return { stdout: `noise\n${JSON.stringify(result)}\n`, stderr: "" };
  };
  const mutate = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...good, ...patch });

  it.each([
    ["a real home that could be written", mutate({ home: "created" })],
    ["a home failing with another error", mutate({ home: "EACCES" })],
    ["a readable .ssh", mutate({ ssh: true })],
    ["a .ssh failing differently", mutate({ ssh: "EACCES" })],
    ["a scope that cannot be written", mutate({ scope: "EROFS" })],
    ["an oracle home that cannot be written", mutate({ oracleHome: "EROFS" })],
    ["a /tmp that cannot be written", mutate({ tmp: "EROFS" })],
    ["a reachable user bus", mutate({ sockets: { ...good.sockets, "/run/user/1000/bus": "connected" } })],
    ["a reachable system bus", mutate({ sockets: { ...good.sockets, "/run/dbus/system_bus_socket": "connected" } })],
    ["a reachable docker socket", mutate({ sockets: { ...good.sockets, "/run/docker.sock": "connected" } })],
    ["a socket failing differently", mutate({ sockets: { ...good.sockets, "/run/systemd/private": "ECONNREFUSED" } })],
    ["a missing socket result", mutate({ sockets: {} })],
    ["a provider host that does not resolve", mutate({ dns: false })],
    ["a missing DNS result", mutate({ dns: undefined })],
    ["a codegraph that does not run", mutate({ codegraph: "ENOENT" })],
    ["a codegraph that exits non-zero", mutate({ codegraph: "ERR_UNHANDLED" })],
    ["a missing absent-path result", mutate({ absent: {} })],
    ...ABSENT_PATHS.map((path): [string, Record<string, unknown>] => [`a visible ${path}`, mutate({ absent: { ...good.absent, [path]: true } })]),
    ["a host-home entry that is expected absent but reported present", mutate({ entry: true })],
  ])("refuses with containment_failed for %s", async (_name, result) => {
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: probe(result), home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
  });

  it("refuses when the probe's own strace log shows an outside write or is missing", async () => {
    const outside = (root: number) => `${benignTrace()}${root + 2} openat(AT_FDCWD</scope>, "/home/x/leak", O_WRONLY|O_CREAT, 0644) = 3</home/x/leak>\n`;
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: probe(good, outside), home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: async () => ({ stdout: JSON.stringify(good), stderr: "" }), home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
  });

  it("picks a real host-home entry that the plan does not bind back and requires it absent inside", async () => {
    const home = await temporaryRoot("ablation-home-");
    for (const name of [".hidden", "src", "Documents", "Music"]) await mkdir(join(home, name));
    const seen: string[][] = [];
    const run = async (file: string, args: readonly string[]) => { seen.push([file, ...args]); return probe({ ...good, entry: "ENOENT" })(file, args); };
    // "Documents" sorts first but holds a bind (the repository below it), and hidden entries are never picked.
    const bound = { ...EMPTY_PLAN, homeReadOnly: [join(home, "Documents", "repo", "node_modules")] };
    await containmentSelfTest(TOOLS, bound, { run, home, uid: 1000 });
    expect(seen[0]!.at(-2)).toBe("Music");
    // The entry being visible inside is a failure.
    await expect(containmentSelfTest(TOOLS, bound, { run: probe({ ...good, entry: true }), home, uid: 1000 })).rejects.toThrow("containment_failed");
    // Without a non-hidden free entry, .ssh is used when it exists; with none at all, nothing is expected.
    const sshHome = await temporaryRoot("ablation-home-ssh-");
    await mkdir(join(sshHome, ".ssh")); await mkdir(join(sshHome, ".config"));
    seen.length = 0;
    await containmentSelfTest(TOOLS, EMPTY_PLAN, { run, home: sshHome, uid: 1000 });
    expect(seen[0]!.at(-2)).toBe(".ssh");
    seen.length = 0;
    await containmentSelfTest(TOOLS, EMPTY_PLAN, { run: async (file, args) => { seen.push([file, ...args]); return probe(good)(file, args); }, home: "/home/x", uid: 1000 });
    expect(seen[0]!.at(-2)).toBe("");
  });

  it("refuses when a marker created in the sandbox's /tmp exists on the host afterwards", async () => {
    const leaking = async (_file: string, args: readonly string[]) => {
      await writeFile(args[args.indexOf("-o") + 1]!, benignTrace());
      const marker = args.find((arg) => arg.startsWith("/tmp/ablation-containment-marker-"))!;
      await writeFile(marker, "leaked");
      return { stdout: JSON.stringify(good), stderr: "" };
    };
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: leaking, home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
  });

  it("refuses when the probe's own log shows egress that cannot be audited, and accepts the name-resolution socket", async () => {
    const withTrace = (extra: string) => async (_file: string, args: readonly string[]) => {
      await writeFile(args[args.indexOf("-o") + 1]!, benignTrace() + extra);
      return { stdout: JSON.stringify(good), stderr: "" };
    };
    const resolver = { ...EMPTY_PLAN, runReadOnly: ["/run/systemd/resolve"] };
    await expect(containmentSelfTest(TOOLS, resolver, { run: withTrace('4242 connect(5<socket:[1]>, {sa_family=AF_UNIX, sun_path=@"x"}, 20) = 0\n'), home: "/home/x", uid: 1000 })).rejects.toThrow("containment_failed");
    await containmentSelfTest(TOOLS, resolver, { run: withTrace('4242 connect(5<socket:[1]>, {sa_family=AF_UNIX, sun_path="/run/systemd/resolve/io.systemd.Resolve"}, 42) = 0\n'), home: "/home/x", uid: 1000 });
  });

  it("refuses when the sandbox does not start or prints garbage, and passes on the expected result through the production command", async () => {
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: async () => { throw Object.assign(new Error("helper_failed"), { code: 1 }); } })).rejects.toThrow("containment_failed");
    await expect(containmentSelfTest(TOOLS, EMPTY_PLAN, { run: async () => ({ stdout: "not json", stderr: "" }) })).rejects.toThrow("containment_failed");
    const seen: string[][] = [];
    const inner = probe(good);
    await containmentSelfTest(TOOLS, plan, { run: async (file, args) => { seen.push([file, ...args]); return inner(file, args); }, home: "/home/x", uid: 4242 });
    // The production shape: prlimit, then strace, then bubblewrap with the plan and the oracle-home bind.
    expect(seen[0]!.slice(0, 4)).toEqual([TOOLS.prlimit, CORE_LIMIT, "--", TOOLS.strace]);
    expect(seen[0]).toContain(TOOLS.bwrap);
    expect(seen[0]).toContain("--remount-ro");
    expect(seen[0]).toContain("/home/x");
    expect(seen[0]).toContain("4242");
    expect(seen[0]!.filter((arg) => arg === "--bind")).toHaveLength(2);
  });

  it("makes the wave refuse to start when the containment check fails, before anything exists", async () => {
    const s = await waveSetup(1);
    const { deps, captured } = s.deps([text()], { containmentCheck: async () => { throw new Error("containment_failed"); } });
    await expect(runWave(s.input, deps)).rejects.toThrow("containment_failed");
    expect(captured).toHaveLength(0);
    expect(existsSync(s.waveDir)).toBe(false);
  });

  it.skipIf(!hasBwrap || !hasCodegraph)("really contains: the real self-test passes through the production shape; $HOME, host sockets, /mnt and the rest of the host root are sealed; /tmp is private; the scope may sit below /tmp or $HOME; the sandbox dies with its leader", async () => {
    const real = { bwrap: onPath("bwrap"), strace: onPath("strace"), prlimit: onPath("prlimit"), git: onPath("git"), codegraph: codegraphPath };
    const realPlan = await planSandbox({ tools: real, repoRoot: process.cwd(), buildRoot: BUILD_ROOT });
    await containmentSelfTest(real, realPlan);
    const run = (scope: string, script: string) => runHelper(real.bwrap, sandboxed(real, realPlan, scope, ["sh", "-c", script]).slice(1));
    // Below /tmp.
    const scope = await temporaryRoot("ablation-real-bwrap-");
    const marker = `.ablation-contain-${process.pid}`;
    await expect(run(scope, `echo x > "${homedir()}/${marker}"`)).rejects.toThrow();
    expect(existsSync(join(homedir(), marker))).toBe(false);
    await run(scope, `echo ok > "${scope}/inside" && test -d /run && test ! -e /run/docker.sock && test ! -e /run/dbus && test ! -e "${homedir()}/.ssh"`);
    // R51: nothing of the host root outside the allowlist exists, the root itself cannot be written, and the etc entries are the allowlisted ones.
    await run(scope, `${ABSENT_PATHS.map((path) => `test ! -e ${path}`).join(" && ")} && test ! -e /var/run && test ! -e /var/lib && ! (touch /root-probe) 2>/dev/null && test -e /etc/hosts && test ! -e /etc/shadow`);
    expect(await readFile(join(scope, "inside"), "utf8")).toBe("ok\n");
    // Below the (hidden, read-only) home: the writable bind still works and is the only writable thing there.
    const homeScope = join(homedir(), `.ablation-scope-test-${process.pid}`);
    await mkdir(homeScope);
    try {
      await run(homeScope, `echo ok > "${homeScope}/inside" && ! (echo x > "${homedir()}/${marker}") 2>/dev/null`);
      expect(await readFile(join(homeScope, "inside"), "utf8")).toBe("ok\n");
      expect(existsSync(join(homedir(), marker))).toBe(false);
    } finally { await rm(homeScope, { recursive: true, force: true }); }
    // A background child does not survive the death of its leader: kill the process group like the supervisor does.
    const duration = String(40000 + (process.pid % 1000));
    const child = spawn(real.bwrap, sandboxed(real, realPlan, scope, ["sh", "-c", `sleep ${duration} & sleep ${duration}`]).slice(1), { detached: true, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const alive = async () => (await exec("ps", ["-eo", "args"])).stdout.split("\n").filter((line) => line.trim() === `sleep ${duration}`).length;
    expect(await alive()).toBeGreaterThan(0);
    process.kill(-child.pid!, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await alive()).toBe(0);
  }, 60_000);
});

describe("pinned wave directories (item 3)", () => {
  it("removes nothing when private was swapped for a symlink, and the victim survives", async () => {
    const s = await waveSetup(2);
    const victimParent = join(s.root, "victim-parent");
    mkdirSync(join(victimParent, s.runs[0]!.runId), { recursive: true });
    writeFileSync(join(victimParent, s.runs[0]!.runId, "precious.txt"), "x");
    const { spawnRun } = fake([text()], s.root);
    const swapping = (scope: RunScope, runInput: string, log: string): ChildProcess => {
      renameSync(join(s.waveDir, "private"), join(s.waveDir, "private-moved"));
      symlinkSync(victimParent, join(s.waveDir, "private"));
      return spawnRun(scope, runInput, log);
    };
    const r = await runWave(s.input, { ...baseDeps(), spawnRun: swapping });
    expect(r.records[0]).toMatchObject({ outcome: "stopped", stopReason: "harness_failure", harnessError: "wave_dir_tampered" });
    expect(r.records[1]!.outcome).toBe("not_run");
    expect(existsSync(join(victimParent, s.runs[0]!.runId, "precious.txt"))).toBe(true);
  });

  it("detects a swapped intermediate directory with the guard itself", async () => {
    const root = await temporaryRoot("ablation-dir-guard-");
    const guard = await WaveDirGuard.capture(join(root, "wave"));
    await guard.assertIntact();
    renameSync(join(root, "wave", "scopes"), join(root, "wave", "scopes-old"));
    await expect(guard.assertIntact()).rejects.toThrow("wave_dir_tampered");
    symlinkSync(join(root, "wave", "scopes-old"), join(root, "wave", "scopes"));
    await expect(guard.assertIntact()).rejects.toThrow("wave_dir_tampered");
  });
});

describe("canonical paths and wave directory scope (items 4 and 6)", () => {
  it("judges a path under a non-existent top-level directory by its own name", async () => {
    await expect(assertWaveDirOutsideSources("/ablation-nx-top/wave", ["/ablation-nx-top"])).rejects.toThrow("wave_dir_in_source");
    // The old slicing turned "/xablation-home" into "/ablation-home" and refused it wrongly.
    await expect(assertWaveDirOutsideSources("/xablation-nx-top/wave", ["/ablation-nx-top"])).resolves.toBeUndefined();
  });

  it("also refuses a wave directory inside the evaluation repository when it is not a configured workspace", async () => {
    const s = await waveSetup(1);
    const { deps, captured } = s.deps([text()]);
    await expect(runWave({ ...s.input, repoRoot: s.root }, deps)).rejects.toThrow("wave_dir_in_source");
    expect(captured).toHaveLength(0);
    const approval = approvalFor(s.input.tasks, s.runs);
    await expect(runPreflight({ approval, waveDir: s.waveDir, ledgerPath: s.input.ledgerPath, productionConfig, hostAuth: {}, repoRoot: s.root }, {
      hostCheck: async () => undefined, containmentCheck: async () => undefined, planSandbox: async () => EMPTY_PLAN, resolveTools: async () => TOOLS,
    })).rejects.toThrow("wave_dir_in_source");
  });
});
