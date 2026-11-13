import type { HeadState, PathRule, Probe, Reading } from "./path-rule.js";

/**
 * The longest path a grep line can print. Linux limits a path to 4096 bytes (PATH_MAX, terminator
 * included), and the UTF-16 length of a string never exceeds its UTF-8 byte count.
 */
const MAX_PATH_LENGTH = 4096;

/**
 * Work the check may spend on one tool result, counted as characters read: each character it
 * resolves or tests counts once, and each segment, candidate, test and matcher state it handles
 * counts as the characters its work is worth. Ordinary grep results of Pi's maximum size use at most
 * about a third of it. Past the budget, the remaining lines with a separator are dropped unchecked.
 */
export const GREP_CHECK_BUDGET = 500_000_000;

/** The work of one segment or candidate besides its characters, counted as characters read. */
const SEGMENT = 16;

/** The work of one matcher state read for a head, counted as characters read. */
const MATCHER_STATE = 64;

interface Budget { left: number }

/** Charges `cost` to the budget; true once the budget is spent. */
function spend(budget: Budget, cost: number): boolean {
  budget.left -= cost;
  return budget.left < 0;
}

/** Start of each `:N:` (match) or `-N-` (context) separator in `line`, overlapping ones included. */
function separators(line: string): number[] {
  const found: number[] = [];
  const pattern = /(?=:\d+:|-\d+-)/g;
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    found.push(match.index);
    pattern.lastIndex = match.index + 1;
  }
  return found;
}

/** Index of the first element of the ascending `values` that is at least `value`. */
function firstAtLeast(values: ArrayLike<number>, value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Tests the paths that end at `end`, inside line `line`; true also once the budget is spent. */
type Check = (line: number, end: number, budget: Budget) => boolean;

/**
 * Drops the lines of Pi grep output that may show content of a file the rule protects.
 *
 * Pi prints `path:N: text` for a match and `path-N- text` for a context line, with the path relative
 * to the search root, and joins the lines with LF. The text never holds an LF, but a path can, and a
 * path can hold a `:N:` or `-N-` of its own, so a line cannot be split into path and text with
 * certainty. A line is dropped when one reading makes it content of a protected file: the path ends
 * at any separator of the line and starts at the line start or, for a path with an LF, at the start
 * of an earlier line at most MAX_PATH_LENGTH before that separator; the rule is applied to it alone
 * and joined onto `root`. This drops more than needed, for example the lines that follow a
 * `secrets/` line within that distance. Lines without a separator hold no file content and stay.
 */
export function filterGrepText(text: string, root: string | undefined, rule: PathRule, budget: Budget): { text: string; dropped: boolean } {
  const prefix = root === undefined || root === "." || root === "" ? "" : `${root.replace(/\/+$/, "")}/`;
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let index = 0, position = 0; index < lines.length; position += lines[index]!.length + 1, index += 1) starts.push(position);
  const check = rule.parts === undefined ? wholeCheck(text, starts, prefix, rule) : partsCheck(text, starts, prefix, rule.parts);
  let dropped = false;
  const kept = lines.filter((line, index) => {
    const ends = separators(line);
    if (ends.length === 0) return true;
    const drop = ends.some((end) => check(index, starts[index]! + end, budget));
    dropped ||= drop;
    return !drop;
  });
  return { text: kept.join("\n"), dropped };
}

/** The first line that can start a path ending at `end` in line `line`: the line itself, or an earlier one that starts at most MAX_PATH_LENGTH before `end`. */
function firstLine(starts: readonly number[], line: number, end: number): number {
  return Math.min(line, firstAtLeast(starts, end - MAX_PATH_LENGTH));
}

/** Applies a rule without parts to each candidate whole. */
function wholeCheck(text: string, starts: readonly number[], prefix: string, rule: PathRule): Check {
  return (line, end, budget) => {
    for (let index = line, first = firstLine(starts, line, end); index >= first; index -= 1) {
      const path = text.slice(starts[index]!, end);
      if (spend(budget, 2 * (path.length + 1) + prefix.length) || rule(path) || (prefix !== "" && rule(prefix + path))) return true;
    }
    return false;
  };
}

const DOT = 46;
const AT = 64;

/** How posix.normalize treats a segment: it drops an empty one or `.` (SKIP), resolves `..` (UP), and keeps a name (NAME). */
const SKIP = 0;
const UP = 1;
const NAME = 2;

function segmentKind(view: string, from: number, to: number): number {
  const length = to - from;
  if (length === 0) return SKIP;
  if (length > 2 || view.charCodeAt(from) !== DOT) return NAME;
  if (length === 1) return SKIP;
  return view.charCodeAt(from + 1) === DOT ? UP : NAME;
}

/** The `..` segments that a path's first segment, of `kind`, leaves for what precedes it when `owed` of them follow it. */
function rise(kind: number, owed: number): number {
  return kind === UP ? owed + 1 : kind === SKIP ? owed : owed - 1;
}

/** The normalized search root: absolute or not, its leading `..` segments, then its names. */
interface Root { readonly absolute: boolean; readonly up: number; readonly names: readonly string[] }

function resolveRoot(prefix: string, normalize: (path: string) => string): Root {
  let raw = prefix.replace(/\\/g, "/");
  if (raw.startsWith("@")) raw = raw.slice(1);
  const absolute = raw.startsWith("/");
  const normalized = normalize(prefix);
  const segments = normalized === "" ? [] : (absolute ? normalized.slice(1) : normalized).split("/");
  let up = 0;
  while (up < segments.length && segments[up] === "..") up += 1;
  return { absolute, up, names: segments.slice(up) };
}

/** Normalized segments that a candidate is joined onto: the matcher states after them, and the last one ("" when there is none). */
interface Head { readonly state: HeadState; readonly last: string; alone?: boolean }

/**
 * Applies the rule's parts to every candidate that ends at a separator, as the rule applies them to
 * the normalized candidate: `name` to its last segment and `lead` to it and to each part that
 * starts after one of its `/`.
 */
function partsCheck(text: string, starts: readonly number[], prefix: string, parts: NonNullable<PathRule["parts"]>): Check {
  const { name, lead, within, deep } = parts;
  // The rule reads a backslash as `/`; the replacement keeps every position.
  const view = text.replace(/\\/g, "/");
  const slashes: number[] = [];
  for (let index = view.indexOf("/"); index !== -1; index = view.indexOf("/", index + 1)) slashes.push(index);
  const searchRoot = prefix === "" ? undefined : resolveRoot(prefix, parts.normalize);
  // Each head is read once, from the one before it: `ups[j]` is j `..` segments, and `rootHeads[k]`
  // the root's `..` segments (or its `/` when it is absolute) followed by k of its names.
  const ups: Head[] = [{ state: parts.start, last: "" }];
  const rootHeads: Head[] = [];
  const rests = new Map<string, Probe | undefined>();
  const extend = (head: Head, segment: string, budget: Budget): Head | undefined => {
    if (spend(budget, SEGMENT + segment.length)) return undefined;
    const read = parts.read(head.state, segment, budget.left / MATCHER_STATE);
    // A read without a result would cost more than is left, so it spends the budget.
    if (read === undefined) { budget.left = -1; return undefined; }
    return spend(budget, MATCHER_STATE * read.work) ? undefined : { state: read.state, last: segment };
  };
  const upHead = (count: number, budget: Budget): Head | undefined => {
    while (ups.length <= count) {
      const head = extend(ups[ups.length - 1]!, "..", budget);
      if (head === undefined) return undefined;
      ups.push(head);
    }
    return ups[count];
  };
  // The root after `carried` `..` segments of the candidate took away its last names.
  const rootHead = (root: Root, carried: number, budget: Budget): Head | undefined => {
    if (!root.absolute && carried > root.names.length) return upHead(root.up + carried - root.names.length, budget);
    if (rootHeads.length === 0) {
      const base = root.absolute ? extend(ups[0]!, "", budget) : upHead(root.up, budget);
      if (base === undefined) return undefined;
      rootHeads.push(base);
    }
    const count = root.names.length - Math.min(carried, root.names.length);
    while (rootHeads.length <= count) {
      const head = extend(rootHeads[rootHeads.length - 1]!, root.names[rootHeads.length - 1]!, budget);
      if (head === undefined) return undefined;
      rootHeads.push(head);
    }
    return rootHeads[count];
  };
  const restOf = (head: Head): Probe | undefined => {
    const { key } = head.state;
    if (!rests.has(key)) rests.set(key, parts.rest(head.state));
    return rests.get(key);
  };
  // The head as the whole normalized path, without its last `/`.
  const alone = (head: Head, budget: Budget): boolean => {
    if (head.last === "") return false;
    if (head.alone === undefined) {
      let found = head.state.matched;
      if (!found) {
        const { cost, at } = name(head.last);
        const reading = at?.(0);
        if (spend(budget, cost + (reading?.cost ?? 0))) return true;
        found = reading?.found === true;
      }
      head.alone = found;
    }
    return head.alone;
  };
  return (line, end, budget) => {
    const first = firstLine(starts, line, end);
    const low = starts[first]!;
    // Resolve the longest candidate right to left as posix.normalize does: a `..` takes away the
    // nearest name to its left that no other `..` took, and empty and `.` segments vanish. Every
    // candidate ends with the same segments, so all share this walk and differ in the first segment.
    const a = firstAtLeast(slashes, low);
    const b = firstAtLeast(slashes, end);
    if (spend(budget, 2 * (end - low) + SEGMENT * (b - a + line - first + 1))) return true;
    const pendingAfter = new Int32Array(b - a);
    const keptFrom: number[] = [];
    const keptTo: number[] = [];
    let pending = 0;
    let to = end;
    for (let index = b - 1; index >= a; index -= 1) {
      const slash = slashes[index]!;
      const kind = segmentKind(view, slash + 1, to);
      if (kind === UP) pending += 1;
      else if (kind === NAME) {
        if (pending > 0) pending -= 1;
        else { keptFrom.push(slash + 1); keptTo.push(to); }
      }
      pendingAfter[index - a] = pending;
      to = slash;
    }
    // Before the first `/` lies the first segment of the longest candidate, which holds the start of
    // every candidate that starts before that `/`.
    if (segmentKind(view, low, to) === NAME && pending === 0) { keptFrom.push(low); keptTo.push(to); }
    keptFrom.reverse();
    keptTo.reverse();
    // The kept segments, each after a `/`: segment k begins at `begins[k]` of `rooted`.
    const pieces = keptFrom.map((from, index) => view.slice(from, keptTo[index]));
    const rooted = `/${pieces.join("/")}`;
    const begins: number[] = [];
    for (let index = 0, offset = 1; index < pieces.length; offset += pieces[index]!.length + 1, index += 1) begins.push(offset);
    const prepared = new Map<Probe, ((start: number) => Reading) | undefined>();
    const test = (probe: Probe | undefined, start: number): boolean => {
      if (probe === undefined) return false;
      if (!prepared.has(probe)) {
        const { cost, at } = probe(rooted);
        prepared.set(probe, at);
        if (spend(budget, cost)) return true;
      }
      const at = prepared.get(probe);
      if (at === undefined) return false;
      const reading = at(start);
      return spend(budget, reading.cost) || reading.found;
    };
    const joined = (head: Head | undefined, rest: number): boolean => {
      if (head === undefined) return true;
      return rest >= 0 ? test(restOf(head), rest) : alone(head, budget);
    };
    // The segments after a `/` are whole in every candidate that holds them: the last one, and each
    // part that starts at one of them, are tested once for all candidates.
    const whole = keptFrom[0] === low ? 1 : 0;
    if (whole < pieces.length) {
      if (test(name, begins[pieces.length - 1]!)) return true;
      const scan = within(rooted, begins[whole]!);
      if (spend(budget, scan.cost) || scan.found) return true;
      if (deep !== undefined) for (let index = whole; index < pieces.length; index += 1) if (test(deep, begins[index]!)) return true;
    }
    // Candidates come in order, so the first `/` at or after a candidate's start, and its first kept
    // segment after that start, only move forward.
    for (let index = first, slash = a, next = 0; index <= line; index += 1) {
      const start = starts[index]!;
      while (slash < b && slashes[slash]! < start) slash += 1;
      while (next < keptFrom.length && keptFrom[next]! <= start) next += 1;
      const boundary = slash < b ? slashes[slash]! : end;
      const owed = slash < b ? pendingAfter[slash - a]! : 0;
      // The kept segments after the candidate's first one begin with segment `next`, at `rest`.
      const rest = next < pieces.length ? begins[next]! : -1;
      // When the first segment stays, it is a suffix of the longest candidate's segment `next - 1`,
      // which then stays too; a position `from` in it lies at `shift + from` of `rooted`.
      const shift = next > 0 ? begins[next - 1]! - keptFrom[next - 1]! : 0;
      // The candidate alone: the rule drops a leading `@`, and a leading `/` makes it absolute.
      const own = view.charCodeAt(start) === AT ? start + 1 : start;
      if (own === boundary) {
        if (boundary < end && rest >= 0 && test(lead, rest - 1)) return true;
      } else {
        const kind = segmentKind(view, own, boundary);
        if (kind === NAME && owed === 0) {
          if (test(lead, shift + own) || (rest < 0 && test(name, shift + own))) return true;
        } else if (joined(upHead(rise(kind, owed), budget), rest)) return true;
      }
      // The candidate joined onto the root, where its `@` is no longer leading.
      if (searchRoot !== undefined) {
        const kind = segmentKind(view, start, boundary);
        if (kind === NAME && owed === 0) {
          if (own !== start && (test(lead, shift + start) || (rest < 0 && test(name, shift + start)))) return true;
          if (joined(rootHead(searchRoot, 0, budget), shift + start)) return true;
        } else if (joined(rootHead(searchRoot, rise(kind, owed), budget), rest)) return true;
      }
    }
    return false;
  };
}
