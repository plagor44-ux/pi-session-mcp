import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { containerRuntimeUsable } from "./container-runtime.js";
import { sandboxBinaryTrusted } from "./sandbox-shell.js";
import { createModelCatalog, type PricedModelCatalog } from "./model-catalog.js";
import { runProfileProbe } from "./profile-probe.js";
import { createProductionSetup } from "./setup.js";
import { createProcessRunner } from "./setup-process.js";
import { changeWriterMode } from "./setup-writers.js";
import { formatSetupHuman, formatSetupResult, type SetupCliRequest } from "./setup-cli.js";
import { result, type SetupResult } from "./setup-result.js";
import { parseGuidedAnswers, type GuidedAnswers } from "./guided/answers.js";
import { collectGuidedAnswers, type Prompter } from "./guided/prompts.js";
import { runGuided, type GuidedDependencies } from "./guided/run.js";

/** Terminal interaction is stderr-only; never show a resolved path or credential. */
export function terminalPrompter(signal: AbortSignal, input: NodeJS.ReadableStream = process.stdin): { prompter: Prompter; close(): void } {
  const terminal = createInterface({ input, output: process.stderr });
  let closed = false;
  terminal.once("close", () => { closed = true; });
  const inputClosed = (): Error => Object.assign(new Error("input_closed"), { code: "input_closed" });
  const text = async (question: string, fallback = ""): Promise<string> => {
    if (closed) throw inputClosed();
    let onClose: () => void = () => {};
    const closing = new Promise<never>((_resolve, reject) => { onClose = () => reject(inputClosed()); terminal.once("close", onClose); });
    try { return (await Promise.race([terminal.question(`${question}: `, { signal }), closing])).trim() || fallback; }
    finally { terminal.off("close", onClose); }
  };
  const prompter: Prompter = {
    text,
    confirm: async (question, fallback) => {
      for (;;) {
        const answer = (await text(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`, fallback ? "yes" : "no")).toLowerCase();
        if (["y", "yes"].includes(answer)) return true;
        if (["n", "no"].includes(answer)) return false;
      }
    },
    choose: async <T extends string>(question: string, options: readonly T[], fallback: T): Promise<T> => {
      for (;;) {
        const answer = await text(`${question} (${options.join(", ")}; default ${fallback})`, fallback);
        if (options.includes(answer as T)) return answer as T;
      }
    },
  };
  return { prompter, close: () => terminal.close() };
}

async function installedClient(command: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    try { await access(join(directory || ".", command), constants.X_OK); return true; }
    catch { /* Keep checking PATH without running the client. */ }
  }
  return false;
}

function productionDependencies(configPath: string, signal: AbortSignal, catalog: () => Promise<PricedModelCatalog>): GuidedDependencies {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const runner = createProcessRunner({ signal });
  const doctor = (path: string) => runDoctor({ packageRoot, configPath: path, loadConfig: () => loadConfig(path) });
  return {
    configPath, signal, catalog,
    optionalFeatures: async () => ({ podman: await containerRuntimeUsable(), bubblewrap: sandboxBinaryTrusted() }),
    doctor,
    probe: (profiles, path) => runProfileProbe({ profiles, apply: true }, {
      configPath: path, signal, loadConfig, doctor: () => doctor(path), catalog,
      adapter: async () => {
        const { SdkPiSessionAdapter } = await import("./sdk-pi-adapter.js");
        return new SdkPiSessionAdapter({
          diagnosticSink: (diagnostic) => { process.stderr.write(JSON.stringify(diagnostic) + "\n"); },
          protectedReadPaths: [dirname(path), dirname(await realpath(path))],
        });
      },
      makeTempDir: async () => {
        const directory = await mkdtemp(join(tmpdir(), "pi-session-mcp-probe-"));
        try { await chmod(directory, 0o700); return directory; }
        catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
      },
      removeDir: (directory) => rm(directory, { recursive: true, force: true }),
    }),
    changeMode: (request, path) => changeWriterMode(path, request, { configPath: path, releaseRoot: packageRoot, signal }),
    registrations: async (operation, targets) => (await createProductionSetup(runner, packageRoot, configPath, undefined, signal)).run({ operation, targets }),
  };
}

export interface GuidedMainDependencies {
  dependencies?: GuidedDependencies;
  prompter?: Prompter;
  terminal?: boolean;
}

export async function runGuidedMain(request: NonNullable<SetupCliRequest["guided"]>, json: boolean, signal: AbortSignal, injected: GuidedMainDependencies = {}): Promise<number> {
  let output: Pick<NodeJS.WriteStream, "write"> = process.stdout;
  const write = (report: SetupResult): number => { output.write((json ? formatSetupResult(report) : formatSetupHuman(report)) + "\n"); return report.exitCode; };
  const fail = (code: string, exitCode: 1 | 64 | 130 | 143 = 1): number => write(result(request.apply ? "apply" : "dry-run", [{ target: { client: "guided", scope: "plan", alias: "installation" }, status: "failed", code }], "failed", exitCode));
  if (!request.answersPath && !(injected.terminal ?? process.stdin.isTTY)) return fail("usage_invalid", 64);
  const configPath = resolve(request.configPath ?? process.env.PI_SESSION_MCP_CONFIG ?? join(homedir(), ".config", "pi-session-mcp", "pi-session-mcp.json"));
  let terminal: ReturnType<typeof terminalPrompter> | undefined;
  try {
    let answers: GuidedAnswers;
    if (request.answersPath) {
      try { answers = parseGuidedAnswers(JSON.parse(await readFile(request.answersPath, "utf8"))); }
      catch { return fail("answers_invalid"); }
    } else {
      let existing: unknown;
      try { existing = JSON.parse(await readFile(configPath, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("operation_failed"); }
      // Reserve stdout before loading the offline SDK catalog or running a provider probe.
      if (!injected.dependencies) output = (await import("./stdout-guard-install.js")).stdoutGuard.transportStdout as NodeJS.WriteStream;
      const prompter = injected.prompter ?? (terminal = terminalPrompter(signal)).prompter;
      let catalog = await (injected.dependencies?.catalog ?? createModelCatalog)();
      for (;;) {
        const providers = catalog.providers().filter((p) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(p.id));
        process.stderr.write(`Authenticated providers: ${providers.filter((p) => p.authConfigured).map((p) => p.id).join(", ") || "none"}\n`);
        process.stderr.write(`Optional providers (not authenticated): ${providers.filter((p) => !p.authConfigured).map((p) => p.id).join(", ") || "none"}\n`);
        process.stderr.write('Log in separately with "$(npm root -g)/pi-session-mcp/node_modules/.bin/pi". Never enter credentials here.\n');
        if (catalog.providers().some((p) => p.authConfigured) || !await prompter.confirm("Re-check provider login?", false)) break;
        catalog = await (injected.dependencies?.catalog ?? createModelCatalog)();
      }
      const clients = { claudeCode: await installedClient("claude"), codex: await installedClient("codex") };
      answers = await collectGuidedAnswers(prompter, catalog, { ...(existing === undefined ? {} : { config: existing }), clients });
    }
    if (!injected.dependencies) output = (await import("./stdout-guard-install.js")).stdoutGuard.transportStdout as NodeJS.WriteStream;
    const deps = injected.dependencies ?? productionDependencies(configPath, signal, createModelCatalog);
    const report = await runGuided({ apply: request.apply, answers }, { ...deps, signal });
    if (request.apply && report.exitCode === 0 && !json) process.stderr.write("Running Claude Code and Codex clients must reconnect (for example /mcp) to see the change.\n");
    return write(report);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const allowed = ["interview_declined", "provider_login_required", "no_read_only_profile", "answers_invalid", "input_closed"];
    return fail(signal.aborted ? "operation_interrupted" : typeof code === "string" && allowed.includes(code) ? code : "operation_failed", signal.aborted ? signal.reason === 143 ? 143 : 130 : 1);
  } finally { terminal?.close(); }
}
