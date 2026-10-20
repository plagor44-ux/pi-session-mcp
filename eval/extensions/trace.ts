import { posix } from "node:path";

/** The caller appends `-o <log> --` and the command. `-y` annotates fds (including AT_FDCWD) with their paths. */
export const STRACE_ARGS: readonly string[] = [
  "-f", "-qq", "-e",
  "trace=connect,openat,open,creat,rename,renameat,renameat2,unlink,unlinkat,mkdir,mkdirat,symlink,symlinkat,link,linkat,truncate,chdir,fchdir,clone,clone3,fork,vfork"
    + ",rmdir,openat2,chmod,fchmod,fchmodat,fchmodat2,chown,fchown,lchown,fchownat,utimensat,utimes,setxattr,lsetxattr,fsetxattr,removexattr,lremovexattr,fremovexattr,mknod,mknodat",
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
}

/** A write target: a path relative to `dir` (or the cwd when `dir` is absent), or an fd (`fd`). */
type Target = { dir?: number; path: number; nullIsDir?: boolean } | { fd: number };
interface Spec { targets: Target[]; flags?: { arg: number; how?: boolean } }

const cwdPath = (path: number): Target => ({ path });
const atPath = (dir: number, path: number): Target => ({ dir, path });
const SPECS: Record<string, Spec> = {
  open: { targets: [cwdPath(0)], flags: { arg: 1 } },
  openat: { targets: [atPath(0, 1)], flags: { arg: 2 } },
  openat2: { targets: [atPath(0, 1)], flags: { arg: 2, how: true } },
  creat: { targets: [cwdPath(0)] },
  rename: { targets: [cwdPath(0), cwdPath(1)] },
  renameat: { targets: [atPath(0, 1), atPath(2, 3)] },
  renameat2: { targets: [atPath(0, 1), atPath(2, 3)] },
  unlink: { targets: [cwdPath(0)] },
  unlinkat: { targets: [atPath(0, 1)] },
  mkdir: { targets: [cwdPath(0)] },
  mkdirat: { targets: [atPath(0, 1)] },
  rmdir: { targets: [cwdPath(0)] },
  symlink: { targets: [cwdPath(1)] }, // the target string (arg 0) is data, not a path being written
  symlinkat: { targets: [atPath(1, 2)] },
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

type Return = { kind: "ok"; value: number } | { kind: "failed" } | { kind: "progress" } | { kind: "restart" };
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
  const m = /^\s*=\s*(-?\d+|\?|0x[0-9a-f]+)(?:<.*>)?\s*(E[A-Z0-9]+)?/.exec(tail);
  if (!m) return null;
  if (m[1] === "?") return { kind: "progress" };
  if (m[2]?.startsWith("ERESTART")) return { kind: "restart" };
  const value = Number(m[1]);
  return value < 0 ? { kind: "failed" } : { kind: "ok", value };
}

/** A call cut off before its return value (an unfinished line that never resumed, a truncated log) is in progress. */
function parseCall(text: string): Call | null {
  const m = /^([a-z_0-9]+)\(/.exec(text);
  if (!m) return null;
  const { args, end } = splitArgs(text, m[0].length);
  const ret = end < 0 ? null : parseReturn(text.slice(end));
  return { name: m[1]!, args, ret: ret ?? { kind: "progress" } };
}

/** `undefined` when the token is not a string literal, `null` for NULL. */
function unquote(token: string | undefined): string | null | undefined {
  if (token === undefined) return undefined;
  if (token === "NULL") return null;
  const m = /^"((?:[^"\\]|\\[\s\S])*)"(?:\.\.\.)?$/.exec(token);
  if (!m) return undefined;
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 };
  const body = m[1]!, bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") { bytes.push(...Buffer.from(body[i]!)); continue; }
    const next = body[++i]!;
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

interface Fd { cwd: boolean; annotation?: string }
function parseFd(token: string | undefined): Fd | null {
  const m = token === undefined ? null : /^(AT_FDCWD|-?\d+)(?:<([^]*)>)?$/.exec(token);
  if (!m) return null;
  const annotation = m[2]?.replace(/ \(deleted\)$/, "");
  return { cwd: m[1] === "AT_FDCWD" || m[1] === "-100", ...(annotation === undefined ? {} : { annotation }) };
}

type Resolved = { path: string } | { unresolved: true } | { ignore: true };
const UNRESOLVED: Resolved = { unresolved: true };

function parseSockaddr(token: string | undefined): { family: "inet" | "inet6"; address: string; port: number } | null {
  const family = /sa_family=(AF_INET6?)\b/.exec(token ?? "")?.[1];
  if (!family) return null;
  const v6 = family === "AF_INET6";
  const port = new RegExp(`${v6 ? "sin6_port" : "sin_port"}=htons\\((\\d+)\\)`).exec(token!)?.[1];
  const address = (v6 ? /inet_pton\(AF_INET6, "([^"]+)"/ : /inet_addr\("([^"]+)"\)/).exec(token!)?.[1];
  return { family: v6 ? "inet6" : "inet", address: address ?? "unknown", port: port === undefined ? 0 : Number(port) };
}

const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;
const normalizeAddress = (address: string): string => {
  const lower = address.toLowerCase();
  return mappedV4.exec(lower)?.[1] ?? lower;
};

const FLAGS_WRITE = /\bO_(?:WRONLY|RDWR|CREAT|TRUNC|TMPFILE)\b/;

export function parseStraceLog(text: string, ctx: TraceContext): TraceFindings {
  const roots = ctx.allowedWriteRoots.map((r) => posix.resolve("/", r));
  const provider = new Set([...ctx.providerAddresses].map(normalizeAddress));
  const dns = new Set([...ctx.dnsAddresses].map(normalizeAddress));
  const cwds = new Map<number, string | null>([[ctx.rootPid, posix.resolve("/", ctx.initialCwd)]]);
  const pending = new Map<number, string>();
  const outside = new Set<string>();
  const unexpected = new Map<string, { family: "inet" | "inet6"; address: string; port: number }>();
  let unresolvedWrites = 0, deniedWriteAttempts = 0, connects = 0;

  const allowed = (p: string): boolean =>
    p === "/dev/null" || p === "/dev/tty" || p.startsWith("/dev/pts/") || p.startsWith("/proc/self/")
    || roots.some((r) => r === "/" || p === r || p.startsWith(`${r}/`));

  function resolveTarget(pid: number, args: string[], t: Target): Resolved {
    if ("fd" in t) {
      const fd = parseFd(args[t.fd]);
      if (fd?.annotation === undefined) return UNRESOLVED;
      return fd.annotation.startsWith("/") ? { path: posix.resolve(fd.annotation) } : { ignore: true }; // socket:[n], pipe:[n], ...
    }
    const path = unquote(args[t.path]);
    if (path === null && t.nullIsDir) return resolveTarget(pid, args, { fd: t.dir! });
    if (path === undefined || path === null) return UNRESOLVED;
    if (path.startsWith("/")) return { path: posix.resolve(path) };
    let base: string | null | undefined;
    if (t.dir === undefined) base = cwds.get(pid);
    else {
      const dir = parseFd(args[t.dir]);
      if (dir?.annotation?.startsWith("/")) base = dir.annotation;
      else if (dir?.cwd) base = cwds.get(pid);
    }
    return base ? { path: posix.resolve(base, path) } : UNRESOLVED;
  }

  function write(pid: number, call: Call, spec: Spec): void {
    if (call.ret.kind === "restart") return;
    if (spec.flags) {
      const token = call.args[spec.flags.arg];
      const flags = spec.flags.how ? /\bflags=([^,}]+)/.exec(token ?? "")?.[1] : token;
      if (flags !== undefined && !FLAGS_WRITE.test(flags)) return;
    }
    const failed = call.ret.kind === "failed";
    let unresolved = false, denied = false;
    for (const target of spec.targets) {
      const r = resolveTarget(pid, call.args, target);
      if ("unresolved" in r) unresolved = true;
      else if ("path" in r && !allowed(r.path)) {
        if (failed) denied = true;
        else outside.add(r.path);
      }
    }
    if (failed) { if (denied) deniedWriteAttempts++; } else if (unresolved) unresolvedWrites++;
  }

  function connect(call: Call): void {
    const dest = parseSockaddr(call.args[1]);
    if (!dest) return; // AF_UNIX, AF_NETLINK, AF_UNSPEC, ...
    connects++;
    const address = normalizeAddress(dest.address);
    if (provider.has(address) || (dest.port === 53 && dns.has(address))) return;
    unexpected.set(`${dest.family}|${dest.address}|${dest.port}`, dest);
  }

  function handle(pid: number, body: string): void {
    const call = parseCall(body);
    if (!call) return;
    const spec = SPECS[call.name];
    if (spec) return write(pid, call, spec);
    if (call.name === "connect") return connect(call);
    if (CLONES.has(call.name)) {
      if (call.ret.kind === "ok" && call.ret.value > 0) cwds.set(call.ret.value, cwds.get(pid) ?? null);
      return;
    }
    if ((call.name === "chdir" || call.name === "fchdir") && (call.ret.kind === "ok" || call.ret.kind === "progress")) {
      if (call.name === "fchdir") {
        const annotation = parseFd(call.args[0])?.annotation;
        cwds.set(pid, annotation?.startsWith("/") ? posix.resolve(annotation) : null);
        return;
      }
      const path = unquote(call.args[0]);
      const base = cwds.get(pid);
      cwds.set(pid, typeof path !== "string" ? null : path.startsWith("/") ? posix.resolve(path) : base ? posix.resolve(base, path) : null);
    }
  }

  for (const line of text.split("\n")) {
    const m = /^(?:\[pid\s+(\d+)\]|(\d+))\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1] ?? m[2]), body = m[3]!;
    if (body.startsWith("--- ") || body.startsWith("+++ ")) continue;
    const resumed = /^<\.\.\. \w+ resumed>([^]*)$/.exec(body);
    if (resumed) {
      const head = pending.get(pid);
      if (head === undefined) continue;
      pending.delete(pid);
      handle(pid, head + resumed[1]!);
      continue;
    }
    const unfinished = /^([^]*?)\s*<unfinished \.\.\.>\s*$/.exec(body);
    if (unfinished) { pending.set(pid, unfinished[1]!); continue; }
    handle(pid, body);
  }
  for (const [pid, head] of pending) handle(pid, head); // never resumed: still in progress

  return {
    outsideWrites: [...outside],
    unresolvedWrites,
    deniedWriteAttempts,
    unexpectedConnects: [...unexpected.values()],
    connects,
  };
}
