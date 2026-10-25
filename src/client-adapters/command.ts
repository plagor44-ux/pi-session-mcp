import type { CommandResult, CommandRunner } from "./types.js";

export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
export const MAX_OUTPUT_BYTES = 32_768;

/**
 * Clients are accepted by contract, not by version: an adapter supports a
 * client whose public `mcp` command output parses as expected and fails closed
 * on any other output. The version is reported for information only.
 */
export type ClientName = "codex" | "claude-code";

/**
 * Regular-expression source of the suggestion suffix that Claude Code 2.1.310 appends to the absent message
 * when a similar server name exists. Claude suggests from all its servers, including plugin servers
 * (`plugin:<plugin>:<server>`) and connectors with spaces or dots, so the suggestion is any quoted text
 * without a quote or line break, at most 256 characters. The message head pins the queried name exactly;
 * the suggestion never decides which registration is absent.
 */
export const CLAUDE_DID_YOU_MEAN_SUFFIX = String.raw`\s+Did you mean "[^"\r\n]{1,256}"\? Run \u0060claude mcp list\u0060 to see all\.`;

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
  return { run: async (command, args, signal, options) => boundedResult(await run(command, args, signal, options)) };
}
