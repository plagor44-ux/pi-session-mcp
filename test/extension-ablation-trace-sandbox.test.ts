import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { guardDiff, guardSnapshot } from "../eval/extensions/guard.js";
import { parseStraceLog, type TraceContext } from "../eval/extensions/trace.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import { ctx, lines } from "./extension-ablation-trace-fixtures.js";

afterAll(removeTemporaryRoots);

describe("production guard", () => {
  async function fakeHome(): Promise<string> {
    const home = await temporaryRoot("guard-home-");
    await mkdir(join(home, ".config", "pi-session-mcp"), { recursive: true });
    await mkdir(join(home, ".pi", "agent", "npm", "node_modules", "pi-lens"), { recursive: true });
    await writeFile(join(home, ".config", "pi-session-mcp", "pi-session-mcp.json"), "{\"a\":1}");
    await writeFile(join(home, ".pi", "agent", "settings.json"), "{}");
    await writeFile(join(home, ".pi", "agent", "mcp.json"), "{}");
    await writeFile(join(home, ".pi", "agent", "npm", "node_modules", "pi-lens", "index.js"), "1");
    await writeFile(join(home, ".claude.json"), JSON.stringify({ numStartups: 1, mcpServers: { "pi-session": { command: "x", args: ["a"] }, other: { command: "y" } } }));
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), "model = \"x\"\n\n[mcp_servers.pi-session]\ncommand = \"pi\"\n\n[mcp_servers.pi-session.env]\nK = \"v\"\n\n[mcp_servers.other]\ncommand = \"o\"\n");
    return home;
  }

  it("guardDiff names changed targets only", () => {
    expect(guardDiff({ files: { a: "1", b: "2" } }, { files: { a: "1", b: "3" } })).toEqual(["b"]);
  });

  it("guardDiff reports keys that appear or disappear", () => {
    expect(guardDiff({ files: { a: "1", gone: "2" } }, { files: { a: "1", new: "3" } })).toEqual(["gone", "new"]);
  });

  it("hashes every target, stores no contents and is stable", async () => {
    const home = await fakeHome();
    const a = await guardSnapshot(home);
    expect(Object.keys(a.files).sort()).toEqual([
      ".claude.json#mcpServers.pi-*", ".codex/config.toml", ".config/pi-session-mcp/pi-session-mcp.json",
      ".pi/agent/mcp.json", ".pi/agent/npm", ".pi/agent/settings.json",
    ]);
    for (const value of Object.values(a.files)) expect(value).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(a)).not.toMatch(/command|pi-lens|numStartups/);
    expect(guardDiff(a, await guardSnapshot(home))).toEqual([]);
  });

  it("records absent files and directories as \"absent\"", async () => {
    const home = await temporaryRoot("guard-empty-");
    const snap = await guardSnapshot(home);
    expect(Object.values(snap.files).every((v) => v === "absent")).toBe(true);
    expect(Object.keys(snap.files)).toHaveLength(6);
  });

  it("detects a changed config file, an npm tree change and edits to pi-* entries only", async () => {
    const home = await fakeHome();
    const before = await guardSnapshot(home);

    await writeFile(join(home, ".pi", "agent", "settings.json"), "{\"x\":1}");
    expect(guardDiff(before, await guardSnapshot(home))).toEqual([".pi/agent/settings.json"]);

    await writeFile(join(home, ".pi", "agent", "npm", "node_modules", "pi-lens", "extra.js"), "2");
    expect(guardDiff(before, await guardSnapshot(home))).toContain(".pi/agent/npm");

    const claude = join(home, ".claude.json");
    const base = await guardSnapshot(home);
    await writeFile(claude, JSON.stringify({ numStartups: 99, mcpServers: { other: { command: "changed" }, "pi-session": { args: ["a"], command: "x" } } }));
    expect(guardDiff(base, await guardSnapshot(home))).toEqual([]);
    await writeFile(claude, JSON.stringify({ mcpServers: { "pi-session": { command: "x", args: ["b"] } } }));
    expect(guardDiff(base, await guardSnapshot(home))).toEqual([".claude.json#mcpServers.pi-*"]);
  });

  it("hashes the whole codex config so inline-table and dotted-key pi-* entries are covered", async () => {
    const home = await fakeHome();
    const base = await guardSnapshot(home);
    const toml = join(home, ".codex", "config.toml");
    const text = await readFile(toml, "utf8");
    for (const next of [
      `${text}\n[mcp_servers]\npi-extra = { command = "x" }\n`,
      `${text}\nmcp_servers.pi-dotted.command = "x"\n`,
      text.replace("model = \"x\"", "model = \"z\""),
    ]) {
      await writeFile(toml, next);
      expect(guardDiff(base, await guardSnapshot(home))).toEqual([".codex/config.toml"]);
    }
    await writeFile(toml, text);
    expect(guardDiff(base, await guardSnapshot(home))).toEqual([]);
  });
});

describe("window-born taint (R24)", () => {
  const TH = "flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD";
  const FORKHEAD = "clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f0 <unfinished ...>";
  const strict = ctx({ allowed: ["/scope/clone"] });
  const flagged = (...l: string[]) => {
    const f = parseStraceLog(lines(...l), strict);
    return f.outsideWrites.length + f.unresolvedWrites;
  };

  it("flags a cloned thread of a fork child that ran before its parent's clone return (X1)", () => {
    expect(flagged(
      "100 fork() = 200", `200 ${FORKHEAD}`,
      "201 chdir(\"/scope/clone\") = 0",
      `201 clone3({${TH}|CLONE_SYSVSEM|CLONE_SETTLS, exit_signal=0, stack=0x7f0, stack_size=0x100}, 88) = 202`,
      "200 <... clone resumed>) = 201",
      "201 chdir(\"/home/u\") = 0", "202 mkdir(\"x\", 0777) = 0",
    )).toBeGreaterThan(0);
  });

  it("flags the same thread when it was cloned through a pending head (X1b)", () => {
    expect(flagged(
      "100 fork() = 200", `200 ${FORKHEAD}`,
      "201 chdir(\"/scope/clone\") = 0",
      `201 clone3({${TH}, exit_signal=0}, 88 <unfinished ...>`, "202 openat(AT_FDCWD</scope/clone>, \"/dev/null\", O_RDONLY) = 3</dev/null>",
      "201 <... clone3 resumed>) = 202",
      "200 <... clone resumed>) = 201",
      "201 chdir(\"/home/u\") = 0", "202 mkdir(\"x\", 0777) = 0",
    )).toBeGreaterThan(0);
  });

  it("flags a thread cloned by an uncertain, window-born child (X2)", () => {
    expect(flagged(
      `100 clone(child_stack=0x7f0, ${TH}) = 300`, "100 fork() = 200", "200 chdir(\"/home/u\") = 0",
      "300 clone3({flags=CLONE_VM|CLONE_FS|CLONE_THREAD}, 88 <unfinished ...>", `200 ${FORKHEAD}`,
      "201 openat(AT_FDCWD</home/u>, \"/etc/ld.so.cache\", O_RDONLY|O_CLOEXEC) = 3</etc/ld.so.cache>",
      `201 clone3({${TH}, exit_signal=0}, 88) = 202`,
      "202 mkdir(\"x\", 0777) = 0",
      "200 <... clone resumed>) = 201", "300 <... clone3 resumed>) = 301",
    )).toBeGreaterThan(0);
  });

  it("flags a grandchild forked by an uncertain, window-born child (X2b)", () => {
    expect(flagged(
      `100 clone(child_stack=0x7f0, ${TH}) = 300`, "100 fork() = 200", "200 chdir(\"/home/u\") = 0",
      "300 clone3({flags=CLONE_VM|CLONE_FS|CLONE_THREAD}, 88 <unfinished ...>", `200 ${FORKHEAD}`,
      "201 openat(AT_FDCWD</home/u>, \"/etc/ld.so.cache\", O_RDONLY|O_CLOEXEC) = 3</etc/ld.so.cache>",
      "201 fork() = 202",
      "200 <... clone resumed>) = 201", "300 <... clone3 resumed>) = 301",
      "202 mkdir(\"x\", 0777) = 0",
    )).toBeGreaterThan(0);
  });

  it("flags a relative chdir and write of an uncertain, window-born child (X3)", () => {
    expect(flagged(
      "100 chdir(\"/scope/clone/a\") = 0", `100 clone(child_stack=0x7f0, ${TH}) = 300`,
      "100 fork() = 200", "200 chdir(\"/scope/clone\") = 0",
      "300 clone3({flags=CLONE_VM|CLONE_FS|CLONE_THREAD}, 88 <unfinished ...>", `200 ${FORKHEAD}`,
      "201 openat(AT_FDCWD</scope/clone>, \"/etc/ld.so.cache\", O_RDONLY|O_CLOEXEC) = 3</etc/ld.so.cache>",
      "201 chdir(\"..\") = 0",
      "200 <... clone resumed>) = 201", "300 <... clone3 resumed>) = 301",
      "201 mkdir(\"evil\", 0777) = 0",
    )).toBeGreaterThan(0);
  });

  it("leaves a child alone that only started after its parent's clone return", () => {
    expect(flagged(
      "100 chdir(\"/scope/clone/a\") = 0", `100 ${FORKHEAD}`, "100 <... clone resumed>) = 200",
      "200 chdir(\"/scope/clone/b\") = 0", "200 mkdir(\"x\", 0777) = 0",
    )).toBe(0);
  });

  it("does not carry the taint of an earlier, exited pid onto a reused pid with a normal start", () => {
    expect(flagged(
      "100 fork() = 200", "200 chdir(\"/scope/clone\") = 0", "200 +++ exited with 0 +++",
      "100 fork() = 200",
      "200 chdir(\"/scope/clone/b\") = 0", "200 mkdir(\"x\", 0777) = 0",
    )).toBe(0);
  });
});

describe("bubblewrap setup (R46)", () => {
  // A real capture of `prlimit … strace … bwrap … -- node -e <write a file in the scope>`.
  const capture = () => readFile(fileURLToPath(new URL("./fixtures/extension-ablation/bwrap-sandboxed.strace", import.meta.url)), "utf8");
  const context = (extra: Partial<TraceContext> = {}): TraceContext => ({ ...ctx({ initialCwd: "/scope", allowed: ["/scope"] }), rootPid: 0, allowedSocketRoots: ["/scope"], ...extra });

  it("judges only the workload: bwrap's namespace setup, mounts and newroot writes are not findings", async () => {
    const text = await capture();
    const rootPid = Number(/^(\d+)/.exec(text)![1]);
    const plain = parseStraceLog(text, context({ rootPid }));
    expect(plain.outsideWrites.length).toBeGreaterThan(0);
    const sandboxed = parseStraceLog(text, context({ rootPid, sandboxed: true }));
    expect(sandboxed).toMatchObject({ outsideWrites: [], unresolvedWrites: 0, deniedWriteAttempts: 0, unresolvedEgress: 0 });
  });

  it("still judges the workload's own writes, sockets and relative paths", async () => {
    const text = await capture();
    const rootPid = Number(/^(\d+)/.exec(text)![1]);
    const workload = Number([...text.matchAll(/^(\d+) clone\(child_stack=NULL, flags=CLONE_CHILD_CLEARTID[^\n]*= \d+$/gm)].at(-1)![0].split(" ")[0]) + 1;
    const extra = [
      `${workload} openat(AT_FDCWD</scope>, "/home/u/x", O_WRONLY|O_CREAT, 0644) = 3</home/u/x>`,
      `${workload} connect(3<socket:[1]>, {sa_family=AF_UNIX, sun_path="/run/user/1000/bus"}, 21) = 0`,
    ].join("\n");
    const f = parseStraceLog(`${text}${extra}\n`, context({ rootPid, sandboxed: true }));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
    expect(f.unresolvedEgress).toBe(1);
  });

  it("does not mute anything without the flag, and mutes mounts of the root pid only when sandboxed", () => {
    const log = lines("100 mount(\"none\", \"/\", NULL, MS_REC|MS_PRIVATE, NULL) = 0", "100 openat(AT_FDCWD</scope>, \"newroot\", O_WRONLY|O_CREAT, 0644) = 3</newroot>");
    expect(parseStraceLog(log, context({ rootPid: 100 })).unresolvedWrites).toBeGreaterThan(0);
    expect(parseStraceLog(log, context({ rootPid: 100, sandboxed: true }))).toMatchObject({ unresolvedWrites: 0, outsideWrites: [] });
  });
});

describe("PID namespace decoding and sandbox-private mounts (R49b, M2)", () => {
  const fileOps = () => readFile(fileURLToPath(new URL("./fixtures/extension-ablation/bwrap-pidns-fileops.strace", import.meta.url)), "utf8");
  const context = (rootPid: number, extra: Partial<TraceContext> = {}): TraceContext =>
    ({ ...ctx({ initialCwd: "/scope", allowed: ["/scope"] }), rootPid, allowedSocketRoots: ["/scope"], sandboxed: true, ...extra });

  it("reads the decoded pid of a clone return, so benign relative writes in the scope stay clean", async () => {
    // A real capture through prlimit, strace --decode-pids=pidns and bwrap: a shell does mkdir, redirect, rename, unlink, rmdir by relative paths.
    const text = await fileOps();
    expect(text).toMatch(/= \d+ \/\* \d+ in strace's PID NS \*\//);
    const rootPid = Number(/^(\d+)/.exec(text)![1]);
    expect(parseStraceLog(text, context(rootPid))).toMatchObject({ outsideWrites: [], unresolvedWrites: 0, deniedWriteAttempts: 0, unresolvedEgress: 0 });
  });

  it("would not have worked on the undecoded value: the namespace pid is not a pid of the log", async () => {
    const text = (await fileOps()).replace(/ \/\* \d+ in strace's PID NS \*\//g, "");
    const rootPid = Number(/^(\d+)/.exec(text)![1]);
    expect(parseStraceLog(text, context(rootPid)).unresolvedWrites).toBeGreaterThan(0);
  });

  it("decodes the value in resumed halves and ignores a comment on other calls", () => {
    const log = lines(
      "100 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "100 <... clone resumed>) = 2 /* 200 in strace's PID NS */",
      "200 chdir(\"/scope/sub\") = 0",
      "200 mkdir(\"x\", 0777) = 0",
    );
    expect(parseStraceLog(log, ctx({ initialCwd: "/scope", allowed: ["/scope"] }))).toMatchObject({ outsideWrites: [], unresolvedWrites: 0 });
    const outside = lines(
      "100 clone(child_stack=NULL, flags=SIGCHLD) = 2 /* 200 in strace's PID NS */",
      "200 chdir(\"/etc\") = 0",
      "200 mkdir(\"x\", 0777) = 0",
    );
    expect(parseStraceLog(outside, ctx({ initialCwd: "/scope", allowed: ["/scope"] })).outsideWrites).toEqual(["/etc/x"]);
  });

  it("counts /tmp, /var/tmp, /dev/shm and /run as private only in a sandboxed parse", () => {
    const log = lines(
      "100 openat(AT_FDCWD</scope>, \"/dev/shm/x\", O_WRONLY|O_CREAT, 0600) = 3</dev/shm/x>",
      "100 openat(AT_FDCWD</scope>, \"/tmp/y\", O_WRONLY|O_CREAT, 0600) = 4</tmp/y>",
      "100 mkdir(\"/run/z\", 0755) = 0",
      "100 openat(AT_FDCWD</scope>, \"/var/tmp/w\", O_WRONLY|O_CREAT, 0600) = 5</var/tmp/w>",
      "100 openat(AT_FDCWD</scope>, \"/var/lib/w\", O_WRONLY|O_CREAT, 0600) = 6</var/lib/w>",
    );
    const plain = parseStraceLog(log, ctx({ initialCwd: "/scope", allowed: ["/scope"] }));
    expect(plain.outsideWrites).toEqual(["/dev/shm/x", "/tmp/y", "/run/z", "/var/tmp/w", "/var/lib/w"]);
    // The root pid is bwrap itself (muted); pid 100 stands for the workload.
    const sandboxed = parseStraceLog(log, { ...ctx({ initialCwd: "/scope", allowed: ["/scope"] }), rootPid: 99, sandboxed: true });
    expect(sandboxed.outsideWrites).toEqual(["/var/lib/w"]);
  });
});

describe("evidence lines (R84)", () => {
  const find = (text: string, o: Parameters<typeof ctx>[0] = {}) => parseStraceLog(text, ctx(o));
  const abstractConnect = `100 connect(3<socket:[9]>, {sa_family=AF_UNIX, sun_path=@"/tmp/.X11-unix/X0"}, 20) = 0`;
  const outsideWrite = `100 openat(AT_FDCWD</scope/clone>, "/home/u/x", O_WRONLY|O_CREAT, 0644) = 3</home/u/x>`;
  const benign = `100 openat(AT_FDCWD</scope/clone>, "/scope/clone/a", O_WRONLY|O_CREAT, 0644) = 3</scope/clone/a>`;

  it("keeps the raw line of an abstract-socket connect, an outside write and a successful io_uring_setup", () => {
    const ring = `100 io_uring_setup(4, {flags=0, sq_thread_cpu=0, sq_thread_idle=0}) = 5<anon_inode:[io_uring]>`;
    const found = find(lines(benign, abstractConnect, outsideWrite, ring));
    expect(found.unresolvedEgress).toBe(2);
    expect(found.outsideWrites).toEqual(["/home/u/x"]);
    expect(found.evidenceLines).toEqual([abstractConnect, outsideWrite, ring]);
  });

  it("keeps both lines of a joined unfinished and resumed call, and the head of a call that never resumed", () => {
    const head = `100 sendmsg(3<socket:[9]>, {msg_name={sa_family=AF_UNIX, sun_path=@"x"}, msg_namelen=4}, 0 <unfinished ...>`;
    const resumed = `100 <... sendmsg resumed>) = 5`;
    expect(find(lines(head, `101 openat(AT_FDCWD</scope/clone>, "/scope/clone/a", O_WRONLY) = 3</scope/clone/a>`, resumed)).evidenceLines).toEqual([`${head}\n${resumed}`]);
    expect(find(lines(head)).evidenceLines).toEqual([head]);
  });

  it("keeps the resumed line of a call whose head is missing (a headless resumed sendmsg)", () => {
    const headless = `100 <... sendmsg resumed>) = 5`;
    const found = find(lines(headless));
    expect(found.unresolvedEgress).toBe(1);
    expect(found.evidenceLines).toEqual([headless]);
  });

  it("keeps the line of an unresolved write, and of a headless resumed write", () => {
    const relative = `777 openat(AT_FDCWD, "y", O_RDWR) = 3`;
    expect(find(lines(relative))).toMatchObject({ unresolvedWrites: 1, evidenceLines: [relative] });
    const headless = `200 <... openat resumed>) = 3`;
    expect(find(lines(benign, headless))).toMatchObject({ unresolvedWrites: 1, evidenceLines: [headless] });
  });

  it("keeps nothing for a clean log and for a refused write, and at most 50 entries", () => {
    expect(find(lines(benign, `100 openat(AT_FDCWD</scope/clone>, "/home/u/x", O_WRONLY) = -1 EACCES (Permission denied)`)).evidenceLines).toEqual([]);
    const many = find(lines(...Array.from({ length: 80 }, (_, i) => `100 openat(AT_FDCWD</scope/clone>, "/home/u/${i}", O_WRONLY|O_CREAT, 0644) = 3</home/u/${i}>`)));
    expect(many.outsideWrites).toHaveLength(80);
    expect(many.evidenceLines).toHaveLength(50);
  });
});
