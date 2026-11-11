# ADR 0022: Owner-operated account sign-in for built-in providers

**Status:** Accepted (2026-11-11, owner decision). The owner decided the
mechanism, the storage, the network use and the sign-out rule and approved
this document on 2026-11-11.

- Amends [ADR 0021](0021-provider-credentials.md), whose consequences keep
  OAuth enrollment out of scope, and the `AGENTS.md` rules listed under
  [Rule changes](#rule-changes).
- Implements [#290](https://github.com/plagor44-ux/pi-session-mcp/issues/290).

## Context

Some built-in providers are used with an account sign-in, for example a
subscription, instead of an API key. Pi Session MCP manages keys only
(ADR 0021): `pi-session-mcp-provider auth set` stores one, `auth remove` and
`auth inherit` change the source. Since 0.20.0 an owner can install with
`sh install.sh` and configure key-based providers without touching Pi (#267).
For an account sign-in the owner still has to know that Pi is bundled, find
its executable inside the installed package and sign in there; guided setup
only names that executable.

Everything after the sign-in already works, because a Pi sign-in is the
`inherit` source:

- the offline catalog reports the provider as authenticated (`checkAuth`,
  reduced to a boolean);
- the session adapter checks and resolves the credential before a session
  starts (`checkAuth`, `getAuth`), and `getAuth` refreshes an OAuth credential
  under Pi's store lock;
- the writer launcher copies a selected provider's access token into the
  writer's boundary `auth.json` without the refresh token and refreshes the
  host credential beforehand (#142).

The pinned Pi SDK 1.5.2 provides the sign-in itself:

- Nine built-in providers declare account sign-in through an `auth.oauth`
  entry on the provider objects that the package-root
  `ModelRuntime.getProviders()` returns: `anthropic`, `github-copilot`,
  `kimi-coding`, `meta`, `openai`, `openai-codex`, `openrouter`, `radius` and
  `xai`. Their methods differ: a browser sign-in with a callback to a local
  port, a device code, or a code or redirect address that the owner pastes.
- The bundled CLI's `pi auth login <provider> [--no-browser]` runs the whole
  dialogue on a terminal and requires standard input and standard output to
  be terminals. Without `--no-browser` it selects the browser method, tries to
  open a browser and prints the address to open. With `--no-browser` it
  selects the provider's other method, such as a device code, or prints the
  browser address without opening it when the provider has no other method.
  It stores the credential in Pi's store, `auth.json` in Pi's agent directory
  (`~/.pi/agent` unless `PI_CODING_AGENT_DIR` moves it), under Pi's file lock
  and with mode 0600 when it creates the file. Afterwards it refreshes that
  provider's model catalog once from Pi's catalog service, bounded to 15
  seconds; Ctrl-C skips the refresh, and `--offline` or `PI_OFFLINE` turns it
  off. It starts no session and sends no model request. It handles Ctrl-C
  itself: during the dialogue it cancels the sign-in, during the catalog
  refresh it skips the refresh. It exits with 0 after a stored sign-in and
  with 1 otherwise, cancellation included. One exit with 1 follows a stored
  sign-in: when Pi cannot synchronize its local model state afterwards, it
  says so on the terminal.
- `pi auth logout <provider>` deletes the provider's entry from Pi's store
  under the same lock. It needs no terminal, sends no revocation request to
  the provider and also exits with 0 when nothing was stored. Like the
  sign-in, it exits with 1 when the entry is deleted but the local model
  state cannot be synchronized.
- The package-root `ModelRuntime` also offers `login` and `logout`; see
  [Alternatives considered](#alternatives-considered).

## Decision

### Commands

The provider CLI gains two commands:

```sh
pi-session-mcp-provider auth login <provider> [--no-browser]
pi-session-mcp-provider auth logout <provider>
```

Both accept only built-in providers that declare account sign-in. An
operator-defined provider, or a built-in provider without account sign-in, is
refused with `sign_in_unsupported` before anything runs.

### Mechanism: Pi's own sign-in as a child process

`auth login` runs the bundled Pi CLI's `auth login <provider>`, with
`--no-browser` when given, as a child process, the way guided setup runs
`auth set` (ADR 0021):

- The command requires standard input and standard error to be terminals and
  otherwise stops with `usage_invalid` before anything else, so a pipe or a
  non-interactive script cannot run it. The check is a guard, not a boundary:
  a program that allocates a pseudo-terminal passes it, so keeping agents out
  of a sign-in stays a rule for agents ([agent guide](../agent-install.md)),
  not something the command enforces.
- The child is the `pi` executable that the pinned
  `@earendil-works/pi-coding-agent` package declares, started with the
  current Node.js and never looked up on `PATH`.
- The child inherits standard input and standard error. Its standard output
  is joined to standard error, so the provider CLI's standard output still
  carries only `ok`, and Pi's terminal check passes because both streams are
  the owner's terminal.
- The child runs in the account's home directory, so no project directory's
  Pi settings apply, and with the provider CLI's environment, so
  `PI_CODING_AGENT_DIR`, `PI_OFFLINE` and Pi's proxy settings apply as they do
  for Pi itself.
- Pi Session MCP never reads, records or reformats the child's output. The
  sign-in address, codes, instructions and Pi's confirmation, which names its
  credential file, reach only the terminal that the command runs on.
- Before the child starts, the command prints one line on standard error:
  `Signing in to <provider> through Pi. Where Pi suggests "pi auth login", run "pi-session-mcp-provider auth login".`
  Pi's own hints name its own executable, which is not on the owner's `PATH`.
- Only the child's exit status is used: 0 is success; any other status, or a
  child that cannot start, is `sign_in_failed`. Pi does not tell a failure
  from a cancellation, so neither does this command.
- While the child runs, the provider CLI ignores `SIGINT`. Ctrl-C on the
  terminal reaches the whole foreground process group; Pi handles it, and the
  provider CLI stays alive to act on Pi's exit status. Otherwise a Ctrl-C that
  only skips Pi's catalog refresh would end the provider CLI after a stored
  sign-in and before the source rule below runs.

`auth logout` runs the bundled CLI's `auth logout <provider>` the same way,
except that all three of the child's standard streams are ignored, so none of
Pi's text reaches the provider CLI's output. Like `auth remove`, it needs no
terminal.

The provider CLI does not call `ModelRuntime.login` or `ModelRuntime.logout`.

### Storage: Pi's own store

The credential lives where Pi stores it. The provider's source stays, or
becomes, `inherit`. There is no new source state, and nothing downstream
changes: the catalog, the session adapter, the profile probe, the writer
handoff and the host refresh treat it like any other Pi credential.

Pi's store is shared with any Pi that the same user runs, so a sign-in or a
sign-out through Pi Session MCP has the same effect as one in that Pi. An
owner without a Pi installation of their own is not affected.

### Source policy

The commands keep ADR 0021's rule that no command silently changes which
credential a provider uses:

| Source before | `auth login` | `auth logout` |
| --- | --- | --- |
| `inherit` | Signs in; the source stays `inherit`. | Sets `none`, then deletes Pi's entry. |
| `none` | Signs in, then sets `inherit`. | Deletes Pi's entry; the source stays `none`. |
| `key` | Refused with `provider_key_stored`; nothing runs. | Deletes Pi's entry; the source stays `key`. |

- `auth login` changes the source only after Pi reported success, and only
  when the source, read again at that point, is still `none`; a source that
  changed during the sign-in stays as it is. If the product store cannot be
  written then, the command fails with `provider_store_unavailable`.
- Every failure of `auth login` fails closed. When Pi stored the credential
  but did not exit with 0 (the synchronization case above), or when the store
  write failed, the sign-in is in Pi's store while a provider that was `none`
  stays `none`. `auth inherit <provider>` or another `auth login` enables it;
  the documentation and guided setup's failure line say so.
- `auth logout` writes `none` before Pi deletes the entry, so a failed
  deletion (`sign_out_failed`) still leaves the provider unauthenticated, and
  running the command again deletes the entry or, when it is already gone,
  succeeds. Under `none` no other Pi credential, such as a key in an
  environment variable, can take over, so a sign-out never silently enables
  another account. `auth login` or `auth inherit` enables Pi's authentication
  again.
- A stored key keeps precedence (ADR 0021). A sign-in made while a key is
  stored would stay unused, so `auth login` refuses it and, on a terminal,
  says that `auth inherit <provider>` drops the key and
  `auth remove <provider>` disables the provider.
- Sign-out is local. The SDK has no revocation, so the provider keeps
  accepting the refresh token until it expires or until the owner ends the
  session in the provider's account settings. The documentation says so.

### Exit statuses

| Exit | Output | When |
| --- | --- | --- |
| 0 | `ok` on standard output | Success. |
| 64 | `usage_invalid` | Wrong arguments, or `auth login` without a terminal on standard input and standard error. |
| 3 | `provider_unknown` | No such provider. |
| 4 | `sign_in_unsupported` | An operator-defined provider, or a built-in provider without account sign-in. |
| 4 | `provider_key_stored` | `auth login` while a stored key is the source. |
| 1 | `sign_in_failed` | Pi's sign-in ended with a status other than 0, or did not start. |
| 1 | `sign_out_failed` | Pi's sign-out ended with a status other than 0, or did not start. |
| 1 | `provider_store_unavailable` | The product store could not be read or written. |

Exits 3, 4 and 64 end before Pi runs and before any write. Error codes go to
standard error, as for the other provider CLI commands.

### Network use

`auth login` becomes the third operation of the setup tools that contacts a
provider, after the two profile probes. As decided by the owner, it runs Pi's
sign-in the way Pi runs it:

- the provider's sign-in endpoints (authorization, token, device code) and the
  calls that Pi's flow makes for some providers, for example to enable
  GitHub Copilot's models, to create Meta's key or to discover Radius's
  gateway;
- one refresh of that provider's model catalog from Pi's catalog service
  (for OpenRouter narrowed through OpenRouter's API to the account's models),
  bounded to 15 seconds. Pi persists the result, so the offline catalog lists
  the provider's current models afterwards. `PI_OFFLINE` in the owner's
  environment turns the refresh off.

The command sends no model request and spends no turn. `auth logout` and all
other provider CLI commands make no network request, and Doctor stays offline.

### Guided setup

The credential step (ADR 0021, #289) offers the sign-in under the same
conditions as the key entry: an interactive terminal on standard input and
standard error, and `--apply`. It never offers it with `--answers`, on a
non-terminal or in a dry run.

- The introduction says that the owner can sign in to a provider account or
  store an API key, for each provider named one at a time. The `?` listing
  adds a line with the providers that offer account sign-in.
- For a provider that offers account sign-in, setup asks whether to sign in
  or to store a key, with sign-in as the default. For any other provider it
  runs the key entry as today.
- Before a sign-in it asks whether to open a browser on this machine. The
  default is no in an SSH session (`SSH_CONNECTION` or `SSH_TTY` set) and on
  Linux without `DISPLAY` or `WAYLAND_DISPLAY`, and yes otherwise; no adds
  `--no-browser`.
- It runs `pi-session-mcp-provider auth login <provider>` as a child process
  on the same terminal and receives only its exit status, as it does for
  `auth set`, then reloads the catalog. For exits 3, 4 and 64 it reports
  `nothing changed`, for any other failure `sign-in failed`, each with
  whether the provider is authenticated; when a failed sign-in leaves the
  provider unauthenticated, it adds that `auth inherit <provider>` enables a
  sign-in that Pi stored anyway.
- While guided setup runs a credential command (`auth set` or `auth login`)
  as a child process, it ignores `SIGINT` as the provider CLI does. A Ctrl-C
  there ends only that command and returns to the provider question, as an
  interrupted key entry already does; anywhere else in the interview Ctrl-C
  still ends the run with `operation_interrupted`.
- The hint after the step names
  `pi-session-mcp-provider auth login <provider>` instead of Pi's executable.

### Unchanged

- Host sessions, the profile probe and the catalog read the credential
  through Pi as before. Doctor stays offline and gets no new check.
- Container writers: the selected provider's access token crosses the
  boundary, the refresh token does not, and the host refreshes (#142). A
  sign-out reaches a writer at its next launch; a running session keeps the
  credential it started with.
- No MCP tool starts, completes or observes a sign-in or a sign-out.

### Leak boundaries

No token, authorization code, device code or sign-in address enters Pi
Session MCP's process, and none appears in its reports, logs, diagnostics, MCP
results, configuration, guided answers, backups, history or event spool. Pi
writes them only to the terminal that the command runs on and keeps the
credential in its own store, as for every `inherit` credential.

### Rule changes

`AGENTS.md`:

1. "Keep Pi behind `PiSessionAdapter`": the provider CLI's `auth login` and
   `auth logout` may run the bundled Pi CLI's commands of the same names as
   child processes and use only their exit status.
2. The offline catalog exception: the catalog may also read, offline, whether
   each provider declares account sign-in (`auth.oauth` on the entries of
   `getProviders()`), for the provider CLI and guided setup.
3. Provider use by the setup tools: `auth login` is added, with the network
   use described above.
4. Guided setup and `install.sh`: the owner signs in with
   `pi-session-mcp-provider auth login` or stores a key; guided setup may run
   either command as a child process and receives only its exit status.
5. Sanitized CLI reports: during `auth login` the child's own output reaches
   the owner's terminal unread; the provider CLI's own lines stay free of
   secrets and paths.
6. The product boundary names owner-operated account sign-in through Pi's own
   store.

ADR 0021 gets a note that this ADR replaces its statement that OAuth
enrollment is out of scope.

### Verification

- Provider-free tests with fakes for both child processes cover every
  refusal (`--answers`, a non-terminal, a dry run, missing terminals, unknown,
  operator-defined and key-only providers, a stored key), the order of the
  source changes against the child's status, the child's streams, the
  ignored `SIGINT`, and guided setup's offer and outcome lines. A
  provider-free contract test reads the bundled CLI's auth help and fails
  when `auth login <provider>`, `--no-browser` or `auth logout <provider>`
  disappears. No test needs a provider, a browser or an account.
- Before the pull request is merged, the owner signs in and out once with a
  real account on a disposable installation that has only the npm package,
  over a terminal without a local browser. The record in `docs/acceptance.md`
  follows #278: sanitized outcomes (`list`, a passing
  `--probe-profile <alias> --apply`, `local_authentication_missing` after the
  sign-out), a leak scan of reports and logs, and the removal of the
  installation. No token, code or sign-in address goes into the record.

## Consequences

- An owner who has only the npm package signs in with one documented
  command, also without a local browser (`--no-browser`), and signs out with
  another.
- The provider CLI depends on the bundled CLI's `auth login` and
  `auth logout` command line. The SDK is pinned exactly, and a provider-free
  test that reads the bundled CLI's auth help guards that contract on SDK
  upgrades.
- The texts of the sign-in dialogue are Pi's, and its hints name Pi's
  executable.
- Pi's sign-in writes into Pi's agent directory beyond the credential: the
  `openai` flow stores a device ID in Pi's `settings.json`, the `radius` flow
  adds an MCP server entry to Pi's `mcp.json`, and the catalog refresh
  persists Pi's model store. Of these, Pi Session MCP uses only the model
  store.
- Pi Session MCP now contacts Pi's catalog service, once per sign-in.
- A sign-out does not revoke anything at the provider.
- An owner who moves Pi's agent directory through `PI_CODING_AGENT_DIR` or a
  different `HOME` must run the provider CLI and the server with the same
  environment; the writer launcher keeps reading Pi's store below the
  account's home directory, as before.

## Alternatives considered

- **`ModelRuntime.login` and `logout` inside the provider CLI.** This gives
  full control over texts, output and exit codes. It costs one more SDK
  exception, a terminal dialogue of our own for four prompt and four event
  types, a device ID of our own for the `openai` flow, and sign-in codes inside
  the product's process.
- **A credential location owned by Pi Session MCP.** It separates the sign-in
  from a Pi of the same user, but needs a new source state, a second
  credential path in the session adapter, the catalog, the probe, the writer
  launcher, the host refresh and Doctor, and rules of its own for binding and
  handoff.
- **Sign-in without the catalog refresh (`--offline`).** It contacts only the
  provider, but a provider's catalog then stays the list shipped with the SDK
  unless a Pi of the owner's own refreshes it. The owner chose Pi's behaviour.
- **Sign-out that keeps `inherit`.** Another Pi credential for the provider,
  such as a key in an environment variable, would take over without notice.
- **Sign-out that sets `none` and keeps Pi's credential.** It is reversible,
  but it leaves the token on disk and is no sign-out.
