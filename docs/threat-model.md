# Threat model

## Boundary and assumptions

Pi Session MCP trusts the local process that launches and speaks MCP over inherited stdio. It is not a network service. Pi and enabled coding tools run with the server OS identity. Provider services, the local Pi catalog/authentication mechanism, and package supply chains remain external trust dependencies.

## Threats and mitigations

- **Unsafe diagnostics:** Doctor is a separate offline CLI with no MCP, Pi,
  provider, credential, or network dependency. Its human/JSON output is
  sanitized and its stable exit statuses are 0 (healthy), 1 (warning), 2
  (failed check), and 64 (usage error).
- **Untrusted working directory:** an MCP client starts the server in the
  directory of the project it works on. The configuration path therefore comes
  only from `PI_SESSION_MCP_CONFIG`; the server has no default file and fails
  closed without the variable. A project cannot supply workspaces, execution
  profiles or external MCP commands by shipping a configuration file.
- **Registration mutation:** Setup defaults to dry-run. Apply, rollback, and
  remove require explicit operation flags; divergent registrations fail closed
  and are never silently replaced. Clients are accepted by contract, not by
  version: an unexpected `mcp` help text, registration output or scope is
  `unsupported`. A new client version that keeps the output format but changes
  what a command does is caught only by the inspection after every mutation,
  which must find the exact intended registration before ownership is recorded.
- **Path/secret disclosure:** Setup derives absolute paths internally from
  `process.execPath`, `dist/`, and `PI_SESSION_MCP_CONFIG`; no arbitrary `cwd` is
  accepted. Durable pending/owned ownership state contains neither paths nor
  secrets.
- **Skill installation into clients:** `setup --apply` writes the controller skill `pi-session-orchestration` into the clients' skill directories, in the home directory (`~/.agents/skills`, `~/.claude/skills`) and, for Claude Code `project`, in the project that setup runs in (`<project>/.claude/skills`). What is written there becomes instructions for the controlling agent, so the copy is as trusted as the package or the override it comes from. Mitigations:
  - Copies come only from the package's `skills/` directory or from the operator's override directory next to the configuration file. No tool argument, client prompt or workspace names a source.
  - The override directory and its `.pi-session-mcp-bases.json` are operator-trusted configuration next to the configuration file, never a workspace. Keep them out of every workspace and writable only by the operator; a `coding` session that can write there could change what setup installs next.
  - Setup reads a bounded tree of regular files (at most 32 files and 1 MiB, no links or special files) and installs it as a real copy, never as a link. The copy is staged and renamed into place. An update renames the old tree to a backup named after the pending record's transaction id and deletes it only after verifying that it is the exact old tree; leftover intermediates are deleted only by their exact names and only after verification (a leftover trash directory only while it still is the complete, unchanged replaced copy), and anything modified, foreign, partial or otherwise unprovable stays (`skill_recovery_retained`).
  - Setup never replaces or deletes a modified installed copy, hidden operator entries inside it, a foreign skill of the same name or a linked or non-directory entry; it reports `skill_divergent`. A link to exactly the effective skill is accepted as the operator's own (`skill_linked`) and never written through or deleted. Ownership records hold a version 2 content fingerprint (and, during an update, the replaced fingerprint), no path. A bare version 1 value from 0.8.0 names a copy only when a trusted reference (a released 0.8.0 shipped tree or the current library tree) has that value and the copy's exact bytes; otherwise setup reports `skill_legacy_unverified` and changes nothing; a project record carries an unsalted, truncated SHA-256 of the project's real path as an opaque identity, which someone who can read the state file could test against guessed paths.
  - A project may be untrusted. Inside a project setup never follows a link: any link below the project root makes the slot divergent, so a repository cannot redirect the write outside itself. In the home directory the client's skills directory may be the operator's own link (for example into a dotfiles checkout) and is followed; the skill entry itself is never followed.
  - `--customize-skill` writes only below the override directory, never overwrites an existing override and never edits an operator's file. It moves the recorded base only on an explicit `--apply`, which acknowledges a reviewed change to the shipped skill. `--apply` runs under an exclusive kernel lock on `<override dir>/.pi-session-mcp-bases.lock` and replaces the bases file atomically, so concurrent runs cannot lose a base; the dry-run takes no lock and writes nothing.
  - Worker skills are not installed into clients. Reports name the skill and a stable code, never a path or content.
- **False verification:** Verify combines Doctor and exact registration
  equality with a bounded direct MCP initialize, `tools/list`, and
  `pi_capabilities_get({})` call. It never starts a session or invokes
  a provider; the verifier cleans up its process.
- **Concurrent setup corruption:** Durable ownership transactions hold a
  stable, never-renamed regular file through a kernel lock on an explicitly
  supported local filesystem:
  - on Linux, through the trusted util-linux `flock`, on ext2/3/4, XFS, Btrfs,
    tmpfs, overlayfs, ZFS, F2FS, UBIFS, or bcachefs;
  - on macOS, through `O_EXLOCK` at open, on the APFS volume type of `/`.

  There is no clock-based stale recovery. A transaction guardian inherits that
  locked file description, launches each mutating client command in its own
  process group, and retains the fence across parent death until a determinate
  process-table scan confirms that no live group member remains. A single-threaded
  zombie has terminated and holds no descriptors; on Linux a zombie thread-group
  leader whose group still counts other threads counts as alive. The scan reads `/proc`
  on Linux and the trusted system `/bin/ps` on macOS; a
  `ps` sample that fails, has an unexpected line or does not list the scanning
  process is indeterminate. On macOS the proof rests on `/bin/ps` on the
  sealed, SIP-protected system volume, together with the uid and mode check
  that also guards `flock`. The macOS lock relies on the documented `O_EXLOCK`
  behavior of open(2): flock(2) semantics on the open file description, and
  `EOPNOTSUPP` on a filesystem without locking, which fails closed.
  Indeterminate cleanup retains the fence and fails closed. A missing or
  untrusted `flock` or `ps`, unsupported filesystems, symlinks, inode
  mismatch, and raw lock errors are reduced to stable codes. Directory
  creation and atomic state replacement are fsynced through their parent
  directory before success. A mutation already accepted by an external CLI or
  configuration backend cannot be rolled back automatically and remains
  `pending` for reconciliation.
- **Unsupported process-group guarantees:** Setup runs on Linux and macOS
  only. Every other platform fails closed before client spawn because no
  tested kernel fence and process-group proof exist for it. On both supported
  platforms, the fence does not cover descendants that leave the process
  group, and it does not promise PID reaping.

- **Workspace escape:** callers can request configured workspace aliases only; validated configuration maps aliases to resolved paths. There is no arbitrary `cwd` input.
- **Execution-selection escalation:** callers cannot supply raw provider, model, thinking level, permission profile, or credentials. A configured execution-profile alias binds all of those values; exactly one configured default is `read-only`. The legacy `profile` input is rejected rather than silently reinterpreted.
- **Resolver fallback:** fuzzy CLI resolution, settings, restore, and first-available fallback could run a different model. The adapter uses only exact `ModelRuntime.getProvider()` and `getModel()` on its durable runtime, then passes an explicit model to `createAgentSession`.
- **Missing/auth-refresh failure:** a catalog entry alone does not prove authentication. `checkAuth()`, `getAuth(model)`, and local availability are checked with a deadline before creation. Auth values and raw refresh failures never leave the adapter.
- **Thinking-level clamping:** SDK capability handling can alter a requested level. The adapter compares the effective `session.thinkingLevel` after creation and disposes on a mismatch.
- **Orphaned SDK session:** a post-creation mismatch or later registry failure could otherwise leave a live Pi handle. The adapter holds it locally until all postconditions pass, best-effort disposes on each later failure, and the registry admits only verified handles.
- **Excess capability:** the execution profile selects a permission-derived tool allowlist. Read-only permits `read`, `grep`, `find`, `ls`, granted MCP tools and exactly the individually granted extension tools; coding remains high impact.
- **Project resource code execution:** Pi resource loading disables extension discovery, default skill directories, prompts, and themes; only a profile's allowlisted extensions and its explicitly selected catalog skills load (see below). A skill, prompt template or theme that an extension package ships is not made available by the allowlist. Non-executable `AGENTS.md` context remains untrusted instruction content, never authorization.
- **Concurrent state corruption:** a per-session queue serializes prompt admission and close; concurrent abort callers share one attempt for the active turn. Closing is terminal, settles an active turn, and disposes once.
- **Secret/prompt disclosure:** stdout is protocol-only. Stderr diagnostics use stable code and safe context only. Public metadata is whitelisted and omits auth objects/sources, credential paths, headers, base URLs, complete model objects, SDK IDs, raw provider errors, prompts, transcripts, and tool data. Completed `assistantText` can still repeat model-visible data and is potentially sensitive.
- **Capability-enumeration disclosure:** the trusted local MCP peer can read configured workspace aliases and execution-profile provider/model intent. Discovery omits workspace paths, authentication state, SDK state, sessions, turns, prompts, transcripts, and tool data. Operators must choose aliases that are suitable for this trusted-peer boundary.
- **Stale capability assumptions:** discovery reads configuration only. It makes no provider, authentication, filesystem, or network probe and cannot prove that a configured provider/model is available. Session creation keeps the existing exact runtime checks.
- **Availability:** input length is bounded; profile-specific authentication/catalog work and session creation have 5,000 ms and 10,000 ms deadlines. Preflight, abort, close cleanup, registry shutdown, and process shutdown (signal or stdin EOF) have 5,000 ms, 5,000 ms, 5,000 ms, 12,000 ms, and 15,000 ms server-side deadlines. Active sessions retain 20 turns and 64 KiB UTF-8 of final text per turn. The registry rejects starts after shutdown begins and disposes a late-created handle. The process shutdown path explicitly exits the process after its cleanup deadline, but cannot prove graceful termination of a blocked provider operation.
- **Allowlisted Pi extensions:** a profile's `extensions` load operator-trusted code into the server process with the user's full rights; it may start processes, use the network and write files (for example `pi-cursor-sdk` below `~/.pi/agent`, `~/.cursor/projects/` and `<workspace>/.pi/`). Mitigations:
  - Only exact `npm:<name>@<version>` specs from the operator's configuration load; the MCP client cannot name an extension.
  - Resolution never installs, and a different installed version fails closed. Only Pi's own user install (`<Pi agent dir>/npm/node_modules/<name>`, normally below `~/.pi/agent`) counts; a package installed elsewhere, for example with `npm i -g`, is reported as not installed.
  - `read-only` profiles activate only extension tools individually named in
    `grantedExtensionTools`; without grants they remain inactive. The grant is
    the operator's trust decision, not a read-only classification: granted tools
    are third-party code and may write. Workspace modes `container` and
    `read-only` do not restrict them. See
    [ADR 0010](adr/0010-read-only-extension-tools.md).
  - Grants must be registered at extension load and active and declared to the
    model at admission, or start fails closed with `extension_tool_missing`
    (class `needs_operator`). The SDK activates only declarable tools;
    registration alone is insufficient. Lazy registration in `session_start`
    or later is unsupported. An extension's `setActiveTools` cannot add
    ungranted tools. After load and again after binding, no extension tool may
    shadow a built-in or granted tool; later registrations are covered in the
    residual risks.
  - Client prompts never dispatch extension commands, but extension input hooks can still see, rewrite or consume a prompt. They receive it with `source: "rpc"`, Pi's marker for input from a program, so a hook that reads the source sees that no human typed it. A hook that ignores the source treats it like any other input.
  - Each extension session gets its own model runtime, and close emits `session_shutdown`.
- **Skills as prompt content:** a profile's `skills` select files from the operator's `skillCatalog`. The MCP client cannot name a skill, a path or a catalog entry; `pi_session_start` and `pi_session_prompt` take no skill input. Mitigations:
  - Catalog values are single local `SKILL.md` files: no directories, globs, URLs, scheme-prefixed sources, `~` or backslashes. The one accepted scheme is `builtin:<name>`, which resolves to the operator's override next to the configuration file or else to the skill shipped in the package, and to no other place. Relative paths resolve against the configuration file's directory, never against a workspace.
  - The server loads exactly the selected files with no default directories, validates them at session start and rejects oversized (over 256 KiB), duplicate, invalid and explicit-only skills with `skill_load_failed`. Its message and diagnostics never contain a path, skill name or SDK text.
  - Selection limits the regular skill catalog only. An allowlisted extension stays trusted executable code and can still read files or inject prompt text.
  - Skills are operator-managed prompt content. In `coding` profiles a skill's instructions run with the profile's tools, so a skill grants no rights but can direct everything the profile may do. Review skills like code.
  - Content is not snapshotted: the SDK keeps file paths, so a changed skill or companion file can reach a running session. Operators must not change them during active sessions. The configuration fingerprint covers configuration bytes, not skill contents.
  - A `coding` session can write any file in its workspace, including a catalog file that lies inside it, and so change the instructions of other sessions and profiles. Operators keep catalog files outside every configured workspace; nothing enforces this.
  - Whether the model reads a listed skill is the model's decision; configured, available and actually read are different states.
  - Pi lists each available skill to the model with the absolute path of its `SKILL.md`, so the model knows that path and can repeat it in `assistantText`. Capabilities, errors and diagnostics stay path-free; completed `assistantText` is model output and not sanitized.
- **stdout corruption:** every write through `process.stdout` or `console.log`, `console.info` and `console.debug` other than the MCP transport's is dropped. The stdout guard intercepts `process.stdout.write`, `process.stdout.end` and `console.log`, `console.info` and `console.debug`, which covers output from extensions and the SDK in the server process. stderr gets only `foreign_stdout_suppressed` with byte and write counts, never the content. Anything that writes file descriptor 1 directly is not covered; see the residual risks.
- **Misleading annotations:** annotations are client hints only and never grant access.
- **Shutdown orphaning:** `SIGINT`, `SIGTERM`, and stdin EOF invoke the same bounded registry cleanup and transport close, so a client that only closes stdin does not leave sessions or their MCP children running. Handles are disposed at most once; late promises are ignored after removal. Explicit process exit prevents local shutdown from hanging indefinitely, but SDK limitations can leave external work unconfirmed or abruptly cut off.
- **Turn-event spool (opt-in, [ADR 0011](adr/0011-turn-events-and-controller-wake.md)):** with `events.delivery: "spool"` the server writes one content-free file per terminal turn below `$XDG_RUNTIME_DIR/pi-session-mcp/events/`, and a Claude Code hook on the host reads them to wake the controller. New assets: the host runtime spool, the hook entry in a Claude Code settings file and the claims directory. Relayed turns use the host registry and spool; there is no per-session writer spool mount or writer hook entry, and the wake hook matches only `mcp__pi-session-mcp__*`. Mitigations:
  - Events carry identifiers, a state and a time only: no prompt, answer, path or error text. Files are mode 0600 in directories of mode 0700, and the server refuses a root that is not a real directory of the current user without group or other access (`event_spool_unavailable`). Doctor reports an unusable or unsafe runtime directory without creating anything (`event_spool_root`).
  - An event is a wake trigger, never state. The controller reads `pi_turn_get` and acts on that, so no event can change a result, a session or a decision of the registry. The server never reads the spool back.
  - A container worker has no spool mount and cannot forge, delete or flood host events through one. The host relay validates inner replies and owns public terminal transitions; inner state remains untrusted. The operator's runtime directory and claims remain outside every writer mount.
  - The hook parses strictly (exact keys, UUID identifiers, at most 1,024 bytes) and bounds its reads: at most 4,096 entries per directory, the 64 newest instance directories, a cache of 4,096 files, and a minimum gap between scans. It opens every directory with `O_NOFOLLOW`, checks the handle and reads through it, opens files with `O_NOFOLLOW`, accepts only regular files, and ignores an event whose instance does not match its directory. It follows no link.
  - Claims live in `claims/` next to, not inside, the events root (a hook whose claims directory lies inside the events root stays silent), which no writer mount contains. A claim is a content-free empty file created exclusively; a hook that is killed releases an undelivered claim.
  - At most one waiter runs per turn (an exclusive lock in `claims/`), a turn ended by `close` does not wake, and a waiter whose namespace shows no spool directory within 2 seconds exits quietly. If the runtime directory is full (`ENOSPC`, `EDQUOT`), claims and locks cannot be written and the waiter falls back to the budget wake, which needs neither.
  - The hook never prints more than event identifiers and a state, never a stack trace, and exits 0 silently on any unexpected input. It exits when its parent goes away. Its stdin is capped at 1 MiB and 10 seconds.
  - The hook runs on the host as the operator and makes no model call and no network access. What it prints becomes a system message for the controller, so the line is fixed text plus validated identifiers and a validated state.
  - Setup edits a Claude Code settings file, which is operator configuration. It writes one `PostToolUse` entry under the same dry-run, ownership and divergence rules as a registration: a read-modify-write with a compare-and-swap on the file bytes (a changed file is read again once, a second change fails with `settings_changed`), an atomic rename that keeps the file mode, a pending-before-write ownership record and no replacement or deletion of an entry it does not own. In a project scope it never follows a link below the project root. The entry holds absolute paths of the Node executable and the package, which must be free of shell metacharacters (`hook_path_unsafe`). Ownership records hold a fingerprint, never a path or a command.

- **Concurrent writer use and orphaned containers ([ADR 0012](adr/0012-leased-writer-pool.md)):** new assets are the host-only lease directory/files, stable wrappers, relay subprocess/transport and recorded workspace default base. The launcher holds `~/.local/state/pi-session-mcp/leases/<name>.lock`, not the host server. Files are never deleted, opened without following links and checked for type, owner and mode (0700 directory, 0600 file). Every mutating setup operation takes the same lease with a bounded wait (`writer_busy`), including collect and acceptance. Mutating host children inherit its descriptor; nested launchers validate/adopt it. Neither container nor Podman's monitor receives it, so worker code cannot unlock it. Fixed session name `pi-writer-<name>` and label `pi-session-mcp.writer=<name>` supplement the lock. Under the lease the holder confirms absence by label and clone mount, removes orphaned containers and fails closed if absence is uncertain, before any credential or clone change. Stdin end, SIGTERM and SIGHUP trigger refresh join and container cleanup while the launcher still holds the fence; a killed holder's leftovers are removed by the next holder. The trusted same-UID operator must not replace lease files or mutate writers outside setup.
- **Writer resource fairness:** optional `--cpus` and `--memory` hard caps and `--cpu-shares` relative weight constrain serving containers when the Podman host exposes the required cgroup controllers. Omitted caps are unlimited; maintenance containers are not limited. These are fairness measures for shared hosts, not a security boundary, and do not change acceptance or require reprovisioning.
- **Ignored writer files:** by default, ignored files in a persistent writer's clone survive reset and finish and reach the next task leased on that writer, invisible to baseline checks and collect. Opt in to `--clean all` to remove them on reset and finish; per-writer Go (`/pi/go`), uv/npm (`/pi/uv`) and npm-only (`/pi/npm`) caches outside the clone remain. These private writable caches survive reset, finish and recreate and are removed with the writer; they are not shared between writers or mounted from host package caches.
- **Untrusted relay replies and wrong-base work:** inner replies are schema-validated and size-bounded, never raw-frame passthrough. Host IDs, turn state and spool remain authoritative. Allocation matches the requested/default branch from host writer state, compares profile selection and rechecks placement after inner start; the inner guard still decides baseline admission. Transport loss fails the turn and makes further prompts refuse with `writer_session_lost`; get and close remain available. Branch matching is not commit freshness: results expose the selected base commit for review. Migration requires closed sessions/controllers, removes only owned registrations, rebinds wrappers and re-accepts provider-free; a divergent registration keeps the writer legacy rather than entering the pool.

## Residual risks

External MCP tool errors are untrusted input. The bridge projects only the
allowlisted `SOURCE_TOO_LARGE` code and a controller-owned message from a bounded,
closed validated object; it never forwards foreign error text, extra fields or
transport exceptions. Unsafe, conflicting and unknown errors remain generic.
This is available to the model as a failed tool execution, not public terminal
cause classification. Raw JSON-text duplicate keys are rejected; the SDK has
already decoded structured content, so original wire duplicates cannot be
observed here. These checks apply after decoding, not as a raw transport or
streaming memory boundary. Cancellation and close remain authoritative.

Successful external MCP result envelopes are limited to 262,144 serialized UTF-8
bytes. An oversized success exposes only a fixed controller-owned size-limit
message to the model as a failed tool execution; foreign payload and actual size
are not included. Only this execution's own error identity may survive the
sanitizing catch. A foreign transport exception with identical text remains
generic. This does not raise the limit, permit additional remote error codes or
change public terminal errors; cancellation and close still take precedence.

Aliases, profile definitions, skill catalog entries and the skill override directory are trusted administrator configuration, not a filesystem or provider-security sandbox. A locally available model may later be unreachable; no live provider request is made during selection. Symlinks and Pi tools can reach resources permitted to the OS identity. `AGENTS.md` can influence model behavior. The number of active sessions and the duration of an already accepted turn remain unbounded. Stdio peer authentication, quotas, persistent recovery, provider hard-kill capability and dependency integrity policy remain outside the verified boundary. OS/filesystem isolation is not provided by the server; ADR 0012 leases a coding-only server in a rootless Podman boundary per writer/session, retaining the writer boundary historically accepted on Linux for one writer on 2026-10-18 ([isolation setup](isolation-setup.md)). Inside that boundary the residual risks stay: network egress to the provider, the credentials the boundary holds, trusted extension code and the container runtime itself. Coding-profile acceptance checks behavior in a selected fixture; it does not prove OS-level isolation.
The trusted same-UID operator can unlink or replace the setup lock path between
checks and must not mutate the ownership directory during a transaction.

An allowlisted extension is trusted code; pinning its version does not detect
modification of the installed package directory. `read-only` limits the
model's tools, not extension code or hooks. Anything that writes file
descriptor 1 directly reaches the MCP stream, because Node.js cannot intercept
it: in-process writes such as `fs.writeSync(1, …)` or native code, and child
processes that an extension starts with inherited stdio. The Cursor runtime
behind `pi-cursor-sdk` starts processes of its own during turns (observed with
`pi-cursor-sdk@0.5.3`: `git`, `ssh`, `gh` and the MCP servers configured for
Cursor, in a `read-only` profile too); none inherited the server's stdout in
that run. Extensions may persist their own state outside Pi
Session MCP's in-memory boundary. Extension tool names are checked for
conflicts and for unsafe or MCP-reserved names after loading and again after binding; a tool that an extension
registers later, during a turn, is not re-checked and may replace a built-in
tool, `read` included, because allowlisted extensions are trusted code. An extension may deactivate built-in or granted
tools for its own session, but deactivating a granted extension tool before
admission fails the start with `extension_tool_missing`.

A hook entry is a command that Claude Code runs as the operator. Whoever can edit that settings file, or the package directory that the entry names, can run code, as with any hook; setup does not change this and never installs a hook into a scope the operator did not name. Claude Code's managed settings can disable hooks or restrict them to managed entries, in which case the wake silently does not happen and the controller must poll. Claude Code may need a restart, or a review of the new hook in `/hooks`, before it loads an entry that was added while it ran; setup reads and writes the file but cannot observe what the running client loads, so a verified entry is not proof that a wake fires. A one-shot `claude -p` run holds its next model request until the hook ends, so it is not a supported wake client. A server that crashes leaves a stale instance directory of content-free files on the host runtime tmpfs, which a logout clears on systemd hosts. Relayed writers have no spool mount. Provider-free acceptance is not evidence of a live controller wake or a live leased-pool rollout.
