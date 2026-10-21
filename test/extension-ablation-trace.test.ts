import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
    expect(STRACE_ARGS.slice(0, 3)).toEqual(["-f", "-q", "-e"]);
    expect(STRACE_ARGS[4]).toBe("-y");
    // R36: strace makes every io_uring_setup fail, so libuv falls back to its thread pool.
    expect(STRACE_ARGS.slice(5)).toEqual(["-e", "inject=io_uring_setup:error=ENOSYS", "--decode-pids=pidns"]);
    expect(STRACE_ARGS).toHaveLength(8);
    const set = STRACE_ARGS[3]!.replace("trace=", "").split(",");
    for (const name of ["connect", "openat", "openat2", "rmdir", "fchmodat2", "fsetxattr", "mknodat", "utimensat", "clone3", "fchdir", "sendto", "sendmsg", "sendmmsg", "io_uring_setup", "chroot", "pivot_root", "setns", "unshare", "mount", "open_tree", "move_mount", "fsopen", "fsmount", "fsconfig", "mount_setattr", "umount2"]) expect(set).toContain(name);
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

  it("allows only the null device, the controlling terminal and numbered ptys", () => {
    const f = parseStraceLog(lines(
      `100 openat(${at()}, "/dev/null", O_WRONLY) = 3</dev/null>`,
      `100 openat(${at()}, "/dev/tty", O_RDWR|O_NOCTTY) = 4</dev/tty>`,
      `100 openat(${at()}, "/dev/pts/3", O_RDWR) = 5</dev/pts/3>`,
      `100 openat(${at()}, "/dev/pts/ptmx", O_RDWR) = 6</dev/pts/ptmx>`,
      `100 openat(${at()}, "/dev/shm/x", O_WRONLY|O_CREAT, 0600) = 7</dev/shm/x>`,
      `100 openat(${at()}, "/proc/self/oom_score_adj", O_WRONLY) = 8</proc/100/oom_score_adj>`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/dev/pts/ptmx", "/dev/shm/x", "/proc/self/oom_score_adj", "/proc/100/oom_score_adj"]);
  });

  it("does not exempt /proc/self magic links", () => {
    const f = parseStraceLog(lines(
      `100 openat(${at()}, "/proc/self/root/home/u/.bashrc", O_WRONLY|O_APPEND) = 3</home/u/.bashrc>`,
      `100 openat(${at()}, "/proc/self/fd/7", O_WRONLY|O_TRUNC) = 4</home/u/other>`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/proc/self/root/home/u/.bashrc", "/home/u/.bashrc", "/proc/self/fd/7", "/home/u/other"]);
    const lexical = parseStraceLog(lines(`100 openat(${at()}, "/proc/self/root/home/u/.bashrc", O_WRONLY) = -1 EACCES (Keine Berechtigung)`), ctx({}));
    expect(lexical).toMatchObject({ outsideWrites: [], deniedWriteAttempts: 1 });
    expect(parseStraceLog(lines(`100 openat(${at()}, "/proc/self/fd/7", O_WRONLY <unfinished ...>`), ctx({})).outsideWrites).toEqual(["/proc/self/fd/7"]);
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
    const f = parseStraceLog(lines(`100 creat("/etc/a\\"b\\n\\303\\244", 0644) = 3`), ctx({}));
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
    expect(f).toEqual({ outsideWrites: [], unresolvedWrites: 0, deniedWriteAttempts: 0, unexpectedConnects: [], connects: 0, unresolvedEgress: 0, evidenceLines: [] });
  });
});

describe("cwd inheritance races (strace -f orders the child before the parent's return)", () => {
  it("keeps a child's chdir made before the parent's vfork return", () => {
    const f = parseStraceLog(lines(
      `100 vfork( <unfinished ...>`,
      `101 chdir("/home/u") = 0`,
      `100 <... vfork resumed>) = 101`,
      `101 mkdir("x", 0777) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("keeps a subshell's chdir made before the parent's clone return", () => {
    const f = parseStraceLog(lines(
      `100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f059670ae50 <unfinished ...>`,
      `101 chdir("/home/u") = 0`,
      `100 <... clone resumed>) = 101`,
      `101 mkdir("x", 0777) = 0`,
      `100 mkdir("y", 0777) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("leaves a child unresolved that writes relatively before any cwd is known", () => {
    const f = parseStraceLog(lines(
      `100 vfork( <unfinished ...>`,
      `101 mkdir("x", 0777) = 0`,
      `100 <... vfork resumed>) = 101`,
    ), ctx({}));
    expect(f).toMatchObject({ unresolvedWrites: 1, outsideWrites: [] });
  });

  it("forgets the cwd of an exited pid (exit lines exist because STRACE_ARGS uses -q, not -qq)", () => {
    const f = parseStraceLog(lines(`100 fork() = 101`, `101 +++ exited with 0 +++`, `101 creat("c", 0644) = 3`), ctx({}));
    expect(f.unresolvedWrites).toBe(1);
  });
});

describe("-q exit and signal lines", () => {
  // Captured with strace 7.2 -f -q -y.
  it("skips signal and exit lines and frees the exited pid's cwd", () => {
    const f = parseStraceLog(lines(
      `100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f38ad69de50) = 101`,
      `101 openat(AT_FDCWD</scope/clone>, "/dev/null", O_RDONLY) = 3</dev/null>`,
      `101 +++ killed by SIGKILL +++`,
      `100 --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_KILLED, si_pid=101, si_uid=1000, si_status=SIGKILL, si_utime=0, si_stime=0} ---`,
      `100 +++ exited with 0 +++`,
      `101 creat("late", 0644) = 3`,
    ), ctx({}));
    expect(f).toMatchObject({ outsideWrites: [], unresolvedWrites: 1 });
  });
});

describe("pid reuse and CLONE_FS siblings", () => {
  it("replaces a cell that predates the clone head (reused pid without exit line)", () => {
    const f = parseStraceLog(lines(
      `100 fork() = 101`,
      `100 chdir("/home/u") = 0`,
      `100 fork() = 101`,
      `101 mkdir("x", 0777) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("replaces a stale shared thread cell when the tid is reused by a fork", () => {
    const f = parseStraceLog(lines(
      `100 chdir("/home/u") = 0`,
      `100 clone3({flags=CLONE_VM|CLONE_FS|CLONE_THREAD, exit_signal=0}, 88) = 101`,
      `100 fork() = 101`,
      `100 chdir("/scope/clone") = 0`,
      `101 mkdir("x", 0777) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("keeps a cell created after the unfinished head even when the head is far above the return", () => {
    const f = parseStraceLog(lines(
      `100 fork( <unfinished ...>`,
      `200 openat(AT_FDCWD</scope/clone>, "/dev/null", O_RDONLY) = 3</dev/null>`,
      `101 chdir("/home/u") = 0`,
      `200 openat(AT_FDCWD</scope/clone>, "/dev/null", O_RDONLY) = 3</dev/null>`,
      `100 <... fork resumed>) = 101`,
      `101 mkdir("x", 0777) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("lets the later chdir of a CLONE_FS sibling win by line order", () => {
    const f = parseStraceLog(lines(
      `100 clone3({flags=CLONE_VM|CLONE_FS|CLONE_THREAD, exit_signal=0}, 88) = 102`,
      `100 clone(child_stack=0x7f0, flags=CLONE_VM|CLONE_FS|CLONE_THREAD <unfinished ...>`,
      `101 chdir("/scope/clone/sub") = 0`,
      `102 chdir("/home/u") = 0`,
      `100 <... clone resumed>) = 101`,
      `100 mkdir("x", 0777) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });
});

describe("unknown cwds fail closed", () => {
  it("keeps a CLONE_FS child's unknown cwd for both threads", () => {
    const f = parseStraceLog(lines(
      `100 clone(child_stack=0x7f0, flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD <unfinished ...>`,
      `101 chdir("../..") = 0`,
      `100 <... clone resumed>) = 101`,
      `101 mkdir("x", 0777) = 0`,
      `100 mkdir("y", 0777) = 0`,
    ), ctx({}));
    expect(f).toMatchObject({ unresolvedWrites: 2, outsideWrites: [] });
  });

  it("treats a clone3 with unreadable flags as a thread group with an unknown cwd", () => {
    const f = parseStraceLog(lines(`100 clone3(0x7ffc, 88) = 101`, `100 chdir("/home/u") = 0`, `101 mkdir("x", 0777) = 0`, `100 mkdir("y", 0777) = 0`), ctx({}));
    expect(f).toMatchObject({ unresolvedWrites: 2, outsideWrites: ["/home/u/x", "/home/u/y"] });
  });

  it("does not create a child for a failed clone3 with unreadable flags", () => {
    const f = parseStraceLog(lines(`100 clone3(0x7ffc, 88) = -1 EAGAIN (Ressource zur Zeit nicht verfügbar)`, `100 chdir("/home/u") = 0`, `100 mkdir("y", 0777) = 0`), ctx({}));
    expect(f).toMatchObject({ unresolvedWrites: 0, outsideWrites: ["/home/u/y"] });
  });

  it("still copies the cwd for fork and vfork, which have no flags to read", () => {
    const f = parseStraceLog(lines(`100 chdir("/home/u") = 0`, `100 fork() = 101`, `101 mkdir("x", 0777) = 0`), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("forgets the cwd after a headless resumed chdir or fchdir", () => {
    for (const name of ["chdir", "fchdir"]) {
      const f = parseStraceLog(lines(`100 <... ${name} resumed>) = 0`, `100 mkdir("x", 0777) = 0`), ctx({}));
      expect(f).toMatchObject({ unresolvedWrites: 1, outsideWrites: [] });
    }
  });
});

describe("candidate cwds (R20)", () => {
  const T = "flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD";
  const FIXTURES = fileURLToPath(new URL("./fixtures/extension-ablation/", import.meta.url));

  it("sees a CLONE_FS child that chdirs out and exits before the parent's clone return (real strace 7.2 shape)", () => {
    const f = parseStraceLog(lines(
      `100 clone(child_stack=0x563e6b9ba070, flags=CLONE_VM|CLONE_FS|SIGCHLD <unfinished ...>`,
      `101 chdir("/s/vfs2/out") = 0`,
      `101 +++ exited with 0 +++`,
      `100 <... clone resumed>)            = 101`,
      `100 mkdir("y50", 0777)              = 0`,
      `100 chdir("/scope/clone") = 0`,
      `100 clone(child_stack=0x563e6b9ba070, flags=CLONE_VM|CLONE_FS|SIGCHLD <unfinished ...>`,
      `102 chdir("/s/vfs2/out") = 0`,
      `102 +++ exited with 0 +++`,
      `100 <... clone resumed>)            = 102`,
      `100 mkdir("y51", 0777)              = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/s/vfs2/out/y50", "/s/vfs2/out/y51"]);
  });

  it("flags all 300 outside mkdirs of the full real capture (paths rewritten to /s)", async () => {
    const log = await readFile(join(FIXTURES, "clone-fs-chdir-exit.strace"), "utf8");
    const f = parseStraceLog(log, { rootPid: Number(log.split(" ")[0]), initialCwd: "/s/vfs2/clone", allowedWriteRoots: ["/s/vfs2/clone"], providerAddresses: new Set(), dnsAddresses: new Set() });
    expect(f.outsideWrites).toEqual(Array.from({ length: 300 }, (_, i) => `/s/vfs2/out/y${i}`));
    expect(f.unresolvedWrites).toBe(0);
  });

  it("reports unresolved when a relative chdir of an exited CLONE_FS child had no known base (P1b)", () => {
    const f = parseStraceLog(lines(
      `100 clone(child_stack=0x7f0, ${T} <unfinished ...>`,
      `101 chdir("../..") = 0`,
      `101 +++ exited with 0 +++`,
      `100 <... clone resumed>) = 101`,
      `100 mkdir("y", 0777) = 0`,
    ), ctx({}));
    expect(f.unresolvedWrites).toBe(1);
  });

  it("never judges a reused pid inside when an earlier incarnation exited before the return (P2)", () => {
    const f = parseStraceLog(lines(
      `200 chdir("/home/u") = 0`,
      `200 fork( <unfinished ...>`,
      `100 fork( <unfinished ...>`,
      `101 +++ exited with 0 +++`,
      `100 <... fork resumed>) = 101`,
      `101 mkdir("x", 0777) = 0`,
      `200 <... fork resumed>) = 101`,
      `101 mkdir("z", 0777) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toContain("/home/u/z");
  });

  it("repoints a grandchild thread created before the merge (P3b)", () => {
    const f = parseStraceLog(lines(
      `100 clone(child_stack=0x7f0, ${T} <unfinished ...>`,
      `101 chdir("/scope/clone/sub") = 0`,
      `101 clone(child_stack=0x7f1, ${T}) = 102`,
      `100 <... clone resumed>) = 101`,
      `100 chdir("/home/u") = 0`,
      `102 mkdir("x", 0777) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("covers a child of unreadable clone3 flags that chdirs out while the parent writes relatively (P4)", () => {
    const f = parseStraceLog(lines(`100 clone3(0x7ffc, 88) = 101`, `101 chdir("/home/u") = 0`, `100 mkdir("y", 0777) = 0`), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/y"]);
  });

  it("judges an unfinished head that a new head of the same pid overwrites (P5c)", () => {
    const f = parseStraceLog(lines(
      `100 chdir("/home/u") = 0`,
      `100 fork() = 101`,
      `100 chdir("/scope/clone") = 0`,
      `101 mkdir("x", 0777 <unfinished ...>`,
      `101 +++ killed by SIGKILL +++`,
      `100 fork() = 101`,
      `101 openat(AT_FDCWD</scope/clone>, "/dev/null", O_RDONLY <unfinished ...>`,
      `101 openat(AT_FDCWD</scope/clone>, "/dev/null", O_RDONLY <unfinished ...>`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("judges an unfinished head of a pid that is killed before its resume", () => {
    const f = parseStraceLog(lines(`100 chdir("/home/u") = 0`, `100 fork() = 101`, `101 mkdir("x", 0777 <unfinished ...>`, `101 +++ killed by SIGKILL +++`), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("keeps a failed clone child unknown and transfers the old tid cwd to the superseded leader", () => {
    const f = parseStraceLog(lines(
      `100 fork() = -1 EAGAIN (Ressource zur Zeit nicht verfügbar)`,
      `101 mkdir("a", 0777) = 0`,
      `100 fork() = 102`,
      `102 chdir("/home/u") = 0`,
      `100 +++ superseded by execve in pid 102 +++`,
      `100 mkdir("b", 0777) = 0`,
    ), ctx({}));
    expect(f.unresolvedWrites).toBe(1);
    expect(f.outsideWrites).toEqual(["/home/u/b"]);
  });

  it("replaces the candidates of a lone process on chdir but only adds for a thread group", () => {
    const lone = parseStraceLog(lines(`100 chdir("/home/u") = 0`, `100 chdir("/scope/clone") = 0`, `100 mkdir("x", 0777) = 0`), ctx({}));
    expect(lone.outsideWrites).toEqual([]);
    const group = parseStraceLog(lines(`100 clone(child_stack=0x7f0, ${T}) = 101`, `100 chdir("/home/u") = 0`, `100 chdir("/scope/clone") = 0`, `100 mkdir("x", 0777) = 0`), ctx({}));
    expect(group.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("maps every candidate through a relative chdir", () => {
    const f = parseStraceLog(lines(
      `100 clone(child_stack=0x7f0, ${T}) = 101`,
      `100 chdir("/home/u") = 0`,
      `100 chdir("sub") = 0`,
      `100 mkdir("x", 0777) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x", "/home/u/sub/x"]);
  });
});

describe("CLONE_FS clone windows", () => {
  const T = "flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD";
  const sibling = `100 clone(child_stack=0x7f0, ${T}) = 102`;
  const head = `100 clone(child_stack=0x7f0, ${T} <unfinished ...>`;

  it("flags the sibling write in the real clone-window capture (paths rewritten to /s)", async () => {
    const log = await readFile(new URL("./fixtures/extension-ablation/clone-fs-window.strace", import.meta.url), "utf8");
    const f = parseStraceLog(log, { ...ctx({ initialCwd: "/s/q1/clone", allowed: ["/s/q1/clone"] }), rootPid: 3674192 });
    expect(f.outsideWrites).toContain("/s/q1/out/x");
  });

  it("sees a sibling write while the child is out before clone return (Q1)", () => {
    const f = parseStraceLog(lines(sibling, head, `101 chdir("/home/u") = 0`, `102 mkdir("x", 0777) = 0`, `100 <... clone resumed>) = 101`), ctx({}));
    expect(f.outsideWrites).toContain("/home/u/x");
  });

  it("keeps the child's outside cwd after it chdirs back before clone return (Q1b)", () => {
    const f = parseStraceLog(lines(sibling, head, `101 chdir("/home/u") = 0`, `102 mkdir("x", 0777) = 0`, `101 chdir("/scope/clone") = 0`, `100 <... clone resumed>) = 101`, `100 mkdir("y", 0777) = 0`), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x", "/home/u/y"]);
  });

  it("sees a sibling write even after the child chdirs back inside the clone window", () => {
    const f = parseStraceLog(lines(sibling, head, `101 chdir("/home/u") = 0`, `101 chdir("/scope/clone") = 0`, `102 mkdir("x", 0777) = 0`, `100 <... clone resumed>) = 101`), ctx({}));
    expect(f.outsideWrites).toContain("/home/u/x");
  });

  it("shows a sibling chdir to a child that already chdir'd inside the clone window (Q2)", () => {
    const f = parseStraceLog(lines(sibling, head, `101 chdir("/scope/clone/a") = 0`, `102 chdir("/home/u") = 0`, `101 mkdir("x", 0777) = 0`, `100 <... clone resumed>) = 101`), ctx({}));
    expect(f.outsideWrites).toContain("/home/u/x");
  });

  it.each(["clone(child_stack=0x7f0, flags=CLONE_VM|CLONE_FS", "clone3({flags=CLONE_VM|CLONE_FS}", "clone3(0x7ffc, 88"])("attaches a first write to the pending group: %s", (call) => {
    const f = parseStraceLog(lines(`100 ${call} <unfinished ...>`, `101 mkdir("first", 0777) = 0`, `100 chdir("/home/u") = 0`, `101 mkdir("second", 0777) = 0`), ctx({}));
    expect(f.outsideWrites).toContain("/home/u/second");
  });

  it("attaches a first fchdir to every possible pending parent group", () => {
    const f = parseStraceLog(lines(
      `100 fork() = 200`,
      `100 clone(child_stack=0x7f0, ${T} <unfinished ...>`,
      `200 clone3({flags=CLONE_FS}, 88 <unfinished ...>`,
      `101 fchdir(3</home/u>) = 0`,
      `100 mkdir("x", 0777) = 0`,
      `200 mkdir("y", 0777) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x", "/home/u/y"]);
  });

  it("attaches an unfinished first write before a sibling changes cwd", () => {
    const f = parseStraceLog(lines(head, `101 mkdir("x", 0777 <unfinished ...>`, `100 chdir("/home/u") = 0`, `101 <... mkdir resumed>) = 0`, `100 <... clone resumed>) = 101`), ctx({}));
    expect(f.outsideWrites).toContain("/home/u/x");
  });

  it("adds an unfinished first chdir to the group before a sibling writes", () => {
    const f = parseStraceLog(lines(sibling, head, `101 chdir("/home/u" <unfinished ...>`, `102 mkdir("x", 0777) = 0`, `101 <... chdir resumed>) = 0`, `100 <... clone resumed>) = 101`), ctx({}));
    expect(f.outsideWrites).toContain("/home/u/x");
  });

  it("keeps an explicitly non-CLONE_FS pending child separate", () => {
    const f = parseStraceLog(lines(`100 clone(child_stack=NULL, flags=CLONE_VM|SIGCHLD <unfinished ...>`, `101 chdir("/home/u") = 0`, `100 mkdir("x", 0777) = 0`, `100 <... clone resumed>) = 101`), ctx({}));
    expect(f).toMatchObject({ outsideWrites: [], unresolvedWrites: 0 });
  });
});

describe("unfinished cwd changes (N1/N2)", () => {
  const interleave = `200 openat(AT_FDCWD</x>, "/dev/null", O_RDONLY) = 3</dev/null>`;

  it("applies a lone relative chdir only once on successful resume (N1)", () => {
    const f = parseStraceLog(lines(
      `100 chdir("sub" <unfinished ...>`, interleave,
      `100 <... chdir resumed>) = 0`, `100 chdir("..") = 0`, `100 mkdir("../evil", 0777) = 0`,
    ), ctx({ allowed: [CWD] }));
    expect(f).toMatchObject({ outsideWrites: ["/scope/evil"], unresolvedWrites: 0 });
  });

  it.each([
    ["chdir", `chdir("/scope/clone/nope"`],
    ["fchdir", `fchdir(3</scope/clone/nope>`],
  ])("preserves a lone outside cwd after a failed unfinished %s (N2)", (name, head) => {
    const f = parseStraceLog(lines(
      `100 chdir("/home/u") = 0`, `100 ${head} <unfinished ...>`, interleave,
      `100 <... ${name} resumed>) = -1 ENOENT (No such file or directory)`, `100 mkdir("x", 0777) = 0`,
    ), ctx({ allowed: [CWD] }));
    expect(f).toMatchObject({ outsideWrites: ["/home/u/x"], unresolvedWrites: 0 });
  });

  it.each([
    ["chdir", `chdir("/scope/clone"`],
    ["fchdir", `fchdir(3</scope/clone>`],
  ])("unions a never-resumed %s when its head is flushed", (_name, head) => {
    const f = parseStraceLog(lines(
      `100 chdir("/home/u") = 0`, `100 ${head} <unfinished ...>`, interleave, `100 mkdir("x", 0777) = 0`,
    ), ctx({ allowed: [CWD] }));
    expect(f.outsideWrites).toContain("/home/u/x");
  });

  it("adds an unfinished fchdir target to an existing shared cell before a sibling writes", () => {
    const f = parseStraceLog(lines(
      `100 clone(flags=CLONE_VM|CLONE_FS) = 101`, `100 fchdir(3</home/u> <unfinished ...>`,
      `101 mkdir("x", 0777) = 0`, `100 <... fchdir resumed>) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toContain("/home/u/x");
  });
});

describe("uncertain pending child ownership (N3/N4)", () => {
  const setup = [
    `100 clone(child_stack=0x7f0, flags=CLONE_VM|CLONE_FS|CLONE_THREAD) = 300`,
    `100 fork() = 200`,
  ];
  const foreignHead = `300 clone3({flags=CLONE_VM|CLONE_FS|CLONE_THREAD}, 88 <unfinished ...>`;

  it.each([
    ["clone", `clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD`],
    ["clone3", `clone3({flags=CLONE_VM, exit_signal=SIGCHLD}, 88`],
    ["fork", `fork(`],
    ["vfork", `vfork(`],
  ])("keeps a possibly foreign %s child's relative write unresolved without tainting its group (N3)", (name, head) => {
    const f = parseStraceLog(lines(
      ...setup, `200 chdir("/home/u") = 0`, foreignHead, `200 ${head} <unfinished ...>`,
      `201 mkdir("x", 0777) = 0`, `100 mkdir("group", 0777) = 0`,
      `200 <... ${name} resumed>) = 201`, `201 mkdir("after", 0777) = 0`,
      `300 <... clone3 resumed>) = 301`, `100 mkdir("group-after", 0777) = 0`,
    ), ctx({ allowed: [CWD] }));
    // The child wrote before its parent's clone return, so it is window-born (R24): both of its relative writes are unresolved.
    expect(f).toMatchObject({ outsideWrites: ["/home/u/after"], unresolvedWrites: 2 });
  });

  it("detaches a resolved non-CLONE_FS child before its later chdir (R5/N4)", () => {
    const f = parseStraceLog(lines(
      ...setup, foreignHead,
      `200 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD <unfinished ...>`,
      `201 openat(AT_FDCWD</scope/clone>, "/etc/ld.so.cache", O_RDONLY|O_CLOEXEC) = 3</etc/ld.so.cache>`,
      `200 <... clone resumed>) = 201`, `300 <... clone3 resumed>) = 301`,
      `201 chdir("/usr/share") = 0`, `100 mkdir("y", 0777) = 0`, `201 mkdir("child", 0777) = 0`,
    ), ctx({ allowed: [CWD] }));
    // 201 emitted a line before the clone return (window-born, R24): its cwd is resolved but its relative write also counts as unresolved.
    expect(f).toMatchObject({ outsideWrites: ["/usr/share/child"], unresolvedWrites: 1 });
  });
});

describe("namespace and root changes (R21)", () => {
  it.each([
    ["chroot", `chroot("/scope/clone")`],
    ["pivot_root", `pivot_root("/scope/clone", "/scope/clone/old")`],
    ["setns", `setns(3<net:[1]>, CLONE_NEWNS)`],
    ["unshare", `unshare(CLONE_NEWNS)`],
    ["mount", `mount("none", "/scope/clone", "tmpfs", 0, NULL)`],
    ["open_tree", `open_tree(AT_FDCWD, "/scope/clone", OPEN_TREE_CLONE)`],
    ["move_mount", `move_mount(3, "", AT_FDCWD, "/scope/clone", MOVE_MOUNT_F_EMPTY_PATH)`],
    ["fsopen", `fsopen("tmpfs", FSOPEN_CLOEXEC)`],
    ["fsmount", `fsmount(3, FSMOUNT_CLOEXEC, 0)`],
    ["fsconfig", `fsconfig(3, FSCONFIG_CMD_CREATE, NULL, NULL, 0)`],
    ["mount_setattr", `mount_setattr(AT_FDCWD, "/scope/clone", 0, {attr_set=MOUNT_ATTR_RDONLY}, 32)`],
    ["umount2", `umount2("/scope/clone", MNT_DETACH)`],
  ])("counts successful %s as unresolved but ignores a failed attempt", (_name, call) => {
    expect(parseStraceLog(lines(`100 ${call} = 0`), ctx({})).unresolvedWrites).toBe(1);
    expect(parseStraceLog(lines(`100 ${call} = -1 EPERM (Operation not permitted)`), ctx({})).unresolvedWrites).toBe(0);
    expect(parseStraceLog(lines(`100 ${call} <unfinished ...>`), ctx({})).unresolvedWrites).toBe(1);
    expect(parseStraceLog(lines(`100 <... ${_name} resumed>) = 0`), ctx({})).unresolvedWrites).toBe(1);
    expect(parseStraceLog(lines(`100 <... ${_name} resumed>) = -1 EPERM (Operation not permitted)`), ctx({})).unresolvedWrites).toBe(0);
  });

  it.each(["CLONE_NEWNS", "CLONE_NEWUSER", "CLONE_NEWPID", "CLONE_NEWNET", "CLONE_NEWUTS", "CLONE_NEWIPC", "CLONE_NEWCGROUP", "CLONE_NEWTIME"])("counts successful clone and clone3 namespace creation with %s (S3)", (flag) => {
    for (const call of [`clone(child_stack=NULL, flags=${flag}|SIGCHLD)`, `clone3({flags=${flag}, exit_signal=SIGCHLD}, 88)`]) {
      expect(parseStraceLog(lines(`100 ${call} = 101`), ctx({})).unresolvedWrites).toBe(1);
      expect(parseStraceLog(lines(`100 ${call} = -1 EPERM (Operation not permitted)`), ctx({})).unresolvedWrites).toBe(0);
    }
    expect(parseStraceLog(lines(
      `100 clone3({flags=${flag}, exit_signal=SIGCHLD}, 88 <unfinished ...>`,
      `100 <... clone3 resumed>) = 101`,
    ), ctx({})).unresolvedWrites).toBe(1);
  });
});

describe("CLONE_FS threads share the cwd", () => {
  const thread = `100 clone3({flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM|CLONE_SETTLS, exit_signal=0, stack=0x7f0, stack_size=0x100}, 88) = 101`;

  it("shows a chdir of the parent to the thread", () => {
    const f = parseStraceLog(lines(thread, `100 chdir("/home/u") = 0`, `101 mkdir("x", 0777) = 0`), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("shows a chdir of the thread to the parent", () => {
    const f = parseStraceLog(lines(thread, `101 chdir("/home/u") = 0`, `100 mkdir("x", 0777) = 0`), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("applies a thread chdir that came before the parent's return line", () => {
    const f = parseStraceLog(lines(
      `100 clone(child_stack=0x7f0, flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD <unfinished ...>`,
      `101 chdir("/home/u") = 0`,
      `100 <... clone resumed>) = 101`,
      `100 mkdir("x", 0777) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("keeps cwds separate for fork, vfork and clone without CLONE_FS", () => {
    const f = parseStraceLog(lines(
      `100 fork() = 101`,
      `100 clone(child_stack=NULL, flags=CLONE_VM|CLONE_VFORK|SIGCHLD) = 102`,
      `100 chdir("/home/u") = 0`,
      `101 mkdir("a", 0777) = 0`,
      `102 mkdir("b", 0777) = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual([]);
  });
});

describe("symlink differentials", () => {
  it("judges the path the kernel opened, not the lexical one", () => {
    const f = parseStraceLog(lines(`100 openat(${at()}, "lnk/x", O_WRONLY|O_CREAT, 0644) = 3</home/u/x>`), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/x"]);
  });

  it("never lets the kernel path clear a lexically outside name", () => {
    const f = parseStraceLog(lines(`100 openat(${at()}, "/tmp/alias/x", O_WRONLY|O_CREAT, 0644) = 3</scope/clone/x>`), ctx({}));
    expect(f.outsideWrites).toEqual(["/tmp/alias/x"]);
  });

  it("judges an unlinked file by the annotation as printed and with the suffix stripped", () => {
    const f = parseStraceLog(lines(`100 openat(${at()}, "gone", O_RDWR|O_TMPFILE, 0600) = 4</home/u/#12 (deleted)>`), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/#12 (deleted)", "/home/u/#12"]);
  });

  it("does not let a (deleted) suffix hide a sibling of the root (real strace 7.2 capture)", () => {
    // Root /r/clone; "../clone (deleted)" is the sibling directory named "clone (deleted)": stripping the suffix would land on the root.
    const f = parseStraceLog(lines(`100 openat(AT_FDCWD</r/clone>, "../clone (deleted)", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3</r/clone (deleted)>`), ctx({ initialCwd: "/r/clone", allowed: ["/r/clone"] }));
    expect(f.outsideWrites).toEqual(["/r/clone (deleted)"]);
  });

  it("also applies the suffix rule to absolute names, dirfds and fd-based calls", () => {
    const f = parseStraceLog(lines(
      `100 openat(AT_FDCWD</scope/clone>, "/scope/clone (deleted)", O_WRONLY|O_CREAT|O_TRUNC, 0644) = 3</scope/clone (deleted)>`,
      `100 openat(7</scope/clone (deleted)>, "x", O_WRONLY|O_CREAT, 0644) = -1 EACCES (Keine Berechtigung)`,
      `100 mkdirat(7</scope/clone (deleted)>, "y", 0777) = 0`,
      `100 fchmod(8</scope/other (deleted)>, 0600) = 0`,
    ), ctx({ allowed: ["/scope/clone"] }));
    expect(f.outsideWrites).toEqual(["/scope/clone (deleted)", "/scope/clone (deleted)/y", "/scope/other (deleted)", "/scope/other"]);
    expect(f.deniedWriteAttempts).toBe(1);
  });

  it("falls back to the lexical path when the fd has no path annotation", () => {
    const f = parseStraceLog(lines(`100 openat(${at()}, "/etc/x", O_WRONLY|O_CREAT, 0644) = 3<anon_inode:[eventfd]>`, `100 creat("/etc/y", 0644) = 4`), ctx({}));
    expect(f.outsideWrites).toEqual(["/etc/x", "/etc/y"]);
  });

  it("judges creat and open by their returned path too", () => {
    const f = parseStraceLog(lines(`100 creat("lnk", 0644) = 3</home/u/c>`, `100 open("lnk2", O_WRONLY) = 4</home/u/o>`), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/c", "/home/u/o"]);
  });

  it("counts a symlink to an absolute target outside the roots as an outside write", () => {
    expect(parseStraceLog(lines(`100 symlink("/home/u", "/scope/clone/lnk") = 0`), ctx({})).outsideWrites).toEqual(["/home/u"]);
  });

  it("resolves a relative symlink target against the link's directory", () => {
    const f = parseStraceLog(lines(
      `100 symlinkat("../../home/u", ${at()}, "l") = 0`,
      `100 symlinkat("inner", ${at()}, "l2") = 0`,
      `100 symlinkat("../../../x", ${at()}, "sub/l3") = 0`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u", "/x"]);
  });

  it("counts a relative symlink target as unresolved when the link path is", () => {
    expect(parseStraceLog(lines(`999 symlink("rel", "lnk") = 0`), ctx({})).unresolvedWrites).toBe(1);
  });

  it("reports a failed outside symlink only as denied", () => {
    const f = parseStraceLog(lines(`100 symlink("/home/u", "/scope/clone/lnk") = -1 EEXIST (Die Datei existiert bereits)`), ctx({}));
    expect(f).toMatchObject({ outsideWrites: [], deniedWriteAttempts: 1 });
  });
});

describe("return value and annotation edge cases", () => {
  it("keeps an interrupted write that will be restarted in progress", () => {
    const f = parseStraceLog(lines(
      `100 creat("/etc/x", 0644) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)`,
      `100 creat("/etc/y", 0644) = -1 ERESTARTSYS (To be restarted if SA_RESTART is set)`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/etc/x", "/etc/y"]);
  });

  it("decodes escapes in return and dirfd annotations like in arguments", () => {
    const f = parseStraceLog(lines(
      `100 openat(${at()}, "a>b, \\"c d\\303\\244", O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0666) = 3</home/u/a\\76b, \\"c d\\303\\244>`,
      `100 openat(7</home/u/d\\303\\244 x>, "n", O_WRONLY|O_CREAT, 0600) = -1 EACCES (Keine Berechtigung)`,
      `100 openat(7</home/u/d\\303\\244 x>, "m", O_WRONLY|O_CREAT <unfinished ...>`,
    ), ctx({}));
    expect(f.outsideWrites).toEqual(["/home/u/a>b, \"c dä", "/home/u/dä x/m"]);
    expect(f.deniedWriteAttempts).toBe(1);
  });

  it("preserves unfinished-marker text inside a resumed return annotation (Q3)", () => {
    const f = parseStraceLog(lines(
      `100 <... chdir resumed>) = 0`,
      `100 open("f", O_WRONLY|O_CREAT, 0644 <unfinished ...>`,
      `101 mkdir("/scope/clone/q", 0777) = 0`,
      `100 <... open resumed>) = 3</scope/clone <unfinished ...>/f>`,
    ), ctx({ allowed: ["/scope/clone"] }));
    expect(f.outsideWrites).toEqual(["/scope/clone <unfinished ...>/f"]);
  });

  it("counts a resumed half without a head as unresolved", () => {
    expect(parseStraceLog(lines(`100 <... openat resumed>, 0644) = 3</etc/x>`), ctx({})).unresolvedWrites).toBe(1);
    expect(parseStraceLog(lines(`100 <... connect resumed>) = 0`), ctx({})).unresolvedEgress).toBe(1);
    expect(parseStraceLog(lines(`100 <... clone resumed>) = 101`), ctx({}))).toMatchObject({ unresolvedWrites: 0, unresolvedEgress: 0 });
  });
});

describe("egress without connect", () => {
  const V4 = (ip: string, port = 9) => `{sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${ip}")}`;
  const unexpected = (log: string, extra: Parameters<typeof ctx>[0] = {}) => parseStraceLog(lines(log), ctx(extra)).unexpectedConnects;

  it("judges the destination of sendto", () => {
    expect(unexpected(`100 sendto(3<socket:[1]>, "x", 1, 0, ${V4("203.0.113.9")}, 16) = 1`)).toEqual([{ family: "inet", address: "203.0.113.9", port: 9 }]);
    expect(unexpected(`100 sendto(3<socket:[1]>, "x", 1, 0, ${V4("198.51.100.1")}, 16) = 1`, { provider: ["198.51.100.1"] })).toEqual([]);
    expect(unexpected(`100 sendto(3<socket:[1]>, "q", 1, 0, ${V4("127.0.0.53", 53)}, 16) = 1`, { dns: ["127.0.0.53"] })).toEqual([]);
  });

  it("judges IPv6 sendto and ignores unix and connected-socket sends", () => {
    expect(unexpected(`100 sendto(4<socket:[2]>, "x", 1, 0, {sa_family=AF_INET6, sin6_port=htons(9), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "::1", &sin6_addr), sin6_scope_id=0}, 28) = 1`))
      .toEqual([{ family: "inet6", address: "::1", port: 9 }]);
    expect(unexpected(`100 sendto(3<socket:[1]>, "x", 1, 0, NULL, 0) = -1 ECONNREFUSED (Verbindungsaufbau abgelehnt)`)).toEqual([]);
    expect(unexpected(`100 sendto(3<socket:[1]>, "x", 1, 0, {sa_family=AF_UNIX, sun_path="/run/x"}, 110) = 1`)).toEqual([]);
  });

  it("judges msg_name of sendmsg and ignores msg_name=NULL", () => {
    const hdr = (name: string) => `{msg_name=${name}, msg_namelen=16, msg_iov=[{iov_base="y", iov_len=1}], msg_iovlen=1, msg_controllen=0, msg_flags=0}`;
    expect(unexpected(`100 sendmsg(3<socket:[1]>, ${hdr(V4("203.0.113.9"))}, 0) = 1`)).toEqual([{ family: "inet", address: "203.0.113.9", port: 9 }]);
    expect(unexpected(`100 sendmsg(3<socket:[1]>, ${hdr("NULL")}, 0) = 1`)).toEqual([]);
  });

  it("judges every msg_name of sendmmsg", () => {
    const msg = (name: string) => `{msg_hdr={msg_name=${name}, msg_namelen=16, msg_iov=[{iov_base="y", iov_len=1}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=1}`;
    expect(unexpected(`100 sendmmsg(3<socket:[1]>, [${msg("NULL")}, ${msg(V4("203.0.113.9"))}, ${msg(V4("203.0.113.10"))}], 3, 0) = 3`).map((d) => d.address)).toEqual(["203.0.113.9", "203.0.113.10"]);
    expect(unexpected(`100 sendmmsg(3<socket:[1]>, [${msg("NULL")}], 1, 0) = 1`)).toEqual([]);
  });

  it("does not count sends as connects", () => {
    expect(parseStraceLog(lines(`100 sendto(3, "x", 1, 0, ${V4("203.0.113.9")}, 16) = 1`), ctx({})).connects).toBe(0);
  });

  it("counts a successful io_uring_setup as unresolved egress and ignores a failed one (R23b)", () => {
    const ok = `100 io_uring_setup(4, {flags=0, sq_thread_cpu=0, sq_thread_idle=0, sq_entries=4, cq_entries=8, features=IORING_FEAT_SINGLE_MMAP|IORING_FEAT_NODROP}) = 5<anon_inode:[io_uring]>`;
    const enomem = `100 io_uring_setup(256, {flags=IORING_SETUP_NO_SQARRAY, sq_thread_cpu=0, sq_thread_idle=0}) = -1 ENOMEM (Cannot allocate memory)`;
    const enosys = `100 io_uring_setup(4, 0x7ffc) = -1 ENOSYS (Funktion nicht implementiert)`;
    expect(parseStraceLog(lines(ok), ctx({})).unresolvedEgress).toBe(1);
    expect(parseStraceLog(lines(enomem, enosys), ctx({})).unresolvedEgress).toBe(0);
    expect(parseStraceLog(lines(enomem, ok, enosys, ok), ctx({})).unresolvedEgress).toBe(2);
  });

  it("reads no egress from a real capture where strace injected ENOSYS into every io_uring_setup (R36)", async () => {
    const text = await readFile(fileURLToPath(new URL("./fixtures/extension-ablation/io-uring-injected.strace", import.meta.url)), "utf8");
    const setups = text.split("\n").filter((line) => line.includes("io_uring_setup("));
    expect(setups.length).toBeGreaterThan(0);
    for (const line of setups) expect(line).toMatch(/= -1 ENOSYS .*\(INJECTED\)$/);
    const first = Number(/^(\d+)/.exec(text)![1]);
    const f = parseStraceLog(text, { ...ctx({}), rootPid: first });
    expect(f).toMatchObject({ unresolvedEgress: 0, outsideWrites: [], unresolvedWrites: 0 });
  });

  it("judges a resumed io_uring_setup by its return value, and an unfinished one as in progress", () => {
    expect(parseStraceLog(lines(`100 io_uring_setup(256, {flags=0} <unfinished ...>`, `100 <... io_uring_setup resumed>) = -1 ENOMEM (Cannot allocate memory)`), ctx({})).unresolvedEgress).toBe(0);
    expect(parseStraceLog(lines(`100 io_uring_setup(256, {flags=0} <unfinished ...>`, `100 <... io_uring_setup resumed>) = 5<anon_inode:[io_uring]>`), ctx({})).unresolvedEgress).toBe(1);
    expect(parseStraceLog(lines(`100 io_uring_setup(256, {flags=0} <unfinished ...>`), ctx({})).unresolvedEgress).toBe(1);
    expect(parseStraceLog(lines(`100 <... io_uring_setup resumed>) = -1 ENOMEM (Cannot allocate memory)`), ctx({})).unresolvedEgress).toBe(0);
    expect(parseStraceLog(lines(`100 <... io_uring_setup resumed>) = 5<anon_inode:[io_uring]>`), ctx({})).unresolvedEgress).toBe(1);
  });

  it("reports an unreadable inet sockaddr as unexpected with address unknown", () => {
    const unknown = [{ family: "inet", address: "unknown", port: 0 }];
    expect(unexpected(`100 connect(3, 0x7ffd1234, 16) = -1 EFAULT (Ungültige Adresse)`)).toEqual(unknown);
    expect(unexpected(`100 sendto(3, "x", 1, 0, 0x7ffd1234, 16) = 1`)).toEqual(unknown);
    expect(unexpected(`100 connect(3, {sa_family=AF_INET, sa_data="\\0\\0"}, 16) = 0`)).toEqual(unknown);
    expect(unexpected(`100 sendmsg(3, 0x7ffd1234, 0) = 1`)).toEqual(unknown);
    expect(parseStraceLog(lines(`100 connect(3, 0x7ffd1234, 16) = -1 EFAULT (Ungültige Adresse)`), ctx({})).connects).toBe(1);
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

  it("checks both paths of rename and link and the link path of symlink", () => {
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
    // symlink targets are judged separately (see "symlinks"), here every target is outside or the link path is
    expect(f.outsideWrites).toEqual(["/etc/b", "/home/u/y", "/etc/r1", "/etc/r2", "/etc/l1", "/etc/l3", "/etc/target", "/etc/link2", "/etc/target2", "/etc/target3"]);
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
      outsideWrites: [], unresolvedWrites: 0, deniedWriteAttempts: 0, unexpectedConnects: [], connects: 0, unresolvedEgress: 0, evidenceLines: [],
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

describe("Unix socket connects (R43)", () => {
  const unix = (path: string, ret = "0") => `100 connect(3<socket:[1]>, {sa_family=AF_UNIX, sun_path=${path}}, 21) = ${ret}`;
  const egress = (line: string, extra: Partial<TraceContext> = {}) =>
    parseStraceLog(lines(line), { ...ctx({}), allowedSocketRoots: ["/scope"], ...extra }).unresolvedEgress;

  it("flags a connect to the user bus or the systemd manager, outside the scope root", () => {
    expect(egress(unix("\"/run/user/1000/bus\""))).toBe(1);
    expect(egress(unix("\"/run/user/1000/systemd/private\""))).toBe(1);
    expect(egress(unix("\"/run/dbus/system_bus_socket\""))).toBe(1);
  });

  it("flags every abstract-namespace socket and a relative pathname", () => {
    expect(egress(unix("@\"/tmp/dbus-abc\""))).toBe(1);
    expect(egress(unix("@\"name\""))).toBe(1);
    expect(egress(unix("\"rel/sock\""))).toBe(1);
  });

  it("allows the name-service allowlist and sockets inside the scope root", () => {
    expect(egress(unix("\"/run/systemd/userdb/io.systemd.Multiplexer\""))).toBe(0);
    expect(egress(unix("\"/run/systemd/resolve/io.systemd.Resolve\""))).toBe(0);
    expect(egress(unix("\"/run/nscd/socket\""))).toBe(0);
    expect(egress(unix("\"/var/run/nscd/socket\""))).toBe(0);
    expect(egress(unix("\"/scope/clone/.sock\""))).toBe(0);
    expect(egress(unix("\"/scope-evil/sock\""))).toBe(1);
    expect(egress(unix("\"/scope/../run/user/1000/bus\""))).toBe(1);
  });

  it("ignores a connect that failed, and does not count inet connects as Unix escapes", () => {
    expect(egress(unix("\"/run/user/1000/bus\"", "-1 ENOENT (No such file or directory)"))).toBe(0);
    expect(egress(unix("@\"x\"", "-1 ECONNREFUSED (Connection refused)"))).toBe(0);
    expect(egress("100 connect(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr(\"203.0.113.9\")}, 16) = 0")).toBe(0);
  });

  it("without a configured root only the built-in allowlist applies", () => {
    expect(parseStraceLog(lines(unix("\"/scope/clone/.sock\"")), ctx({})).unresolvedEgress).toBe(1);
  });

  const sendto = (path: string, ret = "1") => `100 sendto(3<socket:[2]>, "x", 1, 0, {sa_family=AF_UNIX, sun_path=${path}}, 33) = ${ret}`;
  const sendmsg = (path: string, ret = "1") =>
    `100 sendmsg(3<socket:[2]>, {msg_name={sa_family=AF_UNIX, sun_path=${path}}, msg_namelen=29, msg_iov=[{iov_base="x", iov_len=1}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, 0) = ${ret}`;

  it("judges AF_UNIX datagram destinations of sendto, sendmsg and sendmmsg like connects (R46 consistency)", () => {
    expect(egress(sendto("\"/run/user/1000/systemd/notify\""))).toBe(1);
    expect(egress(sendmsg("\"/run/systemd/journal/socket\""))).toBe(1);
    expect(egress(`100 sendmmsg(3<socket:[2]>, [{msg_hdr={msg_name={sa_family=AF_UNIX, sun_path="/run/user/1000/bus"}, msg_namelen=21, msg_iov=[{iov_base="x", iov_len=1}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=1}], 1, 0) = 1`)).toBe(1);
    expect(egress(sendto("@\"abstract\""))).toBe(1);
    expect(egress(sendmsg("@\"abstract\""))).toBe(1);
  });

  it("allows datagram sends to the allowlist and the scope root, and ignores failed sends", () => {
    expect(egress(sendto("\"/run/systemd/resolve/io.systemd.Resolve\""))).toBe(0);
    expect(egress(sendmsg("\"/scope/clone/.sock\""))).toBe(0);
    expect(egress(sendto("\"/run/user/1000/systemd/notify\"", "-1 ENOENT (No such file or directory)"))).toBe(0);
    expect(egress(sendmsg("\"/run/user/1000/bus\"", "-1 ECONNREFUSED (Connection refused)"))).toBe(0);
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

  it("keeps the line of an unresolved write", () => {
    const relative = `100 openat(AT_FDCWD</scope/clone>, "y", O_RDWR) = 3`;
    const found = find(lines(`100 chdir(1) = 0`, `200 <... openat resumed>) = 3`, relative));
    expect(found.unresolvedWrites).toBeGreaterThan(0);
    expect(found.evidenceLines.length).toBe(found.unresolvedWrites);
  });

  it("keeps nothing for a clean log and for a refused write, and at most 50 entries", () => {
    expect(find(lines(benign, `100 openat(AT_FDCWD</scope/clone>, "/home/u/x", O_WRONLY) = -1 EACCES (Permission denied)`)).evidenceLines).toEqual([]);
    const many = find(lines(...Array.from({ length: 80 }, (_, i) => `100 openat(AT_FDCWD</scope/clone>, "/home/u/${i}", O_WRONLY|O_CREAT, 0644) = 3</home/u/${i}>`)));
    expect(many.outsideWrites).toHaveLength(80);
    expect(many.evidenceLines).toHaveLength(50);
  });
});
