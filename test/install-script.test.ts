import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const script = join(root, "install.sh");

function run(installed = "", nodeVersion = "v22.19.0", args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "install-test-"));
  const log = join(dir, "log");
  const fake = (name: string, content: string) => {
    const path = join(dir, name); writeFileSync(path, `#!/bin/sh\n${content}\n`); chmodSync(path, 0o755);
  };
  fake("node", `if [ "$1" = "--version" ]; then echo "$NODE_VERSION"; else exec "${process.execPath}" "$@"; fi`);
  fake("npm", `printf 'npm' >> "$LOG"; printf ' <%s>' "$@" >> "$LOG"; printf '\\n' >> "$LOG"\nif [ "$1" = ls ]; then printf '%s' "$NPM_JSON"; [ -n "$INSTALLED" ]; fi`);
  fake("pi-session-mcp-setup", `printf 'setup' >> "$LOG"; printf ' <%s>' "$@" >> "$LOG"; printf '\\n' >> "$LOG"`);
  try {
    const result = spawnSync("sh", [script, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log, INSTALLED: installed, NODE_VERSION: nodeVersion, NPM_JSON: JSON.stringify({ dependencies: installed ? { "pi-session-mcp": { version: installed } } : {} }) } });
    let calls = ""; try { calls = readFileSync(log, "utf8"); } catch { /* no calls */ }
    return { ...result, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it("pins the package version", () => { expect(readFileSync(script, "utf8")).toContain(`VERSION="${version}"`); });
it("installs that exact version, then runs setup", () => { const r = run(); expect(r.status).toBe(0); expect(r.calls).toContain(`npm <install> <-g> <pi-session-mcp@${version}>`); expect(r.calls).toContain("setup <--guided> <--apply>"); });
it("skips npm install at the same version", () => { const r = run(version); expect(r.status).toBe(0); expect(r.calls).not.toContain("<install>"); expect(r.calls).toContain("setup"); });
it("stops with upgrade_required on another version", () => { const r = run("0.0.1"); expect(r.status).toBe(1); expect(r.stderr).toContain("upgrade_required"); expect(r.stderr).toContain("#upgrade"); expect(r.calls).not.toContain("<install>"); expect(r.calls).not.toContain("setup"); });
it("stops on an unsupported Node.js version", () => { const r = run("", "v22.18.0"); expect(r.status).toBe(1); expect(r.stderr).toContain("node_version_unsupported"); expect(r.calls).toBe(""); });
it("passes arguments through", () => { const r = run(version, "v22.19.0", ["--answers", "a.json"]); expect(r.status).toBe(0); expect(r.calls).toContain("setup <--guided> <--apply> <--answers> <a.json>"); });
