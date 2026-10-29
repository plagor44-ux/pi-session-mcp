import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { STRACE_ARGS, parseStraceLog, type TraceContext } from "../eval/extensions/trace.js";
import { removeTemporaryRoots } from "./temporary-roots.js";
import { ctx, lines } from "./extension-ablation-trace-fixtures.js";

afterAll(removeTemporaryRoots);

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

describe("abstract sockets bound inside the trace (R88)", () => {
  const sock = (n: number) => `${n}<socket:[${n}${n}]>`;
  const bind = (pid: number, name: string, ret = "0") => `${pid} bind(${sock(3)}, {sa_family=AF_UNIX, sun_path=@"${name}"}, 44) = ${ret}`;
  const connect = (pid: number, name: string, ret = "0") => `${pid} connect(${sock(4)}, {sa_family=AF_UNIX, sun_path=@"${name}"}, 44) = ${ret}`;
  const sendmsg = (pid: number, name: string) =>
    `${pid} sendmsg(${sock(5)}, {msg_name={sa_family=AF_UNIX, sun_path=@"${name}"}, msg_namelen=44, msg_iov=[{iov_base="x", iov_len=1}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, 0) = 1`;
  const sendto = (pid: number, name: string) => `${pid} sendto(${sock(6)}, "x", 1, 0, {sa_family=AF_UNIX, sun_path=@"${name}"}, 44) = 1`;
  const run = (...log: string[]) => parseStraceLog(lines(...log), ctx({}));
  const MAIL = "mail-pdf-73342cfaea134cc4be84610388df1d0d";
  const DOCKER = "docker_cli_bda8b079f8fdef11b684b7c481c7a6ce";

  it("traces bind", () => {
    expect(STRACE_ARGS[3]!.replace("trace=", "").split(",")).toContain("bind");
  });

  it("treats a connect to a name bound earlier in the trace as internal, whichever process binds or connects", () => {
    expect(run(bind(100, "svc"), connect(100, "svc")).unresolvedEgress).toBe(0);
    expect(run(bind(100, "svc"), connect(200, "svc"), sendmsg(300, "svc"), sendto(300, "svc")).unresolvedEgress).toBe(0);
    expect(run(bind(100, "svc"), connect(100, "svc")).evidenceLines).toEqual([]);
  });

  it("keeps a connect without a bind, a connect before the bind and another name as escapes", () => {
    expect(run(connect(100, "svc")).unresolvedEgress).toBe(1);
    expect(run(connect(100, "svc"), bind(100, "svc")).unresolvedEgress).toBe(1);
    expect(run(bind(100, "svc"), connect(100, "other")).unresolvedEgress).toBe(1);
    expect(run(bind(100, "svc"), connect(100, "svc2"), connect(100, "sv")).unresolvedEgress).toBe(2);
    expect(run(bind(100, "svc"), connect(100, "svc"), connect(100, "other")).evidenceLines).toEqual([connect(100, "other")]);
  });

  it("does not trust a failed bind: EADDRINUSE means a host process holds the name", () => {
    expect(run(bind(100, "svc", "-1 EADDRINUSE (Address already in use)"), connect(100, "svc")).unresolvedEgress).toBe(1);
    expect(run(bind(100, "svc", "-1 EACCES (Permission denied)"), connect(100, "svc")).unresolvedEgress).toBe(1);
    // A bind that only started (never resumed) is not a bound name either.
    expect(run(`100 bind(${sock(3)}, {sa_family=AF_UNIX, sun_path=@"svc"}, 44 <unfinished ...>`, connect(200, "svc")).unresolvedEgress).toBe(1);
  });

  it("counts a bind that is joined from an unfinished and a resumed line, and ignores binds that are not AF_UNIX abstract", () => {
    expect(run(`100 bind(${sock(3)}, {sa_family=AF_UNIX, sun_path=@"svc"}, 44 <unfinished ...>`, "100 <... bind resumed>) = 0", connect(200, "svc")).unresolvedEgress).toBe(0);
    expect(run(`100 bind(${sock(3)}, {sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr("127.0.0.1")}, 16) = 0`, connect(100, "svc")).unresolvedEgress).toBe(1);
    expect(run(`100 bind(${sock(3)}, {sa_family=AF_UNIX, sun_path="/scope/x.sock"}, 20) = 0`, connect(100, "x.sock")).unresolvedEgress).toBe(1);
    // A filesystem path is judged as before, bound or not.
    expect(run(`100 bind(${sock(3)}, {sa_family=AF_UNIX, sun_path="/run/user/1000/bus"}, 20) = 0`, `100 connect(${sock(4)}, {sa_family=AF_UNIX, sun_path="/run/user/1000/bus"}, 20) = 0`).unresolvedEgress).toBe(1);
  });

  it("compares the names as strace printed them: two different non-UTF-8 names are not the same, and a malformed escape is never trusted", () => {
    expect(run(bind(100, "\\xfe"), connect(100, "\\xfe")).unresolvedEgress).toBe(0);
    expect(run(bind(100, "\\xfe"), connect(100, "\\xff")).unresolvedEgress).toBe(1);
    expect(run(bind(100, "a\\x00b"), connect(100, "a\\x01b")).unresolvedEgress).toBe(1);
    expect(run(bind(100, "a\\q"), connect(100, "a\\q")).unresolvedEgress).toBe(1);
    expect(run(bind(100, "a\\xZZ"), connect(100, "a\\xZZ")).unresolvedEgress).toBe(1);
    expect(run(bind(100, "a\\101"), connect(100, "a\\101")).unresolvedEgress).toBe(0);
    expect(run(bind(100, "a\\101"), connect(100, "aA")).unresolvedEgress).toBe(1);
  });

  it("keeps a name internal only while a process that bound it is alive; an execve keeps it", () => {
    expect(run(bind(100, "svc"), "100 +++ exited with 0 +++", connect(200, "svc")).unresolvedEgress).toBe(1);
    expect(run(bind(100, "svc"), "100 +++ killed by SIGKILL +++", connect(200, "svc")).unresolvedEgress).toBe(1);
    expect(run(bind(100, "svc"), "300 +++ exited with 0 +++", connect(200, "svc")).unresolvedEgress).toBe(0);
    // Another process binds the freed name, or the binder execs: the name is held again.
    expect(run(bind(100, "svc"), "100 +++ exited with 0 +++", bind(101, "svc"), connect(200, "svc")).unresolvedEgress).toBe(0);
    expect(run(bind(100, "svc"), "100 +++ superseded by execve in pid 100 +++", connect(100, "svc")).unresolvedEgress).toBe(0);
    // A thread that binds and then execs becomes the process: its name is held by the process, and ends with it.
    const thread = ["200 +++ superseded by execve in pid 201 +++"];
    expect(run(bind(201, "svc"), ...thread, connect(300, "svc")).unresolvedEgress).toBe(0);
    expect(run(bind(201, "svc"), ...thread, "200 +++ exited with 0 +++", connect(300, "svc")).unresolvedEgress).toBe(1);
    expect(run(bind(201, "svc"), ...thread, "201 +++ exited with 0 +++", connect(300, "svc")).unresolvedEgress).toBe(0);
    // Two holders: it stays while either lives.
    expect(run(bind(100, "svc"), bind(101, "svc"), "100 +++ exited with 0 +++", connect(200, "svc")).unresolvedEgress).toBe(0);
    expect(run(bind(100, "svc"), bind(101, "svc"), "100 +++ exited with 0 +++", "101 +++ exited with 0 +++", connect(200, "svc")).unresolvedEgress).toBe(1);
    // The exit comes after the connect: the connect was internal when it happened.
    expect(run(bind(100, "svc"), connect(200, "svc"), "100 +++ exited with 0 +++").unresolvedEgress).toBe(0);
  });

  it("accepts the evidence lines of the stopped run once the matching bind is in the log, and not without it", () => {
    const evidence = [
      `4 connect(4<socket:[32553896]>, {sa_family=AF_UNIX, sun_path=@"${MAIL}"}, 44) = 0`.replace(/^4 /, "102 "),
      `102 connect(3<socket:[32541120]>, {sa_family=AF_UNIX, sun_path=@"${DOCKER}"}, 46) = 0`,
    ];
    expect(run(...evidence).unresolvedEgress).toBe(2);
    expect(run(bind(101, MAIL), bind(103, DOCKER), ...evidence).unresolvedEgress).toBe(0);
    expect(run(bind(101, MAIL), ...evidence).evidenceLines).toEqual([evidence[1]]);
  });

  it("ignores a bind by the muted bubblewrap process but counts one by the workload, in a sandboxed trace", () => {
    const prelude = [
      "100 clone(child_stack=NULL, flags=CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUSER|CLONE_NEWPID|SIGCHLD) = 101",
      "101 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f0) = 102",
    ];
    const judged = (...log: string[]) => parseStraceLog(lines(...prelude, ...log), { ...ctx({}), sandboxed: true }).unresolvedEgress;
    expect(judged(bind(102, "svc"), connect(102, "svc"))).toBe(0);
    expect(judged(bind(100, "svc"), connect(102, "svc"))).toBe(1);
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

  describe("the sandbox's private /tmp (R87)", () => {
    const daemon = '"/tmp/codegraph-9ae10b5c0e7502a8.sock"';
    /** The line of the stopped run's private diagnostics (the codegraph MCP server's daemon socket); it holds no secret. */
    const evidence = `100 connect(19<socket:[1234567]>, {sa_family=AF_UNIX, sun_path=${daemon}}, 110) = 0`;
    const sandboxed = { sandboxed: true, boundPaths: ["/tmp/build-x", "/opt/tools"] };
    /** bubblewrap's setup processes (muted: the root pid and its CLONE_NEWPID child), then the workload pid 102 whose lines are judged. */
    const prelude = [
      "100 clone(child_stack=NULL, flags=CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUSER|CLONE_NEWPID|SIGCHLD) = 101",
      "101 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f0) = 102",
    ];
    const judged = (line: string, extra: Partial<TraceContext>) => parseStraceLog(lines(...prelude, line.replace(/^100 /, "102 ")), { ...ctx({}), allowedSocketRoots: ["/scope"], ...extra });
    const egress = (line: string, extra: Partial<TraceContext> = {}) => judged(line, extra).unresolvedEgress;
    const sendto = (path: string) => `100 sendto(3<socket:[2]>, "x", 1, 0, {sa_family=AF_UNIX, sun_path=${path}}, 33) = 1`;
    const sendmsg = (path: string) =>
      `100 sendmsg(3<socket:[2]>, {msg_name={sa_family=AF_UNIX, sun_path=${path}}, msg_namelen=29, msg_iov=[{iov_base="x", iov_len=1}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, 0) = 1`;

    it("allows the daemon socket of the evidence line in a sandboxed trace, and nothing of it is unresolved egress", () => {
      const found = judged(evidence, sandboxed);
      expect(found.unresolvedEgress).toBe(0);
      expect(found.evidenceLines).toEqual([]);
      expect(found.connects).toBe(0);
    });

    it("keeps the same path an escape in a trace that is not from a sandboxed command", () => {
      expect(egress(evidence)).toBe(1);
      expect(egress(evidence, { sandboxed: false })).toBe(1);
      // The same line from the muted root pid is not judged at all, so the checks above are about the workload pid.
      expect(parseStraceLog(lines(...prelude, evidence), { ...ctx({}), ...sandboxed }).unresolvedEgress).toBe(0);
    });

    it("allows /var/tmp and sendto/sendmsg destinations there, as for connect", () => {
      expect(egress(unix('"/var/tmp/x.sock"'), sandboxed)).toBe(0);
      expect(egress(sendto('"/tmp/x.sock"'), sandboxed)).toBe(0);
      expect(egress(sendmsg('"/var/tmp/y.sock"'), sandboxed)).toBe(0);
      expect(egress(sendto('"/tmp/x.sock"'))).toBe(1);
    });

    it("counts a socket below a host path bound into the sandbox as an escape, whatever the directory", () => {
      expect(egress(unix('"/tmp/build-x/run/x.sock"'), sandboxed)).toBe(1);
      expect(egress(unix('"/tmp/build-x"'), sandboxed)).toBe(1);
      expect(egress(unix('"/tmp/build-xy/x.sock"'), sandboxed)).toBe(0);
      expect(egress(unix('"/opt/tools/x.sock"'), sandboxed)).toBe(1);
      // A dependency mount inside the scope root is a host directory too, although the scope root itself is allowed.
      const dependency = { ...sandboxed, boundPaths: ["/scope/clone/backend/.venv"] };
      expect(egress(unix('"/scope/clone/backend/.venv/x.sock"'), dependency)).toBe(1);
      expect(egress(unix('"/scope/clone/x.sock"'), dependency)).toBe(0);
    });

    it("keeps the name-service sockets allowed although the plan binds their directory in (the realistic plan of this host)", () => {
      const realistic = { sandboxed: true, boundPaths: ["/run/systemd/resolve", "/opt", "/etc/resolv.conf", "/tmp/build-x"] };
      const resolve = `100 connect(5<socket:[1]>, {sa_family=AF_UNIX, sun_path="/run/systemd/resolve/io.systemd.Resolve"}, 42) = 0`;
      expect(egress(resolve, realistic)).toBe(0);
      expect(egress(resolve.replace("connect(5<socket:[1]>, ", "sendto(5<socket:[1]>, \"x\", 1, 0, ").replace("}, 42)", "}, 42)"), realistic)).toBe(0);
      for (const path of ["/run/systemd/userdb/io.systemd.Multiplexer", "/run/nscd/socket", "/var/run/nscd/socket", "/run/systemd/resolve/io.systemd.Resolve"]) {
        expect(egress(unix(`"${path}"`), realistic), path).toBe(0);
      }
      // Other sockets below the same bound directory are not name-service sockets, and a bound path elsewhere still counts.
      expect(egress(unix('"/run/systemd/private"'), realistic)).toBe(1);
      expect(egress(unix('"/opt/x.sock"'), realistic)).toBe(1);
    });

    it("counts a write below a host path bound in below /tmp, /var/tmp, /dev/shm or /run as an outside write, and a link to it", () => {
      const write = (path: string) => `100 openat(AT_FDCWD</scope/clone>, "${path}", O_WRONLY|O_CREAT, 0644) = 3<${path}>`;
      const plan = { ...ctx({ allowed: ["/scope"] }), sandboxed: true, boundPaths: ["/tmp/build-x", "/run/systemd/resolve", "/dev/shm/host"] };
      const outside = (line: string) => parseStraceLog(lines(...prelude, line.replace(/^100 /, "102 ")), plan).outsideWrites;
      expect(outside(write("/tmp/build-x/file"))).toEqual(["/tmp/build-x/file"]);
      expect(outside(write("/run/systemd/resolve/stub-resolv.conf"))).toEqual(["/run/systemd/resolve/stub-resolv.conf"]);
      expect(outside(write("/dev/shm/host/x"))).toEqual(["/dev/shm/host/x"]);
      expect(outside(`100 symlink("/tmp/build-x/target", "/scope/clone/link") = 0`)).toEqual(["/tmp/build-x/target"]);
      // The sandbox's own tmpfs stays private, and so does a sibling that only shares a prefix with a bound path.
      expect(outside(write("/tmp/other/file"))).toEqual([]);
      expect(outside(write("/tmp/build-xy/file"))).toEqual([]);
      expect(outside(`100 symlink("/tmp/other/target", "/scope/clone/link") = 0`)).toEqual([]);
    });

    it("keeps abstract, relative, other and resolved-outside paths as escapes", () => {
      expect(egress(unix('@"/tmp/codegraph-9ae10b5c0e7502a8.sock"'), sandboxed)).toBe(1);
      expect(egress(unix('"tmp/x.sock"'), sandboxed)).toBe(1);
      expect(egress(unix('"/tmpx/x.sock"'), sandboxed)).toBe(1);
      expect(egress(unix('"/tmp/../home/x.sock"'), sandboxed)).toBe(1);
      expect(egress(unix('"/var/tmp/../../run/user/1000/bus"'), sandboxed)).toBe(1);
      expect(egress(unix('"/run/user/1000/bus"'), sandboxed)).toBe(1);
      expect(egress(unix('"/tmp"'), sandboxed)).toBe(1);
    });
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
