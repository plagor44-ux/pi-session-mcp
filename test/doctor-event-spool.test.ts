import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTemporaryRoots, temporaryRoot } from "./temporary-roots.js";
import type { AppConfig } from "../src/config.js";
import { renderDoctorHuman, renderDoctorJson, runDoctor, type DoctorDependencies, type EventSpoolRootInfo } from "../src/doctor.js";

const config = (eventDelivery: "spool" | "off"): (() => Promise<AppConfig>) => async () => ({
  workspaces: new Map(),
  workspaceModes: new Map(),
  executionProfiles: new Map([["safe", { alias: "safe", default: true, permissionProfile: "read-only" as const, provider: "fake", model: "fake", thinkingLevel: "off" as const }]]),
  defaultExecutionProfile: "safe",
  configuration: { fingerprint: `sha256:${"0".repeat(64)}` as const, reloadPolicy: "restart-required" as const },
  eventDelivery,
  skillOverrideDirectory: "/hidden/skills",
});

/** A package root that Doctor accepts as built, so that only the spool check can add findings. */
async function packageRoot(): Promise<string> {
  const root = await temporaryRoot("pi-session-mcp-spool-pkg-");
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.0.0", engines: { node: ">=22.19.0" } }));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "main.js"), "export {};\n");
  return root;
}

async function spoolChecks(delivery: "spool" | "off", dependencies: DoctorDependencies) {
  const result = await runDoctor({ packageRoot: await packageRoot(), loadConfig: config(delivery), ...dependencies });
  return { result, checks: result.checks.filter((check) => check.id === "event_spool_root") };
}

const RUNTIME = "/run/user/1000";
const probing = (info: EventSpoolRootInfo | undefined, seen: string[] = []) => async (path: string) => { seen.push(path); return info; };
const privateDirectory: EventSpoolRootInfo = { isDirectory: true, uid: 1000, mode: 0o40700 };

afterAll(removeTemporaryRoots);

describe("doctor event_spool_root", () => {
  it("adds no check when delivery is off, and does not probe", async () => {
    const seen: string[] = [];
    const { result, checks } = await spoolChecks("off", { env: {}, eventSpoolRoot: probing(undefined, seen), uid: 1000 });
    expect(checks).toEqual([]);
    expect(seen).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("is ok when the root does not exist yet", async () => {
    const seen: string[] = [];
    const { result, checks } = await spoolChecks("spool", { env: { XDG_RUNTIME_DIR: RUNTIME }, eventSpoolRoot: probing(undefined, seen), uid: 1000 });
    expect(checks).toEqual([{ id: "event_spool_root", severity: "ok", subject: "event spool" }]);
    expect(seen).toEqual([`${RUNTIME}/pi-session-mcp`]);
    expect(result.exitCode).toBe(0);
  });

  it("is ok for a private directory of the current user and inspects the runtime, events and claims directories", async () => {
    const seen: string[] = [];
    const { checks } = await spoolChecks("spool", { env: { XDG_RUNTIME_DIR: RUNTIME }, eventSpoolRoot: probing(privateDirectory, seen), uid: 1000 });
    expect(checks).toEqual([{ id: "event_spool_root", severity: "ok", subject: "event spool" }]);
    expect(seen).toEqual([`${RUNTIME}/pi-session-mcp`, `${RUNTIME}/pi-session-mcp/events`, `${RUNTIME}/pi-session-mcp/claims`]);
  });

  it("is ok when events and claims are absent below a private runtime directory", async () => {
    const probe = async (path: string) => path === `${RUNTIME}/pi-session-mcp` ? privateDirectory : undefined;
    const { checks } = await spoolChecks("spool", { env: { XDG_RUNTIME_DIR: RUNTIME }, eventSpoolRoot: probe, uid: 1000 });
    expect(checks).toEqual([{ id: "event_spool_root", severity: "ok", subject: "event spool" }]);
  });

  it.each(["events", "claims"])("fails when only the %s directory is unsafe", async (name) => {
    for (const bad of [{ ...privateDirectory, isDirectory: false }, { ...privateDirectory, uid: 0 }, { ...privateDirectory, mode: 0o40750 }, { ...privateDirectory, mode: 0o40705 }]) {
      const probe = async (path: string) => path.endsWith(`/${name}`) ? bad : privateDirectory;
      const { result, checks } = await spoolChecks("spool", { env: { XDG_RUNTIME_DIR: RUNTIME }, eventSpoolRoot: probe, uid: 1000 });
      expect(checks).toEqual([{ id: "event_spool_root", severity: "error", subject: "event spool", remediation: expect.stringContaining(name) }]);
      expect(result.exitCode).toBe(2);
    }
  });

  it.each(["events", "claims"])("fails when the %s probe errors", async (name) => {
    const probe = async (path: string) => { if (path.endsWith(`/${name}`)) throw new Error("SECRET"); return privateDirectory; };
    const { checks } = await spoolChecks("spool", { env: { XDG_RUNTIME_DIR: RUNTIME }, eventSpoolRoot: probe, uid: 1000 });
    expect(checks).toEqual([{ id: "event_spool_root", severity: "error", subject: "event spool", remediation: expect.stringContaining(name) }]);
  });

  it("adds no check for an explicit off", async () => {
    const seen: string[] = [];
    const { checks } = await spoolChecks("off", { env: { XDG_RUNTIME_DIR: RUNTIME }, eventSpoolRoot: probing(privateDirectory, seen), uid: 1000 });
    expect(checks).toEqual([]);
    expect(seen).toEqual([]);
  });

  it.each([undefined, "", "relative/run", "./run"])("warns when XDG_RUNTIME_DIR is %j", async (value) => {
    const seen: string[] = [];
    const { result, checks } = await spoolChecks("spool", { env: value === undefined ? {} : { XDG_RUNTIME_DIR: value }, eventSpoolRoot: probing(undefined, seen), uid: 1000 });
    expect(checks).toEqual([{ id: "event_spool_root", severity: "warning", subject: "event spool", remediation: expect.stringContaining("XDG_RUNTIME_DIR") }]);
    expect(seen).toEqual([]);
    expect(result.exitCode).toBe(1);
  });

  it.each([
    ["not a directory", { ...privateDirectory, isDirectory: false }],
    ["another owner", { ...privateDirectory, uid: 0 }],
    ["group readable", { ...privateDirectory, mode: 0o40750 }],
    ["group writable", { ...privateDirectory, mode: 0o40770 }],
    ["other readable", { ...privateDirectory, mode: 0o40705 }],
    ["world accessible", { ...privateDirectory, mode: 0o40777 }],
  ])("fails for %s", async (_label, info) => {
    const { result, checks } = await spoolChecks("spool", { env: { XDG_RUNTIME_DIR: RUNTIME }, eventSpoolRoot: probing(info), uid: 1000 });
    expect(checks).toEqual([{ id: "event_spool_root", severity: "error", subject: "event spool", remediation: expect.any(String) }]);
    expect(result.exitCode).toBe(2);
  });

  it("fails when the probe errors", async () => {
    const { checks } = await spoolChecks("spool", { env: { XDG_RUNTIME_DIR: RUNTIME }, eventSpoolRoot: async () => { throw Object.assign(new Error("denied /SECRET_SPOOL_PATH"), { code: "EACCES" }); }, uid: 1000 });
    expect(checks).toEqual([{ id: "event_spool_root", severity: "error", subject: "event spool", remediation: expect.any(String) }]);
  });

  it("never prints the runtime path or probe error text", async () => {
    const runtime = "/run/user/SECRET_RUNTIME_SENTINEL";
    for (const info of [undefined, privateDirectory, { ...privateDirectory, mode: 0o40777 }, { ...privateDirectory, uid: 0 }, { ...privateDirectory, isDirectory: false }]) {
      const { result } = await spoolChecks("spool", { env: { XDG_RUNTIME_DIR: runtime }, eventSpoolRoot: probing(info), uid: 1000 });
      expect(renderDoctorJson(result) + renderDoctorHuman(result)).not.toMatch(/SECRET|\/run\//);
    }
    const { result } = await spoolChecks("spool", { env: { XDG_RUNTIME_DIR: runtime }, eventSpoolRoot: async () => { throw new Error("SECRET_ERROR_TEXT"); }, uid: 1000 });
    expect(renderDoctorJson(result) + renderDoctorHuman(result)).not.toMatch(/SECRET|\/run\//);
  });

  it("sorts the check after the skill checks", async () => {
    const { result } = await spoolChecks("spool", { env: { XDG_RUNTIME_DIR: RUNTIME }, eventSpoolRoot: probing(undefined), uid: 1000 });
    expect(result.checks.at(-1)?.id).toBe("event_spool_root");
  });

  describe("against the real file system", () => {
    const real = async (setup: (runtime: string) => Promise<void>) => {
      const runtime = await temporaryRoot("pi-session-mcp-spool-run-");
      await setup(runtime);
      return (await spoolChecks("spool", { env: { XDG_RUNTIME_DIR: runtime } })).checks[0];
    };

    it("is ok when absent", async () => { expect((await real(async () => {}))?.severity).toBe("ok"); });
    it("is ok for a mode 0700 directory", async () => {
      expect((await real(async (runtime) => { await mkdir(join(runtime, "pi-session-mcp"), { mode: 0o700 }); }))?.severity).toBe("ok");
    });
    it("fails for a group-accessible directory", async () => {
      const check = await real(async (runtime) => { await mkdir(join(runtime, "pi-session-mcp")); await chmod(join(runtime, "pi-session-mcp"), 0o770); });
      expect(check?.severity).toBe("error");
    });
    it("fails for a regular file", async () => {
      expect((await real(async (runtime) => { await writeFile(join(runtime, "pi-session-mcp"), ""); }))?.severity).toBe("error");
    });
    it("is ok for private events and claims directories", async () => {
      const check = await real(async (runtime) => {
        for (const name of ["pi-session-mcp", "pi-session-mcp/events", "pi-session-mcp/claims"]) await mkdir(join(runtime, name), { mode: 0o700 });
      });
      expect(check?.severity).toBe("ok");
    });
    it.each(["events", "claims"])("fails for a group-accessible %s directory below a private runtime directory", async (name) => {
      const check = await real(async (runtime) => {
        await mkdir(join(runtime, "pi-session-mcp"), { mode: 0o700 });
        await mkdir(join(runtime, "pi-session-mcp", name), { mode: 0o700 });
        await chmod(join(runtime, "pi-session-mcp", name), 0o750);
      });
      expect(check?.severity).toBe("error");
    });
    it("fails for an events entry that is a symbolic link to a private directory", async () => {
      const check = await real(async (runtime) => {
        await mkdir(join(runtime, "pi-session-mcp"), { mode: 0o700 });
        await mkdir(join(runtime, "elsewhere"), { mode: 0o700 });
        await symlink(join(runtime, "elsewhere"), join(runtime, "pi-session-mcp", "events"));
      });
      expect(check?.severity).toBe("error");
    });
    it("fails for a symbolic link, even to a private directory", async () => {
      const check = await real(async (runtime) => {
        const target = join(runtime, "elsewhere");
        await mkdir(target, { mode: 0o700 });
        await symlink(target, join(runtime, "pi-session-mcp"));
      });
      expect(check?.severity).toBe("error");
    });
  });
});
