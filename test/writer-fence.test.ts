import { afterEach, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "../src/client-adapters/types.js";
import { BoundaryError } from "../src/writer-boundary.js";
import { ensureWriterAbsent, FENCE_STOP_TIMEOUT_MS, writerContainerName, writerLabel } from "../src/writer-fence.js";
import { writerPaths } from "../src/writer-state.js";

const paths = writerPaths("/home/example", "repo-w1");
const ok = (stdout = "[]"): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const found = JSON.stringify([{ Id: "abc", Names: ["old"], Extra: true }]);
const listing = (filter: string) => ["ps", "-a", "--filter", filter, "--format", "json"];
afterEach(() => vi.useRealTimers());

it("derives the fixed container name and label", () => {
  expect(writerContainerName("repo-w1")).toBe("pi-writer-repo-w1");
  expect(writerLabel("repo-w1")).toBe("pi-session-mcp.writer=repo-w1");
  expect(FENCE_STOP_TIMEOUT_MS).toBe(20_000);
});
it.skipIf(process.platform !== "linux")("passes when no labelled container and no clone mount exist", async () => {
  const run = vi.fn<CommandRunner["run"]>().mockResolvedValue(ok());
  await ensureWriterAbsent({ run }, paths, "repo-w1", { leaseFd: 9 });
  expect(run.mock.calls.map(([cmd, args]) => [cmd, args])).toEqual([
    ["podman", listing("label=pi-session-mcp.writer=repo-w1")],
    ["podman", listing(`volume=${paths.clone}`)],
  ]);
  for (const call of run.mock.calls) expect(call[3]).toEqual({ inheritFds: [9] });
});
it.skipIf(process.platform !== "linux")("removes labelled and legacy clone containers, deduplicates, polls, and inherits the lease on every call", async () => {
  const run = vi.fn<CommandRunner["run"]>()
    .mockResolvedValueOnce(ok(found)).mockResolvedValueOnce(ok(JSON.stringify([
      { Id: "abc", Names: ["old"] }, { Id: "legacy", Names: [] },
    ]))).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok())
    .mockResolvedValue(ok());
  await ensureWriterAbsent({ run }, paths, "repo-w1", { leaseFd: 9 });
  expect(run.mock.calls.map(([, args]) => args)).toEqual([
    listing("label=pi-session-mcp.writer=repo-w1"), listing(`volume=${paths.clone}`),
    ["rm", "-f", "-t", "20", "abc"], ["rm", "-f", "-t", "20", "legacy"],
    listing("label=pi-session-mcp.writer=repo-w1"), listing(`volume=${paths.clone}`),
  ]);
  for (const call of run.mock.calls) {
    expect(call[2]).toBeInstanceOf(AbortSignal);
    expect(call[3]).toEqual({ inheritFds: [9] });
    expect(call[1]).not.toContain("--preserve-fds");
  }
});
it.each([
  { exitCode: 1, stdout: "[]", stderr: "secret" },
  { exitCode: 0, stdout: "[]", stderr: "output_limit" }, ok("not JSON"), ok("{}"),
  ok('[{"Id":1,"Names":[]}]'), ok('[{"Id":"abc"}]'),
])("fails closed on failed or invalid listings %j", async (result) => {
  const run = vi.fn<CommandRunner["run"]>().mockResolvedValue(result);
  await expect(ensureWriterAbsent({ run }, paths, "repo-w1", { leaseFd: 9 })).rejects.toMatchObject({ code: "writer_fenced", message: "writer_fenced" });
});
it("fails closed on a rejected command or failed removal", async () => {
  for (const run of [vi.fn<CommandRunner["run"]>().mockRejectedValue(new Error("secret")),
    vi.fn<CommandRunner["run"]>().mockResolvedValueOnce(ok(found)).mockResolvedValueOnce(ok()).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "secret" })]) {
    await expect(ensureWriterAbsent({ run }, paths, "repo-w1", { leaseFd: 9 })).rejects.toBeInstanceOf(BoundaryError);
  }
});
it("fails when a container remains listed beyond the stop timeout", async () => {
  vi.useFakeTimers();
  const run = vi.fn<CommandRunner["run"]>().mockImplementation(async (_cmd, args) => ok(args[0] === "ps" ? found : ""));
  const result = expect(ensureWriterAbsent({ run }, paths, "repo-w1", { leaseFd: 9, stopTimeoutMs: 200 })).rejects.toMatchObject({ code: "writer_fenced" });
  await vi.advanceTimersByTimeAsync(201);
  await result;
});
