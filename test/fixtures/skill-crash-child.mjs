// Runs one apply of the compiled skill installer under a durable ownership transaction and
// blocks at the requested checkpoint, so that the test can SIGKILL it exactly there.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { out, packageRoot, configPath, home, cwd, ownershipPath, stopAt } = JSON.parse(process.argv[2]);
const { FileSetupSkillInstaller } = await import(pathToFileURL(join(out, "setup-skills.js")).href);
const { DurableOwnershipStore } = await import(pathToFileURL(join(out, "setup-ownership.js")).href);
const installer = new FileSetupSkillInstaller({ packageRoot, configPath, home, cwd }, {
  checkpoint: (step) => {
    if (step !== stopAt) return undefined;
    process.stdout.write(`checkpoint:${step}\n`);
    return new Promise(() => undefined);
  },
});
const target = { client: "codex", scope: "user", alias: "pi-session-mcp" };
const findings = await new DurableOwnershipStore(ownershipPath).transaction((access) => installer.run("apply", target, access));
process.stdout.write(`finished:${JSON.stringify(findings)}\n`);
