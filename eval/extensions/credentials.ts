import { readFile } from "node:fs/promises";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { selectBoundaryCredentials } from "../../src/writer-credentials.js";

/*
 * R86: OAuth access tokens live about an hour, and the evaluation copies only the access token into a scope (the refresh token is emptied,
 * by design). A multi-hour wave therefore refreshes on the host: before each preflight route and each wave run the provider's credential in
 * the operator's auth file is refreshed through the Pi SDK, and the host auth is read again. The sandbox still gets the access token only.
 *
 * The SDK's documented way (package-root export `ModelRuntime`, see its `getAuth` and `minOAuthValidityMs`) refreshes a stored OAuth credential
 * that is close to expiry under the credential store's lock and writes the result back to the file, as normal pi use does.
 */

/** A stored token with less than this left is refreshed (the SDK refreshes at five minutes at least); above the wave's own 20-minute margin. */
export const REFRESH_WINDOW_MINUTES = 30;

/** Where the host's credentials live and how to refresh one; tests give a fake. Nothing here is ever logged or recorded. */
export interface HostCredentials {
  /** The current host auth (the parsed auth file). */
  read(): Promise<unknown>;
  /** Refreshes the provider's stored OAuth credential if it is close to expiry. */
  refresh(provider: string): Promise<void>;
}

/** The host credentials in `authPath`, refreshed through the Pi SDK's `ModelRuntime`. No model file is read or written (`modelsPath: null`). */
export function fileHostCredentials(authPath: string): HostCredentials {
  let runtime: Promise<ModelRuntime> | undefined;
  return {
    read: async () => JSON.parse(await readFile(authPath, "utf8")) as unknown,
    refresh: async (provider) => {
      // Loaded on first use, so the modes that never refresh (plan, report, scan) do not load the SDK.
      runtime ??= import("@earendil-works/pi-coding-agent").then(({ ModelRuntime: Runtime }) => Runtime.create({ authPath, modelsPath: null, refreshOnCreate: false }));
      await (await runtime).getAuth(provider, { minOAuthValidityMs: REFRESH_WINDOW_MINUTES * 60_000 });
    },
  };
}

/** The type of the stored credential of `provider` in `hostAuth`, or null. */
export function credentialType(hostAuth: unknown, provider: string): "oauth" | "api_key" | null {
  const entry = Object.values(selectBoundaryCredentials(hostAuth, [provider]))[0];
  const type = typeof entry === "object" && entry !== null ? (entry as { type?: unknown }).type : undefined;
  return type === "oauth" || type === "api_key" ? type : null;
}

const emit = (event: string, provider: string, code: string): void => {
  process.stderr.write(`${JSON.stringify({ event, provider, code })}\n`);
};

/**
 * The host auth to judge and copy for the next run or route: for an OAuth credential the provider is refreshed and the auth read again; any other
 * credential, or no source, leaves `current` as it is. A failed refresh is not fatal: a structured, secret-free event goes to stderr and the
 * existing expiry check decides on what is in the file. A failed re-read keeps `current`.
 */
export async function refreshedHostAuth(source: HostCredentials | undefined, current: unknown, provider: string): Promise<unknown> {
  if (source === undefined || credentialType(current, provider) !== "oauth") return current;
  try { await source.refresh(provider); } catch { emit("credential_refresh_failed", provider, "refresh_failed"); }
  try { return await source.read(); } catch { emit("credential_refresh_failed", provider, "auth_unreadable"); return current; }
}
