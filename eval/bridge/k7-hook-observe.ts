#!/usr/bin/env node
// K7 observation hook for the subagent probe (dev-only). The product probe adds this entry to its own disposable
// settings file with the product's wake matcher AFTER the product installer ran, so it receives the same PostToolUse
// input JSON as the shipped waiter (dist/wake-main.js) and records only allowlisted facts: the tool name and whether
// the input carries agent_id / agent_type (booleans; values are never written). It writes nothing to stdout or
// stderr, never fails the host, and always exits 0. The log path is its only argument.
import { appendFileSync } from "node:fs";

const MAX_BYTES = 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,120}$/;

async function main(): Promise<void> {
  const log = process.argv[2];
  if (typeof log !== "string" || !log.startsWith("/")) return;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BYTES) return;
    chunks.push(buffer);
  }
  let input: unknown;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return; }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return;
  const fields = input as Record<string, unknown>;
  const name = typeof fields.tool_name === "string" && SAFE_NAME.test(fields.tool_name) ? fields.tool_name : "other";
  try { appendFileSync(log, `${JSON.stringify({ tool: name, agent_id: fields.agent_id !== undefined, agent_type: fields.agent_type !== undefined })}\n`); } catch { /* best effort */ }
}

void main().catch(() => undefined);
