/**
 * `auth login` refuses to run without a terminal on standard input and standard error. That keeps pipes and
 * non-interactive scripts out, but a program that allocates a pseudo-terminal passes the check, so the
 * documents must present it as a guard and leave keeping agents out of a sign-in to the rule for agents
 * (ADR 0022).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
/** A document's text with its line breaks folded, so a phrase matches across wrapped lines. */
const text = (path: string): string => readFileSync(join(root, path), "utf8").replace(/\s+/g, " ");

it.each(["docs/threat-model.md", "docs/installation.md", "docs/adr/0022-account-sign-in.md"])("%s presents the sign-in's terminal check as a guard, not as a boundary against agents", (path) => {
  expect(text(path)).not.toMatch(/an agent, a pipe or a script (?:therefore )?cannot/);
  expect(text(path)).toContain("pseudo-terminal");
});

it("does not promise that the sign-in's output reaches only the owner's terminal", () => {
  expect(text("docs/adr/0022-account-sign-in.md")).not.toMatch(/only (?:to )?the owner's terminal/);
});
