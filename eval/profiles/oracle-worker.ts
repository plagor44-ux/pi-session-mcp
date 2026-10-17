import { evaluateTask } from "./oracles.js";

const INPUT_LIMIT = 1024 * 1024;

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > INPUT_LIMIT) throw new Error("input_limit");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const input = JSON.parse(await readInput()) as {
    root: string; taskId: string; workspace: string; receipt: unknown;
    artifactRoot?: string; view?: string;
  };
  const result = await evaluateTask(input.taskId, input.workspace, input.receipt, input.artifactRoot, input.view);
  // Only oracle findings cross back to the runner. Paths, prompts, and raw errors
  // remain in the worker's private input or are discarded.
  process.stdout.write(JSON.stringify({ status: result.status, checks: result.checks, metrics: result.metrics ?? {} }));
} catch {
  process.exitCode = 1;
}
