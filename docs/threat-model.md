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
- **False verification:** Verify combines Doctor and exact registration
  equality with a bounded direct MCP initialize, `tools/list`, and
  `pi_capabilities_get({})` call. It never starts a session or invokes
  a provider; the verifier cleans up its process.
- **Concurrent setup corruption:** On an explicitly supported local Linux
  filesystem (ext2/3/4, XFS, Btrfs, tmpfs, overlayfs, ZFS, F2FS, UBIFS, or
  bcachefs), durable
  ownership transactions hold a stable, never-renamed regular file through a
  kernel `flock`. There is no clock-based stale recovery. A transaction guardian
  inherits that locked file description, launches each mutating client command
  in its own process group, and retains the fence across parent death until
  `/proc` confirms that no non-zombie group member remains. Indeterminate cleanup
  retains the fence and fails closed; missing or untrusted `flock`, unsupported
  filesystems, symlinks, inode mismatch, and raw lock errors are reduced to
  stable codes. Directory creation and atomic state replacement are fsynced
  through their parent directory before success. A mutation already accepted
  by an external CLI or configuration backend cannot be rolled back
  automatically and remains `pending` for reconciliation.
- **Unsupported process-group guarantees:** Setup is accepted on Linux only.
  Every non-Linux platform fails closed before client spawn because the tested
  kernel-fence and `/proc` process-group proof are unavailable.

- **Workspace escape:** callers can request configured workspace aliases only; validated configuration maps aliases to resolved paths. There is no arbitrary `cwd` input.
- **Execution-selection escalation:** callers cannot supply raw provider, model, thinking level, permission profile, or credentials. A configured execution-profile alias binds all of those values; exactly one configured default is `read-only`. The legacy `profile` input is rejected rather than silently reinterpreted.
- **Resolver fallback:** fuzzy CLI resolution, settings, restore, and first-available fallback could run a different model. The adapter uses only exact `ModelRuntime.getProvider()` and `getModel()` on its durable runtime, then passes an explicit model to `createAgentSession`.
- **Missing/auth-refresh failure:** a catalog entry alone does not prove authentication. `checkAuth()`, `getAuth(model)`, and local availability are checked with a deadline before creation. Auth values and raw refresh failures never leave the adapter.
- **Thinking-level clamping:** SDK capability handling can alter a requested level. The adapter compares the effective `session.thinkingLevel` after creation and disposes on a mismatch.
- **Orphaned SDK session:** a post-creation mismatch or later registry failure could otherwise leave a live Pi handle. The adapter holds it locally until all postconditions pass, best-effort disposes on each later failure, and the registry admits only verified handles.
- **Excess capability:** the execution profile selects a permission-derived tool allowlist. Read-only permits only `read`, `grep`, `find`, and `ls`; coding remains high impact.
- **Project resource code execution:** Pi resource loading disables extensions, skills, prompts, and themes. Non-executable `AGENTS.md` context remains untrusted instruction content, never authorization.
- **Concurrent state corruption:** a per-session queue serializes prompt admission and close; concurrent abort callers share one attempt for the active turn. Closing is terminal, settles an active turn, and disposes once.
- **Secret/prompt disclosure:** stdout is protocol-only. Stderr diagnostics use stable code and safe context only. Public metadata is whitelisted and omits auth objects/sources, credential paths, headers, base URLs, complete model objects, SDK IDs, raw provider errors, prompts, transcripts, and tool data. Completed `assistantText` can still repeat model-visible data and is potentially sensitive.
- **Capability-enumeration disclosure:** the trusted local MCP peer can read configured workspace aliases and execution-profile provider/model intent. Discovery omits workspace paths, authentication state, SDK state, sessions, turns, prompts, transcripts, and tool data. Operators must choose aliases that are suitable for this trusted-peer boundary.
- **Stale capability assumptions:** discovery reads configuration only. It makes no provider, authentication, filesystem, or network probe and cannot prove that a configured provider/model is available. Session creation keeps the existing exact runtime checks.
- **Availability:** input length is bounded; profile-specific authentication/catalog work and session creation have 5,000 ms and 10,000 ms deadlines. Preflight, abort, close cleanup, registry shutdown, and signal shutdown have 5,000 ms, 5,000 ms, 5,000 ms, 12,000 ms, and 15,000 ms server-side deadlines. Active sessions retain 20 turns and 64 KiB UTF-8 of final text per turn. The registry rejects starts after shutdown begins and disposes a late-created handle. The signal path explicitly exits the process after its cleanup deadline, but cannot prove graceful termination of a blocked provider operation.
- **Misleading annotations:** annotations are client hints only and never grant access.
- **Shutdown orphaning:** signals invoke bounded registry cleanup and transport close. Handles are disposed at most once; late promises are ignored after removal. Explicit process exit prevents local shutdown from hanging indefinitely, but SDK limitations can leave external work unconfirmed or abruptly cut off.

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

Aliases and profile definitions are trusted administrator configuration, not a filesystem or provider-security sandbox. A locally available model may later be unreachable; no live provider request is made during selection. Symlinks and Pi tools can reach resources permitted to the OS identity. `AGENTS.md` can influence model behavior. The number of active sessions and the duration of an already accepted turn remain unbounded. Stdio peer authentication, quotas, persistent recovery, provider hard-kill capability, dependency integrity policy, and OS/filesystem isolation remain outside the verified boundary. Coding-profile acceptance checks behavior in a selected fixture; it does not prove OS-level isolation.
The trusted same-UID operator can unlink or replace the setup lock path between
checks and must not mutate the ownership directory during a transaction.
