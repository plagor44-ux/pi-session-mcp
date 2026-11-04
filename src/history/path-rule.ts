/** Default globs whose file content history never stores (design calls 4 and 17). Configuration adds, never removes. */
export const DEFAULT_REDACT_PATHS: readonly string[] = [".env", ".env.*", "*.sops.*", "secrets/**", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "kubeconfig*"];

function globToRegExp(glob: string): RegExp {
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
  // Case-insensitive: on case-insensitive file systems `.ENV` is the same file as `.env`; over-matching only drops more.
  return new RegExp(`^${source}$`, "i");
}

function normalize(path: string): string {
  let value = path.replace(/\\/g, "/");
  if (value.startsWith("@")) value = value.slice(1);
  while (value.startsWith("./")) value = value.slice(2);
  return value.replace(/\/+$/, "");
}

/**
 * Compiles the path rule. A glob without `/` matches the basename; a glob with `/` matches the
 * path or any suffix of it that starts at a directory boundary, so `secrets/**` also matches an
 * absolute path below a `secrets` directory.
 */
export function compilePathRule(extra: readonly string[]): (path: string) => boolean {
  const globs = [...DEFAULT_REDACT_PATHS, ...extra];
  const basename = globs.filter((glob) => !glob.includes("/")).map(globToRegExp);
  const nested = globs.filter((glob) => glob.includes("/")).map(globToRegExp);
  return (path: string): boolean => {
    if (typeof path !== "string") return false;
    const value = normalize(path);
    if (value.length === 0) return false;
    const name = value.slice(value.lastIndexOf("/") + 1);
    if (basename.some((pattern) => pattern.test(name))) return true;
    if (nested.length === 0) return false;
    const suffixes = [value];
    for (let index = value.indexOf("/"); index !== -1; index = value.indexOf("/", index + 1)) suffixes.push(value.slice(index + 1));
    return suffixes.some((suffix) => suffix.length > 0 && nested.some((pattern) => pattern.test(suffix)));
  };
}
