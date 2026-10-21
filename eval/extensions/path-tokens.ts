const PATH_RUN = /[a-z0-9_.\-/]+/g;
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "proto", "graphql", "gql", "json", "md", "mdx", "py", "go", "rs", "java", "kt", "kts", "rb", "php", "c", "h", "cc", "cpp", "hpp",
  "cs", "swift", "sh", "bash", "zsh", "fish", "yaml", "yml", "toml", "ini", "cfg", "sql", "css", "scss", "sass", "less", "html", "htm", "vue",
  "svelte", "txt", "xml", "gradle", "lock", "env",
]);
/** Prose words that look like `name.ext`. */
const NOT_PATHS = new Set(["node.js", "next.js", "nuxt.js", "vue.js", "react.js", "express.js", "three.js", "d3.js", "e.g", "i.e"]);
const extensionOf = (segment: string): string | undefined => { const dot = segment.lastIndexOf("."); return dot > 0 ? segment.slice(dot + 1) : undefined; };

const WHITESPACE = /\s/g;
const isSchemeChar = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "+" || c === "." || c === "-";

/**
 * The text with every URL (`scheme://` and the non-whitespace run after it) replaced by a space, in linear time: a scheme starts with a
 * letter and continues with letters, digits, `+`, `.` or `-`, so it is the part of the scheme-character run before `://` from its first letter.
 */
export function withoutUrls(text: string): string {
  let out = "";
  let copied = 0; // text before this index has been handled
  let from = 0; // where the next "://" is looked for
  for (;;) {
    const at = text.indexOf("://", from);
    if (at < 0) break;
    from = at + 3;
    let start = at;
    while (start > copied && isSchemeChar(text[start - 1]!)) start -= 1;
    while (start < at && !(text[start]! >= "a" && text[start]! <= "z")) start += 1;
    if (start === at) continue; // no scheme before the "://"
    WHITESPACE.lastIndex = from;
    const space = WHITESPACE.exec(text);
    const end = space === null ? text.length : space.index;
    out += `${text.slice(copied, start)} `;
    copied = end;
    from = end;
  }
  return out + text.slice(copied);
}

/** The text without its trailing dots, in linear time (`/\.+$/` rescans a long run of dots from every position). */
export function withoutTrailingDots(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === ".") end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

/** A path-character run longer than this is not a path (far above any real path); it keeps the work per run bounded. */
const MAX_TOKEN_LENGTH = 4096;

/**
 * Path tokens of lower-cased text: maximal path-character runs (trailing dots trimmed), URLs excluded, that are either
 * `dir/.../name.ext` or `dir/` with a source extension or trailing slash, or a bare `name.ext` with a source extension that is not a prose word.
 * Dotted identifiers (`this.lock.release`) and slash words (`read/write`) are not paths. A run longer than 4096 characters is ignored.
 * Linear in the length of the text.
 */
export function pathTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of withoutUrls(text).matchAll(PATH_RUN)) {
    if (match[0].length > MAX_TOKEN_LENGTH) continue;
    const token = withoutTrailingDots(match[0]);
    if (token === "") continue;
    if (token.includes("/")) {
      const last = token.slice(token.lastIndexOf("/") + 1);
      const ext = extensionOf(last);
      if ((ext !== undefined && SOURCE_EXTENSIONS.has(ext)) || (token.endsWith("/") && token.length >= 3)) tokens.push(token);
    } else if (!NOT_PATHS.has(token)) {
      const ext = extensionOf(token);
      if (ext !== undefined && SOURCE_EXTENSIONS.has(ext)) tokens.push(token);
    }
  }
  return tokens;
}
