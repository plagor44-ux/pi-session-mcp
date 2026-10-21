import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/*
 * Guards for the tests that need the real host: bubblewrap, strace and prlimit (Linux only), a bubblewrap that can really create an
 * unprivileged user namespace (runners with AppArmor or a sysctl restriction cannot), and the network for the containment self-test's
 * DNS lookup. Such a test skips instead of failing where the host cannot do it. Set `ABLATION_SKIP_REAL_HOST=1` to skip them anywhere.
 */

/** The first executable `name` on an absolute PATH entry, or undefined. */
export function which(name: string): string | undefined {
  return (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.startsWith("/")).map((dir) => join(dir, name)).find((path) => existsSync(path));
}

let bwrapProbe: boolean | undefined;
/** True on Linux when `bwrap --unshare-user --ro-bind / / true` succeeds (checked once). */
export function bubblewrapWorks(): boolean {
  if (bwrapProbe !== undefined) return bwrapProbe;
  const bwrap = process.platform === "linux" && process.env.ABLATION_SKIP_REAL_HOST !== "1" ? which("bwrap") : undefined;
  if (bwrap === undefined) return (bwrapProbe = false);
  try { execFileSync(bwrap, ["--unshare-user", "--ro-bind", "/", "/", "true"], { stdio: "ignore", timeout: 10_000 }); bwrapProbe = true; } catch { bwrapProbe = false; }
  return bwrapProbe;
}

/** Linux, a working bubblewrap and every named tool on the PATH. */
export const realHostWith = (...tools: string[]): boolean => bubblewrapWorks() && tools.every((tool) => which(tool) !== undefined);
