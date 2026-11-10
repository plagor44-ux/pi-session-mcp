/**
 * The controller skill eval suite serves fixed worker reports. A controller that follows the skill
 * sends a report in another form back once, so a mock that drifts from the documented form changes
 * what its case measures. This keeps the served implementation reports in step with the validator.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateTextReport } from "../eval/reports/validate.js";

const evals = fileURLToPath(new URL("../eval/controller-skill/plugin/evals/", import.meta.url));

/** The terminal turn that a `pi_turn_get` mock returns; `dir` is `mocks` or `<case>/mocks`. */
function servedTurn(dir: string): { assistantText: string; truncated: boolean; completion: "stop" | "output_limit" | "tool_use" } {
  const mock = JSON.parse(readFileSync(`${evals}${dir}/pi-session-mcp/pi_turn_get.md`, "utf8")) as {
    turn: { assistantText: string; truncated: boolean; completion: "stop" | "output_limit" | "tool_use" };
  };
  return mock.turn;
}

describe("implementation reports served by the controller skill eval suite", () => {
  // `terminal-read-once` allows one read and `verify-worker-claim` expects a check, not a format follow-up.
  // The skill asks for the branch of a code task, and a controller sent a report without one back.
  it.each(["mocks", "verify-worker-claim/mocks"])("%s serves a report in the documented form, with its branch", (dir) => {
    const turn = servedTurn(dir);
    expect(validateTextReport(turn)).toMatchObject({ ok: true, report: { status: "DONE" } });
    // The validator reads the status, the commit and the checks. The other fields are checked here.
    expect(turn.assistantText).toMatch(/^Result: \S.*$/m);
    expect(turn.assistantText).toMatch(/^Branch: \S+$/m);
    expect(turn.assistantText).toMatch(/^Commit: [0-9a-f]{40}$/m);
    expect(turn.assistantText).toMatch(/^Changed files:\n- \S+ — \S/m);
    expect(turn.assistantText).toMatch(/^Checks run:\n- \S.* — exit 0\b/m);
    expect(turn.assistantText).toMatch(/^Open points:\n- \S/m);
  });

  // These two cases are about a report the controller has to send back.
  it("keeps the reports of the follow-up cases outside the form", () => {
    expect(validateTextReport(servedTurn("unstructured-report/mocks"))).toMatchObject({ ok: false, problems: ["status_missing"] });
    expect(validateTextReport(servedTurn("early-stop/mocks"))).toMatchObject({ ok: false, problems: ["commit_missing", "checks_missing"] });
  });
});
