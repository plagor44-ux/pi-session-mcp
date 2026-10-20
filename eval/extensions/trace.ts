import { posix } from "node:path";

/**
 * The caller appends `-o <log> --` and the command. `-y` annotates fds (including AT_FDCWD) with their paths.
 * The trailing `-e inject=...` makes every `io_uring_setup` fail with ENOSYS (R36).
 * `-q` (not `-qq`) keeps the `+++ exited +++` lines that free a pid's cwd; signal and exit lines are skipped by the parser.
 */
export const STRACE_ARGS: readonly string[] = [
  "-f", "-q", "-e",
  "trace=connect,openat,open,creat,rename,renameat,renameat2,unlink,unlinkat,mkdir,mkdirat,symlink,symlinkat,link,linkat,truncate,chdir,fchdir,clone,clone3,fork,vfork"
    + ",rmdir,openat2,chmod,fchmod,fchmodat,fchmodat2,chown,fchown,lchown,fchownat,utimensat,utimes,setxattr,lsetxattr,fsetxattr,removexattr,lremovexattr,fremovexattr,mknod,mknodat"
    + ",sendto,sendmsg,sendmmsg,io_uring_setup,chroot,pivot_root,setns,unshare,mount,open_tree,move_mount,fsopen,fsmount,fsconfig,mount_setattr,umount2",
  "-y",
  // R36: Node's libuv calls io_uring_setup even with UV_USE_IO_URING=0 and it succeeds on some hosts. Failing it makes libuv fall back to its
  // thread pool, as on kernels without io_uring; the injected call returns -1, which the parser ignores (R23b).
  "-e", "inject=io_uring_setup:error=ENOSYS",
];

export interface TraceContext {
  rootPid: number;
  initialCwd: string;
  allowedWriteRoots: string[];
  providerAddresses: ReadonlySet<string>;
  dnsAddresses: ReadonlySet<string>;
  /** Directories whose Unix sockets a worker may connect to besides the built-in name-service allowlist (R43); the wave passes the scope root. */
  allowedSocketRoots?: string[];
}

export interface TraceFindings {
  /** Absolute targets of successful or in-progress writes outside the allowed roots, first-seen order, unique. */
  outsideWrites: string[];
  /** Write calls (successful or in progress) with at least one target that could not be resolved. */
  unresolvedWrites: number;
  /** Failed write calls with at least one resolved target outside the allowed roots. */
  deniedWriteAttempts: number;
  /** Distinct inet/inet6 destinations that are neither a provider address nor DNS on port 53. */
  unexpectedConnects: { family: "inet" | "inet6"; address: string; port: number }[];
  /** All inet/inet6 connect attempts, whatever their return value. */
  connects: number;
  /** Egress that cannot be audited: every `io_uring_setup` that did not fail, every AF_UNIX `connect` outside the allowed socket roots and every abstract socket (R43) (io_uring can connect and write without further syscalls; R23b), and resumed halves whose head is missing. */
  unresolvedEgress: number;
}

/** A write target: a path relative to `dir` (or the cwd when `dir` is absent), or an fd (`fd`). */
type Target = { dir?: number; path: number; nullIsDir?: boolean } | { fd: number };
interface Spec {
  targets: Target[];
  flags?: { arg: number; how?: boolean };
  /** A successful call returns an fd annotated with the path the kernel really opened, which wins over the lexical path. */
  kernelPath?: boolean;
  /** Argument holding the symlink target string; where it points counts as a write destination. */
  symlinkTarget?: number;
}

const cwdPath = (path: number): Target => ({ path });
const atPath = (dir: number, path: number): Target => ({ dir, path });
const SPECS: Record<string, Spec> = {
  open: { targets: [cwdPath(0)], flags: { arg: 1 }, kernelPath: true },
  openat: { targets: [atPath(0, 1)], flags: { arg: 2 }, kernelPath: true },
  openat2: { targets: [atPath(0, 1)], flags: { arg: 2, how: true }, kernelPath: true },
  creat: { targets: [cwdPath(0)], kernelPath: true },
  rename: { targets: [cwdPath(0), cwdPath(1)] },
  renameat: { targets: [atPath(0, 1), atPath(2, 3)] },
  renameat2: { targets: [atPath(0, 1), atPath(2, 3)] },
  unlink: { targets: [cwdPath(0)] },
  unlinkat: { targets: [atPath(0, 1)] },
  mkdir: { targets: [cwdPath(0)] },
  mkdirat: { targets: [atPath(0, 1)] },
  rmdir: { targets: [cwdPath(0)] },
  symlink: { targets: [cwdPath(1)], symlinkTarget: 0 },
  symlinkat: { targets: [atPath(1, 2)], symlinkTarget: 0 },
  link: { targets: [cwdPath(0), cwdPath(1)] },
  linkat: { targets: [atPath(0, 1), atPath(2, 3)] },
  truncate: { targets: [cwdPath(0)] },
  chmod: { targets: [cwdPath(0)] },
  fchmodat: { targets: [atPath(0, 1)] },
  fchmodat2: { targets: [atPath(0, 1)] },
  fchmod: { targets: [{ fd: 0 }] },
  chown: { targets: [cwdPath(0)] },
  lchown: { targets: [cwdPath(0)] },
  fchownat: { targets: [atPath(0, 1)] },
  fchown: { targets: [{ fd: 0 }] },
  utimes: { targets: [cwdPath(0)] },
  utimensat: { targets: [{ dir: 0, path: 1, nullIsDir: true }] }, // futimens(fd) is utimensat(fd, NULL, ...)
  setxattr: { targets: [cwdPath(0)] },
  lsetxattr: { targets: [cwdPath(0)] },
  fsetxattr: { targets: [{ fd: 0 }] },
  removexattr: { targets: [cwdPath(0)] },
  lremovexattr: { targets: [cwdPath(0)] },
  fremovexattr: { targets: [{ fd: 0 }] },
  mknod: { targets: [cwdPath(0)] },
  mknodat: { targets: [atPath(0, 1)] },
};
const CLONES = new Set(["clone", "clone3", "fork", "vfork"]);
const SEND_CALLS = new Set(["connect", "sendto", "sendmsg", "sendmmsg"]);
const ROOT_CHANGES = new Set(["chroot", "pivot_root", "setns", "unshare", "mount", "open_tree", "move_mount", "fsopen", "fsmount", "fsconfig", "mount_setattr", "umount2"]);

type Return = { kind: "ok"; value: number; annotation?: string } | { kind: "failed" } | { kind: "progress" };
interface Call { name: string; args: string[]; ret: Return }

/** Index of the `>` that closes a `-y` annotation opened at `open`; paths may contain `,` and `>`. */
function annotationEnd(s: string, open: number): number {
  for (let k = open + 1; k < s.length; k++) {
    if (s[k] === ">" && (k + 1 === s.length || s[k + 1] === "," || s[k + 1] === ")" || s[k + 1] === " ")) return k;
  }
  return s.length - 1;
}

/** Splits the arguments after `from` at top-level commas. `end` is the index after the closing `)`, or -1 when the call is cut off. */
function splitArgs(s: string, from: number): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0, cur = "";
  for (let i = from; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\"") {
      let j = i + 1;
      while (j < s.length && s[j] !== "\"") j += s[j] === "\\" ? 2 : 1;
      cur += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "<" && /^(?:AT_FDCWD|-?\d+)$/.test(cur.trim())) {
      const close = annotationEnd(s, i);
      cur += s.slice(i, close + 1);
      i = close;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        if (c === ")") { if (cur.trim() || args.length) args.push(cur.trim()); return { args, end: i + 1 }; }
      } else depth--;
    } else if (c === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return { args, end: -1 };
}

function parseReturn(tail: string): Return | null {
  const m = /^\s*=\s*(-?\d+|\?|0x[0-9a-f]+)(?:<(.*)>)?\s*(E[A-Z0-9]+)?/.exec(tail);
  if (!m) return null;
  // `= ? ERESTARTSYS (...)`: the call is interrupted and will be restarted, so it stays in progress and fails closed.
  if (m[3]?.startsWith("ERESTART") || m[1] === "?") return { kind: "progress" };
  const value = Number(m[1]);
  if (value < 0) return { kind: "failed" };
  return m[2] === undefined ? { kind: "ok", value } : { kind: "ok", value, annotation: decodeEscapes(m[2]) };
}

/** A call cut off before its return value (an unfinished line that never resumed, a truncated log) is in progress. */
function parseCall(text: string): Call | null {
  const m = /^([a-z_0-9]+)\(/.exec(text);
  if (!m) return null;
  const { args, end } = splitArgs(text, m[0].length);
  const ret = end < 0 ? null : parseReturn(text.slice(end));
  return { name: m[1]!, args, ret: ret ?? { kind: "progress" } };
}

/** Decodes the escapes strace uses in quoted strings and in `-y` annotations: \n, \", \\, \xHH and octal. */
function decodeEscapes(body: string): string {
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 };
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") { bytes.push(...Buffer.from(body[i]!)); continue; }
    const next = body[++i];
    if (next === undefined) { bytes.push(92); break; }
    if (next in simple) bytes.push(simple[next]!);
    else if (next === "x") { bytes.push(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; }
    else if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(body.slice(i))![0];
      bytes.push(parseInt(octal, 8));
      i += octal.length - 1;
    } else bytes.push(...Buffer.from(next));
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * A `-y` annotation is escaped like a string argument and carries ` (deleted)` for unlinked files. A real directory can also be
 * named "x (deleted)", so every verdict is made on the annotation as printed and on the stripped form, and the stricter one wins.
 */
function pathVariants(annotation: string): string[] {
  const stripped = annotation.replace(/ \(deleted\)$/, "");
  return stripped === annotation ? [annotation] : [annotation, stripped];
}

/** `undefined` when the token is not a string literal, `null` for NULL. */
function unquote(token: string | undefined): string | null | undefined {
  if (token === undefined) return undefined;
  if (token === "NULL") return null;
  const m = /^"((?:[^"\\]|\\[\s\S])*)"(?:\.\.\.)?$/.exec(token);
  return m ? decodeEscapes(m[1]!) : undefined;
}

interface Fd { cwd: boolean; annotation?: string }
function parseFd(token: string | undefined): Fd | null {
  const m = token === undefined ? null : /^(AT_FDCWD|-?\d+)(?:<([^]*)>)?$/.exec(token);
  if (!m) return null;
  const annotation = m[2] === undefined ? undefined : decodeEscapes(m[2]);
  return { cwd: m[1] === "AT_FDCWD" || m[1] === "-100", ...(annotation === undefined ? {} : { annotation }) };
}

/** Every reading of a target that must be judged (cwd candidates, ` (deleted)` variants); `unresolved` when some reading is unknown. */
type Resolved = { paths: string[]; unresolved: boolean } | { ignore: true };
const UNRESOLVED: Resolved = { paths: [], unresolved: true };
const resolveAll = (bases: string[], rest?: string): string[] =>
  [...new Set(bases.map((b) => (rest === undefined ? posix.resolve(b) : posix.resolve(b, rest))))];
type Destination = { family: "inet" | "inet6"; address: string; port: number };
const UNKNOWN_DESTINATION: Destination = { family: "inet", address: "unknown", port: 0 };

/** `null` for sockets that are not inet (AF_UNIX, AF_NETLINK, ...) and for NULL (a connected socket). A sockaddr that cannot be read is an unknown inet destination. */
function parseSockaddr(token: string | undefined): Destination | null {
  if (token === "NULL") return null;
  if (token === undefined || /^0x[0-9a-f]+$/.test(token)) return UNKNOWN_DESTINATION;
  const family = /sa_family=(AF_\w+)/.exec(token)?.[1];
  if (family !== "AF_INET" && family !== "AF_INET6") return family === undefined ? UNKNOWN_DESTINATION : null;
  const v6 = family === "AF_INET6";
  const port = new RegExp(`${v6 ? "sin6_port" : "sin_port"}=htons\\((\\d+)\\)`).exec(token)?.[1];
  const address = (v6 ? /inet_pton\(AF_INET6, "([^"]+)"/ : /inet_addr\("([^"]+)"\)/).exec(token)?.[1];
  return { family: v6 ? "inet6" : "inet", address: address ?? "unknown", port: port === undefined ? 0 : Number(port) };
}

/** The `msg_name` sockaddrs of a `sendmsg` header or a `sendmmsg` vector; NULL entries are connected-socket sends and drop out. */
function messageDestinations(token: string | undefined): (Destination | null)[] {
  const names = [...(token ?? "").matchAll(/msg_name=(NULL|\{[^}]*\}|0x[0-9a-f]+)/g)].map((m) => m[1]!);
  if (names.length === 0) return token === "[]" ? [] : [UNKNOWN_DESTINATION];
  return names.map(parseSockaddr);
}

/** Name-service sockets any process may use. Everything else on the filesystem, and every abstract socket, can reach outside the traced tree (`systemd-run --user`, D-Bus). */
const SOCKET_ALLOWLIST = ["/run/systemd/resolve/", "/run/systemd/userdb/", "/run/nscd/", "/var/run/nscd/"];

const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;
const normalizeAddress = (address: string): string => {
  const lower = address.toLowerCase();
  return mappedV4.exec(lower)?.[1] ?? lower;
};

const FLAGS_WRITE = /\bO_(?:WRONLY|RDWR|CREAT|TRUNC|TMPFILE)\b/;
const EXIT_LINE = /^\+\+\+ (?:exited|killed|superseded)\b/;

/**
 * Possible cwds of one process, or of a CLONE_FS thread group (a shared cell). `null` means unknown. The set only ever
 * over-approximates: lines of different pids arrive out of order under `-f`, so instead of trusting an order the parser keeps
 * every cwd a pid may have had and judges a relative write against all of them.
 */
interface Cell {
  cwds: Set<string | null>;
  /** Set once a CLONE_FS merge happened: chdirs then add candidates instead of replacing them. */
  shared: boolean;
  /** Line of the last change, used only to decide which records of a reused pid count for a clone return. */
  touched: number;
  forward?: Cell;
}
const root = (cell: Cell): Cell => (cell.forward ? root(cell.forward) : cell);

/**
 * Window-born taint (R24) is only known when a clone return line arrives, which can be after the tainted pid (or a pid it cloned
 * earlier) already wrote. The first pass therefore collects the taint closure and the second pass judges every line with it.
 */
export function parseStraceLog(text: string, ctx: TraceContext): TraceFindings {
  return analyze(text, ctx, analyze(text, ctx, new Set()).tainted).findings;
}

function analyze(text: string, ctx: TraceContext, seed: ReadonlySet<number>): { findings: TraceFindings; tainted: Set<number> } {
  const roots = ctx.allowedWriteRoots.map((r) => posix.resolve("/", r));
  const socketRoots = [...SOCKET_ALLOWLIST, ...(ctx.allowedSocketRoots ?? []).map((r) => posix.resolve("/", r))];
  const provider = new Set([...ctx.providerAddresses].map(normalizeAddress));
  const dns = new Set([...ctx.dnsAddresses].map(normalizeAddress));
  const live = new Map<number, Cell>();
  /** Every cell ever made for a pid, live or exited, so a clone return can find what a fast child did before it. */
  const records = new Map<number, { cell: Cell; created: number }[]>();
  const pending = new Map<number, { head: string; seq: number }>();
  /** A speculative group attachment may actually belong to a pending non-CLONE_FS parent. Local to the pid. */
  const uncertain = new Set<number>();
  /**
   * Window-born pids (R24): a pid that emitted any traced line before its parent's clone return line, and every pid they clone.
   * Such a pid may have been attached to the wrong parent, so its cwd-relative writes always count as unresolved. Never cleared.
   */
  const tainted = new Set<number>(seed);
  const children = new Map<number, number[]>();
  const taint = (pid: number): void => {
    if (tainted.has(pid)) return;
    tainted.add(pid);
    for (const child of children.get(pid) ?? []) taint(child);
  };
  /** Pids whose clone return line has been seen (or the root); a pid that emits lines before that is unclaimed. */
  const claimed = new Set<number>([ctx.rootPid]);
  const unclaimed = new Map<number, { exited: boolean }>();
  const outside = new Set<string>();
  const unexpected = new Map<string, Destination>();
  let unresolvedWrites = 0, deniedWriteAttempts = 0, connects = 0, unresolvedEgress = 0;

  function newCell(pid: number, cwds: Iterable<string | null>, seq: number): Cell {
    const cell: Cell = { cwds: new Set(cwds), shared: false, touched: seq };
    live.set(pid, cell);
    records.set(pid, [...(records.get(pid) ?? []), { cell, created: seq }]);
    return cell;
  }
  newCell(ctx.rootPid, [posix.resolve("/", ctx.initialCwd)], -1);

  // Magic links such as /proc/self/root and /proc/self/fd/N are deliberately not exempt.
  const allowed = (p: string): boolean =>
    p === "/dev/null" || p === "/dev/tty" || /^\/dev\/pts\/\d+$/.test(p)
    || roots.some((r) => r === "/" || p === r || p.startsWith(`${r}/`));
  const cellOf = (pid: number): Cell | undefined => { const c = live.get(pid); return c && root(c); };

  /** Before clone return reveals the child pid, an untracked pid may already share any pending parent's fs_struct. */
  function attachPendingGroup(pid: number, seq: number): Cell | undefined {
    const existing = cellOf(pid);
    if (existing) return existing;
    let group: Cell | undefined;
    let nonSharedParent = false;
    for (const [parentPid, head] of pending) {
      const call = parseCall(head.head);
      if (!call || !CLONES.has(call.name)) continue;
      const flags = /\bflags=([^,}]+)/.exec(call.args.join(","))?.[1];
      if (flags === undefined || !/\bCLONE_FS\b/.test(flags)) nonSharedParent = true;
      if (call.name === "fork" || call.name === "vfork" || (flags !== undefined && !/\bCLONE_FS\b/.test(flags))) continue;
      const parent = cellOf(parentPid) ?? newCell(parentPid, [null], seq);
      if (!group) group = parent;
      else if (parent !== group) {
        parent.cwds.forEach((cwd) => group!.cwds.add(cwd));
        parent.forward = group;
      }
      group.shared = true;
      if (flags === undefined) group.cwds.add(null);
    }
    if (group) {
      if (nonSharedParent) uncertain.add(pid);
      group.touched = seq;
      live.set(pid, group);
      records.set(pid, [...(records.get(pid) ?? []), { cell: group, created: seq }]);
    }
    return group;
  }

  /** Only a completed chdir replaces a lone cell; heads affect shared cells, and flushes only add candidates. */
  function changeCwd(pid: number, map: (cwd: string | null) => string | null, seq: number, mode: "complete" | "head" | "flush" = "complete"): void {
    const cell = cellOf(pid);
    if (!cell) {
      const group = attachPendingGroup(pid, seq);
      // The first relative chdir still has an unknown base; retain that uncertainty in the union.
      if (group) group.cwds.add(map(null));
      else if (mode !== "head") newCell(pid, mode === "flush" ? [null, map(null)] : [map(null)], seq);
      return;
    }
    if (mode === "head" && !cell.shared) return;
    const next = [...cell.cwds].map(map);
    if (cell.shared || mode === "flush") next.forEach((c) => cell.cwds.add(c));
    else cell.cwds = new Set(next);
    cell.touched = seq;
  }

  function resolveTarget(pid: number, args: string[], t: Target): Resolved {
    if ("fd" in t) {
      const fd = parseFd(args[t.fd]);
      if (fd?.annotation === undefined) return UNRESOLVED;
      return fd.annotation.startsWith("/") ? { paths: resolveAll(pathVariants(fd.annotation)), unresolved: false } : { ignore: true }; // socket:[n], pipe:[n], ...
    }
    const path = unquote(args[t.path]);
    if (path === null && t.nullIsDir) return resolveTarget(pid, args, { fd: t.dir! });
    if (path === undefined || path === null) return UNRESOLVED;
    if (path.startsWith("/")) return { paths: resolveAll([path]), unresolved: false };
    const fromCwd = (): Resolved => {
      const cwds = cellOf(pid)?.cwds;
      const known = [...(cwds ?? [])].filter((c): c is string => c !== null);
      return { paths: resolveAll(known, path), unresolved: uncertain.has(pid) || tainted.has(pid) || !cwds || cwds.size === 0 || cwds.has(null) };
    };
    if (t.dir === undefined) return fromCwd();
    const dir = parseFd(args[t.dir]);
    if (dir?.annotation?.startsWith("/")) return { paths: resolveAll(pathVariants(dir.annotation), path), unresolved: false };
    return dir?.cwd ? fromCwd() : UNRESOLVED;
  }

  function write(pid: number, call: Call, spec: Spec): void {
    if (spec.flags) {
      const token = call.args[spec.flags.arg];
      const flags = spec.flags.how ? /\bflags=([^,}]+)/.exec(token ?? "")?.[1] : token;
      if (flags !== undefined && !FLAGS_WRITE.test(flags)) return;
    }
    const failed = call.ret.kind === "failed";
    let unresolved = false, denied = false;
    const judge = (r: Resolved): void => {
      if ("ignore" in r) return;
      if (r.unresolved) unresolved = true;
      for (const path of r.paths) {
        if (allowed(path)) continue;
        if (failed) denied = true;
        else outside.add(path);
      }
    };
    const resolved = spec.targets.map((target) => resolveTarget(pid, call.args, target));
    const kernel = spec.kernelPath && call.ret.kind === "ok" ? call.ret.annotation : undefined;
    if (kernel?.startsWith("/")) {
      // The annotation is what the kernel opened (symlinks followed); it can only make the verdict stricter than the lexical path.
      resolved.forEach((r) => { if (!("ignore" in r)) judge({ paths: r.paths, unresolved: false }); });
      judge({ paths: resolveAll(pathVariants(kernel)), unresolved: false });
    } else resolved.forEach(judge);
    if (spec.symlinkTarget !== undefined) {
      const target = unquote(call.args[spec.symlinkTarget]);
      const link = resolved[0];
      if (typeof target !== "string") judge(UNRESOLVED);
      else if (target.startsWith("/")) judge({ paths: resolveAll([target]), unresolved: false });
      else if (link && !("ignore" in link)) judge({ paths: resolveAll(link.paths.map((l) => posix.dirname(l)), target), unresolved: link.unresolved });
      else judge(UNRESOLVED);
    }
    if (failed) { if (denied) deniedWriteAttempts++; } else if (unresolved) unresolvedWrites++;
  }

  function judgeDestination(dest: Destination | null): void {
    if (!dest) return;
    const address = normalizeAddress(dest.address);
    if (provider.has(address) || (dest.port === 53 && dns.has(address))) return;
    unexpected.set(`${dest.family}|${dest.address}|${dest.port}`, dest);
  }

  /**
   * The child starts with the parent's candidates plus every cell the child pid had since the clone head (it may have run, changed
   * directory and exited before this return line). Records older than the head belong to an earlier process with the same pid; when
   * a record might be newer it is included, because over-approximating only risks a false positive.
   */
  function clone(pid: number, call: Call, seq: number, headSeq: number): void {
    const flags = /\bflags=([^,}]+)/.exec(call.args.join(","))?.[1];
    if (call.ret.kind === "ok" && flags !== undefined && /\bCLONE_NEW[A-Z]+\b/.test(flags)) unresolvedWrites++;
    if (call.ret.kind !== "ok" || call.ret.value <= 0) return;
    const child = call.ret.value;
    uncertain.delete(child);
    const born = unclaimed.get(child);
    children.set(pid, [...(children.get(pid) ?? []), child]);
    if (born !== undefined || tainted.has(pid)) taint(child);
    unclaimed.delete(child);
    if (born === undefined || !born.exited) claimed.add(child);
    const parent = cellOf(pid);
    const own = [...new Set((records.get(child) ?? [])
      .filter((r) => r.created > headSeq || root(r.cell).touched > headSeq)
      .map((r) => root(r.cell)))].filter((c) => c !== parent);
    const unreadable = flags === undefined && (call.name === "clone" || call.name === "clone3");
    if (unreadable || (flags !== undefined && /\bCLONE_FS\b/.test(flags))) {
      const group = parent ?? newCell(pid, [null], seq);
      group.shared = true;
      if (unreadable) group.cwds.add(null);
      for (const cell of own) { cell.cwds.forEach((c) => group.cwds.add(c)); cell.forward = group; }
      group.touched = seq;
      live.set(child, group);
      records.set(child, [...(records.get(child) ?? []), { cell: group, created: seq }]);
      return;
    }
    const base: (string | null)[] = parent ? [...parent.cwds] : [null];
    // Ownership is now known: snapshot candidates without keeping or forwarding any speculative group pointer.
    newCell(child, [...base, ...own.flatMap((cell) => [...cell.cwds])], seq);
  }

  function chdir(pid: number, call: Call, seq: number, mode: "complete" | "head" | "flush" = call.ret.kind === "progress" ? "flush" : "complete"): void {
    if (call.ret.kind !== "ok" && call.ret.kind !== "progress") return;
    if (call.name === "fchdir") {
      const annotation = parseFd(call.args[0])?.annotation;
      const target = annotation?.startsWith("/") ? posix.resolve(annotation) : null;
      changeCwd(pid, () => target, seq, mode);
      return;
    }
    const path = unquote(call.args[0]);
    if (typeof path !== "string") changeCwd(pid, () => null, seq, mode);
    else if (path.startsWith("/")) changeCwd(pid, () => posix.resolve(path), seq, mode);
    else changeCwd(pid, (cwd) => (cwd === null ? null : posix.resolve(cwd, path)), seq, mode);
  }

  function handle(pid: number, body: string, seq: number, headSeq: number): void {
    const call = parseCall(body);
    if (!call) return;
    const spec = SPECS[call.name];
    if (spec) { attachPendingGroup(pid, seq); return write(pid, call, spec); }
    // Even absolute paths cannot be audited after a successful root/namespace change.
    if (ROOT_CHANGES.has(call.name)) { if (call.ret.kind !== "failed") unresolvedWrites++; return; }
    if (call.name === "connect") { if (unixConnectEscapes(call.args[1], call.ret)) unresolvedEgress++; return sendTarget(call.args[1], true); }
    if (call.name === "sendto") return sendTarget(call.args[4]);
    if (call.name === "sendmsg" || call.name === "sendmmsg") return messageDestinations(call.args[1]).forEach(judgeDestination);
    // A failed setup (`= -1 E...`) creates no ring and cannot be used for I/O (R23b); a successful or in-progress one counts.
    if (call.name === "io_uring_setup") { if (call.ret.kind !== "failed") unresolvedEgress++; return; }
    if (CLONES.has(call.name)) return clone(pid, call, seq, headSeq);
    if (call.name === "chdir" || call.name === "fchdir") chdir(pid, call, seq);
  }

  /**
   * An AF_UNIX connect that did not fail and does not stay inside the allowed roots (R43): a pathname outside the scope root and the
   * name-service allowlist, a relative pathname, or any abstract-namespace socket (`@name`).
   */
  function unixConnectEscapes(token: string | undefined, ret: Return): boolean {
    if (ret.kind === "failed" || token === undefined || !/sa_family=AF_UNIX\b/.test(token)) return false;
    const m = /sun_path=(@)?"((?:[^"\\]|\\[\s\S])*)"/.exec(token);
    if (!m) return true; // no readable path: cannot be judged
    if (m[1] === "@") return true;
    const path = decodeEscapes(m[2]!);
    if (!path.startsWith("/")) return true;
    const resolved = posix.resolve(path);
    return !socketRoots.some((r) => resolved === r || resolved.startsWith(r.endsWith("/") ? r : `${r}/`));
  }

  function sendTarget(token: string | undefined, isConnect = false): void {
    const d = parseSockaddr(token);
    if (isConnect && d) connects++;
    judgeDestination(d);
  }

  /** A head whose resume never came (killed process, reused pid, end of log) is still an in-progress call. */
  function flush(pid: number): void {
    const head = pending.get(pid);
    if (!head) return;
    pending.delete(pid);
    handle(pid, head.head, head.seq, head.seq);
  }

  for (const [seq, line] of text.split("\n").entries()) {
    const m = /^(?:\[pid\s+(\d+)\]|(\d+))\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1] ?? m[2]), body = m[3]!;
    if (!claimed.has(pid)) unclaimed.set(pid, unclaimed.get(pid) ?? { exited: false });
    const superseded = /^\+\+\+ superseded by execve in pid (\d+) \+\+\+$/.exec(body);
    if (superseded) {
      flush(pid);
      const oldTid = Number(superseded[1]);
      const cell = cellOf(oldTid);
      if (cell) {
        live.set(pid, cell);
        records.set(pid, [...(records.get(pid) ?? []), { cell, created: seq }]);
      } else live.delete(pid);
      if (oldTid !== pid) live.delete(oldTid);
      if (tainted.has(oldTid)) taint(pid);
      if (uncertain.has(oldTid)) uncertain.add(pid);
      else uncertain.delete(pid);
      if (oldTid !== pid) uncertain.delete(oldTid);
      continue;
    }
    if (EXIT_LINE.test(body)) {
      flush(pid);
      claimed.delete(pid);
      const lone = unclaimed.get(pid);
      if (lone) lone.exited = true;
      live.delete(pid); // the records stay: a clone return after this line still has to find the cell
      uncertain.delete(pid);
      continue;
    }
    if (body.startsWith("--- ") || body.startsWith("+++ ")) continue;
    const resumed = /^<\.\.\. (\w+) resumed>([^]*)$/.exec(body);
    if (resumed) {
      const head = pending.get(pid);
      if (head === undefined) {
        // The arguments are lost, so the call cannot be judged: fail closed.
        const name = resumed[1]!;
        if (SPECS[name]) { attachPendingGroup(pid, seq); unresolvedWrites++; }
        else if (ROOT_CHANGES.has(name)) {
          if (parseReturn(resumed[2]!.replace(/^\s*\)/, ""))?.kind !== "failed") unresolvedWrites++;
        }
        else if (name === "io_uring_setup") { if (parseReturn(resumed[2]!.replace(/^\s*\)/, ""))?.kind !== "failed") unresolvedEgress++; }
        else if (SEND_CALLS.has(name)) unresolvedEgress++;
        else if (name === "chdir" || name === "fchdir") changeCwd(pid, () => null, seq);
        continue;
      }
      pending.delete(pid);
      handle(pid, head.head + resumed[2]!.replace(/^\s*<unfinished \.\.\.>/, ""), seq, head.seq);
      continue;
    }
    flush(pid);
    const unfinished = /^([^]*?)\s*<unfinished \.\.\.>\s*$/.exec(body);
    if (unfinished) {
      const head = unfinished[1]!;
      const call = parseCall(head);
      if (call && SPECS[call.name]) attachPendingGroup(pid, seq);
      else if (call && (call.name === "chdir" || call.name === "fchdir")) chdir(pid, call, seq, "head");
      pending.set(pid, { head, seq });
      continue;
    }
    handle(pid, body, seq, seq);
  }
  for (const pid of [...pending.keys()]) flush(pid);

  return {
    findings: {
      outsideWrites: [...outside],
      unresolvedWrites,
      deniedWriteAttempts,
      unexpectedConnects: [...unexpected.values()],
      connects,
      unresolvedEgress,
    },
    tainted,
  };
}
