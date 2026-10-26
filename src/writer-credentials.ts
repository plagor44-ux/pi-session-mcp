import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export const REFRESH_THRESHOLD_MINUTES = 10;
export const REFRESH_INTERVAL_MS = 60_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedEntries(host: unknown, providers: readonly string[]): [string, Record<string, unknown>][] {
  if (!record(host)) return [];
  return [...new Set(providers)].flatMap((provider) => {
    if (provider === "cursor" || !Object.hasOwn(host, provider)) return [];
    const entry = host[provider];
    return record(entry) ? [[provider, entry] as [string, Record<string, unknown>]] : [];
  });
}

export function selectBoundaryCredentials(host: unknown, providers: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(selectedEntries(host, providers).flatMap(([provider, entry]) => {
    if (entry.type === "oauth") return [[provider, { ...entry, refresh: "" }]];
    if (entry.type === "api_key") return [[provider, { ...entry }]];
    return [];
  }));
}

/** The selected providers that hold an OAuth credential on the host. */
export function selectedOAuthProviders(host: unknown, providers: readonly string[]): string[] {
  return selectedEntries(host, providers).filter(([, entry]) => entry.type === "oauth").map(([provider]) => provider);
}

async function writeAtomic(directory: string, name: string, value: Record<string, unknown>): Promise<void> {
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, join(directory, name));
  } finally {
    if (created) await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}

export async function writeBoundaryCredentials(agentDir: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeAtomic(agentDir, "auth.json", value);
}

export function expiresWithin(host: unknown, providers: readonly string[], minutes: number, now: number): boolean {
  return selectedEntries(host, providers).some(([, entry]) => {
    if (entry.type !== "oauth") return false;
    if (typeof entry.expires !== "number" || !Number.isFinite(entry.expires)) return true;
    const expiryMs = entry.expires > 1e12 ? entry.expires : entry.expires * 1000;
    return expiryMs - now <= minutes * 60_000;
  });
}

/** The part of the SDK's `ModelRuntime` the host refresh uses; only the package-root export, loaded on first use like `src/doctor.ts`. */
interface AuthRuntime { getAuth(provider: string, overrides?: { minOAuthValidityMs?: number; signal?: AbortSignal }): Promise<unknown> }

const createAuthRuntime = (authPath: string): Promise<AuthRuntime> =>
  import("@earendil-works/pi-coding-agent").then(({ ModelRuntime }) => ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false }));

/** A host OAuth warm-up: refresh the stored credential through Pi's own locked store; the SDK writes the file, never this code. */
export interface HostCredentialRefresh {
  authPath: string;
  provider: string;
  minOAuthValidityMs: number;
  timeoutMs: number;
}

/**
 * Refreshes the host's stored OAuth credential for one provider through the SDK's documented `ModelRuntime`: `getAuth` refreshes a
 * credential with less than `minOAuthValidityMs` of validity left under the credential store's lock and persists the result itself.
 * No model file is read or written (`modelsPath: null`), no model request is made, and the call is bounded by `timeoutMs`: the SDK's
 * own signal cancels the wait for the store's lock, and the race returns promptly even if a refresh is already in flight.
 */
export async function refreshHostCredential(
  input: HostCredentialRefresh,
  createRuntime: (authPath: string) => Promise<AuthRuntime> = createAuthRuntime,
): Promise<void> {
  const signal = AbortSignal.timeout(input.timeoutMs);
  await Promise.race([
    (async () => {
      const runtime = await createRuntime(input.authPath);
      await runtime.getAuth(input.provider, { minOAuthValidityMs: input.minOAuthValidityMs, signal });
    })(),
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  ]);
}
