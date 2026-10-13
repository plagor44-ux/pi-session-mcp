// Runs the harness CLI entry with an injected home, so a CLI test never reads the operator's real home.
// Usage: node cli-driver.mjs <home> <subcommand> [options...]; it ends the way the script's own entry does.
import { HarnessFailure, main } from "../../../scripts/multi-session-acceptance.mjs";

const [home, ...argv] = process.argv.slice(2);
try { await main(argv, { home }); } catch (error) {
  if (!(error instanceof HarnessFailure)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.code;
}
