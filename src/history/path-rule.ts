import { posix } from "node:path";

/** Default globs whose file content history never stores (design calls 4 and 17). Configuration adds, never removes. */
export const DEFAULT_REDACT_PATHS: readonly string[] = [".env", ".env.*", "*.sops.*", "secrets/**", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "kubeconfig*"];

/** One step of a glob: a literal character (with a test of one character as the compiled glob matches it), `?`, `*`, `**` or `**` followed by `/`. */
type Step = { readonly kind: "char"; readonly char: string; readonly pattern: RegExp } | { readonly kind: "?" | "*" | "**" | "**/" };

const escape = (char: string): string => char.replace(/[\\^$.|+()[\]{}]/g, "\\$&");

const FRAGMENTS = { "?": "[^/]", "*": "[^/]*", "**": ".*", "**/": "(?:.*/)?" } as const;

// Case-insensitive: on case-insensitive file systems `.ENV` is the same file as `.env`; over-matching only drops more.
// Dot-all: a path may contain a line feed or another line terminator, and `**` must match across it.
const FLAGS = "is";

/** The work of starting one test of a regular expression, counted as characters read. */
const CALL = 16;

function literal(char: string): Step {
  return { kind: "char", char, pattern: new RegExp(`^${escape(char)}$`, FLAGS) };
}

function parse(glob: string): Step[] {
  const steps: Step[] = [];
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") { index += 1; steps.push({ kind: "**/" }); } else steps.push({ kind: "**" });
      } else steps.push({ kind: "*" });
    } else if (char === "?") steps.push({ kind: "?" });
    else steps.push(literal(char));
  }
  return steps;
}

/** The capture groups of one regular expression so far, so that each atomic part refers to its own. */
interface Groups { count: number }

const isSlash = (step: Step | undefined): boolean => step?.kind === "char" && step.char === "/";

/**
 * The source of the steps from `from` to `to` (`groups` counts the regular expression's capture
 * groups before them). A regular expression that backtracks into several wildcards can read a text
 * many times over, which no work budget counts. So a wildcard takes the shortest stretch after which
 * the steps up to the next wildcard match, and gives up no longer stretch, whenever the next
 * wildcard can take up what a longer one would have taken: a `*` before another `*` of its segment
 * or before `**`, and `**` or `**` with `/` before `**`, or before `**` with `/` when the steps in
 * between end with `/` (for `**` with `/` they may also be none). The shortest stretch is found in a
 * lookahead and consumed by a back reference, which matching never reenters. A `**` that shares
 * its segment with other characters can still backtrack.
 */
function source(steps: readonly Step[], groups: Groups, from = 0, to = steps.length): string {
  let text = "";
  for (let index = from; index < to; index += 1) {
    const step = steps[index]!;
    if (step.kind === "char") { text += escape(step.char); continue; }
    if (step.kind === "?") { text += FRAGMENTS["?"]; continue; }
    const star = step.kind === "*";
    // A `*` is followed by fixed steps up to the next wildcard; `**` by steps up to the next `**`.
    let end = index + 1;
    while (end < to && (star ? steps[end]!.kind === "char" || steps[end]!.kind === "?" : steps[end]!.kind !== "**" && steps[end]!.kind !== "**/")) end += 1;
    const next = steps[end]?.kind;
    const atomic = star
      ? next === "**" || (next === "*" && !steps.slice(index + 1, end).some(isSlash))
      : next === "**" || (next === "**/" && (end === index + 1 ? step.kind === "**/" : isSlash(steps[end - 1])));
    if (!atomic) { text += FRAGMENTS[step.kind]; continue; }
    groups.count += 1;
    const group = groups.count;
    const shortest = star ? "[^/]*?" : step.kind === "**" ? ".*?" : "(?:.*?/)??";
    text += `(?=(${shortest}${source(steps, groups, index + 1, end)}))(?:\\${group})`;
    index = end - 1;
  }
  return text;
}

/** What one test read: whether a glob matched, and how many characters it read. */
export interface Reading { readonly found: boolean; readonly cost: number }

/**
 * Globs tested on the parts of one text that run to its end. Called with the text, it reads the
 * text's end once and returns `at`, the test of the part that begins at `start`, or no `at` when no
 * part can match; `cost` counts the characters read.
 */
export type Probe = (text: string) => { readonly cost: number; readonly at: ((start: number) => Reading) | undefined };

/**
 * One glob of a probe. A glob can match a part only if the part begins with the glob's leading
 * literal characters, ends with its trailing ones and holds its longest other run of them, so these
 * are tested first.
 */
interface Alternative {
  readonly whole: RegExp;
  readonly head: RegExp | undefined;
  readonly headSource: string;
  readonly headLength: number;
  readonly tail: RegExp | undefined;
  readonly tailLength: number;
  /** Finds the last place in a text where the inner run starts. */
  readonly inner: RegExp | undefined;
  readonly innerLength: number;
}

function alternative(steps: readonly Step[]): Alternative {
  let head = 0;
  while (head < steps.length && steps[head]!.kind === "char") head += 1;
  let tail = steps.length;
  while (tail > 0 && steps[tail - 1]!.kind === "char") tail -= 1;
  let innerFrom = 0;
  let innerTo = 0;
  for (let index = head; index < tail; index += 1) {
    let end = index;
    while (end < tail && steps[end]!.kind === "char") end += 1;
    if (end - index > innerTo - innerFrom) { innerFrom = index; innerTo = end; }
    index = end;
  }
  // Each literal step matches exactly one UTF-16 code unit, so a run's length is its step count.
  // Runs of literal steps have no capture groups, so their sources can be joined freely.
  const headSource = source(steps, { count: 0 }, 0, head);
  return {
    whole: new RegExp(`(?:${source(steps, { count: 0 })})$`, `${FLAGS}y`),
    head: head === 0 ? undefined : new RegExp(headSource, `${FLAGS}y`),
    headSource,
    headLength: head,
    tail: tail === steps.length ? undefined : new RegExp(`(?:${source(steps, { count: 0 }, tail)})$`, `${FLAGS}y`),
    tailLength: steps.length - tail,
    inner: innerTo === innerFrom ? undefined : new RegExp(`^.*(?:${source(steps, { count: 0 }, innerFrom, innerTo)})`, FLAGS),
    innerLength: innerTo - innerFrom,
  };
}

function probe(globs: readonly (readonly Step[])[]): Probe {
  // An empty glob matches only an empty part, which is never tested.
  const alternatives = globs.filter((steps) => steps.length > 0).map(alternative);
  // One test of every leading run at once: a part that fails it begins with none of them.
  const headed = alternatives.filter((glob) => glob.head !== undefined);
  const anyHead = new RegExp(`(?:${headed.map((glob) => glob.headSource).join("|")})`, `${FLAGS}y`);
  const longest = Math.max(0, ...headed.map((glob) => glob.headLength));
  return (text) => {
    let cost = 0;
    const live: { readonly glob: Alternative; readonly inner: number }[] = [];
    for (const glob of alternatives) {
      if (glob.tail !== undefined) {
        cost += glob.tailLength + CALL;
        if (text.length < glob.tailLength) continue;
        glob.tail.lastIndex = text.length - glob.tailLength;
        if (!glob.tail.test(text)) continue;
      }
      let inner = 0;
      if (glob.inner !== undefined) {
        cost += text.length + CALL;
        const match = glob.inner.exec(text);
        if (match === null) continue;
        inner = match[0].length - glob.innerLength;
      }
      live.push({ glob, inner });
    }
    if (live.length === 0) return { cost, at: undefined };
    const leads = live.some(({ glob }) => glob.head !== undefined);
    return {
      cost,
      at: (start) => {
        let read = 1;
        if (start >= text.length) return { found: false, cost: read };
        let begins = false;
        if (leads) {
          read += longest + CALL;
          anyHead.lastIndex = start;
          begins = anyHead.test(text);
        }
        for (const { glob, inner } of live) {
          if (glob.inner !== undefined && inner < start + glob.headLength) continue;
          if (glob.head !== undefined) {
            if (!begins) continue;
            read += glob.headLength + CALL;
            glob.head.lastIndex = start;
            if (!glob.head.test(text)) continue;
          }
          read += text.length - start + CALL;
          glob.whole.lastIndex = start;
          if (glob.whole.test(text)) return { found: true, cost: read };
        }
        return { found: false, cost: read };
      },
    };
  };
}

/**
 * States of a glob matcher, as in the compiled regular expression: `2i` before step `i` (`2n` after
 * the last step) and `2i + 1` inside the directories of the `**` and `/` at step `i`. Adds the
 * states reachable without reading a character.
 */
function close(steps: readonly Step[], states: Set<number>): Set<number> {
  const work = [...states];
  for (let state = work.pop(); state !== undefined; state = work.pop()) {
    if (state % 2 === 1) continue;
    const kind = steps[state / 2]?.kind;
    const targets = kind === "*" || kind === "**" ? [state + 2] : kind === "**/" ? [state + 1, state + 2] : [];
    for (const target of targets) if (!states.has(target)) { states.add(target); work.push(target); }
  }
  return states;
}

function advance(steps: readonly Step[], states: ReadonlySet<number>, char: string): Set<number> {
  const next = new Set<number>();
  for (const state of states) {
    if (state % 2 === 1) {
      next.add(state);
      if (char === "/") next.add(state + 1);
      continue;
    }
    const step = steps[state / 2];
    if (step === undefined) continue;
    if (step.kind === "**") next.add(state);
    else if (step.kind === "*") { if (char !== "/") next.add(state); }
    else if (step.kind === "?") { if (char !== "/") next.add(state + 2); }
    else if (step.kind === "char" && step.pattern.test(char)) next.add(state + 2);
  }
  return close(steps, next);
}

const SLASH = literal("/");

/** The steps that may follow once a matcher is in `state`. */
function remainder(steps: readonly Step[], state: number): readonly Step[] {
  return state % 2 === 1 ? [{ kind: "**" }, SLASH, ...steps.slice((state + 1) / 2)] : steps.slice(state / 2);
}

/** The matcher states of the globs with `/` after a head: path segments that each end with `/`. */
export interface HeadState {
  /** Equal for heads whose states are equal. */
  readonly key: string;
  /** True when a glob matched the head without its last `/`, from the start of one of its segments. */
  readonly matched: boolean;
  /** One ascending list of states for each glob. */
  readonly sets: readonly (readonly number[])[];
}

/** A compiled path rule: true for a path whose file content history never stores. */
export interface PathRule {
  (path: string): boolean;
  /**
   * The rule's own steps, for a caller that sees a path in pieces, such as a grep path split over
   * lines. Without `parts` such a caller must call the rule on every whole candidate.
   */
  readonly parts?: {
    readonly normalize: (path: string) => string;
    /** The globs without `/`, on a part that holds no `/`. */
    readonly name: Probe;
    /**
     * The globs with `/`, each without a leading `**` and `/`: whatever a glob matches with that
     * beginning, it matches without it on a later part that starts after a `/`. The rule is true for
     * a normalized path when `name` is true for its last segment or `lead` for the path or for a part
     * that starts after one of its `/`.
     */
    readonly lead: Probe;
    /**
     * `lead` on the part from `start` and on each part after one of its `/`, in one pass, for the
     * globs whose `**` can only come last; `deep` is `lead` for the others, which such a pass would
     * read again for each `/`.
     */
    readonly within: (text: string, start: number) => Reading;
    readonly deep: Probe | undefined;
    /** The states before any segment is read. */
    readonly start: HeadState;
    /**
     * Reads one more segment and the `/` after it, starting a part at the segment. `work` counts the
     * matcher states read; past `limit` there is no result.
     */
    readonly read: (state: HeadState, segment: string, limit: number) => { readonly state: HeadState; readonly work: number } | undefined;
    /** The test of a non-empty rest after a head: true when `lead` is true for the rest joined to the head from the start of one of the head's segments. */
    readonly rest: (state: HeadState) => Probe | undefined;
  };
}

/** Resolves `.`, `..` and repeated separators the way the tools resolve them, so an equivalent spelling of a protected path matches too. */
function normalize(path: string): string {
  let value = path.replace(/\\/g, "/");
  if (value.startsWith("@")) value = value.slice(1);
  if (value.length === 0) return "";
  value = posix.normalize(value);
  while (value.startsWith("./")) value = value.slice(2);
  return value === "." ? "" : value.replace(/\/+$/, "");
}

/**
 * Compiles the path rule. A glob without `/` matches the basename; a glob with `/` matches the
 * path or any suffix of it that starts at a directory boundary, so `secrets/**` also matches an
 * absolute path below a `secrets` directory.
 */
export function compilePathRule(extra: readonly string[]): PathRule {
  const globs = [...DEFAULT_REDACT_PATHS, ...extra];
  const names = globs.filter((glob) => !glob.includes("/")).map(parse);
  const basename = names.map((steps) => new RegExp(`^${source(steps, { count: 0 })}$`, FLAGS));
  const cores = globs.filter((glob) => glob.includes("/")).map((glob) => {
    const steps = parse(glob);
    let start = 0;
    while (steps[start]?.kind === "**/") start += 1;
    return steps.slice(start);
  });
  // One pass for the path and every suffix that starts after a `/`.
  const alternatives = (list: readonly (readonly Step[])[]): string => {
    const groups = { count: 0 };
    return list.map((steps) => source(steps, groups)).join("|");
  };
  const anywhere = cores.length === 0 ? undefined : new RegExp(`^(?:.*/)?(?:${alternatives(cores)})$`, FLAGS);
  // A glob whose only `**` is its last step reads at most to the end of the segments it spans, or
  // to the end of the text once it matched, so one pass over a text reads each character a bounded
  // number of times.
  const linear = cores.filter((steps) => steps.every((step, index) => step.kind !== "**/" && (step.kind !== "**" || index === steps.length - 1)));
  const deep = cores.filter((steps) => !linear.includes(steps));
  const scan = linear.length === 0 ? undefined : new RegExp(`(?:.*/)?(?:${alternatives(linear)})$`, `${FLAGS}y`);
  const within = (text: string, from: number): Reading => {
    if (scan === undefined || from >= text.length) return { found: false, cost: 1 };
    scan.lastIndex = from;
    return { found: scan.test(text), cost: text.length - from + CALL };
  };
  const rule = (path: string): boolean => {
    if (typeof path !== "string") return false;
    const value = normalize(path);
    if (value.length === 0) return false;
    const last = value.slice(value.lastIndexOf("/") + 1);
    return basename.some((pattern) => pattern.test(last)) || (anywhere !== undefined && anywhere.test(value));
  };
  const keyOf = (sets: readonly (readonly number[])[]): string => sets.map((states) => states.join(",")).join(";");
  const empty = cores.map(() => []);
  const start: HeadState = { key: keyOf(empty), matched: false, sets: empty };
  const read = (state: HeadState, segment: string, limit: number): { state: HeadState; work: number } | undefined => {
    let work = 0;
    let matched = false;
    let none = true;
    const sets: (readonly number[])[] = [];
    for (let index = 0; index < cores.length; index += 1) {
      const steps = cores[index]!;
      const before = state.sets[index]!;
      // Most segments do not begin with a glob's first character, which ends its only new part at once.
      const first = steps[0];
      if (before.length === 0 && first?.kind === "char" && segment.length > 0 && !first.pattern.test(segment[0]!)) {
        work += 1;
        sets.push(before);
        continue;
      }
      let states = close(steps, new Set([...before, 0]));
      for (let position = 0; position < segment.length && states.size > 0; position += 1) {
        work += states.size + 1;
        if (work > limit) return undefined;
        states = advance(steps, states, segment[position]!);
      }
      if (states.has(2 * steps.length)) matched = true;
      work += states.size + 1;
      if (work > limit) return undefined;
      const after = [...advance(steps, states, "/")].sort((left, right) => left - right);
      if (after.length > 0) none = false;
      sets.push(after);
    }
    return { state: { key: none ? start.key : keyOf(sets), matched, sets }, work };
  };
  const rest = (state: HeadState): Probe | undefined => {
    const rests = new Map<string, readonly Step[]>();
    state.sets.forEach((states, index) => {
      const steps = cores[index]!;
      // The end state matches only an empty rest.
      for (const value of states) {
        if (value === 2 * steps.length) continue;
        const remaining = remainder(steps, value);
        rests.set(source(remaining, { count: 0 }), remaining);
      }
    });
    return rests.size === 0 ? undefined : probe([...rests.values()]);
  };
  return Object.assign(rule, { parts: { normalize, name: probe(names), lead: probe(cores), within, deep: deep.length === 0 ? undefined : probe(deep), start, read, rest } });
}
