import { posix } from "node:path";

/**
 * The caller appends `-o <log> --` and the command. `-y` annotates fds (including AT_FDCWD) with their paths.
 * `-q` (not `-qq`) keeps the `+++ exited +++` lines that free a pid's cwd; signal and exit lines are skipped by the parser.
 */
export const STRACE_ARGS: readonly string[] = [
  "-f", "-q", "-e",
  "trace=connect,openat,open,creat,rename,renameat,renameat2,unlink,unlinkat,mkdir,mkdirat,symlink,symlinkat,link,linkat,truncate,chdir,fchdir,clone,clone3,fork,vfork"
    + ",rmdir,openat2,chmod,fchmod,fchmodat,fchmodat2,chown,fchown,lchown,fchownat,utimensat,utimes,setxattr,lsetxattr,fsetxattr,removexattr,lremovexattr,fremovexattr,mknod,mknodat"
    + ",sendto,sendmsg,sendmmsg,io_uring_setup",
  "-y",
];

export interface TraceContext {
  rootPid: number;
  initialCwd: string;
  allowedWriteRoots: string[];
  providerAddresses: ReadonlySet<string>;
  dnsAddresses: ReadonlySet<string>;
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
  /** Egress that cannot be audited: every `io_uring_setup` (io_uring can connect and write without further syscalls), and resumed halves whose head is missing. */
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

/** `alt` is the ` (deleted)`-stripped reading of the same target; both are judged. */
type Resolved = { path: string; alt?: string } | { unresolved: true } | { ignore: true };
function fromVariants(bases: string[], rest?: string): Resolved {
  const [path, alt] = bases.map((b) => (rest === undefined ? posix.resolve(b) : posix.resolve(b, rest)));
  return alt === undefined || alt === path ? { path: path! } : { path: path!, alt };
}
const UNRESOLVED: Resolved = { unresolved: true };
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

const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;
const normalizeAddress = (address: string): string => {
  const lower = address.toLowerCase();
  return mappedV4.exec(lower)?.[1] ?? lower;
};

const FLAGS_WRITE = /\bO_(?:WRONLY|RDWR|CREAT|TRUNC|TMPFILE)\b/;
const EXIT_LINE = /^\+\+\+ (?:exited|killed)\b/;

/**
 * One cwd value; CLONE_FS threads share a cell, so a chdir by one is seen by all. `at` is the log line of the last change and
 * `created` the line that made the cell: both order events, because under `-f` lines of different pids arrive out of order.
 */
interface Cell { cwd: string | null; at: number; created: number }

export function parseStraceLog(text: string, ctx: TraceContext): TraceFindings {
  const roots = ctx.allowedWriteRoots.map((r) => posix.resolve("/", r));
  const provider = new Set([...ctx.providerAddresses].map(normalizeAddress));
  const dns = new Set([...ctx.dnsAddresses].map(normalizeAddress));
  const cells = new Map<number, Cell>([[ctx.rootPid, { cwd: posix.resolve("/", ctx.initialCwd), at: -1, created: -1 }]]);
  const pending = new Map<number, { head: string; seq: number }>();
  const outside = new Set<string>();
  const unexpected = new Map<string, Destination>();
  let unresolvedWrites = 0, deniedWriteAttempts = 0, connects = 0, unresolvedEgress = 0;

  // Magic links such as /proc/self/root and /proc/self/fd/N are deliberately not exempt.
  const allowed = (p: string): boolean =>
    p === "/dev/null" || p === "/dev/tty" || /^\/dev\/pts\/\d+$/.test(p)
    || roots.some((r) => r === "/" || p === r || p.startsWith(`${r}/`));
  const cwdOf = (pid: number): string | null | undefined => cells.get(pid)?.cwd;
  function setCwd(pid: number, cwd: string | null, seq: number): void {
    const cell = cells.get(pid);
    if (cell) { cell.cwd = cwd; cell.at = seq; }
    else cells.set(pid, { cwd, at: seq, created: seq });
  }

  function resolveTarget(pid: number, args: string[], t: Target): Resolved {
    if ("fd" in t) {
      const fd = parseFd(args[t.fd]);
      if (fd?.annotation === undefined) return UNRESOLVED;
      return fd.annotation.startsWith("/") ? fromVariants(pathVariants(fd.annotation)) : { ignore: true }; // socket:[n], pipe:[n], ...
    }
    const path = unquote(args[t.path]);
    if (path === null && t.nullIsDir) return resolveTarget(pid, args, { fd: t.dir! });
    if (path === undefined || path === null) return UNRESOLVED;
    if (path.startsWith("/")) return fromVariants([path]);
    let bases: string[] = [];
    if (t.dir === undefined) bases = [cwdOf(pid)].filter((b): b is string => !!b);
    else {
      const dir = parseFd(args[t.dir]);
      if (dir?.annotation?.startsWith("/")) bases = pathVariants(dir.annotation);
      else if (dir?.cwd) bases = [cwdOf(pid)].filter((b): b is string => !!b);
    }
    return bases.length ? fromVariants(bases, path) : UNRESOLVED;
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
      if ("unresolved" in r) unresolved = true;
      else if ("path" in r) {
        for (const path of [r.path, ...(r.alt === undefined ? [] : [r.alt])]) {
          if (allowed(path)) continue;
          if (failed) denied = true;
          else outside.add(path);
        }
      }
    };
    const resolved = spec.targets.map((target) => resolveTarget(pid, call.args, target));
    const kernel = spec.kernelPath && call.ret.kind === "ok" ? call.ret.annotation : undefined;
    if (kernel?.startsWith("/")) {
      // The annotation is what the kernel opened (symlinks followed); it can only make the verdict stricter than the lexical path.
      resolved.forEach((r) => { if (!("unresolved" in r)) judge(r); });
      judge(fromVariants(pathVariants(kernel)));
    } else resolved.forEach(judge);
    if (spec.symlinkTarget !== undefined) {
      const target = unquote(call.args[spec.symlinkTarget]);
      const link = resolved[0];
      if (typeof target !== "string") judge(UNRESOLVED);
      else if (target.startsWith("/")) judge(fromVariants([target]));
      else if (link && "path" in link) judge(fromVariants([link.path, ...(link.alt === undefined ? [] : [link.alt])].map((l) => posix.dirname(l)), target));
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

  /** `headSeq` is the line where the call started (the unfinished head, or the full line), `seq` the line of its return. */
  function clone(pid: number, call: Call, seq: number, headSeq: number): void {
    if (call.ret.kind !== "ok" || call.ret.value <= 0) return;
    const child = call.ret.value, parent = cells.get(pid), found = cells.get(child);
    // Under -f the child may run, and chdir, between the head and the return line. A cell from before the head belongs to an
    // earlier process with the same pid and is replaced.
    const own = found && found.created > headSeq ? found : undefined;
    const flags = /\bflags=([^,}]+)/.exec(call.args.join(","))?.[1];
    if (flags !== undefined && /\bCLONE_FS\b/.test(flags)) {
      // Threads share one cell; the later change by sequence wins, including an unknown cwd.
      const cell = parent ?? { cwd: null, at: -1, created: seq };
      if (own && own !== cell && own.at > cell.at) { cell.cwd = own.cwd; cell.at = own.at; }
      cells.set(pid, cell);
      cells.set(child, cell);
    } else if (!own) {
      // clone/clone3 whose flags cannot be read may have shared the cwd: fail closed with an unknown cwd.
      const unreadable = flags === undefined && (call.name === "clone" || call.name === "clone3");
      cells.set(child, { cwd: unreadable ? null : (parent?.cwd ?? null), at: seq, created: seq });
    }
  }

  function chdir(pid: number, call: Call, seq: number): void {
    if (call.ret.kind !== "ok" && call.ret.kind !== "progress") return;
    if (call.name === "fchdir") {
      const annotation = parseFd(call.args[0])?.annotation;
      setCwd(pid, annotation?.startsWith("/") ? posix.resolve(annotation) : null, seq);
      return;
    }
    const path = unquote(call.args[0]);
    const base = cwdOf(pid);
    setCwd(pid, typeof path !== "string" ? null : path.startsWith("/") ? posix.resolve(path) : base ? posix.resolve(base, path) : null, seq);
  }

  function handle(pid: number, body: string, seq: number, headSeq: number): void {
    const call = parseCall(body);
    if (!call) return;
    const spec = SPECS[call.name];
    if (spec) return write(pid, call, spec);
    if (call.name === "connect") return sendTarget(call.args[1], true);
    if (call.name === "sendto") return sendTarget(call.args[4]);
    if (call.name === "sendmsg" || call.name === "sendmmsg") return messageDestinations(call.args[1]).forEach(judgeDestination);
    if (call.name === "io_uring_setup") { unresolvedEgress++; return; }
    if (CLONES.has(call.name)) return clone(pid, call, seq, headSeq);
    if (call.name === "chdir" || call.name === "fchdir") chdir(pid, call, seq);
  }

  function sendTarget(token: string | undefined, isConnect = false): void {
    const d = parseSockaddr(token);
    if (isConnect && d) connects++;
    judgeDestination(d);
  }

  for (const [seq, line] of text.split("\n").entries()) {
    const m = /^(?:\[pid\s+(\d+)\]|(\d+))\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1] ?? m[2]), body = m[3]!;
    if (EXIT_LINE.test(body)) { cells.delete(pid); continue; }
    if (body.startsWith("--- ") || body.startsWith("+++ ")) continue;
    const resumed = /^<\.\.\. (\w+) resumed>([^]*)$/.exec(body);
    if (resumed) {
      const head = pending.get(pid);
      if (head === undefined) {
        // The arguments are lost, so the call cannot be judged: fail closed.
        const name = resumed[1]!;
        if (SPECS[name]) unresolvedWrites++;
        else if (SEND_CALLS.has(name) || name === "io_uring_setup") unresolvedEgress++;
        else if (name === "chdir" || name === "fchdir") setCwd(pid, null, seq);
        continue;
      }
      pending.delete(pid);
      handle(pid, head.head + resumed[2]!, seq, head.seq);
      continue;
    }
    const unfinished = /^([^]*?)\s*<unfinished \.\.\.>\s*$/.exec(body);
    if (unfinished) { pending.set(pid, { head: unfinished[1]!, seq }); continue; }
    handle(pid, body, seq, seq);
  }
  for (const [pid, head] of pending) handle(pid, head.head, head.seq, head.seq); // never resumed: still in progress

  return {
    outsideWrites: [...outside],
    unresolvedWrites,
    deniedWriteAttempts,
    unexpectedConnects: [...unexpected.values()],
    connects,
    unresolvedEgress,
  };
}
