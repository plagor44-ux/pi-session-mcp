/** What the evidence and an approval are bound to: the profile evaluation's sources plus the ablation code itself. */
export const BOUND_PATH = /^(src\/|eval\/(profiles|fixtures|extensions)\/|test\/|scripts\/|package(-lock)?\.json$|tsconfig.*\.json$)/;

/** The same set as git pathspecs, for `git diff <commit> HEAD -- <pathspecs>`. */
export const BOUND_PATHSPECS: readonly string[] = [
  "src", "eval/profiles", "eval/fixtures", "eval/extensions", "test", "scripts", "package.json", "package-lock.json", ":(glob)tsconfig*.json",
];

/**
 * The bound paths named by `git status --porcelain -z` output (tracked changes and, with `--untracked-files=all`, untracked files);
 * a rename names both of its paths.
 */
export function dirtyBoundPaths(statusZ: string): string[] {
  const tokens = statusZ.split("\0").filter((t) => t !== "");
  const dirty: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const paths = [token.slice(3)];
    if (/[RC]/.test(token.slice(0, 2))) { i += 1; if (tokens[i] !== undefined) paths.push(tokens[i]!); }
    dirty.push(...paths.filter((path) => BOUND_PATH.test(path)));
  }
  return dirty;
}

/**
 * True when `git status --porcelain -z --untracked-files=all` shows a tracked change anywhere, or an untracked file under a bound path
 * (an approval or evidence must not claim code that includes an unreviewed new file there).
 */
export function sourceIsDirty(statusZ: string): boolean {
  const tokens = statusZ.split("\0").filter((t) => t !== "");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("?? ")) { if (BOUND_PATH.test(token.slice(3))) return true; continue; }
    if (token.startsWith("!! ")) continue;
    return true;
  }
  return false;
}
