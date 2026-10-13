// Runs the harness CLI entry with an injected home, Codex system skills directory and ancestor boundary, so a CLI
// test never reads the operator's real home or /etc. Usage: node cli-driver.mjs <home> <etc skills dir> <boundary>
// <subcommand> [options...]; it ends the way the script's own entry does.
import { HarnessFailure, main } from "../../../scripts/multi-session-acceptance.mjs";

const [home, etcCodexSkills, ancestorBoundary, ...argv] = process.argv.slice(2);
try { await main(argv, { home, etcCodexSkills, ancestorBoundary }); } catch (error) {
  if (!(error instanceof HarnessFailure)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.code;
}
