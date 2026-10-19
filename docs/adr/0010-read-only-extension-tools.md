# ADR 0010: Granted extension tools in read-only profiles

**Status:** Accepted (2026-10-19). Amends
[ADR 0006](0006-pi-extension-allowlist.md).

## Context

ADR 0006 keeps read-only built-in tools at `read`, `grep`, `find` and `ls`.
Extensions can already run hooks and change prompts, but their tools remain
inactive in read-only profiles. Review workers need selected extension tools
for code navigation without enabling every tool a package registers.

## Decision

Allow the optional profile field `grantedExtensionTools`, an array of individual
extension tool names, only on `read-only` profiles with at least one extension.
There is no package-wide grant. Without grants, behavior stays unchanged.

Each name must be 1–64 characters from `[A-Za-z0-9_-]`, not start with `-`,
and not be MCP-reserved (`mcp__` prefix, `list_mcp_resources`,
`list_mcp_resource_templates`, `read_mcp_resource`). No duplicates or built-in
names (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) are allowed, and
there are at most 32 entries. A violation prevents startup with
`invalid_execution_profile_config`.

The active tools are `read`, `grep`, `find`, `ls`, the granted MCP tools and
exactly the granted extension tools. An extension's `setActiveTools` cannot
add others. A granted name must be registered when extensions load, before
binding. After bind the existing registered-set re-check applies. Each granted
tool must also be active and declared to the model at admission; otherwise
`pi_session_start` fails with `extension_tool_missing`, message
`Granted Pi extension tool is not available`, class `needs_operator`.
Extension resolution errors (`extension_not_installed`,
`extension_version_mismatch`) take precedence. Tool conflict rules are checked
first and still fail with `extension_tool_conflict`.

The SDK activates only declarable tools. Registration alone is not availability:
several registered `pi-lens` tools were never active in the
[provider-free evaluation](../evaluation/pi-lens-registration-2026-10-19/).
Granting such a tool fails closed. Extensions that register tools lazily in
`session_start` or later are unsupported.

Capabilities expose `grantedExtensionTools` directly after `extensions` for
every profile, in configured order, or `[]` when absent. This is configuration
intent only. Setup verify compares it; Doctor remains offline and cannot inspect
registered tools without importing extension code.

## Contract change and versioning

The new capabilities field and start error are a public contract change for
minor release **0.10.0** under
[ADR 0003](0003-post-mvp-maintenance.md#versioning). This decision does not
itself bump the version or authorize publication. See
[Tool contracts](../tool-contracts.md#capability-discovery) for the bounded
setup-verifier limit.

## Consequences

- A grant is the operator's trust decision, not proof that a tool only reads.
  Granted tools are third-party code and may write with the server user's rights.
- Workspace modes `container` and `read-only` do not restrict granted tools;
  read-only profiles remain allowed in every mode. Modes are application policy,
  not a sandbox for extensions.
- Hooks and prompt changes retain their existing rights. Coding profiles still
  get every extension tool and cannot configure this field.
- Misspelled, unavailable or non-declarable grants fail closed, rather than
  silently starting a session without the promised tool. Controllers report
  `extension_tool_missing` to the operator without retrying or switching profiles.
