# Node 24 installation and launcher binding

Date: 2026-10-17. The operator approved continuing the previously proposed Node
24 update, explicit Pi/MCP interpreter selection and provider-free verification.

Node **24.22.0**, Linux x64, was downloaded from the official versioned Node
distribution endpoint. The archive's SHA-256 matched the versioned official
HTTPS `SHASUMS256.txt` exactly. [Download evidence](download.json) records both
URLs, byte count and hash. No detached-signature verification is claimed.

The runtime was installed alongside existing installations in the user's local
opt directory. The system Node 22.23.2 package and the separate existing Node
24.20.0 installation were preserved. Pi remains version 1.1.0; the evaluated
project and its SDK remain 0.8.3 and 1.2.0. No SDK or Pi package upgrade was
substituted for a Node update.

## Explicit launch paths

The shared selector is `$HOME/.local/share/pi-node/current`, pointing to the new
24.22.0 installation. Both the managed Pi launcher and the installed
`pi-session-mcp` executable now explicitly execute this selector's Node binary.
They prepend the same runtime's `bin` directory to child PATH and fail if the
runtime is missing. They do not depend on an optional `XDG_DATA_HOME` override or
fall back silently to the system interpreter.

The MCP executable's former npm-owned symlink was replaced with the scoped
wrapper; the installed package's JavaScript entry was not edited. Pi's managed
version selection is retained. The global shell PATH was not edited.

A subsequent inspection found that both actual user registrations, Codex and
Claude Code, bypass this wrapper: they directly invoked `/usr/bin/node` with the
installed server entry. Both registrations were migrated to the real Node
24.22.0 executable. Only their command string changed; args, environment and all
other configuration bytes were preserved. The existing owned release binding was
proved before mutation, and only the two registration fingerprints were updated.
Managed skills were preserved. The normal setup CLI has no interpreter migration
operation; its refusal to replace a divergent binding was retained. The explicit
operator-authorized migration uses a separate reviewed helper with the existing
ownership fence, private backups and a persistent recovery journal.
[Migration](client-registration-migration.json),
[independent review](client-migration-review.json).

Direct client registrations bind the **server** to Node 24. They do not prepend
PATH like the wrappers. Children that select `node` through PATH can therefore
still use the client's original runtime. Likewise a bare `node` in an unrelated
shell can remain Node 22. No host-wide or child-runtime migration is claimed.

The new official runtime bundles npm 11.19.1. The existing user-prefix npm 12.2.0
was not replaced. PATH inherited from these launchers prefers the runtime's
bundled npm; the isolated package install used that recorded version with
lifecycle scripts disabled.

For an optional shell-local selection:

```sh
export PATH="$HOME/.local/share/pi-node/current/bin:$PATH"
node --version
```

## Verification

- The real `pi --version` path returned **1.1.0**. A preload receipt independently
  observed Node **24.22.0**, the expected executable and child PATH, even when
  the incoming PATH selected only system locations. [Pi result](pi-launcher-test.json).
- The real installed MCP executable completed initialize, `tools/list` and
  `pi_capabilities_get` with a fresh synthetic configuration and isolated HOME.
  Its receipt likewise observed Node **24.22.0**. Eight tools were listed;
  zero sessions were started and zero providers were called. Child termination
  was observed. [MCP result](mcp-launcher-test.json).
- The full provider-free suite passed **1,459 tests**, six skipped, zero failures,
  across 60 files. The standalone offline CLI passed **308 tests** with no failures
  or skips. These counts overlap. Typecheck and both builds passed.
  [Source-bound checks](node24-checks.json).
- Evaluated source digest remained
  `sha256:686887d57899c2e55593bb7dd98b78be08ea0fc6c471a6dd4eab3298f890d160`.
- An independent read-only review found no concrete launcher/ownership issue.
  [Review](launcher-review.json).
- Offline Doctor, exact registration inspection and the normal setup verification
  were run against the actual installed package and existing configuration.
  A separate bounded direct-registration handshake invokes only initialize,
  `tools/list` and `pi_capabilities_get`. No session or provider was started.
  [Actual-client verification](client-registration-verification.json).

Three pre-existing MCP stdio connections were still running Node 22 when checked:
one belongs to a Codex client and two to Claude clients. Their processes cannot
change interpreter in place. This session has no client reconnect control API;
it did not terminate peers whose sessions and pipes it does not own. Those clients
must reconnect their MCP server to apply the new command. The successful
fresh-start test does not mean that all existing connections were migrated.
For Codex, the documented desktop path is Settings → MCP servers → Restart;
the IDE extension exposes Restart extension after saving the server settings.
[Official Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Ownership and restoration

The original Pi launcher, original MCP symlink target, file modes, original/current
hashes and an ownership marker are stored under the user's local state directory
in scope `node24-extension-followup-04470d85-3a99-47e3-b356-ce96e77de0dd`.
The [switch record](launcher-switch.json) is path-free relative to user home.

The [restoration helper](restore-launchers.mjs) defaults to a non-mutating check.
It refuses to act if the owner, backups, current wrappers or selector diverged.
Its check passed. With an explicit `--apply`, it restores the original launcher
and symlink and removes only this switch's selector; it retains the installed
Node distribution and evaluation artifacts.

The launcher helper does **not** restore the two direct client registrations.
For a complete interpreter rollback, first run the separate
[client migration helper](migrate-client-node.mjs) with `--restore-check`, then
explicitly `--restore`, and only then restore launchers. The client helper
revalidates release binding, ownership and exact registration, replaces only the
current command token, and preserves other client edits. Its journal can recover
proved old/new intermediate states after interruption; unrecognized divergence
is refused. Leftover staging files fail closed and require inspection. Both
helpers were checked; neither restoration was applied. Private full configuration
backups remain outside the repository and are never copied into this dossier.

```sh
"$HOME/.local/opt/node-v24.22.0/bin/node" \
  "$HOME/.local/state/pi-node24-switch/node24-extension-followup-04470d85-3a99-47e3-b356-ce96e77de0dd/restore-launchers.mjs" \
  --check
```

Future npm or managed-Pi upgrades can regenerate these launcher files. Their Node
binding must then be checked again; restoring over later unrelated edits is
deliberately refused. No authentication store, production profile, deployment or
external repository was changed by this installation.
