#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import type { ProcessTable } from "./setup-platform.js";

type SetupPlatformModule = typeof import("./setup-platform.js");
// Source-mode tests run this guardian through Node type stripping, which cannot
// map a static `./setup-platform.js` import to its `.ts` source.
const platform = await (import(import.meta.url.endsWith(".ts") ? "./setup-platform.ts" : "./setup-platform.js") as Promise<SetupPlatformModule>);
const platformName = platform.currentSetupPlatform();
const table: ProcessTable | undefined = platformName ? platform.createProcessTable(platformName) : undefined;

type GroupState = "alive" | "gone" | "unknown";
interface RunRequest {
  readonly type: "run";
  readonly id: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}
interface AbortRequest { readonly type: "abort"; readonly id: number; }
interface ShutdownRequest { readonly type: "shutdown"; }
type Request = RunRequest | AbortRequest | ShutdownRequest;
interface ActiveExecution {
  readonly id: number;
  readonly child: ChildProcess;
  readonly group: number;
  cleanupStarted: boolean;
  resultSent: boolean;
  timeout?: NodeJS.Timeout;
}

const TERM_GRACE_MS = 100;
const CLEANUP_REPORT_MS = 2_000;
const RETRY_MS = 25;
// Each macOS scan starts `ps`, so cleanup loops poll no faster than the table allows.
const CLEANUP_RETRY_MS = Math.max(RETRY_MS, table?.pollMs ?? RETRY_MS);

let active: ActiveExecution | undefined;
let shuttingDown = false;
// Source-mode signal injection is available only to credential-free tests. The
// accepted production entry is the bound .js artifact, where this branch is off.
let forceUnknownForSourceTest = false;
if (process.argv[1]?.endsWith(".ts")) {
  process.on("SIGUSR1", () => { forceUnknownForSourceTest = true; });
  process.on("SIGUSR2", () => { forceUnknownForSourceTest = false; });
}
const parentArgument = Number(process.argv[2]);
const owningParent = Number.isSafeInteger(parentArgument) && parentArgument > 1 ? parentArgument : process.ppid;
const parentWatch = setInterval(() => {
  if (process.ppid === owningParent) return;
  shuttingDown = true;
  if (active) void terminateActive(); else exitWhenSafe();
}, RETRY_MS);

function send(message: unknown): void {
  if (process.connected) process.send?.(message, undefined, undefined, () => undefined);
}

function exitWhenSafe(): void {
  clearInterval(parentWatch);
  if (process.connected) process.disconnect();
  process.exitCode = 0;
}

function parseRequest(value: unknown): Request | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (input.type === "shutdown" && Object.keys(input).length === 1) return { type: "shutdown" };
  if (input.type === "abort" && Object.keys(input).length === 2 && Number.isSafeInteger(input.id)) return { type: "abort", id: input.id as number };
  if (input.type !== "run" || Object.keys(input).sort().join(",") !== "args,command,id,maxOutputBytes,timeoutMs,type") return undefined;
  if (!Number.isSafeInteger(input.id) || typeof input.command !== "string" || input.command.length === 0 || input.command.length > 4_096) return undefined;
  if (!Array.isArray(input.args) || input.args.length > 128 || !input.args.every((argument) => typeof argument === "string" && argument.length <= 16_384)) return undefined;
  if (!Number.isSafeInteger(input.timeoutMs) || (input.timeoutMs as number) < 1 || (input.timeoutMs as number) > 120_000) return undefined;
  if (!Number.isSafeInteger(input.maxOutputBytes) || (input.maxOutputBytes as number) < 1 || (input.maxOutputBytes as number) > 1_048_576) return undefined;
  return { type: "run", id: input.id as number, command: input.command, args: input.args as string[], timeoutMs: input.timeoutMs as number, maxOutputBytes: input.maxOutputBytes as number };
}

async function groupState(group: number): Promise<GroupState> {
  if (forceUnknownForSourceTest || !table) return "unknown";
  return table.groupState(group);
}

function signalGroup(group: number, signal: NodeJS.Signals): void {
  try { process.kill(-group, signal); } catch { /* absence is confirmed by the scan */ }
}

function bounded(value: string, maximum: number): string {
  return Buffer.from(value).subarray(0, maximum).toString("utf8");
}

function start(request: RunRequest): void {
  if (active || shuttingDown) { send({ type: "result", id: request.id, exitCode: 126, stdout: "", stderr: "" }); return; }
  let child: ChildProcess;
  try { child = spawn(request.command, [...request.args], { stdio: ["ignore", "pipe", "pipe", 3], detached: true }); }
  catch { send({ type: "result", id: request.id, exitCode: 127, stdout: "", stderr: "" }); return; }
  if (child.pid === undefined || !child.stdout || !child.stderr) { child.once("error", () => undefined); send({ type: "result", id: request.id, exitCode: 127, stdout: "", stderr: "" }); return; }
  const execution: ActiveExecution = { id: request.id, child, group: child.pid, cleanupStarted: false, resultSent: false };
  active = execution;
  let stdout = "";
  let stderr = "";
  let overflow = false;
  const collect = (stream: "stdout" | "stderr") => (chunk: Buffer): void => {
    const next = (stream === "stdout" ? stdout : stderr) + chunk.toString("utf8");
    if (Buffer.byteLength(next, "utf8") > request.maxOutputBytes) { overflow = true; return; }
    if (stream === "stdout") stdout = next; else stderr = next;
  };
  child.stdout.on("data", collect("stdout"));
  child.stderr.on("data", collect("stderr"));
  const finish = (exitCode: number): void => {
    if (execution.resultSent) return;
    execution.resultSent = true;
    if (execution.timeout) clearTimeout(execution.timeout);
    send({ type: "result", id: request.id, exitCode, stdout: bounded(stdout, request.maxOutputBytes), stderr: overflow ? "output_limit" : bounded(stderr, request.maxOutputBytes) });
  };
  const cleanup = async (reportedCode: number): Promise<void> => {
    if (execution.cleanupStarted) return;
    execution.cleanupStarted = true;
    signalGroup(execution.group, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, TERM_GRACE_MS));
    signalGroup(execution.group, "SIGKILL");
    const reportDeadline = Date.now() + CLEANUP_REPORT_MS;
    while (true) {
      const state = await groupState(execution.group);
      if (state === "gone") {
        finish(reportedCode);
        active = undefined;
        if (shuttingDown || !process.connected) exitWhenSafe();
        return;
      }
      if (!execution.resultSent && Date.now() >= reportDeadline) finish(126);
      signalGroup(execution.group, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_MS));
    }
  };
  execution.timeout = setTimeout(() => { void cleanup(124); }, request.timeoutMs);
  child.once("error", () => {
    if (execution.cleanupStarted) return;
    finish(127);
    active = undefined;
    if (shuttingDown || !process.connected) exitWhenSafe();
  });
  child.once("close", (code) => {
    if (execution.cleanupStarted) return;
    if (execution.timeout) clearTimeout(execution.timeout);
    void groupState(execution.group).then((state) => {
      if (execution.cleanupStarted) return;
      if (state === "gone") {
        finish(code ?? 1);
        active = undefined;
        if (shuttingDown || !process.connected) exitWhenSafe();
      } else void cleanup(code ?? 1);
    });
  });
}

process.on("message", (value: unknown) => {
  const request = parseRequest(value);
  if (!request) { shuttingDown = true; if (active) void terminateActive(); else { if (process.connected) process.disconnect(); process.exitCode = 64; } return; }
  if (request.type === "run") { start(request); return; }
  if (request.type === "abort") { if (active?.id === request.id) void terminateActive(); return; }
  shuttingDown = true;
  if (active) void terminateActive(); else exitWhenSafe();
});

async function terminateActive(): Promise<void> {
  const execution = active;
  if (!execution || execution.cleanupStarted) return;
  execution.cleanupStarted = true;
  if (execution.timeout) clearTimeout(execution.timeout);
  signalGroup(execution.group, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, TERM_GRACE_MS));
  signalGroup(execution.group, "SIGKILL");
  const reportDeadline = Date.now() + CLEANUP_REPORT_MS;
  while (true) {
    const state = await groupState(execution.group);
    if (state === "gone") {
      if (!execution.resultSent) { execution.resultSent = true; send({ type: "result", id: execution.id, exitCode: 125, stdout: "", stderr: "" }); }
      active = undefined;
      if (shuttingDown || !process.connected) exitWhenSafe();
      return;
    }
    if (!execution.resultSent && Date.now() >= reportDeadline) { execution.resultSent = true; send({ type: "result", id: execution.id, exitCode: 126, stdout: "", stderr: "" }); }
    signalGroup(execution.group, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_MS));
  }
}

process.on("disconnect", () => {
  shuttingDown = true;
  if (active) void terminateActive(); else exitWhenSafe();
});
process.once("SIGINT", () => { shuttingDown = true; if (active) void terminateActive(); else exitWhenSafe(); });
process.once("SIGTERM", () => { shuttingDown = true; if (active) void terminateActive(); else exitWhenSafe(); });
if (table && await table.readable()) send({ type: "ready" });
else {
  clearInterval(parentWatch);
  if (process.connected) process.disconnect();
  process.exitCode = 69;
}
