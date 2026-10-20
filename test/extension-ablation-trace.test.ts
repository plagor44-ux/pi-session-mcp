import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { guardDiff, guardSnapshot } from "../eval/extensions/guard.js";
import { STRACE_ARGS, parseStraceLog, type TraceContext } from "../eval/extensions/trace.js";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";

afterAll(removeTemporaryRoots);

function ctx(o: { initialCwd?: string; allowed?: string[]; provider?: string[]; dns?: string[] }): TraceContext {
  return {
    rootPid: 100,
    initialCwd: o.initialCwd ?? "/scope/clone",
    allowedWriteRoots: o.allowed ?? ["/scope"],
    providerAddresses: new Set(o.provider ?? []),
    dnsAddresses: new Set(o.dns ?? []),
  };
}
const lines = (...l: string[]) => `${l.join("\n")}\n`;
const CWD = "/scope/clone";
const at = (cwd = CWD) => `AT_FDCWD<${cwd}>`;

describe("STRACE_ARGS", () => {
  it("keeps the brief's shape with the extended syscall set", () => {
    expect(STRACE_ARGS.slice(0, 3)).toEqual(["-f", "-qq", "-e"]);
    expect(STRACE_ARGS[4]).toBe("-y");
    expect(STRACE_ARGS).toHaveLength(5);
    const set = STRACE_ARGS[3]!.replace("trace=", "").split(",");
    for (const name of ["connect", "openat", "openat2", "rmdir", "fchmodat2", "fsetxattr", "mknodat", "utimensat", "clone3", "fchdir"]) expect(set).toContain(name);
  });
});

describe("write detection", () => {
  it("flags an absolute write outside the allowed roots", () => {
    const f = parseStraceLog(`100 openat(AT_FDCWD</clone>, "/home/u/repo/x", O_WRONLY|O_CREAT, 0644) = 3</home/u/repo/x>\n`, ctx({ allowed: ["/scope"] }));
    expect(f.outsideWrites).toEqual(["/home/u/repo/x"]);
  });

  it("resolves relative writes after chdir in a forked child", () => {
    const log = ["100 clone3({...}) = 101", "101 chdir(\"/elsewhere\") = 0", "101 openat(AT_FDCWD, \"x\", O_WRONLY|O_CREAT, 0644) = 3"].join("\n");
    expect(parseStraceLog(log, ctx({ initialCwd: "/scope/clone", allowed: ["/scope"] })).outsideWrites).toEqual(["/elsewhere/x"]);
  });

  it("counts a relative write of an untracked pid as unresolved", () => {
    expect(parseStraceLog(`555 openat(AT_FDCWD, "y", O_RDWR) = 3\n`, ctx({})).unresolvedWrites).toBe(1);
  });

  it("does not treat reads as writes", () => {
    const f = parseStraceLog(lines(`100 openat(${at()}, "/etc/hosts", O_RDONLY|O_CLOEXEC) = 3</etc/hosts>`), ctx({}));
    expect(f).toMatchObject({ outsideWrites: [], unresolvedWrites: 0, deniedWriteAttempts: 0 });
  });

  it("matches roots by path segment, not by string prefix", () => {
    const f = parseStraceLog(lines(
      `100 openat(${at()}, "/scope-evil/x", O_WRONLY|O_CREAT, 0644) = 3</scope-evil/x>`,
      `100 openat(${at()}, "/scope/ok", O_WRONLY|O_CREAT, 0644) = 4</scope/ok>`,
      `100 mkdir("/scope", 0755) = -1 EEXIST (Die Datei existiert bereits)`,
    ), ctx({ allowed: ["/scope"] }));
    expect(f.outsideWrites).toEqual(["/scope-evil/x"]);
  });

  it("normalizes dot segments lexically", () => {
    const f = parseStraceLog(lines(
      `100 openat(${at()}, "../../etc/passwd", O_WRONLY, 0) = 3</etc/passwd>`,
      `100 openat(${at()}, "./sub/../keep", O_WRONLY|O_CREAT, 0644) = 4</scope/clone/keep>`,
      `100 openat(${at()}, "/scope/../tmp/x", O_RDWR) = 5</tmp/x>`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/etc/passwd", "/tmp/x"]);
  });

  it("allows the null device, terminals and /proc/self", () => {
    const f = parseStraceLog(lines(
      `100 openat(${at()}, "/dev/null", O_WRONLY) = 3</dev/null>`,
      `100 openat(${at()}, "/dev/tty", O_RDWR|O_NOCTTY) = 4</dev/tty>`,
      `100 openat(${at()}, "/dev/pts/3", O_RDWR) = 5</dev/pts/3>`,
      `100 openat(${at()}, "/proc/self/oom_score_adj", O_WRONLY) = 6</proc/100/oom_score_adj>`,
      `100 openat(${at()}, "/dev/shm/x", O_WRONLY|O_CREAT, 0600) = 7</dev/shm/x>`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/dev/shm/x"]);
  });

  it("uses the dirfd annotation of a real directory fd before the tracked cwd", () => {
    const f = parseStraceLog(lines(`100 openat(7</etc/conf.d>, "new", O_WRONLY|O_CREAT, 0644) = 8</etc/conf.d/new>`), ctx({}));
    expect(f.outsideWrites).toEqual(["/etc/conf.d/new"]);
  });

  it("counts a relative write against an unannotated dirfd as unresolved", () => {
    const f = parseStraceLog(lines(`100 openat(7, "new", O_WRONLY|O_CREAT, 0644) = 8`), ctx({}));
    expect(f).toMatchObject({ unresolvedWrites: 1, outsideWrites: [] });
  });

  it("falls back to the tracked cwd for a bare AT_FDCWD and prefers the annotated one", () => {
    const f = parseStraceLog(lines(
      `100 openat(AT_FDCWD, "a", O_WRONLY|O_CREAT, 0644) = 3`,
      `100 openat(AT_FDCWD</other>, "b", O_WRONLY|O_CREAT, 0644) = 4</other/b>`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/other/b"]);
  });

  it("tracks relative chdir and fchdir per pid", () => {
    const f = parseStraceLog(lines(
      `100 chdir("sub") = 0`,
      `100 openat(AT_FDCWD, "a", O_WRONLY|O_CREAT, 0644) = 3`,
      `100 fchdir(9</var/lib>) = 0`,
      `100 openat(AT_FDCWD, "b", O_WRONLY|O_CREAT, 0644) = 3`,
      `100 chdir("/nonexistent") = -1 ENOENT (Datei oder Verzeichnis nicht gefunden)`,
      `100 openat(AT_FDCWD, "c", O_WRONLY|O_CREAT, 0644) = 3`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/var/lib/b", "/var/lib/c"]);
  });

  it("inherits the cwd of the parent at clone return for fork and vfork", () => {
    const f = parseStraceLog(lines(
      `100 chdir("/work") = 0`,
      `100 vfork() = 102`,
      `102 creat("c", 0644) = 3`,
      `100 fork() = 103`,
      `103 mkdir("d", 0755) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/work/c", "/work/d"]);
  });

  it("does not hand a cwd to the child of a failed clone", () => {
    const f = parseStraceLog(lines(`100 clone3({...}, 88) = -1 EAGAIN (Ressource zur Zeit nicht verfügbar)`, `104 creat("c", 0644) = 3`), ctx({}));
    expect(f.unresolvedWrites).toBe(1);
  });

  it("accepts the [pid N] prefix", () => {
    const f = parseStraceLog(`[pid   100] creat("/etc/x", 0644) = 3</etc/x>\n`, ctx({}));
    expect(f.outsideWrites).toEqual(["/etc/x"]);
  });

  it("unescapes quoted paths", () => {
    const f = parseStraceLog(lines(`100 creat("/etc/a\\"b\\n\\303\\244", 0644) = 3</etc/x>`), ctx({}));
    expect(f.outsideWrites).toEqual(["/etc/a\"b\nä"]);
  });

  it("deduplicates repeated outside paths", () => {
    const l = `100 creat("/etc/x", 0644) = 3</etc/x>`;
    expect(parseStraceLog(lines(l, l), ctx({})).outsideWrites).toEqual(["/etc/x"]);
  });
});

describe("failed and in-progress calls", () => {
  it("reports a failed outside write only as a denied attempt", () => {
    const f = parseStraceLog(lines(
      `100 openat(${at()}, "/etc/shadow", O_WRONLY|O_CREAT, 0644) = -1 EACCES (Keine Berechtigung)`,
      `100 openat(${at()}, "/scope/fine", O_WRONLY|O_CREAT, 0644) = -1 ENOENT (Datei oder Verzeichnis nicht gefunden)`,
    ), ctx({}));
    expect(f).toMatchObject({ outsideWrites: [], deniedWriteAttempts: 1, unresolvedWrites: 0 });
  });

  it("counts an unfinished call that never resumed as a write", () => {
    const f = parseStraceLog(lines(`100 openat(${at()}, "/etc/fifo", O_WRONLY <unfinished ...>`), ctx({}));
    expect(f.outsideWrites).toEqual(["/etc/fifo"]);
  });

  it("counts a call whose return is unknown as in progress", () => {
    expect(parseStraceLog(lines(`100 creat("/etc/x", 0644) = ?`), ctx({})).outsideWrites).toEqual(["/etc/x"]);
  });

  it("joins unfinished and resumed halves per pid, interleaved with other pids", () => {
    const f = parseStraceLog(lines(
      `200 openat(${at("/work")}, "pf", O_WRONLY <unfinished ...>`,
      `201 openat(${at("/work")}, "other", O_RDONLY) = 3</work/other>`,
      `200 <... openat resumed>) = 3</work/pf>`,
      `202 openat(${at("/work")}, "late", O_RDONLY <unfinished ...>`,
      `202 <... openat resumed>, 0644) = -1 EACCES (Keine Berechtigung)`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/work/pf"]);
  });

  it("applies the flags that arrive in the resumed half", () => {
    const f = parseStraceLog(lines(
      `100 openat(${at()}, "/etc/x", O_RDONLY <unfinished ...>`,
      `100 <... openat resumed>) = 3</etc/x>`,
      `101 openat(${at()}, "/etc/y", O_WRONLY|O_CREAT <unfinished ...>`,
      `101 <... openat resumed>, 0644) = 4</etc/y>`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/etc/y"]);
  });

  it("assigns the child's cwd when an unfinished clone resumes", () => {
    const f = parseStraceLog(lines(
      `100 chdir("/work") = 0`,
      `100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f0 <unfinished ...>`,
      `100 <... clone resumed>) = 105`,
      `105 creat("c", 0644) = 3`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/work/c"]);
  });

  it("ignores signal, exit and unrelated lines", () => {
    const f = parseStraceLog(lines(
      `100 --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_EXITED, si_pid=101, si_uid=1000, si_status=0, si_utime=0, si_stime=0} ---`,
      `101 +++ exited with 0 +++`,
      ``,
      `garbage`,
    ), ctx({}));
    expect(f).toEqual({ outsideWrites: [], unresolvedWrites: 0, deniedWriteAttempts: 0, unexpectedConnects: [], connects: 0 });
  });
});

describe("write syscalls (real strace output shapes)", () => {
  const outside = (line: string) => parseStraceLog(lines(line), ctx({})).outsideWrites;

  it.each([
    [`100 creat("/etc/c", 0644) = 3</etc/c>`, ["/etc/c"]],
    [`100 open("/etc/o", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3</etc/o>`, ["/etc/o"]],
    [`100 open("/etc/o", O_RDONLY) = 3</etc/o>`, []],
    [`100 openat(${at()}, "/etc/t", O_RDONLY|O_TRUNC) = 3</etc/t>`, ["/etc/t"]],
    [`100 openat(${at()}, "/etc/t", O_RDWR|O_TMPFILE, 0600) = 3</etc/t>`, ["/etc/t"]],
    [`100 openat2(${at()}, "/etc/o2", {flags=O_RDWR|O_CREAT, mode=0600, resolve=0}, 24) = 3</etc/o2>`, ["/etc/o2"]],
    [`100 openat2(${at()}, "/etc/o2", {flags=O_RDONLY, resolve=0}, 24) = 3</etc/o2>`, []],
    [`100 mkdir("/etc/d", 0777) = 0`, ["/etc/d"]],
    [`100 mkdirat(${at()}, "/etc/d", 0777) = 0`, ["/etc/d"]],
    [`100 rmdir("/etc/d") = 0`, ["/etc/d"]],
    [`100 unlink("/etc/u") = 0`, ["/etc/u"]],
    [`100 unlinkat(${at()}, "/etc/u", AT_REMOVEDIR) = 0`, ["/etc/u"]],
    [`100 truncate("/etc/tr", 0) = 0`, ["/etc/tr"]],
    [`100 chmod("/etc/m", 0600) = 0`, ["/etc/m"]],
    [`100 fchmodat(${at()}, "/etc/m", 0600) = 0`, ["/etc/m"]],
    [`100 fchmodat2(${at()}, "/etc/m", 0640, 0) = 0`, ["/etc/m"]],
    [`100 chown("/etc/ch", -1, -1) = 0`, ["/etc/ch"]],
    [`100 lchown("/etc/ch", -1, -1) = 0`, ["/etc/ch"]],
    [`100 fchownat(${at()}, "/etc/ch", 1000, 1000, 0) = 0`, ["/etc/ch"]],
    [`100 utimes("/etc/ut", NULL) = 0`, ["/etc/ut"]],
    [`100 utimensat(${at()}, "/etc/ut", NULL, 0) = 0`, ["/etc/ut"]],
    [`100 setxattr("/etc/x", "user.a", "1", 1, 0) = 0`, ["/etc/x"]],
    [`100 lsetxattr("/etc/x", "user.a", "1", 1, 0) = 0`, ["/etc/x"]],
    [`100 removexattr("/etc/x", "user.a") = 0`, ["/etc/x"]],
    [`100 lremovexattr("/etc/x", "user.a") = 0`, ["/etc/x"]],
    [`100 mknod("/etc/n", S_IFIFO|0666) = 0`, ["/etc/n"]],
    [`100 mknodat(${at()}, "/etc/n", S_IFIFO|0666) = 0`, ["/etc/n"]],
  ])("%s", (line, expected) => {
    expect(outside(line)).toEqual(expected);
  });

  it("resolves a relative path against the annotated cwd for non-at calls too", () => {
    expect(parseStraceLog(lines(`100 chdir("/etc") = 0`, `100 rmdir("d") = 0`, `100 setxattr("f", "user.a", "1", 1, 0) = 0`), ctx({})).outsideWrites).toEqual(["/etc/d", "/etc/f"]);
  });

  it("uses the -y fd path for fd-based calls and counts bare fds as unresolved", () => {
    const f = parseStraceLog(lines(
      `100 fchmod(3</etc/f1>, 0600) = 0`,
      `100 fchown(4</scope/clone/ok>, 1000, 1000) = 0`,
      `100 fsetxattr(5</etc/f2>, "user.b", "1", 1, 0) = 0`,
      `100 fremovexattr(6</etc/f3>, "user.b") = 0`,
      `100 fchmod(7, 0600) = 0`,
      `100 fsetxattr(8<socket:[2406205]>, "user.b", "1", 1, 0) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/etc/f1", "/etc/f2", "/etc/f3"]);
    expect(f.unresolvedWrites).toBe(1);
  });

  it("handles futimens through utimensat with a NULL path", () => {
    const f = parseStraceLog(lines(
      `100 utimensat(0</etc/fd0>, NULL, NULL, 0) = 0`,
      `100 utimensat(3, NULL, NULL, 0) = 0`,
    ), ctx({}));
    expect(f).toMatchObject({ outsideWrites: ["/etc/fd0"], unresolvedWrites: 1 });
  });

  it("checks both paths of rename and link and only the link path of symlink", () => {
    const f = parseStraceLog(lines(
      `100 rename("/scope/a", "/etc/b") = 0`,
      `100 renameat2(${at()}, "x", ${at("/home/u")}, "y", RENAME_NOREPLACE) = 0`,
      `100 renameat(${at()}, "/etc/r1", ${at()}, "/etc/r2") = 0`,
      `100 link("/etc/l1", "/scope/l2") = 0`,
      `100 linkat(${at()}, "/etc/l3", ${at()}, "l4", 0) = 0`,
      `100 symlink("/etc/target", "/scope/link") = 0`,
      `100 symlinkat("/etc/target2", ${at()}, "/etc/link2") = 0`,
      `100 symlinkat("/etc/target3", ${at()}, "link3") = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/etc/b", "/home/u/y", "/etc/r1", "/etc/r2", "/etc/l1", "/etc/l3", "/etc/link2"]);
  });

  it("reports one unresolved write per call even when several paths are unresolved", () => {
    expect(parseStraceLog(lines(`999 rename("a", "b") = 0`), ctx({})).unresolvedWrites).toBe(1);
  });

  it("copes with annotations that contain commas and spaces", () => {
    const f = parseStraceLog(lines(`100 openat(5</etc/a, b/c d>, "x", O_WRONLY|O_CREAT, 0644) = 6</etc/a, b/c d/x>`), ctx({}));
    expect(f.outsideWrites).toEqual(["/etc/a, b/c d/x"]);
  });
});

describe("real strace sample", () => {
  // Captured with strace 7.2: bash -c 'cd w2dir; touch x; ...; (cd ..; echo hi > zz1) & (echo a > zz2) & wait'.
  const S = "/scratch/st";
  const sample = lines(
    `1000 chdir("${S}/w2dir") = 0`,
    `1000 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f059670ae50) = 1001`,
    `1001 openat(AT_FDCWD<${S}/w2dir>, "x", O_WRONLY|O_CREAT|O_NOCTTY|O_NONBLOCK, 0666) = 3<${S}/w2dir/x>`,
    `1001 utimensat(0<${S}/w2dir/x>, NULL, NULL, 0) = 0`,
    `1000 --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_EXITED, si_pid=1001, si_uid=1000, si_status=0, si_utime=0, si_stime=0} ---`,
    `1000 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f059670ae50) = 1002`,
    `1002 symlinkat("x", AT_FDCWD<${S}/w2dir>, "lnk") = 0`,
    `1000 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f059670ae50) = 1003`,
    `1003 linkat(AT_FDCWD<${S}/w2dir>, "x", AT_FDCWD<${S}/w2dir>, "hard", 0) = 0`,
    `1000 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f059670ae50) = 1004`,
    `1004 renameat2(AT_FDCWD<${S}/w2dir>, "x", AT_FDCWD<${S}/w2dir>, "y", RENAME_NOREPLACE) = 0`,
    `1000 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f059670ae50) = 1005`,
    `1000 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f059670ae50) = 1006`,
    `1005 chdir("${S}") = 0`,
    `1005 openat(AT_FDCWD<${S}>, "zz1", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3<${S}/zz1>`,
    `1006 openat(AT_FDCWD<${S}/w2dir>, "zz2", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3<${S}/w2dir/zz2>`,
    `1000 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f059670ae50) = 1007`,
    `1007 mknodat(AT_FDCWD<${S}/w2dir>, "ff", S_IFIFO|0666) = 0`,
  );

  it("classifies the whole log against the scratch root", () => {
    expect(parseStraceLog(sample, ctx({ initialCwd: S, allowed: [S] }))).toEqual({
      outsideWrites: [], unresolvedWrites: 0, deniedWriteAttempts: 0, unexpectedConnects: [], connects: 0,
    });
    expect(parseStraceLog(sample, ctx({ initialCwd: S, allowed: [`${S}/w2dir`] })).outsideWrites).toEqual([`${S}/zz1`]);
  });
});

describe("connections", () => {
  it("ignores reads, unix sockets and DNS; reports other inet destinations", () => {
    const log = ["100 openat(AT_FDCWD, \"/etc/hosts\", O_RDONLY|O_CLOEXEC) = 3", "100 connect(4, {sa_family=AF_UNIX, sun_path=\"/run/x\"}, 110) = 0",
      "100 connect(5, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr(\"127.0.0.53\")}, 16) = 0",
      "100 connect(6, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr(\"203.0.113.9\")}, 16) = -1 EINPROGRESS"].join("\n");
    const f = parseStraceLog(log, ctx({ provider: ["198.51.100.1"], dns: ["127.0.0.53"] }));
    expect(f.outsideWrites).toEqual([]);
    expect(f.unexpectedConnects).toEqual([{ family: "inet", address: "203.0.113.9", port: 443 }]);
  });

  it("counts inet connects regardless of return value and ignores netlink", () => {
    const f = parseStraceLog(lines(
      `100 connect(3<socket:[1]>, {sa_family=AF_NETLINK, nl_pid=0, nl_groups=00000000}, 12) = 0`,
      `100 connect(4<socket:[2]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("198.51.100.1")}, 16) = -1 EINPROGRESS (Die Operation läuft gerade)`,
      `100 connect(5<socket:[3]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("198.51.100.1")}, 16) = -1 ECONNREFUSED (Verbindungsaufbau abgelehnt)`,
    ), ctx({ provider: ["198.51.100.1"] }));
    expect(f).toMatchObject({ connects: 2, unexpectedConnects: [] });
  });

  it("takes DNS only on port 53 and provider addresses on any port", () => {
    const f = parseStraceLog(lines(
      `100 connect(4, {sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr("127.0.0.53")}, 16) = 0`,
      `100 connect(5, {sa_family=AF_INET, sin_port=htons(8443), sin_addr=inet_addr("198.51.100.1")}, 16) = 0`,
      `100 connect(6, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("198.51.100.77")}, 16) = 0`,
    ), ctx({ provider: ["198.51.100.1"], dns: ["127.0.0.53"] }));
    expect(f.unexpectedConnects).toEqual([
      { family: "inet", address: "127.0.0.53", port: 8080 },
      { family: "inet", address: "198.51.100.77", port: 53 },
    ]);
  });

  it("parses IPv6 destinations in the strace 7.2 format", () => {
    const line = `100 connect(4<socket:[2422217]>, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2001:db8::1", &sin6_addr), sin6_scope_id=0}, 28) = -1 EINPROGRESS (Die Operation läuft gerade)`;
    expect(parseStraceLog(lines(line), ctx({})).unexpectedConnects).toEqual([{ family: "inet6", address: "2001:db8::1", port: 443 }]);
    expect(parseStraceLog(lines(line), ctx({ provider: ["2001:db8::1"] })).unexpectedConnects).toEqual([]);
  });

  it("matches IPv4-mapped IPv6 addresses against IPv4 allow lists", () => {
    const line = `100 connect(4, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "::ffff:198.51.100.1", &sin6_addr), sin6_scope_id=0}, 28) = 0`;
    expect(parseStraceLog(lines(line), ctx({ provider: ["198.51.100.1"] })).unexpectedConnects).toEqual([]);
  });

  it("reads a connect from the joined unfinished and resumed halves", () => {
    const f = parseStraceLog(lines(
      `100 connect(5, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("203.0.113.9")}, 16 <unfinished ...>`,
      `100 <... connect resumed>) = 0`,
    ), ctx({}));
    expect(f).toMatchObject({ connects: 1, unexpectedConnects: [{ family: "inet", address: "203.0.113.9", port: 443 }] });
  });

  it("reports each distinct unexpected destination once", () => {
    const l = `100 connect(5, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("203.0.113.9")}, 16) = 0`;
    const f = parseStraceLog(lines(l, l), ctx({}));
    expect(f.connects).toBe(2);
    expect(f.unexpectedConnects).toHaveLength(1);
  });
});

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
      ".claude.json#mcpServers.pi-*", ".codex/config.toml#mcp_servers.pi-*", ".config/pi-session-mcp/pi-session-mcp.json",
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

  it("scopes the codex check to pi-* tables and their subtables", async () => {
    const home = await fakeHome();
    const base = await guardSnapshot(home);
    const toml = join(home, ".codex", "config.toml");
    const text = await readFile(toml, "utf8");
    await writeFile(toml, text.replace("command = \"o\"", "command = \"changed\"").replace("model = \"x\"", "model = \"z\""));
    expect(guardDiff(base, await guardSnapshot(home))).toEqual([]);
    await writeFile(toml, text.replace("K = \"v\"", "K = \"w\""));
    expect(guardDiff(base, await guardSnapshot(home))).toEqual([".codex/config.toml#mcp_servers.pi-*"]);
  });
});
