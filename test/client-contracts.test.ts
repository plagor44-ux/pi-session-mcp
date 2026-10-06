/**
 * Recorded client contracts: replays the exact public outputs of a real client,
 * captured in a disposable HOME, through the real adapters.
 * A client whose output or registration contract drifts fails here instead of in setup.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "../src/client-adapters/claude-code.js";
import { createCodexAdapter } from "../src/client-adapters/codex.js";
import type { ClientScope, CommandResult, CommandRunner, RegistrationIntent } from "../src/client-adapters/index.js";

interface RecordedCall extends CommandResult { readonly args: readonly string[] }
interface ClientContract { readonly description: string; readonly calls: readonly RecordedCall[] }

const paths = { nodePath: "/usr/bin/node", entryPath: "/srv/pi-session-mcp/dist/main.js", configPath: "/etc/pi-session-mcp.json" };
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  "<NODE>": paths.nodePath, "<ENTRY>": paths.entryPath, "<CONFIG>": paths.configPath, "<HOME>": "/home/user", "<PROJECT>": "/srv/project",
};

function substitute(value: string): string {
  return Object.entries(PLACEHOLDERS).reduce((text, [placeholder, path]) => text.split(placeholder).join(path), value);
}

function loadContract(name: string): ClientContract {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/client-contracts/${name}.json`, import.meta.url), "utf8")) as ClientContract;
  return { ...raw, calls: raw.calls.map((call) => ({ ...call, args: call.args.map(substitute), stdout: substitute(call.stdout), stderr: substitute(call.stderr) })) };
}

function scopeOf(args: readonly string[]): ClientScope {
  const index = args.indexOf("-s");
  return index === -1 ? "user" : args[index + 1] as ClientScope;
}

/**
 * Simulates one client from its recording. Registration state selects the recorded `mcp get`
 * answer; any call the client was never observed to answer fails the test.
 */
function simulatedClient(contract: ClientContract, overrides: { readonly version?: string } = {}): CommandRunner {
  const same = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((arg, index) => arg === right[index]);
  const absentGet = contract.calls.find((call) => call.args[1] === "get");
  const presentGet = new Map<ClientScope, RecordedCall>();
  contract.calls.forEach((call, index) => {
    const next = contract.calls[index + 1];
    if (call.args[1] === "add" && next?.args[1] === "get") presentGet.set(scopeOf(call.args), next);
  });
  let registered: ClientScope | undefined;
  return {
    async run(_command, args): Promise<CommandResult> {
      if (args[0] === "--version" && overrides.version !== undefined) return { exitCode: 0, stdout: overrides.version, stderr: "" };
      let recorded: RecordedCall | undefined;
      if (args[1] === "get") recorded = registered === undefined ? absentGet : presentGet.get(registered);
      else recorded = contract.calls.find((call) => same(call.args, args));
      if (!recorded) throw new Error(`unrecorded client call: ${args.join(" ")}`);
      if (args[1] === "add" && recorded.exitCode === 0) registered = scopeOf(args);
      if (args[1] === "remove" && recorded.exitCode === 0) registered = undefined;
      return { exitCode: recorded.exitCode, stdout: recorded.stdout, stderr: recorded.stderr };
    },
  };
}

function intentFor(scope: ClientScope, entryPath = paths.entryPath): RegistrationIntent {
  return { ...paths, scope, entryPath };
}

describe("recorded Codex CLI 0.159.2 contract", () => {
  const contract = loadContract("codex-0.159.2");

  it("discovers the version and the user scope", async () => {
    const adapter = createCodexAdapter({ runner: simulatedClient(contract) });
    expect(await adapter.discover()).toEqual({ client: "codex", version: "0.159.2", supportsJson: true, supportsAdd: true, supportsRemove: true, scopes: ["user"] });
  });

  it("runs the recorded registration cycle: absent, add, equivalent, remove, absent", async () => {
    const adapter = createCodexAdapter({ runner: simulatedClient(contract) });
    const intent = intentFor("user");
    expect((await adapter.inspect("user", intent)).state).toBe("absent");
    expect((await adapter.plan(intent)).operation).toBe("add");
    await adapter.add(intent);
    expect(await adapter.inspect("user", intent)).toMatchObject({ state: "equivalent", command: "node", hasExpectedConfig: true, supported: true });
    await adapter.remove("user");
    expect((await adapter.inspect("user", intent)).state).toBe("absent");
  });

  it("reports the recorded registration as divergent for another entry point", async () => {
    const adapter = createCodexAdapter({ runner: simulatedClient(contract) });
    await adapter.add(intentFor("user"));
    expect((await adapter.inspect("user", intentFor("user", "/srv/other/dist/main.js"))).state).toBe("divergent");
  });

  it("accepts a version that was never recorded when its outputs match the contract", async () => {
    const adapter = createCodexAdapter({ runner: simulatedClient(contract, { version: "codex-cli 0.160.0\n" }) });
    const intent = intentFor("user");
    expect(await adapter.discover()).toEqual({ client: "codex", version: "0.160.0", supportsJson: true, supportsAdd: true, supportsRemove: true, scopes: ["user"] });
    expect((await adapter.inspect("user", intent)).state).toBe("absent");
    await adapter.add(intent);
    expect((await adapter.inspect("user", intent)).state).toBe("equivalent");
  });

  it("does not depend on a parseable version line", async () => {
    const adapter = createCodexAdapter({ runner: simulatedClient(contract, { version: "WARNING: helper binaries were not created\ncodex-cli 0.159.2\n" }) });
    expect(await adapter.discover()).toEqual({ client: "codex", version: "unknown", supportsJson: true, supportsAdd: true, supportsRemove: true, scopes: ["user"] });
    expect((await adapter.inspect("user", intentFor("user"))).state).toBe("absent");
  });
});

// Each recording documents the contract of one Claude Code version; the neighbor is one never recorded.
describe.each([
  { version: "2.1.292", neighbor: "2.1.293" },
])("recorded Claude Code $version contract", ({ version, neighbor }) => {
  const contract = loadContract(`claude-code-${version}`);
  const scopes = ["user", "project", "local"] as const;

  it("discovers the version and all three scopes", async () => {
    const adapter = createClaudeCodeAdapter({ runner: simulatedClient(contract) });
    expect(await adapter.discover()).toEqual({ client: "claude-code", version, supportsJson: false, supportsAdd: true, supportsRemove: true, scopes: ["user", "project", "local"] });
  });

  for (const scope of scopes) {
    it(`runs the recorded ${scope} registration cycle: absent, add, equivalent, remove, absent`, async () => {
      const adapter = createClaudeCodeAdapter({ runner: simulatedClient(contract) });
      const intent = intentFor(scope);
      expect((await adapter.inspect(scope, intent)).state).toBe("absent");
      expect((await adapter.plan(intent)).operation).toBe("add");
      await adapter.add(intent);
      expect(await adapter.inspect(scope, intent)).toMatchObject({ state: "equivalent", command: "node", hasExpectedConfig: true, supported: true });
      const otherScope = scopes.find((candidate) => candidate !== scope)!;
      expect((await adapter.inspect(otherScope, intentFor(otherScope))).state, "a registration in another scope is not equivalent").toBe("divergent");
      await adapter.remove(scope);
      expect((await adapter.inspect(scope, intent)).state).toBe("absent");
    });
  }

  it("accepts a version that was never recorded when its outputs match the contract", async () => {
    const adapter = createClaudeCodeAdapter({ runner: simulatedClient(contract, { version: `${neighbor} (Claude Code)\n` }) });
    const intent = intentFor("user");
    expect(await adapter.discover()).toEqual({ client: "claude-code", version: neighbor, supportsJson: false, supportsAdd: true, supportsRemove: true, scopes: ["user", "project", "local"] });
    expect((await adapter.inspect("user", intent)).state).toBe("absent");
    await adapter.add(intent);
    expect((await adapter.inspect("user", intent)).state).toBe("equivalent");
  });
});
