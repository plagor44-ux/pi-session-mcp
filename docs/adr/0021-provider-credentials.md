# ADR 0021: Opt-in provider credentials and operator-defined providers

**Status:** Accepted (2026-11-10, owner decision).

- Amends the SDK exceptions in `AGENTS.md` (#142, #199) with one more narrow
  `ModelRuntime` use, and the install rule for an owner-operated key prompt.
- Implements [#265](https://github.com/plagor44-ux/pi-session-mcp/issues/265);
  frames [#266](https://github.com/plagor44-ux/pi-session-mcp/issues/266) and
  [#267](https://github.com/plagor44-ux/pi-session-mcp/issues/267).

## Context

Pi Session MCP has no credential source of its own. Host sessions, the offline
catalog and the profile probe resolve authentication through Pi's default
store; the Linux writer launcher copies the selected providers' entries from
that store into the writer's private agent directory. Using a different key for
one provider means changing Pi's store, which also changes the operator's own
`pi`. Endpoints that Pi does not ship, such as a local inference server, can
only be added through Pi's `models.json`, which the product does not read.

The roadmap keeps credentials out of scope without a separate ADR. This ADR is
that decision. It stays inside the product boundary: one local operator, local
files, no network service, no MCP tool that sees a credential.

## Decision

### Source policy per provider

Each provider has exactly one effective source:

| State | Meaning |
| --- | --- |
| `inherit` (default, no entry) | Pi's own authentication, as today. Pi-managed OAuth keeps its host-side refresh. |
| `key` | A static API key stored by Pi Session MCP. It takes precedence for this provider only. |
| `none` | Explicitly no credential. The provider counts as unauthenticated; Pi's store is not consulted. |

`auth remove` moves a provider from `key` to `none`, never back to `inherit`, so
removing a key cannot silently re-enable another account. `auth inherit`
restores `inherit` explicitly. An existing installation has no entries and
behaves exactly as before.

A `key` or `none` entry that cannot be read, fails validation, or whose binding
no longer matches (below) yields a sanitized error code. There is no fallback to
Pi's store or to another provider.

### Storage

Both files live in one fixed directory derived from the account database, like
the history file: `~/.config/pi-session-mcp/providers/`. `HOME` and
`XDG_CONFIG_HOME` do not move it, so every server process and the CLI see the
same store.

- `credentials.json` holds the source entries and key values (schema version 1).
- `providers.json` holds non-secret definitions of operator-defined providers.

The directory must be `0700` and each file `0600`, plain, owned by the user and
never a link. Reads use `O_NOFOLLOW` and an inode check. Writes go through a
temporary file, `fsync` and rename, serialized by an exclusive lock file in the
same directory. The directory lies outside every workspace, writer and snapshot
tree. The home directory is already a protected read path for skills, read-only
tools only read inside the workspace, and the sandboxed shell has no home, so
confined read-only workers cannot reach the store.

### Runtime integration

One host-side module (`provider-store`) is the only reader and writer. Every
place that creates a `ModelRuntime` for provider work (the session adapter, the
offline catalog and, through the adapter, the profile probe) applies the same
policy right after creation:

1. register each operator-defined provider with `ModelRuntime.registerProvider`,
   without any key in its configuration;
2. for each `key` entry, call `ModelRuntime.setRuntimeApiKey`, an in-memory
   overlay that takes precedence over Pi's store for that provider, persists
   nothing and synchronizes offline (`allowNetwork: false`);
3. treat each `none` entry as unauthenticated before Pi is asked.

These are documented methods of the package-root `ModelRuntime` export. This
adds one narrow SDK exception: `registerProvider` and `setRuntimeApiKey` with
values from the product's own store, no network, no `getAuth` beyond what the
session adapter already does. Catalog and probe report presence only and never
refresh OAuth.

The policy is read when a runtime is created. A changed key applies to new
sessions, new catalog reads and new probes; running sessions keep the key they
started with. A leased writer receives the key at launch, so a rotation reaches
it on its next session.

### Writers

The launcher reads the store on the host. For each selected provider it writes
into the writer's boundary `auth.json`:

- `inherit`: today's behaviour (OAuth without refresh token, API keys as stored);
- `key`: `{ "type": "api_key", "key": … }` from the product store;
- `none`: no entry.

Only the selected providers cross the boundary; the store, other keys and
refresh tokens never do. Operator-defined providers that a writer uses are
copied as non-secret definitions into the writer's configuration directory and
registered by the inner server the same way. A provider whose endpoint is a
loopback address is refused for container workspaces with
`provider_unsupported_in_writer`, because the writer's network namespace cannot
reach the host's loopback. Code inside a writer can use the key of its selected
provider; host coding runs as the operator. The threat model records both.

### Operator-defined providers

A definition has a unique ID that does not collide with a built-in provider, one
API from a fixed allowlist of Pi-supported protocols, an `https` base URL (or
`http` only for loopback hosts), no userinfo, and explicit model IDs. A key
stored for such a provider is bound to its ID and base-URL origin; changing the
endpoint makes the key unusable (`credential_binding_mismatch`) until the
operator sets it again. Inherited Pi credentials never apply to an
operator-defined provider.

### CLI and installer

`pi-session-mcp-provider` (#266) is the only interface to the store: `list`,
`auth set|remove|inherit`, `add`, `remove`. `auth set` reads the key from a
terminal prompt with echo off, or from standard input with `--stdin`; a key in
an argument is rejected; no command prints a key.

The installer and guided setup (#267) never read, print or store a key
themselves. On an interactive terminal, guided setup may offer, before profile
selection, to run `pi-session-mcp-provider auth set <provider>` as a child
process on the same terminal, and receives only its exit status. `--answers`,
non-terminal runs and dry runs never offer it.

### Leak boundaries

No key value is written to configuration, guided answers, backups, logs,
diagnostics, MCP results, history, the event spool or evidence. The history
redactor adds the stored key values to its secret list. Code that handles a key
itself (a provider SDK, an extension, code in a writer) is outside these
guarantees.

## Consequences

- One more SDK surface is used; a breaking change in `registerProvider` or
  `setRuntimeApiKey` shows up in the SDK canary.
- Operators get per-provider keys and local endpoints without touching Pi's
  store; Pi's own login stays the default.
- OAuth enrollment, a shared or remote secret service and MCP credential tools
  remain out of scope.

## Alternatives considered

- **A custom `CredentialStore` passed to `ModelRuntime.create`.** It would
  replace Pi's default store entirely, and that store is not a package-root
  export, so `inherit` could not be expressed without internal imports.
- **Writing keys into Pi's `auth.json`.** Changes the operator's own `pi`, and
  removal could not be told apart from inheritance.
- **Mounting or importing `models.json` for custom providers.** Brings Pi's whole
  model configuration across the boundary, which #266 excludes.
