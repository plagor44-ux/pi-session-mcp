import { spawn } from "node:child_process";
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
  stderrTerminal?: boolean;
  setProviderKey?: (provider: string) => Promise<number>;
  /** Runs `pi-session-mcp-provider auth login` on the owner's terminal (ADR 0022). */
  signIn?: (provider: string, noBrowser: boolean) => Promise<number>;
  /** The default answer to opening a browser for a sign-in; detected from the environment when omitted. */
  browserDefault?: boolean;
  /** Runs a credential command with Ctrl-C left to that command; `setup-main` passes its SIGINT gate (ADR 0022). */
  deferInterrupts?: <T>(run: () => Promise<T>) => Promise<T>;
}

const runDirectly = <T>(run: () => Promise<T>): Promise<T> => run();

/** The child's stdout goes to stderr: guided setup's stdout carries only its final report. */
export const CREDENTIAL_CHILD_STDIO = Object.freeze(["inherit", 2, "inherit"] as const);

const providerEntry = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "provider-main.js");

/** Child inherits the owner's terminal; only its exit status returns to guided setup. */
function runProviderCommand(args: readonly string[], entry: string): Promise<number> {
  return new Promise((resolveStatus) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: [...CREDENTIAL_CHILD_STDIO] });
    child.once("error", () => resolveStatus(1));
    child.once("exit", code => resolveStatus(code ?? 1));
  });
}

export function setProviderKeyInTerminal(provider: string, entry = providerEntry()): Promise<number> {
  return runProviderCommand(["auth", "set", provider], entry);
}

/** `auth login` runs Pi's own sign-in dialogue on the owner's terminal (ADR 0022). */
export function signInInTerminal(provider: string, noBrowser: boolean, entry = providerEntry()): Promise<number> {
  return runProviderCommand(["auth", "login", provider, ...(noBrowser ? ["--no-browser"] : [])], entry);
}

/** A browser on this machine is unlikely in an SSH session, and on Linux without a display. */
export function opensBrowserByDefault(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const set = (name: string): boolean => (env[name] ?? "") !== "";
  if (set("SSH_CONNECTION") || set("SSH_TTY")) return false;
  return platform !== "linux" || set("DISPLAY") || set("WAYLAND_DISPLAY");
}

/** A provider ID that is safe to print on the owner's terminal. */
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/** The catalog's printable provider IDs, one line for the authenticated and one for the others. */
function providerListing(catalog: PricedModelCatalog): string {
  const providers = catalog.providers().filter((p) => SAFE_PROVIDER_ID.test(p.id));
  const ids = (authenticated: boolean): string => providers.filter((p) => p.authConfigured === authenticated).map((p) => p.id).join(", ") || "none";
  return `Authenticated providers: ${ids(true)}\nOptional providers (not authenticated): ${ids(false)}\n`;
}

/** Levenshtein distance between two strings. */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** Up to three catalog IDs near a typed value: a few edits away, ignoring case, or containing it. */
function closestProviderIds(typed: string, ids: readonly string[]): string[] {
  const value = typed.toLowerCase();
  if (value.length > 256) return [];
  const limit = Math.max(1, Math.floor(value.length / 3));
  return ids
    .map((id) => {
      const candidate = id.toLowerCase();
      return { id, contains: value.length >= 3 && candidate.includes(value), distance: editDistance(value, candidate) };
    })
    .filter(({ contains, distance }) => contains || distance <= limit)
    .sort((left, right) => left.distance - right.distance || (left.id < right.id ? -1 : 1))
    .slice(0, 3)
    .map(({ id }) => id);
}

/**
 * `auth set` and `auth login` exit with these before they change anything: provider_unknown (3),
 * credential_invalid, sign_in_unsupported or provider_key_stored (4) and usage_invalid (64).
 */
const CREDENTIAL_UNCHANGED_EXITS: ReadonlySet<number> = new Set([3, 4, 64]);

/** The step's `?` listing: the provider listing and the providers that declare account sign-in. */
function signInListing(catalog: PricedModelCatalog): string {
  const ids = catalog.providers().filter((p) => p.signIn === true && SAFE_PROVIDER_ID.test(p.id)).map((p) => p.id).join(", ") || "none";
  return `${providerListing(catalog)}Providers with account sign-in: ${ids}\n`;
}

/** What the credential step runs; each command takes over the owner's terminal and returns only its exit status. */
export interface CredentialStep {
  readonly reload: () => Promise<PricedModelCatalog>;
  readonly setKey: (provider: string) => Promise<number>;
  readonly signIn: (provider: string, noBrowser: boolean) => Promise<number>;
  readonly report: (text: string) => void;
  readonly browserDefault: boolean;
}

export async function offerProviderCredentials(prompter: Prompter, catalog: PricedModelCatalog, step: CredentialStep): Promise<PricedModelCatalog> {
  // Pi's catalog lists dozens of providers, so the owner names the ones to configure instead of being asked about each.
  step.report("Pi Session MCP can sign you in to a provider account or store an API key, for each provider you name, one at a time.\n"
    + "At each provider question, ? lists the IDs and an empty answer continues.\n");
  if (!(await prompter.confirm("Sign in to a provider or store a key now?", false))) return catalog;
  let configured = false;
  for (;;) {
    const id = (await prompter.text(`${configured ? "Another provider ID" : "Provider ID"} (? lists them, empty to continue)`, "")).trim();
    if (id === "") return catalog;
    if (id === "?") { step.report(signInListing(catalog)); continue; }
    const ids = catalog.providers().map((p) => p.id).filter((value) => SAFE_PROVIDER_ID.test(value));
    if (!ids.includes(id)) {
      // Name catalog IDs only: the typed value may be a key entered at the wrong question.
      const near = closestProviderIds(id, ids);
      step.report(near.length ? `Unknown provider ID. Closest: ${near.join(", ")}. Enter ? to list all.\n` : "Unknown provider ID. Enter ? to list all provider IDs.\n");
      continue;
    }
    const signIn = catalog.providers().some((p) => p.id === id && p.signIn === true)
      && await prompter.choose(`${id}: sign in with an account or store an API key?`, ["sign-in", "key"] as const, "sign-in") === "sign-in";
    const status = signIn
      ? await step.signIn(id, !(await prompter.confirm("Open a browser on this machine to sign in?", step.browserDefault)))
      : await step.setKey(id);
    catalog = await step.reload();
    const authenticated = catalog.providers().some((p) => p.id === id && p.authConfigured);
    // After a success the command itself has said what it stored or replaced.
    if (status === 0 && authenticated) { configured = true; continue; }
    const command = signIn ? "sign-in" : "key command";
    step.report(status === 0 ? `${id}: ${command} succeeded, but not authenticated\n`
      : CREDENTIAL_UNCHANGED_EXITS.has(status) ? `${id}: nothing changed, ${authenticated ? "still authenticated" : "not authenticated"}\n`
        : `${id}: ${command} failed, ${authenticated ? "authenticated" : "not authenticated"}\n`
          // A sign-in that Pi stored before the provider store failed leaves the provider at none.
          + (signIn && !authenticated ? `If Pi stored the sign-in anyway, "pi-session-mcp-provider auth inherit ${id}" enables it.\n` : ""));
  }
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
      let prompter = injected.prompter ?? (terminal = terminalPrompter(signal)).prompter;
      const reload = injected.dependencies?.catalog ?? createModelCatalog;
      let catalog = await reload();
      if (request.apply && (injected.terminal ?? process.stdin.isTTY) && (injected.stderrTerminal ?? process.stderr.isTTY)) {
        const currentPrompter: Prompter = {
          text: (question, fallback) => prompter.text(question, fallback),
          confirm: (question, fallback) => prompter.confirm(question, fallback),
          choose: (question, options, fallback) => prompter.choose(question, options, fallback),
        };
        // A credential command owns the terminal while it runs: close the prompter, leave Ctrl-C to the command, reopen.
        const handOver = async (command: () => Promise<number>): Promise<number> => {
          terminal?.close(); terminal = undefined;
          try { return await (injected.deferInterrupts ?? runDirectly)(command); }
          catch { return 1; }
          finally { if (!injected.prompter) prompter = (terminal = terminalPrompter(signal)).prompter; }
        };
        catalog = await offerProviderCredentials(currentPrompter, catalog, {
          reload,
          setKey: (provider) => handOver(() => (injected.setProviderKey ?? setProviderKeyInTerminal)(provider)),
          signIn: (provider, noBrowser) => handOver(() => (injected.signIn ?? signInInTerminal)(provider, noBrowser)),
          report: (text) => { process.stderr.write(text); },
          browserDefault: injected.browserDefault ?? opensBrowserByDefault(process.env, process.platform),
        });
      }
      for (;;) {
        process.stderr.write(providerListing(catalog));
        process.stderr.write('Sign in with "pi-session-mcp-provider auth login <provider>" or store a key with "pi-session-mcp-provider auth set <provider>". Never enter credentials here.\n');
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
