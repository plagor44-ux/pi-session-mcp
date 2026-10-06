import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { runDoctorBootstrap } from "../scripts/doctor.mjs";

function outputCapture() {
  let stdout = "";
  let stderr = "";
  return {
    dependencies: {
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    },
    read: () => ({ stdout, stderr }),
  };
}

describe("Doctor bootstrap", () => {
  it("returns one sanitized JSON model when the independent CLI cannot load", async () => {
    const capture = outputCapture();
    const exitCode = await runDoctorBootstrap(["--json"], {
      ...capture.dependencies,
      load: async () => { throw new Error("RAW_BOOTSTRAP_SECRET /private/doctor.ts"); },
    });

    const output = capture.read();
    expect(exitCode).toBe(2);
    expect(output.stderr).toBe("");
    expect(JSON.parse(output.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      checks: [{
        id: "doctor_cli_unavailable",
        severity: "error",
        subject: "Doctor CLI",
        remediation: "run the independent Doctor build",
      }],
      exitCode: 2,
    });
    expect(output.stdout).not.toMatch(/RAW_BOOTSTRAP_SECRET|private|doctor\.ts/);
  });

  it("keeps human bootstrap failures bounded and path-free", async () => {
    const capture = outputCapture();
    const exitCode = await runDoctorBootstrap([], {
      ...capture.dependencies,
      load: async () => { throw new Error("SECRET_SENTINEL /home/operator/repo"); },
    });

    const output = capture.read();
    expect(exitCode).toBe(2);
    expect(output.stdout).toBe("ERROR doctor_cli_unavailable [Doctor CLI]: run the independent Doctor build\n");
    expect(`${output.stdout}${output.stderr}`).not.toMatch(/SECRET_SENTINEL|home|operator|repo/);
  });

  it("rejects misuse before loading generated code", async () => {
    const capture = outputCapture();
    let loads = 0;
    const exitCode = await runDoctorBootstrap(["--network"], {
      ...capture.dependencies,
      load: async () => { loads += 1; },
    });

    expect(exitCode).toBe(64);
    expect(loads).toBe(0);
    expect(capture.read()).toEqual({ stdout: "", stderr: "Usage: doctor [--json]\n" });
  });

  it("delegates valid invocations without adding output", async () => {
    const capture = outputCapture();
    let loads = 0;
    const exitCode = await runDoctorBootstrap(["--json"], {
      ...capture.dependencies,
      load: async () => { loads += 1; },
    });

    expect(exitCode).toBe(0);
    expect(loads).toBe(1);
    expect(capture.read()).toEqual({ stdout: "", stderr: "" });
  });

  it("keeps a closed real stdout pipe from leaking an error stack or changing the result", async () => {
    const moduleUrl = new URL("../scripts/doctor.mjs", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import { runDoctorBootstrap } from ${JSON.stringify(moduleUrl)}; process.exitCode = await runDoctorBootstrap(["--json"], { load: async () => { throw new Error("RAW /private/doctor.ts"); } });`], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("bootstrap subprocess timeout")); }, 2_000);
      child.once("error", reject);
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    expect(result).toEqual({ code: 2, signal: null });
    expect(stderr).not.toMatch(/EPIPE|ERR_STREAM|doctor\.mjs|private|RAW| at /);
  });
});
