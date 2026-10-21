# Pi extension ablation for worker profiles — design

Date: 2026-10-19. Status: approved by the operator on 2026-10-19, together
with their answers below. Nothing live runs before the plan that follows from
it is in place.

## Intent

The operator delegates work from controller sessions (Claude Code, Codex) to Pi
workers through pi-session-mcp. The operator does not rework worker results;
the controller does, on the most expensive model in the loop. A worker result
that the controller can accept without a correction round therefore saves the
most money.

The question: does adding a Pi extension to a worker profile make worker
results better for the controller (accepted without correction more often, at
the same or lower total cost)? If yes, which extension for which profile?

Cost is a co-goal, not a side issue: an extension that improves results but
costs more is acceptable only if it saves more correction work than it costs.

## Evidence this builds on

- The extension allowlist per execution profile exists since 0.8 (#34).
  Profiles name exact `npm:<name>@<version>` pins, resolved from Pi's install
  without installing.
- Today only `pi-cursor-sdk@0.5.3` is enabled, on `code-cursor` and
  `review-cursor`.
- [Extension audit](../../evaluation/extension-audit-2026-10-17/README.md) and
  [functional evidence](../../evaluation/extension-functions-2026-10-17/README.md)
  (2026-10-17) cover packages, licences and provider-free function checks.
  They did not measure any benefit over the baseline.
- Recorded usage, 2026-10-12 to 2026-10-19: Claude Code controllers ran 210
  real worker sessions; Codex controllers none.
  - Profiles: `review-grok` and `code` 55 each, `review` 39, `review-glm` 26,
    `code-deepseek` 15.
  - Tasks: about half are read-only reviews of a diff or branch; about 50 are
    implementations or bug fixes from a plan; the rest are tests, docs and
    audits.
  - About a quarter of the coding sessions and 27 % of the reviews needed a
    further round. Most fix rounds came from a cross-family review by design;
    about 4 came from real worker defects.
  - These counts come from a heuristic scan of controller transcripts. Treat
    them as orientation, not as a baseline.
- The pi-session-mcp server keeps Pi sessions in memory and exposes no usage or
  cost. Worker usage must be measured on the evaluation side
  ([#92 note](../../evaluation/s5-decision-inputs-2026-10-18/worker-usage.md)).
- The [M1 A/B proposal and results](../../evaluation/m1-ab-proposal-2026-10-18/README.md)
  are the template for arms, pairing, stop rules and evidence handling.

## Goals

1. For each candidate pairing below, run the same tasks with and without the
   extension, and report per task and per arm:
   - acceptance by the task oracle;
   - worker usage and catalog cost;
   - runtime;
   - any network or file activity outside the task.
2. Make a recommendation per profile: enable, do not enable, or inconclusive.
3. Keep every attempt, including failed and stopped ones, as evidence in
   `docs/evaluation/extension-ablation-<date>/`.

## Candidate pairings (the operator agreed to this selection)

| Arm B adds | Profiles | Why |
| --- | --- | --- |
| `pi-lens@4.4.3` | `review-grok`, `review` | Code navigation and diagnostics for the most-used review profiles. |
| `openwiki@0.7.2` (superseded, see Amendments: replaced by `pi-lens@4.4.3` on these profiles) | `code`, `code-deepseek` | Repository knowledge from the existing OpenWiki of each repo; all five aliased repos have one (17–29 pages). |
| `pi-cache-optimizer@2.9.3`, warming disabled | `code`, `review` (OpenAI) | Cost lever only. Report its cost effect, not a quality claim. |

Arm A is the profile exactly as configured today. Arm B adds one extension.
Only one variable changes per pair. Profiles that appear in two pairings share
their arm A runs.

Product constraint (verified in `src/session-tools.ts`, `composeSessionTools`):
extension tools are active only in `coding` profiles. In `read-only` profiles
the model gets exactly `read`, `grep`, `find` and `ls`; only an extension's
hooks still act (superseded, see Amendments: v0.10.0 grants a fixed set of
extension tools on review profiles). Tool-based extensions such as `pi-lens`
therefore do nothing useful on the review profiles (superseded, see
Amendments). Hook-based ones such as `pi-cache-optimizer` do
act there. Operator decision (2026-10-19): review profiles shall get
extension tool access too. That is a separate product change, a granted
extension-tool list for `read-only` profiles with its own design, ADR and
release. The `pi-lens` pairing on `review-grok` and `review` runs only after
that change is released. Until then it stays out of the wave. The other
pairings do not depend on it and may run first. (Superseded, see Amendments:
the change is released, so this pairing is in the wave.)

pi-session-mcp creates sessions with `projectTrusted: false`. `pi-lens` likely
keeps LSP spawning and tool auto-install off in that state. The pairing
measures `pi-lens` as it behaves under pi-session-mcp, which is the production
behaviour, not its best case.

The workstation profiles `code` and `review` use the `openai` provider, not
`openai-codex`, so `pi-cache-optimizer` is not a no-op there.

Out of scope:
- `context-mode`, `pi-permission-system`, `pi-web-access` (blocked by the
  resolver);
- the Cursor profiles;
- the GLM and Mistral profiles. They had six instant `turn_failed` results in
  recorded usage, which should be investigated separately.

## Tasks

- About 6 to 8 real tasks replayed from recorded sessions in the operator's
  repositories, at the commit before the original solution. The operator
  allowed replaying real tasks.
- Two kinds, matching recorded usage:
  - **Reviews** of a diff or candidate whose real findings are known from
    later rounds. Oracle: recall of the known findings, plus false findings
    counted against a fixed list.
  - **Implementations** from a plan or brief with tests that decide
    correctness. Oracle: the decisive tests pass, and only files within scope
    changed.
- Selection criterion: the original outcome is unambiguous and checkable
  without a model. A task whose oracle needs judgment is dropped.
- Prompts are the original prompts with paths and aliases rewritten to the
  disposable clone. They are not improved, so that only the extension differs.
- Replay unit (designer's call): the first task prompt of the recorded
  session, as one turn. "Accepted" means the oracle passes on that first turn.
  Follow-up rounds are not replayed.
- Source: the operator's Claude Code transcripts under `~/.claude/projects/`.
  The operator allowed replaying real tasks. The repositories are the ones the
  recorded sessions already sent to the same providers.
- Review oracle (designer's call): for each known finding, pre-registered
  deterministic anchors (file, symbol or line range plus a key term) are fixed
  before the live wave. A review is accepted when it hits every finding marked
  as critical and reports no finding from the fixed false-finding list.
  Recall and false findings are reported as numbers too. No model or human
  judges matches.
- OpenWiki (designer's call): the clone uses the wiki as committed at the
  task's base commit. Tasks are limited to base commits where the repository
  already had an `openwiki/` directory. The extension's writer tools stay
  active, as shipped. A write into `openwiki/` counts as out of scope in the
  scored result; it does not stop the wave. (Superseded, see Amendments: the
  OpenWiki pairing is replaced, so this restriction no longer applies.)

## Constraints

- **Budget: at most USD 10 in total**, provider costs and controller quota
  combined, as decided by the operator.
  - Count worker cost as catalog cost from the measured usage.
  - Stop the wave before a run would exceed the remaining budget, using the
    most expensive run observed so far as the estimate.
  - Subscription quota (OpenAI OAuth, Claude) is unmetered; record that it was
    used, not as money.
- **Isolation:**
  - Everything runs on disposable full clones under a work directory outside
    the operator's repositories, with an evaluation-owned Pi agent directory
    (`PI_CODING_AGENT_DIR`).
  - Extensions are installed only there, at the exact pins.
  - The production configuration, the production Pi install, the client
    registrations and the operator's repositories stay unchanged.
  - Copy provider credentials into the evaluation agent directory the way the
    writer wrappers do (access token only, refresh token emptied). Never print
    or archive them.
- **Extension hazards from the audit:**
  - `pi-lens`: disable auto-install of LSP servers and tools, grammar
    downloads and format/autofix writes, or account for them in the scope
    oracle.
  - `pi-cache-optimizer`: warming must be off, because it can trigger
    billable requests.
  - `openwiki` (superseded, see Amendments: pairing replaced): it attempted
    one outgoing fetch in the audit. Log network attempts per run.
- **Measurement:** worker usage comes from the evaluation side (for example a
  harness that drives the Pi SDK session directly and sums assistant `usage`
  per turn; superseded, see Amendments: `getSessionStats()` is the cost of
  record). pi-session-mcp itself gets no new field, no runtime change and no
  internal import for this. Product sources stay unchanged.
- **No controller model in the loop for this wave** (designer's call). The
  oracles stand in for "the controller accepts". A controller-in-the-loop
  wave with Claude Opus would not fit USD 10 for 2 arms × 6–8 tasks × the
  pairings above. It can follow if this wave shows a signal.
- **Stop rules, adapted from M1 (designer's call):**
  - **Scored outcomes, the wave continues:**
    - a worker task failure (`turn_failed`);
    - an out-of-scope edit inside the clone;
    - a per-run timeout of 15 minutes.
  - **Stop the wave and keep every attempt, without retrying within the
    approval:**
    - any write outside the clone, or into the production Pi install or a
      client registration (detected by before/after hashes; superseded, see Amendments: the `strace`
      write audit is the primary detector);
    - a harness or cleanup failure (open session, residual process);
    - a provider, quota or authentication error;
    - the budget stop;
    - a wave runtime over 4 hours.
- **Observation (designer's call):** record each worker process tree's
  outgoing connections with `strace -f -e trace=connect`. Unlike the earlier
  JS-level probes, this also covers LSP binaries and other subprocesses. Any
  destination other than the configured provider endpoints and the package
  registry during setup is reported per run. Workers run on the host with
  clone isolation, not inside the Podman boundary. The before/after hashes
  above guard the anti-goals (superseded, see Amendments: they guard only the
  production config, the Pi install and the client registrations). `strace` is a prerequisite. The operator
  approved installing it (`pacman -S strace`, which needs the operator's sudo
  password). Without it, fall back to the JS-level instrumentation of the
  audit probes and state the gap in the report.
- **Budget accounting.** Operator decision: every worker run counts against
  the USD 10 at catalog price, including runs on subscription logins.
  Designer's calls:
  - Start with a calibration of one task per arm on the cheapest pairing. Its
    observed cost then serves as the per-run estimate for the budget stop.
  - Priority order if the budget cannot cover everything (superseded, see
    Amendments):
    1. `openwiki` on `code-deepseek`, then on `code`;
    2. the `pi-lens` pairing;
    3. `pi-cache-optimizer`.
  - Fewer tasks per pairing is preferred over dropping a pairing entirely,
    with at least 3 tasks per pairing.
  - Record cache-read tokens per run and alternate the A/B order per task, so
    the provider prompt cache does not favour one arm silently.
- **Recommendation rule (designer's call, fixed before the wave):**
  - **Enable:** arm B is accepted on at least as many tasks as arm A, is
    strictly better on at least one, and costs no more than 25 % above arm A
    in total for that pairing.
  - **Do not enable:** arm B is worse on acceptance.
  - **Inconclusive:** everything else. Cost and acceptance are reported side
    by side, not netted into one figure.
- **Reporting:** report all attempts. Predict no saving, ranking or success
  rate beyond what was observed. With one run per task and arm, say plainly
  that the result is indicative, not significant.

## Non-goals

- Changing production profiles. That needs a separate operator decision after
  the results.
- Proving security properties of extensions or containment.
- Comparing models or providers with each other.
- New public MCP fields or a release.

## Anti-goals (failure even if it technically works)

- A run writes into the operator's repositories, the production Pi install or
  a client registration.
- Credentials or full prompts end up in tracked evidence.
- Spending goes over USD 10, or the evaluation effort grows beyond what a
  per-profile recommendation is worth.
- An extension sends repository content somewhere and this goes unnoticed.

## Left to the builder

- Harness structure, and whether it reuses `eval/profiles` or adds a new
  `eval/extensions` module.
- The exact task list within the criteria above, documented with its source
  session and oracle before the live wave. The heuristic scan scripts from the
  usage recon may be reused as a starting point; they are not tracked.
- The order of runs. Interleave A and B per task (A/B, then B/A), as in M1.
- Price table source for catalog cost (the Pi model catalog of the pinned SDK).
- Evidence file layout and the integrity index, following earlier evaluation
  folders.

## Amendments (2026-10-20)

Decisions taken after the approval on 2026-10-19. Where they contradict the
text above, they win.

- **OpenWiki pairing replaced.** `openwiki@0.7.2` (latest on npm) registers
  only `openwiki_begin`, `openwiki_submit_plan`, `openwiki_next_page`,
  `openwiki_inspect_page_claims`, `openwiki_submit_page` and `openwiki_finish`
  (`dist/integrations/pi/openwiki.js`). It has no retrieval tool and no context
  hook, so it cannot supply repository knowledge to a worker. Operator
  decision 2026-10-20: replace that pairing with `pi-lens@4.4.3` on `code` and
  `code-deepseek`.
- **New priority order** if the budget cannot cover everything:
  1. `pi-lens` on `code-deepseek`;
  2. `pi-lens` on `code`;
  3. `pi-lens` on `review-grok` and `review`;
  4. `pi-cache-optimizer` on `code` and `review`.

  Calibration runs on pairing 1.
- **The `pi-lens` review pairing is unblocked.** v0.10.0 (ADR 0010) shipped
  `grantedExtensionTools`. Granted set on the review profiles: `symbol_search`,
  `project_report`, `read_symbol`, `read_enclosing`, `module_report`,
  `ast_grep_search` and `ast_grep_outline`. Left out: `ast_grep_replace`
  (writes), `lens_diagnostic_mark`, `pi_lens_activate_tools`, `lsp_navigation`,
  `lens_diagnostics` (LSP spawning is off in untrusted projects) and
  `effective_config`. Coding profiles activate every registered tool; that is
  product behaviour. (Superseded, see Amendments 2026-10-21: the AST tools are
  situational and cannot be granted.)
- **"Warming disabled"** means `PI_CACHE_OPTIMIZER_NO_ZERO_PRICE_WARMING=1`,
  the extension's only warming lever. Pi's own `cacheWarming` stays at its
  default `streaming` in both arms
  (`node_modules/@earendil-works/pi-coding-agent/docs/settings.md`), because
  that is production behaviour and only one variable changes.
- **`pi-lens` safety.** Untrusted projects already block tool install and LSP
  spawn (`isToolInstallAllowedByTrust`, `isLspSpawnAllowedByTrust`). Both arms
  additionally set `PI_LENS_DISABLE_TOOL_INSTALL=1`,
  `PI_LENS_DISABLE_LSP_INSTALL=1` and `PI_LENS_HOME` inside the run scope.
- **Usage source.** The public `AgentSession`, captured through the adapter
  seams. Per run, `getSessionStats()` is the cost of record: there is one turn
  per session, so it is the run total, including warming refreshes. The sum of
  assistant `usage` is a cross-check.
- **Codegraph index.** Clones get a `codegraph` index (`codegraph init -y`),
  because every profile under test configures the `codegraph` MCP server.
- **Out-of-clone writes.** They are detected primarily by the `strace` write
  audit. The trace set is extended from `connect` to file-writing syscalls plus
  process and cwd tracking: `open`/`openat` with write flags, `creat`,
  `rename*`, `unlink*`, `mkdir*`, `symlink*`, `link*`, `truncate`,
  `chdir`/`fchdir` and `clone`/`clone3`/`fork`/`vfork`, with paths resolved
  against the per-process cwd. Before/after hashes guard the production config, the Pi install and
  the client registrations. Hashing the operator's repositories would misfire
  on concurrent work.
- **Budget estimate** before each run: the most expensive run observed so far,
  as in the spec, but at least USD 1.00 for a profile with no observed run yet.
  This is stricter than the spec, never looser. Calibration counts as the first
  task pair of the wave.
- **Token expiry stop.** Before each run, the wave stops with an auth stop if a
  needed OAuth access token expires within 20 minutes (`expiresWithin` from
  `src/writer-credentials.ts`), instead of letting the run fail.
- **Arm B start failures.** Arm B session-start failures
  (`extension_load_failed`, `extension_tool_missing`) are harness failures and
  stop the wave.

## Amendments (2026-10-21)

Findings of the first provider-free dry load (Task 9). Where they contradict
the text above, they win.

- **Review grant narrowed to five tools.** The granted `pi-lens` set on the
  review profiles is `symbol_search`, `project_report`, `read_symbol`,
  `read_enclosing` and `module_report`. `ast_grep_search` and
  `ast_grep_outline` are removed. Evidence: in `pi-lens@4.4.3`
  (`dist/index.js`, `TOOL_REGISTRY`) `ast_grep_search`, `ast_grep_replace`,
  `ast_grep_outline`, `lsp_navigation` and `lens_diagnostic_mark` are
  `situational: true`, so they are inactive until `pi_lens_activate_tools` runs.
  On the code profiles the active tools were exactly `bash`, `edit`,
  `effective_config`, `find`, `grep`, `lens_diagnostics`, `ls`,
  `mcp_codegraph_explore`, `module_report`, `pi_lens_activate_tools`,
  `project_report`, `read`, `read_enclosing`, `read_symbol`, `symbol_search`
  and `write`; the review pairings failed at start with
  `extension_tool_missing` for the two AST tools. `pi_lens_activate_tools` stays
  ungranted, so **review arm B has no AST search**.
- **Codegraph phone-home disabled in both arms.** The `codegraph` MCP server
  (`codegraph serve --mcp`) runs a background update check against
  `github.com` and `api.github.com`, and the sandbox `HOME` is fresh per run, so
  every session connected out. The evaluation sets `DO_NOT_TRACK=1`,
  `CODEGRAPH_NO_UPDATE_CHECK=1` and `CODEGRAPH_TELEMETRY=0` in the run
  environment and, because the MCP child does not inherit that environment,
  adds an identity `envFrom` mapping for these three variables to every
  `mcpServers` entry of the copied profile. This is a further deviation from
  "copied verbatim except `workspaces`", in addition to the extension pin and
  grant and to what `runConfig` already does (it sets the default profile and
  adds the read-only copy).
- **`io_uring_setup` counting.** A call split by `<unfinished ...>` is joined
  with its `resumed` line and counts only if its final return value is
  non-negative; the injected `ENOSYS` no longer counts.
