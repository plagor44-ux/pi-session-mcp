# Worker system-prompt probe — 2026-10-26

## Question and answer

Does `phase0ResourceLoaderOptions()` in `src/sdk-pi-adapter.ts` make workers use `phase-0-system-prompt-disabled` rather than Pi's default prompt?

**No, in the observed Pi SDK 1.4.0 behavior.** The adapter-created session's effective initial system prompt contains Pi's default coding-assistant preamble, tool summaries, behavior rules, documentation guidance, workspace context, a selected-skill catalogue, and the working directory. The placeholder is absent. For each permission profile tested, the complete prompt string equals the one from a default resource loader in the same isolated workspace.

## Method

Run from the repository root:

```sh
npm run build
node docs/evaluation/worker-system-prompt-2026-10-26/probe.mjs
```

The script creates and removes a temporary workspace containing:

- A small `AGENTS.md` with heading `# Probe workspace` and marker `WORKSPACE_CONTEXT_MARKER_26OCT`.
- One skill with name `prompt-marker`, description marker `SKILL_DESCRIPTION_MARKER_26OCT`, and separate body marker `SKILL_BODY_MARKER_26OCT`.

It clears inherited environment variables before importing Pi, isolates home/agent/auth/model-store locations, disables model refresh/network access, and installs network and child-process denial guards. An offline `ModelRuntime` registers a faux provider with a synthetic auth value, not a real provider credential. The provider throws if invoked. No turn, tool execution, or external provider request is made.

The script builds real sessions through the compiled `SdkPiSessionAdapter`, using its injectable `createSession` boundary only to retain the returned public `AgentSession`. Both `read-only` and `coding` profiles select the skill through the adapter's normal skill-loading path. It reads **`session.systemPrompt`**, documented in Pi's `docs/sdk.md` as the current effective system prompt, including changes not yet sent to the model. Thus the observation is of public, runtime-constructed model-bound prompt state, not merely a reconstruction from source or a captured wire request.

For comparison, it constructs `DefaultResourceLoader` with only `cwd`, `agentDir`, and in-memory `settingsManager`: no `systemPrompt`, overrides, or discovery-disable options. The same workspace, model, tool selection, in-memory session storage, and untrusted-project setting are used. The fixture resides in the agent directory's normal `skills/` discovery location, so default discovery finds exactly the same skill. The adapter itself uses the workspace as its agent directory. Assertions check one loaded skill, one context file, marker inclusion/exclusion, and complete prompt equality per profile.

Only package-root SDK exports are imported. Installed implementation files were read afterward to explain the runtime result; no internal SDK import was needed. Diagnostics are suppressed, and stdout contains only a small, path-free JSON summary, never the complete prompt.

## Environment

- Base: `main` at `e6fc87c`; clean working tree verified before branching.
- Repository direct Pi SDK dependency: `@earendil-works/pi-coding-agent` **1.4.0**, exactly pinned in root `package.json`; installed manifest also reports **1.4.0**.
- Node: **v22.23.3**.
- Linux; offline, credential-free session construction.

## Observed results

Character counts are JavaScript string lengths of the **actual effective prompt**, not normalized text. They include internally generated absolute paths, which are not printed. The temporary directory suffix has fixed length. Counts can differ in another installation because the SDK documentation paths and temporary-root length can differ.

| Session | Profile | Characters | Placeholder | Default preamble | Context marker | Skill name / description / location | Skill body marker | Tool summaries / behavior rules |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| Adapter | read-only | 2991 | absent | present | present | present | absent | present |
| Default loader | read-only | 2991 | absent | present | present | present | absent | present |
| Adapter | coding | 3828 | absent | present | present | present | absent | present |
| Default loader | coding | 3828 | absent | present | present | present | absent | present |

In all four sessions:

- Top-level structure, in order: untagged **preamble**, `<tools>`, `<rules>`, `<docs>`, `<project_context>`, `<skills>`, `<cwd>`.
- The skill catalogue's `<available_skills>` is nested inside `<skills>`, not an additional top-level section.
- The only Markdown heading is the fixture's `# Probe workspace` inside project context; Pi's own section boundaries use tags rather than Markdown headings.
- The complete `read` tool description is **not** in this prompt text; its short `Read file contents` summary is. Do not confuse prompt summaries with full tool declarations and parameter schemas.
- Active read-only tools: `find`, `grep`, `ls`, `read`. Active coding tools: `bash`, `edit`, `find`, `grep`, `ls`, `read`, `write`.
- The adapter loader's public `getSystemPrompt()` returns `undefined`.

The adapter/default prompts are byte-for-byte equal within each profile (string equality assertion). Two consecutive runs of the final script produced identical JSON (`cmp` exit 0). Both reported zero network attempts, zero child-process attempts, and zero provider calls.

## Explanation from installed Pi implementation

These references are relative to `node_modules/@earendil-works/pi-coding-agent/`. This distribution contains compiled implementation source in `dist/`, not the original `src/` files.

1. **`dist/core/resource-loader.js`, `DefaultResourceLoader.reload()` (around lines 462–490):** after context-file loading, it resolves the configured system-prompt input into `baseSystemPrompt`, then assigns `this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt`. The adapter supplies a truthy callback that returns `undefined`. That return value **replaces** the placeholder; `undefined` does not mean “retain the original option.” The append override independently returns an empty array. Context loading is independent of this override and remains enabled.
2. **`dist/core/agent-session.js`, `AgentSession._rebuildSystemPrompt()` (around lines 1287–1312):** it reads `resourceLoader.getSystemPrompt()` into `customPrompt`, gathers loaded skills/context files, and supplies selected tools, prompt snippets, and tool guidelines to the prompt builder. **`AgentSession.systemPrompt`** (around lines 1075–1078) renders the current effective options with `buildSystemPrompt()`.
3. **`dist/core/system-prompt.js`, `buildSystemPromptSections()` and `buildSystemPrompt()`:** a truthy `customPrompt` replaces the default preamble/tool/rule/docs branch. With the observed `undefined`, Pi takes the default branch. It appends project context and the skill catalogue independently, adds the cwd, and renders tagged sections. `buildRules()` combines tool guidance with default concise-response/path-display rules.
4. **`dist/core/skills.js`, `formatSkillsForPrompt()` (around lines 278–302):** advertises visible skills by name, description, and location, with instructions to load their files. It does not inline the skill body. The observed description marker present/body marker absent matches this design.
5. **`dist/core/tools/read.js`, `readToolSystemPromptContribution` and `createReadToolDefinition()` (around lines 15–18 and 46–61):** the short prompt snippet and prompt guidelines are distinct from the full tool description/schema. **`dist/core/agent-session.js`, `_preparePromptAndToolLoadout()` (around lines 1315–1328)** builds prompt-section updates and notes that the agent loop separately declares tool changes before requests. Full declarations are therefore not accurately described as being embedded in the `session.systemPrompt` string; their request projection is a source-based explanation, not an observed provider call here.

## Meaning for workers: facts versus inferences

**Observed:** for the two extension-free adapter profiles, the initial effective prompt retains Pi's default coding/tool/behavior guidance. Workspace `AGENTS.md` content is included. Selected skill metadata and the file location are included, but the selected skill's instructions are not automatically inlined. The default-loader comparison is identical for this controlled workspace.

**Inferred:** the placeholder is a resource-discovery suppression input, not the worker's effective system prompt. These workers do not lose Pi's default tool and behavior guidance because of that input. A skill still requires the model to read its file before its body can guide a task. The extension-session path uses the same `phase0ResourceLoaderOptions()` function, so its base construction should share this fallback; however, extensions can modify prompts or tool loadouts later, and this probe does not establish the final request for an arbitrary extension-enabled worker. It also does not claim every default-loader workspace is equivalent: ambient `SYSTEM.md`, append files, additional skills, or other discovered resources can change the default loader's result. No live worker/provider behavior or adherence was tested.

Options, without a recommendation: retain the current behavior and document why the override returns `undefined`; simplify the placeholder/override arrangement only after checking discovery suppression remains intact; or introduce an explicit custom prompt if a later product decision calls for replacing Pi's defaults. This investigation changes none of those policies.

## Checks

| Command | Exit code | Result |
| --- | ---: | --- |
| `npm run build` | 0 | Compiled adapter used by probe |
| `node docs/evaluation/worker-system-prompt-2026-10-26/probe.mjs` (final run 1) | 0 | All runtime assertions passed |
| Same command (final run 2) | 0 | All runtime assertions passed |
| `cmp /tmp/worker-prompt-run1.json /tmp/worker-prompt-run2.json` | 0 | Identical complete JSON summaries |
| `npm run typecheck` | 0 | Green |

No `src/` or test files were changed. No network, real mutation, provider-backed turn, or dogfooding result is claimed.

Controller reproduction on the workstation host (outside the writer, Node
26.12.1, Pi SDK 1.4.0): two runs exited 0 with identical output; adapter and
default-loader prompts were equal per profile (2883 characters read-only, 3720
coding; the difference from the counts above comes from the longer paths
inside the writer), the placeholder was absent, and the probe saw zero network
attempts and zero provider calls.
