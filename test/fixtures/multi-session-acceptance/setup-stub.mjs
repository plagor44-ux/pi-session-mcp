// Stand-in for the candidate's `pi-session-mcp-setup` (dist/setup-main.js) in prepare tests. It installs the
// controller skill as a regular copy in the project scope (its working directory), records the environment it
// was given for the test to read, and reports success. It never touches anything outside the run.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const shipped = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "pi-session-orchestration");
mkdirSync(join(process.cwd(), ".claude", "skills"), { recursive: true });
cpSync(shipped, join(process.cwd(), ".claude", "skills", "pi-session-orchestration"), { recursive: true });
writeFileSync(join(process.cwd(), "..", "setup-env.json"), JSON.stringify({ PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null, HOME: process.env.HOME ?? null }));
process.stdout.write(JSON.stringify({ findings: [{ target: { alias: "claude-code:project:pi-session-mcp" }, code: "applied" }, { target: { alias: "claude-code:project:pi-session-mcp" }, code: "skill_installed" }] }));
