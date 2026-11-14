import { compilePathRule, DEFAULT_REDACT_PATHS } from "../src/history/path-rule.js";

/** The plain translation of a glob into a regular expression, without the rule's measures against backtracking. */
function plain(glob: string): string {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") { index += 1; source += "(?:.*/)?"; } else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
  }
  return source;
}

/**
 * The path rule as the plain translations of its globs decide it, a reference for the compiled rule
 * and for the grep check: a glob without `/` tests the basename, a glob with `/` the normalized path
 * and every part of it that starts after a `/`.
 */
export function plainPathRule(extra: readonly string[]): (path: string) => boolean {
  const globs = [...DEFAULT_REDACT_PATHS, ...extra];
  const names = globs.filter((glob) => !glob.includes("/")).map((glob) => new RegExp(`^${plain(glob)}$`, "is"));
  const nested = globs.filter((glob) => glob.includes("/")).map((glob) => new RegExp(`^(?:.*/)?(?:${plain(glob)})$`, "is"));
  const { normalize } = compilePathRule([]).parts!;
  return (path) => {
    const value = normalize(path);
    if (value.length === 0) return false;
    const last = value.slice(value.lastIndexOf("/") + 1);
    return names.some((pattern) => pattern.test(last)) || nested.some((pattern) => pattern.test(value));
  };
}

/** A small deterministic generator (mulberry32), so a failing case can be replayed from its seed. */
export function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const GLOB_PIECES = ["a", "b", "x", "s", "/", "/", "/", "*", "*", "*", "**", "**/", "?", ".", "ab", "secret"];

/** A glob of up to seven pieces, often with several wildcards in one segment and `**` inside segments. */
export function generatedGlob(random: () => number): string {
  let glob = "";
  for (let count = 1 + Math.floor(random() * 7); count > 0; count -= 1) glob += GLOB_PIECES[Math.floor(random() * GLOB_PIECES.length)]!;
  return glob;
}
