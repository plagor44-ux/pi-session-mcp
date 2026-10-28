import { expect, it } from "vitest";
import { podmanCgroupControllers } from "../src/writer-boundary.js";
import { sameWriterLimits, writerLimits } from "../src/writer-limits.js";

it.each([
  [{ host: { cgroupControllers: ["cpu", "memory", "pids"] } }, ["cpu", "memory", "pids"]],
  [{ host: {} }, []], [{}, []], [{ host: { cgroupControllers: "cpu" } }, []],
  [{ host: { cgroupControllers: ["cpu", 1] } }, []],
])("probes cgroup controllers fail-closed for %j", async (info, expected) => {
  expect(await podmanCgroupControllers({ run: async (command, args, signal) => {
    expect(command).toBe("podman");
    expect(args).toEqual(["info", "--format", "json"]);
    expect(signal).toBeDefined();
    return { exitCode: 0, stdout: JSON.stringify(info), stderr: "" };
  } })).toEqual(expected);
});
it("fails closed on probe errors and invalid JSON", async () => {
  for (const runner of [
    { run: async () => { throw new Error("unavailable"); } },
    { run: async () => ({ exitCode: 1, stdout: "{}", stderr: "" }) },
    { run: async () => ({ exitCode: 0, stdout: "invalid", stderr: "" }) },
  ]) expect(await podmanCgroupControllers(runner)).toEqual([]);
});
it("normalizes empty limits and compares values independent of key order", () => {
  expect(writerLimits({})).toBeUndefined();
  expect(sameWriterLimits(undefined, {})).toBe(true);
  expect(sameWriterLimits({ cpus: 1, memory: "512m" }, { memory: "512m", cpus: 1 })).toBe(true);
  expect(sameWriterLimits({ cpuShares: 256 }, undefined)).toBe(false);
});
