import type { CommandResult, CommandRunner } from "./types.js";

export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
export const MAX_OUTPUT_BYTES = 32_768;

/**
 * Clients are accepted by contract, not by version: an adapter supports a
 * client whose public `mcp` command output parses as expected and fails closed
 * on any other output. The version is reported for information only.
 */
export type ClientName = "codex" | "claude-code";

export function boundedResult(result: CommandResult): CommandResult {
  const truncate = (value: string): string => {
    const bytes = Buffer.from(value, "utf8");
    return bytes.byteLength <= MAX_OUTPUT_BYTES ? value : bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  };
  return {
    exitCode: result.exitCode,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
  };
}

export function versionFromOutput(client: ClientName, output: string): string | undefined {
  // Each CLI has its own complete public line. Keep the boundary narrow: `\\s`
  // would accept arbitrary additional lines and trailing diagnostic text.
  const pattern = client === "codex"
    ? /^[ \t]*codex(?:-cli)?[ \t]+v?(\d+\.\d+\.\d+)[ \t]*(?:\r?\n)?$/
    : /^[ \t]*(?:(?:claude(?:-code)?)[ \t]+)?v?(\d+\.\d+\.\d+)(?:[ \t]+\(Claude Code\))?[ \t]*(?:\r?\n)?$/;
  const match = pattern.exec(output);
  return match?.[1];
}

export function safeRunner(run: CommandRunner["run"]): CommandRunner {
  return { run: async (command, args, signal) => boundedResult(await run(command, args, signal)) };
}
