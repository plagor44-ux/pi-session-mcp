/** Safe, client-neutral contract used by the setup lifecycle. */
export type ClientName = "codex" | "claude-code";
export type ClientScope = "user" | "project" | "local";
export type RegistrationState = "absent" | "equivalent" | "divergent" | "unsupported";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], signal?: AbortSignal): Promise<CommandResult>;
}
export interface CommandExecution {
  readonly signal?: AbortSignal;
  readonly runner?: CommandRunner;
}

export interface ClientRegistration {
  readonly client: ClientName;
  readonly scope: ClientScope;
  readonly name: "pi-session-mcp";
  readonly state: RegistrationState;
  readonly command: "node" | "unknown";
  readonly hasExpectedConfig: boolean;
  readonly supported: boolean;
}

export interface ClientCapabilities {
  readonly client: ClientName;
  readonly version: string;
  readonly supportsJson: boolean;
  readonly supportsAdd: boolean;
  readonly supportsRemove: boolean;
  readonly scopes: readonly ClientScope[];
}

export interface RegistrationIntent {
  readonly scope: ClientScope;
  readonly nodePath: string;
  readonly entryPath: string;
  readonly configPath: string;
}

export interface RegistrationPlan {
  readonly client: ClientName;
  readonly scope: ClientScope;
  readonly state: RegistrationState;
  readonly operation: "none" | "add" | "replace";
  readonly reason: "already_registered" | "missing" | "divergent" | "unsupported";
}

export interface ClientAdapter {
  readonly client: ClientName;
  discover(): Promise<ClientCapabilities>;
  inspect(scope: ClientScope, intent: RegistrationIntent): Promise<ClientRegistration>;
  plan(intent: RegistrationIntent): Promise<RegistrationPlan>;
  add(intent: RegistrationIntent, execution?: CommandExecution): Promise<void>;
  remove(scope: ClientScope, execution?: CommandExecution): Promise<void>;
}
