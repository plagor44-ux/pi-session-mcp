import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { ChildStdioTransport } from "../src/child-stdio-transport.js";
import { temporaryRoot, removeTemporaryRoots } from "./temporary-roots.js";
afterAll(removeTemporaryRoots);
it.skipIf(process.platform !== "linux")("child-stdio-transport: spawns detached, close ends stdin without killing the child", async () => {
  const home = await temporaryRoot("pi-transport-"); const report = join(home, "report");
  const transport = new ChildStdioTransport(process.execPath, { HOME: home }, ["--input-type=module", "-e", `
    import { writeFileSync, readFileSync } from 'node:fs';
    const stat = readFileSync('/proc/self/stat', 'utf8').split(' ');
    writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, group: Number(stat[4]), secret: process.env.RELAY_TEST_SECRET }));
    process.stdin.resume();
    process.stdin.on('end', () => setTimeout(() => { writeFileSync(process.argv[1], 'ended'); process.exit(0); }, 100));
  `, report]);
  process.env.RELAY_TEST_SECRET = "not-inherited";
  try {
    await transport.start();
    await vi.waitFor(async () => expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({ pid: expect.any(Number) }));
    const data = JSON.parse(await readFile(report, "utf8")); expect(data.group).toBe(data.pid); expect(data.secret).toBeUndefined();
    await transport.close(); process.kill(data.pid, 0);
    await vi.waitFor(async () => expect(await readFile(report, "utf8")).toBe("ended"));
  } finally { delete process.env.RELAY_TEST_SECRET; await transport.close(); }
});
it("reports spawn failure without an unhandled child error", async () => {
  const transport = new ChildStdioTransport("/does-not-exist", {}); const onerror = vi.fn(); transport.onerror = onerror;
  await expect(transport.start()).rejects.toThrow(); expect(onerror).toHaveBeenCalled(); await transport.close();
});
it("rejects malformed frames and drains child stderr", async () => {
  const transport = new ChildStdioTransport(process.execPath, {}, ["-e", "process.stderr.write('x'.repeat(100000)); process.stdout.write('not-json\\n'); process.stdin.resume()"]);
  const failed = new Promise<void>(resolve => { transport.onerror = () => resolve(); });
  await transport.start(); await failed; await transport.close();
});
