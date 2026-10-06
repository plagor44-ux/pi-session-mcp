# ADR 0004: setup accepts clients by contract, not by version

**Status:** Accepted (2026-10-06)

## Context

`setup` registers Pi Session MCP with Codex CLI and Claude Code through their public `mcp` commands. It originally accepted only exact client versions whose command output had been recorded and replayed in tests. Every other version was reported as `unsupported`.

Both clients update themselves often. The allowlist was stale three times within one week; the last time, a client updated itself on the same day its previous version had been added. Each time `setup` refused a client whose command output was byte-identical to the last recorded one except for the version line. ADR 0003 names repeated setup friction beyond version drift as a trigger to revisit this area.

## Decision

`setup` no longer pins client versions. An adapter supports a client when:

- `mcp --help` exits with `0` and lists the `get`, `add` and `remove` subcommands, and
- the output of `mcp get` parses into the expected registration shape, or is the exact "not registered" message.

Any other output is `unsupported`. The client version is parsed when possible and reported for information only; an unparseable version line no longer blocks `setup`.

## Consequences

- A new client release needs no Pi Session MCP release as long as its output format is unchanged.
- The recorded outputs stay in `test/fixtures/client-contracts/` as contract regression tests. They are recorded again when a client changes its output; see [Releasing](../releasing.md#record-a-client-contract).
- The version check was a coarse guard against a client that keeps its output format but changes what a command does. That guard is gone. What remains is the inspection after every mutation: `setup` records ownership only when the client reports exactly the intended registration, and `--verify` checks registration equality and performs a direct MCP handshake. A registration that differs is reported as divergent and is never replaced.
- Unknown output still fails closed, and `setup` still does not parse undocumented client configuration files.

## Alternatives considered

- **Keep the exact allowlist.** Rejected: it made `setup` unusable for current clients most of the time, with no observed contract change to justify it.
- **A minimum version.** Rejected: it would still be a version rule that needs maintenance, and the contract check already rejects clients whose output differs.
- **Accept unknown versions with a warning status.** Rejected: a status that is neither success nor failure would complicate the stable result model without changing what is safe to do.
