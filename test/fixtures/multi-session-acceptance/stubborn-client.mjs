// Controlled stand-in for a real client in the acceptance harness tests. It never talks to a provider.
// Mode (FAKE_CLIENT_MODE or argv[3]), state file (FAKE_CLIENT_STATE or argv[2]):
//   ignore-term   ignores SIGTERM; its descendants keep the inherited stdout pipe open, one of them in
//                 its own session so only the harness's record of the run can find it
//   exit-on-term  exits on SIGTERM; one descendant ignores it and keeps the pipe open
//   leaks-pipe    exits 0 at once; one descendant keeps the pipe open
//   mutate        edits FAKE_CLIENT_TOUCH, then exits 0
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// The environment wins: a fake client installed as `claude` receives the harness's own arguments.
const statePath = process.env.FAKE_CLIENT_STATE ?? process.argv[2];
const mode = process.env.FAKE_CLIENT_MODE ?? process.argv[3];
const startOf = (pid) => { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; };
// A holder ends by itself after two minutes so a failing test never leaves it behind for long.
const holderSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 120000);";
const holder = (options) => spawn(process.execPath, ["-e", holderSource], { stdio: "inherit", ...options });
const publish = (state) => {
  writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
  renameSync(`${statePath}.tmp`, statePath);
};

if (mode === "mutate") {
  appendFileSync(process.env.FAKE_CLIENT_TOUCH, "\nchanged during the run\n");
  process.stdout.write("done\n");
} else {
  if (mode === "ignore-term") process.on("SIGTERM", () => {});
  const inGroup = holder({});
  const children = [inGroup];
  if (mode === "ignore-term") children.push(holder({ detached: true }));
  process.stdout.write("ready\n");
  publish({ leader: { pid: process.pid, start: startOf(process.pid) }, children: children.map((child) => ({ pid: child.pid, start: startOf(child.pid) })) });
  for (const child of children) child.unref();
  if (mode === "leaks-pipe") process.exit(0);
  setInterval(() => {}, 1000);
}
