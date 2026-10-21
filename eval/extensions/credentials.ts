import { readFile } from "node:fs/promises";
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

/** A refresh that failed for a reason worth telling apart; only `code` ever reaches an event. */
export class HostCredentialError extends Error {
  constructor(readonly code: "refresh_failed" | "refresh_too_short") { super(code); }
}

/** Where the host's credentials live and how to refresh one; tests give a fake. Nothing here is ever logged or recorded. */
export interface HostCredentials {
  /** The current host auth (the parsed auth file). */
  read(): Promise<unknown>;
  /** Refreshes the provider's stored OAuth credential if it is close to expiry. `signal` cancels only the wait for the credential store's lock. */
  refresh(provider: string, signal?: AbortSignal): Promise<void>;
}

/** The part of the SDK's `ModelRuntime` the refresh uses; tests give a fake factory. */
interface AuthRuntime { getAuth(provider: string, overrides?: { minOAuthValidityMs?: number; signal?: AbortSignal }): Promise<unknown> }
const createRuntime = (authPath: string): Promise<AuthRuntime> =>
  // Loaded on first use, so the modes that never refresh (plan, report, scan) do not load the SDK.
  import("@earendil-works/pi-coding-agent").then(({ ModelRuntime }) => ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false }));

const expiryOf = (hostAuth: unknown, provider: string): number | undefined => {
  const entry = Object.values(selectBoundaryCredentials(hostAuth, [provider]))[0];
  const expires = typeof entry === "object" && entry !== null ? (entry as { expires?: unknown }).expires : undefined;
  return typeof expires === "number" && Number.isFinite(expires) ? expires : undefined;
};

/**
 * The host credentials in `authPath`, refreshed through the Pi SDK's `ModelRuntime`. No model file is read or written (`modelsPath: null`).
 * A failed runtime creation is not kept, so the next refresh tries again. The SDK reports a refreshed token that is still too close to expiry
 * with the same error code as other OAuth failures; it is told apart by the stored expiry having moved (`refresh_too_short`).
 */
export function fileHostCredentials(authPath: string, create: (authPath: string) => Promise<AuthRuntime> = createRuntime): HostCredentials {
  let runtime: Promise<AuthRuntime> | undefined;
  const read = async (): Promise<unknown> => JSON.parse(await readFile(authPath, "utf8")) as unknown;
  return {
    read,
    refresh: async (provider, signal) => {
      const before = expiryOf(await read().catch(() => undefined), provider);
      try {
        runtime ??= create(authPath).catch((error: unknown) => { runtime = undefined; throw error; });
        await (await runtime).getAuth(provider, { minOAuthValidityMs: REFRESH_WINDOW_MINUTES * 60_000, ...(signal === undefined ? {} : { signal }) });
      } catch (error) {
        const after = (error as { code?: unknown } | null)?.code === "oauth" ? expiryOf(await read().catch(() => undefined), provider) : undefined;
        throw new HostCredentialError(before !== undefined && after !== undefined && after > before ? "refresh_too_short" : "refresh_failed");
      }
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

export interface RefreshedAuth {
  /** The auth to judge and copy. */
  hostAuth: unknown;
  /** The refresh succeeded but the file could not be read afterwards (twice): the credential is treated like an expiring one, not like the old one. */
  unreadable: boolean;
}

const REREAD_DELAY_MS = 200;

/**
 * The host auth to judge and copy for the next run or route: for an OAuth credential the provider is refreshed and the auth read again; any other
 * credential, or no source, leaves `current` as it is. A failed refresh is not fatal: a structured, secret-free event (provider and a fixed code,
 * `refresh_failed` or `refresh_too_short`) goes to stderr, and the existing expiry check decides on what is in the file. After a successful
 * refresh the re-read is tried once more after a short delay; if it still fails, `unreadable` is set and the caller stops as for an expiring
 * credential. A failed re-read after a failed refresh keeps `current`, which the failed refresh did not change.
 */
export async function refreshedHostAuth(
  source: HostCredentials | undefined, current: unknown, provider: string, options: { signal?: AbortSignal | undefined; rereadDelayMs?: number } = {},
): Promise<RefreshedAuth> {
  if (source === undefined || credentialType(current, provider) !== "oauth") return { hostAuth: current, unreadable: false };
  let refreshed = true;
  try { await source.refresh(provider, options.signal); } catch (error) {
    refreshed = false;
    emit("credential_refresh_failed", provider, error instanceof HostCredentialError ? error.code : "refresh_failed");
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return { hostAuth: await source.read(), unreadable: false }; } catch {
      if (attempt === 0 && refreshed) await new Promise((resolve) => setTimeout(resolve, options.rereadDelayMs ?? REREAD_DELAY_MS));
      else break;
    }
  }
  emit("credential_refresh_failed", provider, "auth_unreadable");
  return { hostAuth: current, unreadable: refreshed };
}
