// Child process for the cross-process customization tests: runs `customizeSkill` from a compiled
// build and reports through the IPC channel. Usage: node customize-child.mjs '<json spec>'.
//   spec.module        file URL path of the compiled skill-customize.js
//   spec.request       the customize request
//   spec.lockTimeoutMs optional lock acquisition bound
//   spec.released      optional reference trees for legacy bases
//   spec.afterLock / spec.beforeBasesRename   "pause" | "hang" | "fail": a hook of the implementation
//   spec.patchRename   same values: stops at the bases rename by wrapping fs.promises.rename, which
//                      also works against builds that have no hooks
// "pause" sends {type:"at"} and waits for {type:"continue"}, "hang" waits forever, "fail" throws.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const spec = JSON.parse(process.argv[2]);

function stopAt(point, mode) {
  if (mode === undefined) return undefined;
  if (mode === "fail") throw new Error("injected failure");
  process.send({ type: "at", point });
  if (mode === "hang") { setInterval(() => undefined, 1 << 30); return new Promise(() => undefined); }
  return new Promise((resolve) => {
    const onMessage = (message) => { if (message?.type === "continue") { process.off("message", onMessage); resolve(); } };
    process.on("message", onMessage);
  });
}

if (spec.patchRename !== undefined) {
  const promises = createRequire(import.meta.url)("node:fs/promises");
  const original = promises.rename;
  promises.rename = async (from, to) => {
    if (String(to).endsWith(".pi-session-mcp-bases.json")) await stopAt("beforeBasesRename", spec.patchRename);
    return original(from, to);
  };
  syncBuiltinESMExports();
}

const { customizeSkill } = await import(pathToFileURL(spec.module).href);
const dependencies = {
  ...(spec.released ? { released: spec.released } : {}),
  ...(spec.lockTimeoutMs ? { lock: { timeoutMs: spec.lockTimeoutMs } } : {}),
  afterLock: () => stopAt("afterLock", spec.afterLock),
  beforeBasesRename: () => stopAt("beforeBasesRename", spec.beforeBasesRename),
};
const result = await customizeSkill(spec.request, dependencies);
process.send({ type: "result", result }, () => process.exit(0));
