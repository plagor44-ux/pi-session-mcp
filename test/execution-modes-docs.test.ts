import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

it("documents literal writer findings and Doctor writer ids", () => {
  const docs = read("docs/execution-modes.md");
  // ENOENT is a filesystem discriminator, not a setup finding.
  const exclusions = ["ENOENT"];
  const codes = new Set<string>();
  for (const path of ["src/setup-writers.ts", "src/writer-lifecycle.ts", "src/writer-acceptance.ts"]) {
    const source = read(path);
    // Include the failure helpers' fallback after their error-code ternary.
    for (const match of source.matchAll(/code:\s*"([^"]+)"|(?:failed|LifecycleError|Error)\("([a-z][a-z0-9_]+)"\)|:\s*"(writer_operation_failed)"/g)) {
      const code = match[1] ?? match[2] ?? match[3]!;
      if (!exclusions.includes(code)) codes.add(code);
    }
    // Conditional code values are still finding literals.
    for (const match of source.matchAll(/code:\s*[^,\n;]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)) {
      codes.add(match[1]!); codes.add(match[2]!);
    }
  }
  expect(codes.size).toBeGreaterThan(30);
  for (const code of codes) expect(docs.split("\n").filter((line) => line.startsWith(`| \`${code}\` |`)), code).toHaveLength(1);
  for (const removed of ["writer_registered", "registration_not_equivalent", "writer_reconnect_required"]) {
    expect(docs.split("\n").some((line) => line.startsWith(`| \`${removed}\` |`)), removed).toBe(false);
  }
  for (const term of ["defaultBase", "writer_unavailable", "base_not_applicable", "--reset --base <branch> --apply", "--clean", "Ignored files (opt-in)", "git clean -ffdx", "/pi/go", "/pi/uv", "--cache npm", "/pi/npm", "--cpus", "--cpu-shares", "--memory", "Resource limits"]) {
    expect(docs).toContain(term);
  }
  for (const path of ["docs/tool-contracts.md", "skills/pi-session-orchestration/references/start-errors.md"]) {
    const contract = read(path);
    for (const term of ["writer_unavailable", "writer_session_lost", "base_not_applicable", "none_ready", "none_at_base", "none_admitted", "busy", "notAtBaseline", "settingsChanged"]) {
      expect(contract, `${path}: ${term}`).toContain(term);
    }
  }
  for (const path of ["README.md", "docs/execution-modes.md", "docs/isolation-setup.md", "skills/pi-session-orchestration/SKILL.md"]) {
    const guidance = read(path);
    expect(guidance, path).not.toContain("writer_reconnect_required");
    expect(guidance, path).toMatch(/no reconnect/i);
  }
  const doctorDocs = read("docs/doctor-design.md");
  const ids = new Set([...read("src/doctor.ts").matchAll(/(?:failure|warning|ok)\("(writer_[^"]+)"/g)].map((match) => match[1]!));
  expect(ids.size).toBe(7);
  for (const id of ids) expect(doctorDocs.split("\n").filter((line) => line.startsWith(`| \`${id}\` |`)), id).toHaveLength(1);
});
