import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseStraceLog } from "../eval/extensions/trace.js";
import { removeTemporaryRoots } from "./temporary-roots.js";
import { ctx, lines, CWD, at } from "./extension-ablation-trace-fixtures.js";

afterAll(removeTemporaryRoots);

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
