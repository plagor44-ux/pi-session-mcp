# Project rules

## Commands

- Install: `npm ci`. Type check: `npm run typecheck`. Build: `npm run build`.
- Tests: `npm test` (Vitest); one file with `npx vitest run test/<name>.test.ts`.
- Issues and pull requests follow the templates in `.github/`. In a pull
  request, report only checks you actually ran, with their results.
- Run the targeted tests for the files you change, then `npm test`. Inside a
  container writer a few lock and hook tests can time out; report them by
  file and test name instead of changing them.
- CI runs `npm ci`, `npm run typecheck`, `npm run build:cli`,
  `NODE_OPTIONS=--unhandled-rejections=strict npm test` and `npm run build`;
  run the same before a pull request.

## Rules

- Use Node.js 22.19.0 or newer, TypeScript strict mode, ESM, and `.js` suffixes in relative imports.
- Pin every direct production and development dependency exactly; do not use range prefixes.
- Keep stdout exclusively for MCP stdio frames. Diagnostic logs go to stderr, are structured, and contain neither secrets nor complete prompts.
- Accept workspaces only through configured aliases. Never add a tool argument that accepts an arbitrary `cwd`.
- Keep Pi behind `PiSessionAdapter`; tests must use a fake and must not need provider credentials.
  One maintainer-approved exception (2026-10-26, #142): the writer wrapper
  refreshes host OAuth credentials through the package-root `ModelRuntime`
  (`getAuth` only, no session, injectable in tests). A second narrow exception
  is the offline model catalog: `getProviders`, `getModels`, and
  `checkAuth` (reduced to a boolean) only, behind injectable `ModelCatalog`.
  Its runtime is created with `refreshOnCreate: true` and
  `allowModelNetwork: false`: an offline restore of the catalog Pi persisted
  earlier (`models-store.json`). It reads stored credential records and
  resolves API-key values in-process, as `checkAuth` does, but makes no
  network request, no credential refresh and no `getAuth`. The catalog may also
  read each model's output price offline for the guided setup's tier proposal only
  (maintainer-approved 2026-11-09). The session
  adapter keeps `refreshOnCreate: false` and restores that catalog only for
  the selected provider, offline and within its auth deadline
  (maintainer-approved 2026-10-30, #199). A third narrow exception is the
  provider store (ADR 0021, maintainer-approved 2026-11-10): right after a
  `ModelRuntime` is created for the session adapter or the catalog, the
  runtime may call `registerProvider` for operator-defined providers (without
  a key in their configuration) and `setRuntimeApiKey` for providers whose
  source is a stored key, both offline and without persistence; only
  `src/provider-store.ts` reads key values. Do not widen these exceptions.
- Use only documented exports from package roots. Record unsupported SDK needs rather than importing internals.
- Treat MCP annotations as client hints, never as authorization or policy enforcement.
- CLI reports must be sanitized and must not contain secrets, paths, or
  complete prompts.
  Exception: `pi-session-mcp-history show --full`, `export` and `query` print
  redacted session content by purpose (ADR 0019); their other output follows
  this rule.
- Doctor is offline-only. Setup mutations require explicit `--apply`,
  `--rollback`, or `--remove`; default to dry-run, never pin client versions but
  reject a client whose public command output does not match the expected
  contract, and never auto-replace divergent registrations.
- Only two setup operations use a provider: `--probe-profile … --apply`, and
  the probe step of `--guided --apply` for new profiles after explicit
  `approveProbes`. Both use the fixed probe prompt, never output reply text,
  and use fakes in tests.
- Guided setup and `install.sh` never read, print or store a provider
  credential themselves; the owner logs in through Pi or stores a key with
  `pi-session-mcp-provider auth set`. Only on an interactive terminal, and
  never with `--answers`, a non-terminal or a dry run, guided setup may run
  that command as a child process on the same terminal and receives only its
  exit status (ADR 0021). The provider CLI reads a key only from a terminal
  prompt with echo off or from standard input with `--stdin`, rejects a key in
  an argument and has no command that prints one.
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
- Tracked files contain no operator-specific hosts, paths, or internal service names; use placeholders.
- The current product boundary is local stdio, in-memory session state, an opt-in local session history file (ADR 0019), and one trusted local MCP peer. Optional tier routing (ADR 0020) reads `routing.json` beside the configuration and keeps its learning state in that history file. HTTP, a web UI, resume, remote access, and multi-user behavior are out of scope unless a later approved change explicitly expands it.
- Pi extensions load only from an execution profile's exact
  `npm:<name>@<version>` allowlist, resolved from Pi's install without
  installing. Client prompts never dispatch extension commands, and stdout stays
  reserved for MCP frames through the stdout guard. Extensions may persist their
  own state; Pi Session MCP itself keeps sessions in memory; its only persistent store is the opt-in session history (ADR 0019).

<!-- OPENWIKI:START -->

## OpenWiki

A checkout may have a generated `openwiki/` evidence index. It is not tracked in Git and may be missing or stale. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

No workflow refreshes the index; the maintainer regenerates it with the OpenWiki update lifecycle. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
