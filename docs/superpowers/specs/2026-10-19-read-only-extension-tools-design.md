# Granted extension tools for read-only profiles — design

Date: 2026-10-19. Status: draft; the operator agreed to the approach in chat
on 2026-10-19 (explicit grants per tool). The written design is pending
approval.

## Intent

Review workers run on `read-only` profiles. Today an extension loaded by such
a profile can act only through hooks and prompt changes. Its tools stay
registered but inactive, because `composeSessionTools` activates extension
tools only in `coding` profiles
([ADR 0006](../../adr/0006-pi-extension-allowlist.md),
[design](../../pi-extensions-design.md#tools-hooks-and-prompts)).

The operator wants review workers to use extension tools such as code
navigation (for example `pi-lens`), so that reviews hit the real findings
more often and the controller needs fewer re-review rounds. The planned
[extension ablation](2026-10-19-extension-ablation-design.md) measures that.
This change makes it possible.

## Decision taken with the operator

- A `read-only` profile may grant **individual extension tools by name**. A
  package-wide switch is not offered, because packages mix reading and
  writing tools (`openwiki` ships six lifecycle tools, several of which
  write).
- Without a grant, nothing changes. Today's behaviour stays the default.
- The server cannot verify that an extension tool only reads: it is
  third-party code. A grant is the operator's trust decision and is
  documented as such, like the extension allowlist itself.

## Goals

1. New optional profile field, working name `grantedExtensionTools`: an array
   of tool names, allowed only on `read-only` profiles that also list at
   least one extension.
2. In a `read-only` session with grants, the active tools become:
   - `read`, `grep`, `find` and `ls`;
   - the granted MCP tools, as today;
   - exactly the granted extension tools.
   Nothing else becomes active, including an extension's own
   `setActiveTools` attempts. This keeps the existing contract-test
   guarantee, extended by the grant list.
3. **Fail closed at session start** when a granted name is not registered by
   any extension of that profile. New `pi_session_start` error code, working
   name `extension_tool_missing`, class `needs_operator`. Diagnostics carry
   only the profile and tool name, never paths.
4. Existing conflict rules also apply to granted names:
   - the name pattern;
   - the MCP-reserved names;
   - collisions with built-in tools, granted MCP tools or another
     extension's tools.
5. **Config validation** (offline, `invalid_config` at startup):
   - the field is rejected on `coding` profiles and on profiles without
     extensions;
   - names must match the extension tool-name pattern;
   - no duplicates;
   - at most 32 entries.
6. **Capabilities** add the field to each profile, as configured intent,
   sorted as configured and `[]` when absent. Controllers then see which
   tools a review worker will have. This is a public contract change.
7. **Doctor** stays offline and imports no extension code, so it cannot see
   tool names. It only reports what config validation already guarantees.
   The registration check happens at session start (goal 3), as documented.
8. **Setup verify:** the bounded capabilities check accepts and compares the
   new field, so `--verify` does not regress as it did in #36.

## Clarifications after the builder check (designer's calls)

- **When a granted tool must exist:**
  - A granted tool must be registered when the extensions load, before
    `bindExtensions`.
  - After bind, the existing re-check applies: a change in the registered set
    fails closed.
  - Extensions that register tools lazily (in `session_start` or later) are
    out of scope for this release.
  - The plan's first step is a provider-free probe. Install `pi-lens@4.4.3`
    into a throwaway `PI_CODING_AGENT_DIR` and record its registered tools
    before and after bind.
  - If `pi-lens` registers `symbol_search` or `project_report` lazily, stop
    and return to the operator before building further.
- **Active at admission, exactly:**
  - For read-only sessions with grants, the post-bind admission check becomes
    exact for the granted names.
  - Every granted tool must be active and declared to the model; otherwise
    the start fails with the new code (`extension_tool_missing`).
  - This covers a hidden-exposure tool and one that the extension deactivates
    in `session_start`. It replaces the subset check for those names only.
  - The real-SDK contract test gets fixtures for both cases.
- **Release in the same PR:**
  - Under [Releasing](../../releasing.md#prepare-a-release), a release travels
    in the pull request of the change it ships.
  - The PR therefore carries the 0.10.0 version bump, the changelog heading
    and the pre-release acceptance record, including every literal pinned to
    the version.
  - Merge, tag and publish stay maintainer decisions.
- **Live acceptance:** it belongs to the pre-release acceptance and gates the
  release, not the merge of reviewed code.
  - One provider turn on a read-only profile with a granted `pi-lens` tool,
    in an evaluation-owned agent directory.
  - Pass:
    - the tool is active and declared to the model;
    - the model's call to it returns a non-error tool result.
  - A cold-index "not ready" answer counts as a pass and is recorded as such.
    The server creates sessions with `projectTrusted: false`, so `pi-lens`
    likely keeps LSP spawning and auto-install off. That is the production
    behaviour this release ships.
  - Spend: at most USD 0.50 at catalog price, separate from the ablation
    budget. Network observation as in the ablation design.
- **Workspace modes:** grants are allowed in every mode, as read-only
  profiles are today. Extension hooks already act with full rights in those
  workspaces. The threat model and the execution-modes guide state that a
  granted tool is third-party code that may write, and that `container` or
  `read-only` workspace modes do not restrict it.

## Release and records

- This is a minor release, 0.10.0, under ADR 0003: a new capabilities field
  and a new start error code.
- New ADR 0010, "Granted extension tools in read-only profiles", which
  amends ADR 0006. Update `docs/pi-extensions-design.md`,
  `docs/tool-contracts.md` (capabilities field, error code and class),
  `docs/threat-model.md` (grant as trust decision) and
  `pi-session-mcp.example.json` (a commented example only if the format
  allows it; otherwise a documentation example).
- The orchestration skill's start-error reference gets the new code.

## Non-goals

- Granting extension tools in `coding` profiles. They already get all of
  them.
- Classifying tools as read-only automatically, or sandboxing extension code.
- Changing hooks or prompt changes of extensions in read-only profiles. They
  already act today.
- Enabling any extension in the operator's production profiles. That follows
  the ablation results and the operator's decision.

## Anti-goals

- A `read-only` profile without a grant behaves differently than today.
- A granted name can activate a built-in write tool (`bash`, `edit`, `write`)
  or shadow one.
- A grant silently becomes a no-op. A misspelled or unregistered name must
  fail closed, not start a session without the tool.

## Tests the builder must provide (provider-free)

- Read-only with grants activates exactly the granted extension tools, plus
  `read`, `grep`, `find`, `ls` and the granted MCP tools.
- An extension's `setActiveTools` cannot activate an ungranted tool. Use the
  existing real-SDK contract test, extended.
- A granted name not registered gives `extension_tool_missing` before a
  session exists, and leaks nothing into diagnostics.
- Config rejects the field on coding profiles, on profiles without
  extensions, on duplicates, on bad names and above 32 entries.
- Granting a built-in name (`write`, `bash`) is rejected by config or by the
  conflict check.
- Capabilities show the field for every profile.
- Setup verify passes against a profile with grants.

## Left to the builder

- The final field name and error code name, if a better fit exists in the
  existing vocabulary.
- Where config validation lives, following `src/config.ts` conventions.
- Live acceptance: one provider turn on a read-only profile with a granted
  `pi-lens` tool, in an evaluation agent directory. It is recorded in the
  pre-release acceptance and needs no production profile change.
