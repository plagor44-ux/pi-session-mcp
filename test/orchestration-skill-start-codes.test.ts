import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const contracts = read("../docs/tool-contracts.md");
const skill = read("../skills/pi-session-orchestration/SKILL.md");

const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const CLASSES = ["Operator needed", "Transient", "Unknown"] as const;
type StartClass = (typeof CLASSES)[number];

function section(markdown: string, heading: RegExp, name: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) throw new Error(`heading not found: ${name}`);
  const level = /^#+/.exec(lines[start]!)![0].length;
  const end = lines.findIndex((line, index) => index > start && /^#+ /.test(line) && /^#+/.exec(line)![0].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!).filter((token) => CODE.test(token));
}

function tableCodes(table: string): string[] {
  const rows = table.split("\n").filter((line) => /^\| `/.test(line));
  if (rows.length === 0) throw new Error("no table rows found");
  return rows.flatMap((row) => backticked(row.split("|")[1]!));
}

const errorSection = section(contracts, /^## Deterministic MCP errors$/, "Deterministic MCP errors");
const [errorTable, startupTable] = errorSection.split("| Startup diagnostic code |");
if (errorTable === undefined || startupTable === undefined) throw new Error("startup diagnostic table not found");
const mcpErrorCodes = tableCodes(errorTable);
const startupCodes = tableCodes(startupTable);
const documented = new Set([...mcpErrorCodes, ...startupCodes, "unknown_workspace", "startup_failed"]);

const orchestration = section(skill, /^## 9\. /, "skill section 9");
const classBullets = (): Record<StartClass, string[]> => {
  const result = {} as Record<StartClass, string[]>;
  for (const name of CLASSES) {
    const bullets = orchestration.split("\n").filter((line) => line.startsWith(`  - ${name} (`));
    if (bullets.length !== 1) throw new Error(`expected one class bullet for ${name}, found ${bullets.length}`);
    result[name] = backticked(bullets[0]!);
  }
  return result;
};
const classes = classBullets();
const classOf = (code: string): StartClass[] => CLASSES.filter((name) => classes[name].includes(code));

describe("orchestration skill start-error classification", () => {
  it("reads the documented codes from the contract", () => {
    expect(mcpErrorCodes).toContain("unknown_execution_profile");
    expect(mcpErrorCodes).toContain("unknown_provider");
    expect(mcpErrorCodes).toContain("unknown_model");
    expect(mcpErrorCodes).toContain("local_authentication_missing");
    expect(mcpErrorCodes).toContain("local_authentication_unavailable");
    expect(mcpErrorCodes).toContain("server_stopping");
    expect(new Set(mcpErrorCodes).size).toBe(mcpErrorCodes.length);
    expect(startupCodes).toEqual(["invalid_execution_profile_config", "invalid_thinking_level"]);
  });

  it("puts every documented start code in exactly one class", () => {
    for (const code of [...mcpErrorCodes, "unknown_workspace"]) {
      expect(classOf(code), code).toHaveLength(1);
    }
  });

  it("lists no code twice within a class", () => {
    for (const name of CLASSES) expect(new Set(classes[name]).size, name).toBe(classes[name].length);
  });

  it("names no code in a class that the contract does not document", () => {
    for (const name of CLASSES) {
      for (const code of classes[name]) expect(documented.has(code), `${name}: ${code}`).toBe(true);
    }
  });

  it("keeps startup diagnostics out of the response classes and names them", () => {
    for (const code of startupCodes) expect(classOf(code), code).toEqual([]);
    for (const code of [...startupCodes, "startup_failed"]) expect(backticked(orchestration), code).toContain(code);
    expect(orchestration).toMatch(/pi-session-mcp tools are missing/);
    expect(orchestration).toMatch(/operator must fix the configuration/);
  });

  it("decides by the code alone and treats unlisted codes as unknown", () => {
    expect(orchestration).toMatch(/by its `code` alone/);
    expect(orchestration).toMatch(/Never decide by the message, provider text or any other free text/);
    expect(orchestration).toMatch(/Any code not listed above is also unknown/);
  });

  it("states the action of each class", () => {
    const bullet = (name: StartClass) => orchestration.split("\n").find((line) => line.startsWith(`  - ${name} (`))!;
    expect(bullet("Operator needed")).toMatch(/do not retry and do not switch to another profile/);
    expect(bullet("Transient")).toMatch(/retry at most once after a pause/);
    expect(bullet("Unknown")).toMatch(/at most one retry in a fresh session/);
  });
});
