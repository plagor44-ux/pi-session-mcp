const PATH_RUN = /[a-z0-9_.\-/]+/g;
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "proto", "graphql", "gql", "json", "md", "mdx", "py", "go", "rs", "java", "kt", "kts", "rb", "php", "c", "h", "cc", "cpp", "hpp",
  "cs", "swift", "sh", "bash", "zsh", "fish", "yaml", "yml", "toml", "ini", "cfg", "sql", "css", "scss", "sass", "less", "html", "htm", "vue",
  "svelte", "txt", "xml", "gradle", "lock", "env",
]);
/** Prose words that look like `name.ext`. */
const NOT_PATHS = new Set(["node.js", "next.js", "nuxt.js", "vue.js", "react.js", "express.js", "three.js", "d3.js", "e.g", "i.e"]);
const extensionOf = (segment: string): string | undefined => { const dot = segment.lastIndexOf("."); return dot > 0 ? segment.slice(dot + 1) : undefined; };

/**
 * Path tokens of lower-cased text: maximal path-character runs (trailing dots trimmed), URLs excluded, that are either
 * `dir/.../name.ext` or `dir/` with a source extension or trailing slash, or a bare `name.ext` with a source extension that is not a prose word.
 * Dotted identifiers (`this.lock.release`) and slash words (`read/write`) are not paths.
 */
export function pathTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/g, " ").matchAll(PATH_RUN)) {
    const token = match[0].replace(/\.+$/, "");
    if (token === "") continue;
    if (token.includes("/")) {
      const last = token.split("/").pop() ?? "";
      const ext = extensionOf(last);
      if ((ext !== undefined && SOURCE_EXTENSIONS.has(ext)) || (token.endsWith("/") && token.length >= 3)) tokens.push(token);
    } else if (!NOT_PATHS.has(token)) {
      const ext = extensionOf(token);
      if (ext !== undefined && SOURCE_EXTENSIONS.has(ext)) tokens.push(token);
    }
  }
  return tokens;
}

