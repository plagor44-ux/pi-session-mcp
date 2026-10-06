import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientAdapter, ClientScope, CommandExecution, CommandRunner, RegistrationIntent, RegistrationState } from "./client-adapters/types.js";
import { createClaudeCodeAdapter, createCodexAdapter } from "./client-adapters/index.js";
import { runDoctor } from "./doctor.js";
import { createMcpStdioLauncher } from "./setup-process.js";
import { verifyMcpCapabilities } from "./client-adapters/mcp-verifier.js";
import { PACKAGE_VERSION, readPackageMetadata } from "./package-metadata.js";
import { DurableOwnershipStore, MemoryOwnershipStore, type OwnershipAccess, type OwnershipStore, type OwnershipRecord } from "./setup-ownership.js";
import { result, type SetupFinding, type SetupOperation, type SetupResult, type SetupTarget } from "./setup-result.js";

export interface SetupClientAdapter { readonly name: string; readonly supportedScopes: readonly string[]; inspect(target: SetupTarget, fingerprint: string): Promise<{ state: RegistrationState; fingerprint?: string }>; apply(target: SetupTarget, execution?: CommandExecution): Promise<void>; remove(target: SetupTarget, execution?: CommandExecution): Promise<void>; verify(target: SetupTarget): Promise<{ ok: boolean; code: string }>; }
export interface SetupDoctor { check(): Promise<{ ok: boolean; code: string }>; }
export interface SetupDependencies { readonly adapters?: readonly SetupClientAdapter[]; readonly doctor?: SetupDoctor; readonly ownership?: OwnershipStore; readonly intendedFingerprint: string; }
export interface SetupRequest { readonly operation?: SetupOperation; readonly targets: readonly SetupTarget[]; }
export const isSupportedTarget = (target: SetupTarget): boolean =>
  target.alias === "pi-session-mcp" &&
  (target.client === "codex" ? target.scope === "user" :
    target.client === "claude-code" && ["user", "project", "local"].includes(target.scope));

export class SetupOrchestrator {
  private readonly ownership: OwnershipStore;
  constructor(private readonly dependencies: SetupDependencies) { this.ownership = dependencies.ownership ?? new MemoryOwnershipStore(); }
  async run(request: SetupRequest): Promise<SetupResult> {
    const operation = request.operation ?? "dry-run";
    const targets = request.targets.filter(isSupportedTarget).filter((target, index, all) => all.findIndex((candidate) => candidate.client === target.client && candidate.scope === target.scope && candidate.alias === target.alias) === index);
    if (targets.length !== request.targets.length || targets.length === 0) return result(operation, [{ target: { client: "invalid", scope: "invalid", alias: "invalid" }, status: "failed", code: "target_invalid" }], "failed");
    if (operation === "dry-run") return this.plan(targets, this.ownership);
    if (operation === "apply") return this.ownership.transaction((ownership) => this.apply(targets, ownership));
    if (operation === "verify") return this.ownership.transaction((ownership) => this.verify(targets, ownership));
    if (operation === "rollback") return this.ownership.transaction((ownership) => this.restore(targets, "rolled_back", ownership));
    return this.ownership.transaction((ownership) => this.restore(targets, "removed", ownership));
  }
  private adapter(t: SetupTarget): SetupClientAdapter | undefined { return this.dependencies.adapters?.find((a) => a.name === t.client && a.supportedScopes.includes(t.scope)); }
  private assertOwnershipHealthy(ownership: OwnershipAccess): void { ownership.assertHealthy?.(); }
  private signal(ownership: OwnershipAccess): AbortSignal | undefined { return ownership.signal?.(); }
  private execution(ownership: OwnershipAccess): CommandExecution { const signal = this.signal(ownership); return { ...(signal ? { signal } : {}), ...(ownership.mutationRunner ? { runner: ownership.mutationRunner } : {}) }; }
  private async plan(targets: readonly SetupTarget[], ownership: OwnershipAccess): Promise<SetupResult> {
    const findings: SetupFinding[] = [];
    if (this.dependencies.doctor) {
      const doctor = await this.safe(() => this.dependencies.doctor!.check());
      if (!doctor?.ok) return result("dry-run", targets.map((target) => ({ target, status: "failed", code: doctor?.code ?? "doctor_failed" })), "failed");
    }
    for (const target of targets) {
      this.assertOwnershipHealthy(ownership);
      const adapter = this.adapter(target);
      if (!adapter) { findings.push({ target, status: "unsupported", code: "client_unsupported" }); continue; }
      const inspected = await this.safe(() => adapter.inspect(target, this.dependencies.intendedFingerprint));
      if (!inspected) { findings.push({ target, status: "failed", code: "inspect_failed" }); continue; }
      let owned: OwnershipRecord | undefined;
      try { owned = await ownership.get(target); } catch { findings.push({ target, status: "failed", code: "ownership_unavailable" }); continue; }
      if (owned && owned.fingerprint !== this.dependencies.intendedFingerprint) {
        findings.push({ target, status: "divergent", code: "release_binding_mismatch" });
        continue;
      }
      if (inspected.state === "absent" && owned?.phase === "owned") { findings.push({ target, status: "divergent", code: "ownership_diverged" }); continue; }
      findings.push({ target, status: inspected.state === "equivalent" ? "unchanged" : inspected.state, code: inspected.state });
    }
    const failed = findings.some((finding) => ["failed", "unsupported", "divergent"].includes(finding.status));
    return result("dry-run", findings, failed ? "failed" : "planned");
  }
  private async apply(targets: readonly SetupTarget[], ownership: OwnershipAccess): Promise<SetupResult> {
    const plan = await this.plan(targets, ownership);
    if (plan.status === "failed") {
      const findings = plan.findings.map((finding) => finding.status === "divergent" && finding.code === "divergent"
        ? { ...finding, code: "divergence_requires_replacement" }
        : finding);
      return result("apply", findings, "failed");
    }
    const findings: SetupFinding[] = [];
    for (const target of targets) {
      this.assertOwnershipHealthy(ownership);
      const adapter = this.adapter(target);
      if (!adapter) { findings.push({ target, status: "unsupported", code: "client_unsupported" }); continue; }
      const current = await this.safe(() => adapter.inspect(target, this.dependencies.intendedFingerprint));
      let owned: OwnershipRecord | undefined;
      try { owned = await ownership.get(target); }
      catch { findings.push({ target, status: "failed", code: "ownership_unavailable" }); continue; }
      if (!current) { findings.push({ target, status: "failed", code: "inspect_failed" }); continue; }
      if (owned && owned.fingerprint !== this.dependencies.intendedFingerprint) { findings.push({ target, status: "failed", code: "release_binding_mismatch" }); continue; }
      if (current.state === "absent" && owned?.phase === "owned") { findings.push({ target, status: "failed", code: "ownership_diverged" }); continue; }
      if (current.state === "equivalent") {
        if (current.fingerprint !== this.dependencies.intendedFingerprint) { findings.push({ target, status: "failed", code: "registration_fingerprint_mismatch" }); continue; }
        if (owned?.phase === "pending" && owned.fingerprint === this.dependencies.intendedFingerprint) {
          try { this.assertOwnershipHealthy(ownership); await ownership.put({ ...owned, phase: "owned" }); this.assertOwnershipHealthy(ownership); findings.push({ target, status: "ok", code: "pending_recovered" }); }
          catch { findings.push({ target, status: "failed", code: "ownership_unavailable" }); }
        } else findings.push({ target, status: "unchanged", code: "already_equivalent" });
        continue;
      }
      if (current.state !== "absent") { findings.push({ target, status: "divergent", code: "divergence_requires_replacement" }); continue; }
      const pending: OwnershipRecord = { target, fingerprint: this.dependencies.intendedFingerprint, previous: "absent", phase: "pending", transactionId: randomUUID() };
      try {
        this.assertOwnershipHealthy(ownership);
        await ownership.put(pending);
        this.assertOwnershipHealthy(ownership);
        await adapter.apply(target, this.execution(ownership));
        this.assertOwnershipHealthy(ownership);
        const after = await adapter.inspect(target, this.dependencies.intendedFingerprint);
        this.assertOwnershipHealthy(ownership);
        if (!after || after.state !== "equivalent" || after.fingerprint !== this.dependencies.intendedFingerprint) throw new Error("post_apply_mismatch");
        await ownership.put({ ...pending, phase: "owned" });
        findings.push({ target, status: "ok", code: "applied" });
      } catch { findings.push({ target, status: "failed", code: "apply_failed_recovery_pending" }); }
    }
    return result("apply", findings);
  }
  private async verify(targets: readonly SetupTarget[], ownership: OwnershipAccess): Promise<SetupResult> {
    const findings: SetupFinding[] = [];
    for (const target of targets) {
      this.assertOwnershipHealthy(ownership);
      const adapter = this.adapter(target);
      if (!adapter) { findings.push({ target, status: "unsupported", code: "client_unsupported" }); continue; }
      let owned: OwnershipRecord | undefined;
      try { owned = await ownership.get(target); } catch { findings.push({ target, status: "failed", code: "ownership_unavailable" }); continue; }
      if (owned && owned.fingerprint !== this.dependencies.intendedFingerprint) { findings.push({ target, status: "failed", code: "release_binding_mismatch" }); continue; }
      const doctor = this.dependencies.doctor ? await this.safe(() => this.dependencies.doctor!.check()) : { ok: true, code: "doctor_skipped" };
      const inspected = await this.safe(() => adapter.inspect(target, this.dependencies.intendedFingerprint));
      const equivalent = inspected?.state === "equivalent" && inspected.fingerprint === this.dependencies.intendedFingerprint;
      const verified = equivalent ? await this.safe(() => adapter.verify(target)) : undefined;
      findings.push({ target, status: doctor?.ok && equivalent && verified?.ok ? "ok" : "failed", code: !doctor?.ok ? doctor?.code ?? "doctor_failed" : !equivalent ? "registration_not_equivalent" : verified?.code ?? "verify_failed" });
    }
    return result("verify", findings);
  }
  private async restore(targets: readonly SetupTarget[], success: "rolled_back" | "removed", ownership: OwnershipAccess): Promise<SetupResult> {
    const findings: SetupFinding[] = [];
    for (const target of targets) {
      this.assertOwnershipHealthy(ownership);
      const adapter = this.adapter(target);
      let owned: OwnershipRecord | undefined;
      try { owned = await ownership.get(target); } catch { findings.push({ target, status: "failed", code: "ownership_unavailable" }); continue; }
      if (!adapter) { findings.push({ target, status: "unsupported", code: "client_unsupported" }); continue; }
      if (!owned || (owned.phase !== "owned" && owned.phase !== "pending")) { findings.push({ target, status: "failed", code: "ownership_unavailable" }); continue; }
      const inspected = await this.safe(() => adapter.inspect(target, owned!.fingerprint));
      this.assertOwnershipHealthy(ownership);
      if (!inspected || (inspected.state !== "equivalent" && inspected.state !== "absent") || (inspected.state === "equivalent" && inspected.fingerprint !== owned.fingerprint)) { findings.push({ target, status: "failed", code: "ownership_diverged" }); continue; }
      try {
        if (inspected.state === "equivalent") {
          this.assertOwnershipHealthy(ownership);
          await adapter.remove(target, this.execution(ownership));
          this.assertOwnershipHealthy(ownership);
          const after = await adapter.inspect(target, owned.fingerprint);
          this.assertOwnershipHealthy(ownership);
          if (!after || after.state !== "absent") throw new Error("post_remove_mismatch");
        }
        this.assertOwnershipHealthy(ownership);
        await ownership.delete(target);
        findings.push({ target, status: "ok", code: success });
      } catch { findings.push({ target, status: "failed", code: "cleanup_failed" }); }
    }
    return result(success === "removed" ? "remove" : "rollback", findings);
  }
  private async safe<T>(call: () => Promise<T>): Promise<T | undefined> { try { return await call(); } catch { return undefined; } }
}
export function registrationFingerprint(intent: RegistrationIntent, releaseBinding = "unbound"): string {
  return createHash("sha256")
    .update(JSON.stringify({ node: intent.nodePath, entry: intent.entryPath, config: intent.configPath, releaseBinding }))
    .digest("hex");
}

/** Bind setup ownership to the exact package manifests and built runtime tree. */
export async function immutableReleaseBinding(packageRoot: string): Promise<string> {
  const metadata = await readPackageMetadata(packageRoot, readFile);
  if (metadata.version !== PACKAGE_VERSION || metadata.lockVersion !== PACKAGE_VERSION) throw new Error("release_version_mismatch");
  const runtimeRoot = join(packageRoot, "dist");
  const runtimeFiles = await listRuntimeFiles(runtimeRoot);
  for (const required of ["main.js", "setup-command-guardian.js"] as const) {
    if (!runtimeFiles.includes(required)) throw new Error("release_entry_missing");
    const entry = await lstat(join(runtimeRoot, required));
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("release_entry_invalid");
  }
  const hash = createHash("sha256");
  for (const manifest of ["package.json", "package-lock.json"] as const) {
    hash.update(manifest).update("\0").update(await readFile(join(packageRoot, manifest))).update("\0");
  }
  for (const relativePath of runtimeFiles) {
    hash.update(relativePath).update("\0").update(await readFile(join(runtimeRoot, ...relativePath.split("/")))).update("\0");
  }
  return hash.digest("hex");
}

async function listRuntimeFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("release_symlink_invalid");
    if (entry.isDirectory()) files.push(...await listRuntimeFiles(join(directory, entry.name), relativePath));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(relativePath);
  }
  return files.sort();
}

export async function createProductionSetup(
  runner: CommandRunner,
  packageRoot: string,
  configPath: string,
  ownershipPath = join(homedir(), ".local", "state", "pi-session-mcp", "ownership.json"),
  signal?: AbortSignal,
): Promise<SetupOrchestrator> {
  const nodePath = process.execPath;
  const entryPath = join(packageRoot, "dist", "main.js");
  const makeIntent = (target: SetupTarget): RegistrationIntent => ({ scope: target.scope as ClientScope, nodePath, entryPath, configPath });
  const fingerprintFor = async (target: SetupTarget): Promise<string> => registrationFingerprint(makeIntent(target), await immutableReleaseBinding(packageRoot));
  const wrap = (adapter: ClientAdapter): SetupClientAdapter => ({
    name: adapter.client,
    supportedScopes: adapter.client === "codex" ? ["user"] : ["user", "project", "local"],
    async inspect(target, expectedFingerprint) {
      const capabilities = await adapter.discover();
      if (!capabilities.supportsAdd || !capabilities.supportsRemove || !capabilities.scopes.includes(target.scope as ClientScope)) return { state: "unsupported" };
      const inspected = await adapter.inspect(target.scope as ClientScope, makeIntent(target));
      if (inspected.state !== "equivalent") return { state: inspected.state };
      const currentFingerprint = await fingerprintFor(target);
      return currentFingerprint === expectedFingerprint ? { state: "equivalent", fingerprint: currentFingerprint } : { state: "divergent" };
    },
    async apply(target, execution) { await adapter.add(makeIntent(target), execution); },
    async remove(target, execution) { await adapter.remove(target.scope as ClientScope, execution); },
    async verify() {
      const verification = await verifyMcpCapabilities({ launch: createMcpStdioLauncher({ nodePath, entryPath, configPath }) });
      return { ok: verification.status === "verified", code: verification.status === "verified" ? "mcp_verified" : `mcp_${verification.status}` };
    },
  });
  const referenceTarget: SetupTarget = { client: "codex", scope: "user", alias: "pi-session-mcp" };
  const dependencies: SetupDependencies = {
    adapters: [wrap(createCodexAdapter({ runner })), wrap(createClaudeCodeAdapter({ runner }))],
    doctor: {
      async check() {
        const doctor = await runDoctor({ packageRoot, loadConfig: async () => { const { loadConfig } = await import("./config.js"); return loadConfig(configPath); } });
        return { ok: doctor.ok, code: doctor.ok ? "doctor_ok" : "doctor_failed" };
      },
    },
    ownership: new DurableOwnershipStore(ownershipPath, { ...(signal ? { signal } : {}) }),
    intendedFingerprint: await fingerprintFor(referenceTarget),
  };
  return new SetupOrchestrator(dependencies);
}
export { result } from "./setup-result.js";
export type { SetupFinding, SetupOperation, SetupResult, SetupStatus, SetupTarget } from "./setup-result.js";
