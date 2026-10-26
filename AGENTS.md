# Project rules

## Commands

- Install: `npm ci`. Type check: `npm run typecheck`. Build: `npm run build`.
- Tests: `npm test` (Vitest); one file with `npx vitest run test/<name>.test.ts`.
- Run the targeted tests for the files you change, then `npm test`. Inside a
  container writer a few lock and hook tests can time out; report them by
  file and test name instead of changing them.

## Rules

- Use Node.js 22.19.0 or newer, TypeScript strict mode, ESM, and `.js` suffixes in relative imports.
- Pin every direct production and development dependency exactly; do not use range prefixes.
- Keep stdout exclusively for MCP stdio frames. Diagnostic logs go to stderr, are structured, and contain neither secrets nor complete prompts.
- Accept workspaces only through configured aliases. Never add a tool argument that accepts an arbitrary `cwd`.
- Keep Pi behind `PiSessionAdapter`; tests must use a fake and must not need provider credentials.
- Use only documented exports from package roots. Record unsupported SDK needs rather than importing internals.
- Treat MCP annotations as client hints, never as authorization or policy enforcement.
- Keep MCP-server stdout exclusively for MCP stdio frames; CLI reports must be
  sanitized and must not contain secrets, paths, or complete prompts.
- Doctor is offline-only. Setup mutations require explicit `--apply`,
  `--rollback`, or `--remove`; default to dry-run, never pin client versions but
  reject a client whose public command output does not match the expected
  contract, and never auto-replace divergent registrations.
- Setup accepts only configured client targets and derives absolute paths
  internally; durable ownership state must remain path-free and secret-free.
- Mutating setup runs on Linux and macOS only. Linux requires a supported
  local-filesystem kernel `flock`, a trusted fixed util-linux binary, and
  readable `/proc`; macOS requires an `O_EXLOCK` lock on the APFS volume type
  of `/` and the trusted system `/bin/ps`. On both, keep the stable lock inode
  and guardian-held fence until a determinate process-table scan confirms no
  live mutating client process-group member remains. A single-threaded zombie
  has terminated and holds no descriptors; on Linux a zombie thread-group leader
  whose group still counts other threads (`num_threads` above 1) counts as alive. This is a termination
  guarantee, not a PID-reaping guarantee. An indeterminate scan retains the fence.
- Verify must include Doctor, registration equality, and a bounded direct MCP
  handshake/tools/list/capabilities check, without starting sessions or using a
  provider. No real mutation or dogfooding may be claimed without evidence.
- Write all tracked documentation in English, including plans, handoff notes, and evidence records.
- The current product boundary is local stdio, in-memory state, and one trusted local MCP peer. HTTP, a web UI, persistence/resume, remote access, and multi-user behavior are out of scope unless a later approved change explicitly expands it.
- Pi extensions load only from an execution profile's exact
  `npm:<name>@<version>` allowlist, resolved from Pi's install without
  installing. Client prompts never dispatch extension commands, and stdout stays
  reserved for MCP frames through the stdout guard. Extensions may persist their
  own state; Pi Session MCP itself stays in-memory.
