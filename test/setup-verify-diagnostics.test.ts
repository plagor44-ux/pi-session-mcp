import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/setup-main.js";
import { formatSetupHuman, formatSetupResult } from "../src/setup-cli.js";
import { currentSetupPlatform } from "../src/setup-platform.js";
import { MemoryOwnershipStore, type OwnershipRecord } from "../src/setup-ownership.js";
import type { SetupSkillInstaller } from "../src/setup-skills.js";
import { SetupOrchestrator, type SetupClientAdapter, type SetupDoctor } from "../src/setup.js";
import type { SetupFinding, SetupTarget } from "../src/setup-result.js";

const target: SetupTarget = { client: "codex", scope: "user", alias: "pi-session-mcp" };
const fingerprint = "a".repeat(64);
const otherFingerprint = "b".repeat(64);
const sentinels = ["/home/sentinel-path", "sk_sentinel"];
type Inspection = "unsupported" | "throws" | "absent" | "divergent" | "other-fingerprint" | "equivalent";
type Handshake = { ok: boolean; code: string } | "throws";

// Counting fake client: inspection outcome and handshake result are chosen per case.
function fixture(options: { inspection: Inspection; handshake?: Handshake; doctor?: SetupDoctor; ownership?: MemoryOwnershipStore; skills?: SetupSkillInstaller; adapterName?: string }) {
  const calls = { inspect: 0, apply: 0, remove: 0, verify: 0 };
  const handshake = options.handshake ?? { ok: true, code: "mcp_verified" };
  const adapter: SetupClientAdapter = {
    name: options.adapterName ?? "codex", supportedScopes: ["user"],
    async inspect() {
      calls.inspect += 1;
      if (options.inspection === "throws") throw new Error(`spawn ${sentinels[0]} failed with token ${sentinels[1]}`);
      if (options.inspection === "unsupported" || options.inspection === "absent") return { state: options.inspection };
      return { state: options.inspection === "divergent" ? "divergent" : "equivalent", fingerprint: options.inspection === "other-fingerprint" ? otherFingerprint : fingerprint };
    },
    async apply() { calls.apply += 1; },
    async remove() { calls.remove += 1; },
    async verify() { calls.verify += 1; if (handshake === "throws") throw new Error(`handshake ${sentinels[0]} ${sentinels[1]}`); return handshake; },
  };
  const ownership = options.ownership ?? new MemoryOwnershipStore();
  const orchestrator = new SetupOrchestrator({ adapters: [adapter], ...(options.doctor ? { doctor: options.doctor } : {}), ...(options.skills ? { skills: options.skills } : {}), ownership, intendedFingerprint: fingerprint });
  return { calls, ownership, orchestrator };
}
const doctor = (ok: boolean, code = ok ? "doctor_ok" : "doctor_failed"): SetupDoctor => ({ async check() { return { ok, code }; } });
const owned = (fp = fingerprint): OwnershipRecord => ({ target, fingerprint: fp, previous: "absent", phase: "owned", transactionId: "tx-owned" });
const verify = (f: { orchestrator: SetupOrchestrator }, targets: readonly SetupTarget[] = [target]) => f.orchestrator.run({ operation: "verify", targets });
const noMutation = (f: ReturnType<typeof fixture>) => { expect(f.calls.apply).toBe(0); expect(f.calls.remove).toBe(0); };
const okSkills = (): SetupSkillInstaller => ({ async run(_operation, skillTarget): Promise<readonly SetupFinding[]> { return [{ target: skillTarget, status: "ok", code: "skill_verified" }]; }, async owns() { return false; } });

describe("setup verify diagnostics", () => {
  const withDoctor: ReadonlyArray<[string, SetupDoctor | undefined]> = [["Doctor ok", doctor(true)], ["no Doctor", undefined]];
  describe.each(withDoctor)("with %s", (_label, configuredDoctor) => {
    const options = (inspection: Inspection, extra: Partial<Parameters<typeof fixture>[0]> = {}) => ({ inspection, ...(configuredDoctor ? { doctor: configuredDoctor } : {}), ...extra });
    it("reports an unsupported inspection as unsupported, not as a registration mismatch", async () => {
      const f = fixture(options("unsupported")); const output = await verify(f);
      expect(output).toMatchObject({ operation: "verify", status: "failed", exitCode: 1 });
      expect(output.findings).toEqual([{ target, status: "unsupported", code: "unsupported" }]);
      expect(f.calls).toEqual({ inspect: 1, apply: 0, remove: 0, verify: 0 });
    });
    it("reports a throwing inspection as inspect_failed without a handshake", async () => {
      const f = fixture(options("throws")); const output = await verify(f);
      expect(output).toMatchObject({ status: "failed", exitCode: 1 });
      expect(output.findings).toEqual([{ target, status: "failed", code: "inspect_failed" }]);
      expect(f.calls).toEqual({ inspect: 1, apply: 0, remove: 0, verify: 0 });
    });
    it.each(["absent", "divergent", "other-fingerprint"] as const)("keeps %s as registration_not_equivalent without a handshake", async (inspection) => {
      const f = fixture(options(inspection)); const output = await verify(f);
      expect(output).toMatchObject({ status: "failed", exitCode: 1 });
      expect(output.findings).toEqual([{ target, status: "failed", code: "registration_not_equivalent" }]);
      expect(f.calls).toEqual({ inspect: 1, apply: 0, remove: 0, verify: 0 });
    });
    it("runs the handshake exactly once for the intended equivalent registration and projects its ok result", async () => {
      const f = fixture(options("equivalent", { handshake: { ok: true, code: "mcp_verified" } })); const output = await verify(f);
      expect(output).toMatchObject({ status: "ok", exitCode: 0 });
      expect(output.findings).toEqual([{ target, status: "ok", code: "mcp_verified" }]);
      expect(f.calls).toEqual({ inspect: 1, apply: 0, remove: 0, verify: 1 });
    });
    it("projects a failed handshake code", async () => {
      const f = fixture(options("equivalent", { handshake: { ok: false, code: "mcp_timeout" } })); const output = await verify(f);
      expect(output).toMatchObject({ status: "failed", exitCode: 1 });
      expect(output.findings).toEqual([{ target, status: "failed", code: "mcp_timeout" }]);
      expect(f.calls.verify).toBe(1); noMutation(f);
    });
    it("reports a throwing handshake as verify_failed", async () => {
      const f = fixture(options("equivalent", { handshake: "throws" })); const output = await verify(f);
      expect(output).toMatchObject({ status: "failed", exitCode: 1 });
      expect(output.findings).toEqual([{ target, status: "failed", code: "verify_failed" }]);
      expect(JSON.stringify(output)).not.toMatch(/sentinel|sk_/);
      expect(f.calls.verify).toBe(1); noMutation(f);
    });
    it.each(["unsupported", "throws", "absent", "divergent", "other-fingerprint", "equivalent"] as const)("leaves ownership state unchanged for %s", async (inspection) => {
      const ownership = new MemoryOwnershipStore(); await ownership.put(owned());
      const f = fixture(options(inspection, { ownership })); await verify(f);
      expect(await ownership.get(target)).toEqual(owned());
      noMutation(f);
    });
    it("does not create ownership when none exists", async () => {
      const f = fixture(options("unsupported")); await verify(f);
      expect(await f.ownership.get(target)).toBeUndefined();
    });
  });

  describe("precedence", () => {
    it.each(["unsupported", "throws", "equivalent", "absent"] as const)("a failing Doctor wins over a %s inspection and skips inspection and handshake", async (inspection) => {
      const f = fixture({ inspection, doctor: doctor(false, "doctor_failed") }); const output = await verify(f);
      expect(output).toMatchObject({ status: "failed", exitCode: 1 });
      expect(output.findings).toEqual([{ target, status: "failed", code: "doctor_failed" }]);
      expect(f.calls).toEqual({ inspect: 0, apply: 0, remove: 0, verify: 0 });
    });
    it("projects the Doctor's own code", async () => {
      const f = fixture({ inspection: "unsupported", doctor: doctor(false, "doctor_config_invalid") });
      expect((await verify(f)).findings).toEqual([{ target, status: "failed", code: "doctor_config_invalid" }]);
      expect(f.calls.inspect).toBe(0);
    });
    it("a throwing Doctor is a failure that skips inspection and handshake", async () => {
      const f = fixture({ inspection: "equivalent", doctor: { async check() { throw new Error(sentinels[0]!); } } }); const output = await verify(f);
      expect(output).toMatchObject({ status: "failed", exitCode: 1 });
      expect(output.findings[0]).toMatchObject({ status: "failed" });
      expect(output.findings[0]?.code).not.toBe("registration_not_equivalent");
      expect(f.calls).toEqual({ inspect: 0, apply: 0, remove: 0, verify: 0 });
    });
    it.each(["unsupported", "throws", "equivalent"] as const)("a release binding mismatch wins over a %s inspection", async (inspection) => {
      const ownership = new MemoryOwnershipStore(); await ownership.put(owned(otherFingerprint));
      const f = fixture({ inspection, doctor: doctor(true), ownership }); const output = await verify(f);
      expect(output).toMatchObject({ status: "failed", exitCode: 1 });
      expect(output.findings).toEqual([{ target, status: "failed", code: "release_binding_mismatch" }]);
      expect(f.calls).toEqual({ inspect: 0, apply: 0, remove: 0, verify: 0 });
      expect(await ownership.get(target)).toEqual(owned(otherFingerprint));
    });
    it("an unreadable ownership record wins over the inspection", async () => {
      const ownership = new MemoryOwnershipStore(); ownership.get = async () => { throw new Error(sentinels[0]!); };
      const f = fixture({ inspection: "unsupported", ownership }); const output = await verify(f);
      expect(output.findings).toEqual([{ target, status: "failed", code: "ownership_unavailable" }]);
      expect(output.exitCode).toBe(1);
      expect(f.calls).toEqual({ inspect: 0, apply: 0, remove: 0, verify: 0 });
    });
    it.each([{ client: "claude-code", scope: "project" }, { client: "claude-code", scope: "local" }])("an unconfigured $client/$scope target is client_unsupported without any adapter call", async ({ client, scope }) => {
      const f = fixture({ inspection: "equivalent", doctor: doctor(true) });
      const unknown: SetupTarget = { client, scope, alias: "pi-session-mcp" };
      const output = await verify(f, [unknown]);
      expect(output).toMatchObject({ status: "failed", exitCode: 1 });
      expect(output.findings).toEqual([{ target: unknown, status: "unsupported", code: "client_unsupported" }]);
      expect(f.calls).toEqual({ inspect: 0, apply: 0, remove: 0, verify: 0 });
    });
    it("classifies each target independently", async () => {
      const f = fixture({ inspection: "unsupported", doctor: doctor(true) });
      const unconfigured: SetupTarget = { client: "claude-code", scope: "user", alias: "pi-session-mcp" };
      const output = await verify(f, [target, unconfigured]);
      expect(output.findings).toEqual([{ target, status: "unsupported", code: "unsupported" }, { target: unconfigured, status: "unsupported", code: "client_unsupported" }]);
      expect(output.exitCode).toBe(1);
    });
    it("introduces no client_unavailable code", async () => {
      for (const inspection of ["unsupported", "throws", "absent", "divergent", "other-fingerprint", "equivalent"] as const) {
        const output = await verify(fixture({ inspection, doctor: doctor(true) }));
        expect(JSON.stringify(output)).not.toContain("client_unavailable");
      }
    });
  });

  describe("skills do not mask the registration failure", () => {
    it.each([["unsupported", "unsupported", "unsupported"], ["throws", "failed", "inspect_failed"]] as const)("a %s registration stays failed next to an ok skill finding", async (inspection, status, code) => {
      const f = fixture({ inspection, doctor: doctor(true), skills: okSkills() }); const output = await verify(f);
      expect(output).toMatchObject({ status: "failed", exitCode: 1 });
      expect(output.findings[0]).toEqual({ target, status, code });
      expect(output.findings.some((finding) => finding.code === "skill_verified")).toBe(true);
      expect(f.calls).toEqual({ inspect: 1, apply: 0, remove: 0, verify: 0 });
    });
    it("a verified registration with an ok skill finding is ok with exit 0", async () => {
      const output = await verify(fixture({ inspection: "equivalent", doctor: doctor(true), skills: okSkills() }));
      expect(output).toMatchObject({ status: "ok", exitCode: 0 });
      expect(output.findings[0]).toEqual({ target, status: "ok", code: "mcp_verified" });
    });
  });

  describe("report boundary", () => {
    const originalConfig = process.env.PI_SESSION_MCP_CONFIG;
    afterEach(() => {
      vi.restoreAllMocks();
      if (originalConfig === undefined) delete process.env.PI_SESSION_MCP_CONFIG;
      else process.env.PI_SESSION_MCP_CONFIG = originalConfig;
    });
    // main() is driven through its injectable createSetup; no real client, runner or ownership file is touched.
    async function drive(inspection: Inspection, json: boolean) {
      process.env.PI_SESSION_MCP_CONFIG = "/home/sentinel-path/config.json";
      const out: string[] = []; const err: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => { out.push(String(value)); return true; }) as typeof process.stdout.write);
      vi.spyOn(process.stderr, "write").mockImplementation(((value: string | Uint8Array) => { err.push(String(value)); return true; }) as typeof process.stderr.write);
      const f = fixture({ inspection, doctor: doctor(true) });
      const exitCode = await main([...(json ? ["--json"] : []), "--verify", "--target", "codex:user:pi-session-mcp"], { createSetup: async () => f.orchestrator });
      return { exitCode, stdout: out.join(""), stderr: err.join(""), f };
    }
    const cases = [["unsupported", "unsupported", "unsupported"], ["throws", "failed", "inspect_failed"]] as const;
    describe.skipIf(!currentSetupPlatform()).each(cases)("main() with a %s inspection", (inspection, status, code) => {
      it("prints a human line and exits 1 without leaking error text", async () => {
        const { exitCode, stdout, stderr, f } = await drive(inspection, false);
        expect(exitCode).toBe(1);
        expect(stdout.split("\n")).toContain(`codex/user/pi-session-mcp: ${status} (${code})`);
        for (const sentinel of sentinels) { expect(stdout).not.toContain(sentinel); expect(stderr).not.toContain(sentinel); }
        expect(f.calls.verify).toBe(0); noMutation(f);
      });
      it("prints strict JSON and exits 1 without leaking error text", async () => {
        const { exitCode, stdout, stderr, f } = await drive(inspection, true);
        expect(exitCode).toBe(1);
        expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 1, operation: "verify", status: "failed", exitCode: 1, findings: [{ target, status, code }] });
        for (const sentinel of sentinels) { expect(stdout).not.toContain(sentinel); expect(stderr).not.toContain(sentinel); }
        expect(f.calls.verify).toBe(0); noMutation(f);
      });
    });
    it.each(cases)("formatters project a %s result and leak no error text", async (inspection, status, code) => {
      const output = await verify(fixture({ inspection, doctor: doctor(true) }));
      expect(formatSetupHuman(output).split("\n")).toContain(`codex/user/pi-session-mcp: ${status} (${code})`);
      expect(JSON.parse(formatSetupResult(output))).toMatchObject({ exitCode: 1, findings: [{ status, code }] });
      for (const sentinel of sentinels) { expect(formatSetupHuman(output)).not.toContain(sentinel); expect(formatSetupResult(output)).not.toContain(sentinel); }
    });
  });
});
