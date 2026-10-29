import { type TraceContext } from "../eval/extensions/trace.js";

export function ctx(o: { initialCwd?: string; allowed?: string[]; provider?: string[]; dns?: string[] }): TraceContext {
  return {
    rootPid: 100,
    initialCwd: o.initialCwd ?? "/scope/clone",
    allowedWriteRoots: o.allowed ?? ["/scope"],
    providerAddresses: new Set(o.provider ?? []),
    dnsAddresses: new Set(o.dns ?? []),
  };
}
export const lines = (...l: string[]) => `${l.join("\n")}\n`;
export const CWD = "/scope/clone";
export const at = (cwd = CWD) => `AT_FDCWD<${cwd}>`;
