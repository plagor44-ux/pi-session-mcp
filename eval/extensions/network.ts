import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface AuditAddresses {
  /** Addresses the approved routes' model endpoints resolve to. */
  providerAddresses: Set<string>;
  /** Nameservers a resolver may legitimately talk to on port 53. */
  dnsAddresses: Set<string>;
}

/** `/etc/resolv.conf` nameservers plus the systemd-resolved stub. */
export async function dnsServers(resolvConf = "/etc/resolv.conf"): Promise<Set<string>> {
  const servers = new Set(["127.0.0.53"]);
  try {
    for (const line of (await readFile(resolvConf, "utf8")).split("\n")) {
      const address = /^\s*nameserver\s+(\S+)/.exec(line)?.[1];
      if (address !== undefined) servers.add(address.replace(/%.*$/, ""));
    }
  } catch { /* no resolv.conf: the stub address alone */ }
  return servers;
}

/** The host of a route's model endpoint from the pinned SDK's catalog (no network, no credentials, an empty agent directory). */
export async function modelHost(route: { provider: string; model: string }): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "ablation-models-"));
  try {
    const runtime = await ModelRuntime.create({
      refreshOnCreate: false, allowModelNetwork: false, modelsPath: null,
      authPath: join(scratch, "auth.json"), modelsStorePath: join(scratch, "models-store.json"),
    });
    const baseUrl = runtime.getModel(route.provider, route.model)?.baseUrl;
    if (typeof baseUrl !== "string") throw new Error("provider_model_unknown");
    try { return new URL(baseUrl).hostname.replace(/^\[|\]$/g, ""); } catch { throw new Error("provider_url_invalid"); }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Every A and AAAA address of one route's endpoint; an unresolvable host is an error (`provider_host_unresolvable`). */
export async function routeAddresses(route: { provider: string; model: string }): Promise<string[]> {
  const host = await modelHost(route);
  if (isIP(host) !== 0) return [host];
  try {
    const found = await lookup(host, { all: true });
    if (found.length === 0) throw new Error("none");
    return found.map((entry) => entry.address);
  } catch { throw new Error("provider_host_unresolvable"); }
}

export async function resolveAuditAddresses(routes: { provider: string; model: string }[]): Promise<AuditAddresses> {
  const providerAddresses = new Set<string>();
  for (const route of routes) for (const address of await routeAddresses(route)) providerAddresses.add(address);
  return { providerAddresses, dnsAddresses: await dnsServers() };
}
