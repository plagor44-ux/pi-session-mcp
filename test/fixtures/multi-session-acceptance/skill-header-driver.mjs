// Runs one skill-discovery function of the harness in its own process, so a test can put a watchdog around it:
// a regression to a blocking read of a FIFO must fail that test within the bound instead of hanging the test worker.
// Usage: node skill-header-driver.mjs find <source dir> | header <file> | differing <json {run, candidate, context}>
import { differingCodexControllerSkills, findControllerSkills, readSkillHeader } from "../../../scripts/multi-session-acceptance.mjs";

const [mode, argument] = process.argv.slice(2);
let result;
if (mode === "find") result = findControllerSkills(argument);
else if (mode === "header") result = readSkillHeader(argument);
else if (mode === "differing") { const { run, candidate, context } = JSON.parse(argument); result = differingCodexControllerSkills(run, candidate, context); }
else throw new Error("unknown mode");
process.stdout.write(JSON.stringify(result ?? null));
