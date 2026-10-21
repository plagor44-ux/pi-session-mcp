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
2. Make a recommendation per profile: enable, do not enable, or inconclusive
   (for implementation pairings only, see Amendments R83).
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
  as critical and reports no finding from the fixed false-finding list
  (the false-finding condition is superseded, see Amendments 2026-10-21, R78:
  a review is accepted when its verdict pattern matches and it hits every
  critical finding; false findings are report-only; review acceptance is
  descriptive only since R83).
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
  situational and cannot be granted, and coding profiles activate only the
  non-situational registered tools; the situational pi-lens tools stay inactive
  until `pi_lens_activate_tools`.)
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
  adds the read-only copy for coding profiles).
- **`io_uring_setup` counting.** A call split by `<unfinished ...>` is joined
  with its `resumed` line and counts only if its final return value is
  non-negative; the injected `ENOSYS` no longer counts.
- **Task dependencies, mounted read-only at the base lock (R68).** The sandbox
  hides the home directory and a fresh clone has no installed dependencies, so
  an implementation oracle (and the worker) could not run a repository's tests.
  A task may declare up to four `dependencies` (`{ path, lockfile }`: a
  repo-relative directory such as `backend/.venv` and the lockfile it was built
  from). The operator builds them beforehand in a directory given by
  `--deps <dir>` (`--dry-load` and `--wave`; not `--plan` or `--preflight`),
  which must lie outside the repository, every configured workspace and the
  wave directory (`deps_dir_in_source`), must be canonical (its realpath is its
  path, `deps_dir_not_canonical`) and is required (`deps_missing`) when a
  task that will run declares dependencies. No link is allowed below it on the
  way to a bind source: each mount and the runtime must be exactly
  `<deps>/<taskId>/mounts/<path>` and `<deps>/<taskId>/runtime` by realpath
  (`dependency_mount_invalid`; a linked `lock` directory is a
  `dependency_lock_mismatch`), so a link cannot bring a source checkout into
  the sandbox. The read-only checks run for every pending task up front in a
  wave and for every task that declares dependencies in a dry load, and again
  for each scope. Per task, `<deps>/<taskId>/mounts/<path>/`
  holds the content, `<deps>/<taskId>/lock/<lockfile>` the lockfile copy and
  `<deps>/<taskId>/runtime/` optionally whatever the content references by
  absolute path (the interpreter a venv points to). Before a scope is used, the
  lock copy must equal the lockfile at the base commit
  (`dependency_lock_mismatch`), the mount must exist and be a real directory
  (`dependency_missing`, `dependency_mount_invalid`) and `<path>` must not exist
  in the base tree (`dependency_path_tracked`). The harness creates `<path>`
  as an empty directory in the clone, and the run, oracle and dry-load
  sandboxes bind the mount read-only there and the runtime read-only at its own
  real path, after the scope bind. Nothing else of `<deps>` is visible and no
  absolute path reaches tracked evidence.
- **The worker clone holds only history reachable from the base commit (R69).**
  A local clone copies every object and ref, so a coding worker could read the
  original solution with `git log --all` or `git show <branch>:<file>`. The
  worker clone is now made over the transport (`--no-local --single-branch
  --no-tags`) from a temporary branch at the base commit in the pristine bare
  clone; the branch, the remote-tracking ref and every other ref are removed,
  and `HEAD` is detached at the base commit. The bare clone itself keeps the
  full history (it is outside the sandbox) because the scope check and the
  oracle use it; an oracle setup step may therefore still run
  `git checkout <solution> -- <file>`.
- **Residual risk: the oracle's `.git` holds the full history (R69).** The
  worker clone is cut at the base commit, but `neutralizeGitDir` replaces the
  clone's `.git` with one cloned from the pristine bare clone before the oracle
  runs, so candidate code that executes in the oracle (a `conftest.py`, a
  pretest script) could read later commits and the original solution. This is
  not prevented: the oracle's setup steps need that history, and the run unit
  has finished by then. It is detected only insofar as the oracle's strace
  audit shows an unexpected write or connection. No code change.
- **Package managers run offline in the sandbox (R73).** The run environment
  of every traced process sets `GOPROXY=off`, `GOTOOLCHAIN=local`,
  `UV_OFFLINE=1`, `UV_NO_SYNC=1`, `UV_PYTHON_DOWNLOADS=never` and
  `npm_config_offline=true` (six variables; `GOFLAGS=-mod=mod` is deliberately
  not set, since it breaks offline builds of vendored modules and is refused in
  `go.work` workspace mode, and Go's default read-only module mode with
  `GOPROXY=off` already fails fast). Without them a `go test` fetched the toolchain
  and modules that `go.mod` asked for (1.27.2 against the host's 1.27.1) and
  `uv run` would try to sync into the read-only venv mount, which adds network
  traffic and minutes to a run. Production workers have warm caches and the
  sandbox has none, so the commands fail fast instead. The variables are
  identical for every run and both arms; the oracle's own minimal environment is
  unchanged (its commands are explicit argv). With `UV_NO_SYNC=1`, `uv run` in
  a project without a mounted venv creates an empty `.venv` and fails later, at
  the first import, rather than immediately. This is a documented deviation
  from the production environment.
- **Task curation rulings (R70-R72).** R70: a task's `repo` is the recorded
  workspace alias (worktree aliases included), so `renderPrompt` rewrites the
  recorded paths to the clone. R71: the go-app implementation oracle adds
  `grep -qF` setup steps for the issue rows the prompt requires, because the
  repository's own checker only proves the callsite keys. R72: the
  `i-pyng-authz` `scopeIgnore` lists the cache prefixes under package
  directories that exist at the base commit. The cost is that a worker that
  creates a new `__pycache__` (or similar) elsewhere scores out of scope.
  Dependency mount points are not listed, because the harness keeps them empty
  and git does not report empty directories.
- **Directory prefixes in `allowedPaths` (R77).** An `allowedPaths` entry is a
  repo-relative file or a directory prefix ending in `/` (no leading `/`, no
  `..` segment, no glob characters), as `scoreImplementation` already
  supported; the task schema had refused the prefix form.
- **Review acceptance needs a verdict; false findings are report-only (R78).**
  Each review oracle carries a required `verdict: { pattern }`, a JavaScript
  regular expression source (non-empty, at most 500 characters, compiled with
  flags `im` at parse time) fixed before the live wave. A review is accepted
  when the pattern matches its text and every critical finding is hit
  (`verdictMatched && criticalHit === criticalTotal`). False findings are still
  computed and recorded, and the summary counts the scored runs with any false
  finding and those without the verdict per pairing and arm (`falseFindingRuns`,
  `verdictMissed`), but they no longer decide. This replaces the sentence
  "reports no finding from the fixed false-finding list" in the Tasks section's
  review oracle bullet. Evidence: in two reviews the keyword anchors cannot see
  negation. A review that approves while walking the prompt's checklist hit
  critical anchors, and correct reviews containing "never X" or "nothing Y"
  lines hit false-finding anchors; tuning the anchors did not converge. Cost: a
  complete review that omits the requested verdict is not accepted, and a review
  that does hit a false finding can be accepted (the number is reported, not
  decisive). `verdictMatched` is carried in the run record's `review` score; the
  record keeps no pattern and no text.
  Verdict patterns must run in linear time (R80): literal alternations,
  anchors and simple classes. A pattern with a backreference or with a repeated
  group that itself contains a quantifier (`(a+)+`) is refused at parse time
  (`verdict_pattern_unsafe`; a conservative syntactic check that does not
  detect overlapping alternations such as `(a|a)*`, nor adjacent overlapping
  quantifiers such as `^\W*(x\s*)?\W*` or `[^\n]*\b[\w/-]+\.` tried from
  every `^` position, so curation must time each pattern on adversarial 64 KiB
  inputs). A review oracle
  also needs at least one finding marked `critical: true`
  (`review_oracle_no_critical`), since the verdict alone would otherwise accept
  any review that matches it.
- **Review anchors use defect-claim vocabulary (R74; partly superseded by R78).**
  Review anchors use words that claim a defect and do not occur in the prompt's
  own checklist. Every review task must reject an approval that walks the
  checklist and the empty and generic controls, must accept the original first
  review as recorded, and its false findings must not hit a correct review that
  writes "no finding" lines; a task that cannot meet this is dropped (an oracle
  that needs judgment is dropped). Cost: possibly fewer review tasks. The part
  about false findings is superseded by R78: they are report-only, and the
  verdict gate rejects the approvals.
- **`i-go-app-inv3` is dropped and `i-pyng-pdf` replaces it (R75).** The recorded
  first turn of `i-go-app-inv3` exceeded the 15-minute run timeout. The
  replacement is the mail PDF renderer task in pynode-app (base `203cfc07`,
  worktree `pyng-stab-b`), whose oracle deselects implementation-coupled tests
  with `-k` and passes base-fail/solution-pass with a base-lock venv. Cost: a
  replacement whose recorded first turn needed a test-only follow-up.
- **`i-pyng-pdf` allows `backend/tests/` (R76).** The prompt allows a new
  renderer test file, so `allowedPaths` adds the directory prefix
  `backend/tests/` (accepted by the schema since R77). Cost: edits to other test
  files are allowed too; the oracle restores its own test file.
- **`i-pyng-pdf` oracle command (R79).** It pins `-c pyproject.toml` (a
  `pytest.ini` under the allowed test prefix cannot override the configuration)
  and runs with a short `TMPDIR=/tmp` (sandbox-private) so the AF_UNIX timeout
  test is kept; only the two tests that assert the internal code
  `process_status` stay deselected. Cost: the ECHILD check of the deselected
  tests is lost.
- **Verdict patterns are hardened and timed (R81).** After the final review
  found that the first patterns missed real non-approving formats and that one
  was super-linear, the reviewer's tested variants were adopted: wider authz
  and chat patterns, direct phrases for psm, bounded `[^\w\n]{0,N}` instead of
  `\W*`/`\s*`, and the `*+spoof` anchors of the go-app task dropped. The 101
  controls, the reviewer's probes, a held-out set and an adversarial timing suite
  (the reviewer's inputs plus generic classes) are re-run, with 50 ms per
  pattern at 64 KiB as the bound; the timing claim in the README and setup notes
  is corrected. The R80 check does not detect adjacent overlapping quantifiers,
  which is why timing is part of curation. Cost: one more curation round.
- **Review tasks are descriptive only (R83, owner decision 2026-10-21).** Review
  runs still run and are scored by `scoreReview`, and their records keep the
  score, but no review pairing (`pl-review-grok`, `pl-review`, `co-review`)
  yields a recommendation: its `recommendation` is the fixed value
  `descriptive`, and review acceptance never decides anything. The summary
  reports per arm, next to cost, cache-read share and unexpected connects, the
  oracle's numbers as description: runs with a review score, critical findings
  hit (sum, total and mean ratio), verdict matches, mean recall, runs with a
  false finding and `oracleAccepted` (what the keyword oracle computed, not an
  outcome); there is no `accepted` total in a review pairing, and `complete`
  only means at least three tasks were scored in both arms. The CLI's wave
  summary counts accepted implementation runs only. Why: four curation rounds
  and three independent reviews showed that the keyword oracle does not converge
  on fresh text (8 to 11 of 18 fresh correct reviews were accepted); the rule
  that an oracle needing judgment is dropped applies to acceptance. Cost: no
  recommendation for `review-grok`, `review` and `co-review` in this wave; cost,
  cache, network and the descriptive oracle numbers are still reported.
- **Audit stops keep their evidence privately (R84).** A run stopped by the
  trace audit (`outside_write`, `unresolved_write`, `unresolved_egress`) used
  to leave nothing to attribute the event to, because the strace log is removed
  with the private run directory. `parseStraceLog` now remembers, up to 50
  entries, the raw log line behind every outside write, unresolved write and
  unresolved egress (both lines of a joined unfinished/resumed call) in
  `evidenceLines`; run records and summaries never copy them. On such a stop
  (including the oracle traces of that run) the wave writes them, each line cut
  at 1000 characters, to `<waveDir>/diagnostics/<runId>.txt` (`wx`, mode 0600)
  before the private directory is removed; the dry load does the same for an
  unclean load. Nothing else is kept, and the report never reads or copies
  `diagnostics/`. Cost: worker-controlled paths and addresses exist on disk in
  that one private file, the kept lines can include up to 32 bytes of syscall
  payload (strace's default string size), for example the start of a message
  sent over an escaping socket, and an audit stop is the only trigger. A failed
  write leaves a structured, path-free `diagnostics_write_failed` event on
  stderr and the stop stands; a `diagnostics/` that is not a real directory is
  refused.
- **Audit-stopped slots are planned again (R85).** A trace-audit stop says
  nothing about the extension's result, but the slot stays charged in the
  ledger, which used to exclude it for good. `--plan --exclude-wave` now plans a
  slot again when every executed record of it in the excluded waves is a stop
  with an audit reason (`exclusion.replannedStopped`); a ledger charge without
  any record still excludes it, and a slot with any other executed record stays
  excluded. The earlier charge stays in the ledger and in `remainingUsd`.
  The plan does so only when the ledger agrees with the records: the slot must
  hold exactly one run charge per excluded wave that stopped it by the audit;
  any other count (a wave left out of `--exclude-wave` that already re-ran it,
  or a charge without a record after a crash) keeps it excluded and is listed
  in `exclusion.notReplanned`. The approval carries `replannedStopped` as
  `{ runId, charges }` entries (run ids of its own list, unique, written by the
  plan, covered by the approval the operator signs and compared exactly on
  resume); the wave's guard against running a charged run id
  (`run_already_charged`) skips a listed id only while the ledger still holds
  exactly `charges` run charges for it, checked up front and per run. Alternatives considered: a
  guard that reads the earlier waves' records (the wave does not have them) or
  one that drops the charge check (it protects against double spending). In the
  report a record stopped by the audit is not final: a final record of the same
  run id from any other wave replaces it, whatever the order in which the waves
  are given, two final records still refuse (`duplicate_run_record`), and
  `waveStops` keeps the earlier stop.
- **OAuth credentials are refreshed on the host before each route and run
  (R86, owner decision).** OAuth access tokens live about an hour, and a scope
  gets the access token only (the refresh token is emptied, by design), so a
  multi-hour wave stopped with `credential_expiring` as soon as a token neared
  expiry. Before each preflight route and each wave run whose host credential
  is OAuth, the evaluation now calls the Pi SDK's documented path (the
  package-root `ModelRuntime`, created on the `--auth` file with no models
  file, and its `getAuth` with a 30-minute minimum validity), which refreshes a
  stored OAuth credential that is close to expiry under the credential store's
  lock and writes it back; the evaluation then reads the auth file again and
  applies the existing expiry check (20-minute margin) and the boundary
  selection to what it read. An API-key credential is never refreshed. A failed
  refresh is not fatal: a structured, secret-free `credential_refresh_failed`
  event (provider and a fixed code) goes to stderr, and the existing check
  decides, so a token too close to expiry still stops with
  `credential_expiring`. Tokens, refresh tokens and the auth path are never
  logged or recorded; records keep `authType` only. Cost: the evaluation writes
  to the operator's auth store during the wave, as normal pi use does (a
  refresh rotates the stored tokens).
- **Sockets in the sandbox's private tmpfs are internal (R87).** The first live
  run stopped with `unresolved_egress`: the codegraph MCP server connects to its
  daemon socket `/tmp/codegraph-<hash>.sock` (the MCP child has no `TMPDIR`, so
  its temporary directory is `/tmp`). The sandbox mounts a fresh tmpfs on `/tmp`
  and `/var/tmp`, so the only possible peer of a socket there is a process of
  the same sandbox. For a trace from a sandboxed command the audit therefore
  accepts a filesystem AF_UNIX path that resolves below `/tmp/` or `/var/tmp/`
  (for `connect`, `sendto` and `sendmsg` alike), except below a host path bound
  into the sandbox: the plan's read-only binds (the build root under `/tmp`,
  node and codegraph directories, `/etc` entries, name-resolution directories,
  home binds and links) and the task's dependency mounts and runtime, passed to
  the audit as `boundPaths` from the run, the oracle, the dry load and the
  containment self-test. A socket below a bound path is a host socket wherever
  it lies, so this is also stricter than before for a socket inside a
  dependency mount below the scope root. Abstract (`@`), relative, resolved-
  outside (`/tmp/../home/x.sock`) and all other paths still count as unresolved
  egress; an unsandboxed trace gets no tmp exemption. Cost: a worker process can
  talk to another process of its own sandbox over a socket in `/tmp`, which it
  could already do with pipes and loopback.
- **Abstract sockets that the trace itself bound are internal (R88).** A wave
  stopped on abstract-socket connects that the task's own code created: the
  pynode-app PDF renderer's parent/child IPC (`@mail-pdf-<hex>`, run by the
  task's tests) and the docker CLI's plugin socket (`@docker_cli_<hex>`). The
  sandbox shares the host's network namespace, so an abstract name is a real
  reach in general, and the audit could not tell who had created a name because
  `bind` was not traced. `bind` is now in the traced calls. The parser remembers
  every abstract AF_UNIX name that a process of the trace bound successfully
  (`= 0`; the muted bubblewrap process does not count, and a bind that never
  completed does not either), and a connect, `sendto`, `sendmsg` or `sendmmsg`
  to such a name, later in the log, is internal. A connect before the bind, a
  name whose bind failed (`EADDRINUSE` means a host process holds it) and every
  other abstract name stay unresolved egress, and the filesystem socket rules
  are unchanged; diagnostics (R84) still keep the line of any remaining
  escape. Cost: a worker that binds a name nobody holds on the host can
  connect to it without a stop (a process of its own sandbox is the only peer
  at the moment of the bind, but a host process could take the name later; the
  network namespace stays shared, R50).
  Names are compared as strace printed them (the escaped text, so two different
  non-UTF-8 names never collide), a name with an escape strace cannot print is
  never trusted, and a name is internal only while a process that bound it is
  alive in the trace (its `+++ exited`/`+++ killed` line drops it; an execve
  keeps it, because the socket survives it unless it is close-on-exec; a thread
  that exits drops it although its process may live on, which errs towards a
  stop). `close` is not traced, to keep logs small. The run and oracle
  environments never carry `DISPLAY`, `WAYLAND_DISPLAY`,
  `DBUS_SESSION_BUS_ADDRESS`, `SSH_AUTH_SOCK` or `XDG_RUNTIME_DIR` (a test sets
  them in the host process and checks both).
- **A report across waves at different commits (R89).** The report refuses
  (`approval_source_mismatch`) unless the bound code is unchanged between each
  wave's approval commit and HEAD, which a multi-wave evaluation with fixes
  between its waves cannot meet. `--report` takes `--allow-source-drift`
  (refused in every other mode): then each wave's `sourceCommit` must exist and
  be an ancestor of HEAD (`git merge-base --is-ancestor`, else
  `approval_source_unknown`), and instead of refusing, the repo-relative bound
  paths changed between that commit and HEAD (`git diff --name-only`) are
  recorded per wave, by its 1-based position among the `--wave` arguments, as
  `{ wave, sourceCommit, boundPathsChangedSinceSource, allowSourceDrift: true }`
  in `summary.json` (`sourceDrift`) and `integrity.json` (`source_drift`); both
  fields are absent without the option, whose output is unchanged. The dirty
  tree check and the source binding of HEAD stay. Cost: the evidence no longer
  says that every wave ran the code at HEAD; it says which bound files differ,
  and a reader judges whether a changed file affects a wave's records.

## Amendments (2026-10-21, repeat)

- **Replicates are a slot dimension (R90).** The first `pl-code` result (A 2/3,
  B 2/3, decided by one timeout) is one run per task and arm, which cannot tell
  an extension effect from run-to-run noise of a model that is not
  deterministic. `--plan --replicates <N>` (integer 1 to 9, `--plan` only,
  `invalid_argument` elsewhere; default 1) plans every task and arm N times.
  The slot is now (task, profile, arm, replicate). The canonical matrix (R58)
  is built once per replicate and concatenated replicate by replicate, ordinals
  run over the whole list, and the arm-A/arm-B order per task flips between
  consecutive replicates (so every task sees both orders). With N > 1 every run
  id ends in `-r<k>` (also `-r1`) and the run and its record carry `replicate`;
  the approval records `replicates`, which is part of the binding
  (`validateApproval` checks the run list against the canonical matrix of that
  replicate count; `matrixDigest` covers the runs). `--exclude-wave`, `--resume`
  and the charge guard (G1) key on the run id, which names one slot, and refuse
  a record of the same id for another task, profile, arm or replicate. The
  report merges per run id with that consistency check. For an implementation
  pairing it pairs arm A and arm B per (task, replicate) unit, applies the
  pre-registered rule (`recommend()`, unchanged) to those units, and still asks
  for three distinct tasks before it calls a pairing complete; the summary adds
  per task the units paired and the accepted ones per arm (read as `k of N`)
  and the per-arm totals over the units. Review pairings stay descriptive.
  With N = 1 nothing changes: run ids, ordinals, order, digests, records and
  every output are byte-identical, and the approvals and evidence of
  2026-10-20 still parse and report the same. Cost: the budget scales with N
  (the repeat plan projects 18 runs for `pl-code`), and a rule written for
  three tasks now runs over up to 3 N units, so its "strictly better on one
  task" clause is met more easily by noise; the write-up reads the per-task
  counts beside the verdict.
